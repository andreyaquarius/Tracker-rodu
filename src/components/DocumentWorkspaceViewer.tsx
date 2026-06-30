import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { DocumentFragmentSelection, ScanAttachment } from "../types";
import { downloadScan, getScanBlob, openScan, saveScan } from "../services/scanStorage";
import { authorizeGoogleDrive, reconnectGoogleDrive } from "../services/googleDriveStorage";

export type DocumentScanViewerContext = {
  source: "documents";
  document: {
    id: string;
    title: string;
    researchId: string;
    documentType: string;
    archive: string;
    fund: string;
    description: string;
    file: string;
    place: string;
  };
};

export type ActiveDocumentScanViewer = {
  scan: ScanAttachment;
  scans?: ScanAttachment[];
  pageIndex?: number;
  context?: DocumentScanViewerContext;
  openedAt: number;
};

type PreviewKind = "image" | "pdf" | "web";
type ViewerMode = "window" | "minimized" | "fullscreen";
type ViewerPosition = { left: number; top: number };
type ViewerSize = { width: number; height: number };
type ImagePan = { x: number; y: number };
type CropRect = { x: number; y: number; width: number; height: number };
type CachedPreview = { kind: PreviewKind; url: string; revokeOnClose: boolean; blob?: Blob };
type PdfDocumentCache = {
  document: PDFDocumentProxy;
};
type PdfJsModule = typeof import("pdfjs-dist");

const MIN_VIEWER_WIDTH = 420;
const MIN_VIEWER_HEIGHT = 360;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.01;
const PDF_RENDER_SCALE = 2;

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

interface DocumentWorkspaceViewerProps {
  viewer: ActiveDocumentScanViewer | null;
  onClose: () => void;
  onOpenDocument: (documentId: string) => void;
  onCreateFinding: (initialValues: Record<string, unknown>) => void;
}

export function DocumentWorkspaceViewer({
  viewer,
  onClose,
  onOpenDocument,
  onCreateFinding,
}: DocumentWorkspaceViewerProps) {
  const viewerRef = useRef<HTMLElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropStartRef = useRef<{ x: number; y: number } | null>(null);
  const panStartRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const previewCacheRef = useRef(new Map<string, CachedPreview>());
  const previewPromisesRef = useRef(new Map<string, Promise<CachedPreview>>());
  const pdfCacheRef = useRef(new Map<string, PdfDocumentCache>());
  const pdfPromisesRef = useRef(new Map<string, Promise<PdfDocumentCache>>());
  const [mode, setMode] = useState<ViewerMode>("window");
  const [position, setPosition] = useState<ViewerPosition | null>(null);
  const [viewerSize, setViewerSize] = useState<ViewerSize | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [blobUrl, setBlobUrl] = useState("");
  const [kind, setKind] = useState<PreviewKind | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [pdfRendering, setPdfRendering] = useState(false);
  const [pdfNativeFallback, setPdfNativeFallback] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pan, setPan] = useState<ImagePan>({ x: 0, y: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [creatingCrop, setCreatingCrop] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [previewReloadKey, setPreviewReloadKey] = useState(0);

  const pages = viewer?.scans?.length ? viewer.scans : viewer ? [viewer.scan] : [];
  const currentScan = pages[currentIndex] ?? viewer?.scan ?? null;
  const pageCount = pages.length;
  const isInteractivePdf = kind === "pdf" && !pdfNativeFallback;
  const navigationPageCount = isInteractivePdf ? pdfPageCount : pageCount;
  const navigationPageNumber = isInteractivePdf ? pdfPageNumber : Math.min(currentIndex + 1, Math.max(1, pageCount));

  const loadPreview = (scan: ScanAttachment): Promise<CachedPreview> => {
    const cached = previewCacheRef.current.get(scan.id);
    if (cached) return Promise.resolve(cached);
    const pending = previewPromisesRef.current.get(scan.id);
    if (pending) return pending;

    const promise = getScanBlob(scan)
      .then((blob) => {
        const previewBlob = normalizePreviewBlob(scan, blob);
        const nextKind = previewKind(scan, previewBlob);
        if (!nextKind) {
          throw new Error("Попередній перегляд доступний для зображень, PDF і web-джерел.");
        }
        const preview = {
          kind: nextKind,
          url: URL.createObjectURL(previewBlob),
          revokeOnClose: true,
          blob: previewBlob,
        };
        previewCacheRef.current.set(scan.id, preview);
        return preview;
      })
      .finally(() => {
        previewPromisesRef.current.delete(scan.id);
      });

    previewPromisesRef.current.set(scan.id, promise);
    return promise;
  };

  const loadPdfDocument = (scan: ScanAttachment): Promise<PdfDocumentCache> => {
    const cached = pdfCacheRef.current.get(scan.id);
    if (cached) return Promise.resolve(cached);
    const pending = pdfPromisesRef.current.get(scan.id);
    if (pending) return pending;

    const promise = Promise.resolve(previewCacheRef.current.get(scan.id)?.blob)
      .then((cachedBlob) => cachedBlob ?? getScanBlob(scan))
      .then(async (blob) => {
        const data = new Uint8Array(await blob.arrayBuffer());
        const pdfJs = await loadPdfJs();
        const document = await pdfJs.getDocument({
          data,
          // Some scanned archival PDFs use image codecs that PDF.js tries to
          // load through external WASM assets. In the app bundle those assets
          // are not served from a stable folder, so the JS decoder path is the
          // safer default for in-app previews.
          useWasm: false,
        }).promise;
        const cache = { document };
        pdfCacheRef.current.set(scan.id, cache);
        return cache;
      })
      .finally(() => {
        pdfPromisesRef.current.delete(scan.id);
      });

    pdfPromisesRef.current.set(scan.id, promise);
    return promise;
  };

  const preloadPage = (index: number) => {
    const scan = pages[index];
    if (!scan || previewCacheRef.current.has(scan.id)) return;
    void loadPreview(scan).catch(() => undefined);
  };

  useEffect(() => {
    return () => {
      for (const preview of previewCacheRef.current.values()) {
        URL.revokeObjectURL(preview.url);
      }
      previewCacheRef.current.clear();
      previewPromisesRef.current.clear();
      for (const pdf of pdfCacheRef.current.values()) {
        void pdf.document.cleanup();
      }
      pdfCacheRef.current.clear();
      pdfPromisesRef.current.clear();
    };
  }, [viewer?.openedAt]);

  useEffect(() => {
    if (!viewer) return;
    const requestedIndex = typeof viewer.pageIndex === "number"
      ? viewer.pageIndex
      : pages.findIndex((scan) => scan.id === viewer.scan.id);
    setCurrentIndex(Math.max(0, Math.min(pages.length - 1, requestedIndex >= 0 ? requestedIndex : 0)));
    setMode("window");
    setPosition(null);
    setViewerSize(null);
    setBlobUrl("");
    setKind(null);
    setPdfPageNumber(1);
    setPdfPageCount(0);
    setPdfRendering(false);
    setPdfNativeFallback(false);
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    setError("");
  }, [viewer?.openedAt]);

  useEffect(() => {
    let active = true;

    setError("");
    setSelectionMode(false);
    setCropRect(null);
    setPdfPageNumber(1);
    setPdfPageCount(0);
    setPdfRendering(false);
    setPdfNativeFallback(false);
    cropStartRef.current = null;
    panStartRef.current = null;

    if (!currentScan) return undefined;

    const cached = previewCacheRef.current.get(currentScan.id);
    if (cached) {
      setKind(cached.kind);
      setBlobUrl(cached.url);
      setLoading(false);
      preloadPage(currentIndex + 1);
      preloadPage(currentIndex - 1);
      return undefined;
    }

    setLoading(true);
    void loadPreview(currentScan)
      .then((preview) => {
        if (!active) return;
        setKind(preview.kind);
        setBlobUrl(preview.url);
        preloadPage(currentIndex + 1);
        preloadPage(currentIndex - 1);
      })
      .catch((loadError) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Не вдалося відкрити попередній перегляд.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [currentScan?.id, currentIndex, previewReloadKey]);

  useEffect(() => {
    let active = true;
    const canvas = pdfCanvasRef.current;

    if (!currentScan || kind !== "pdf" || pdfNativeFallback || !canvas) return undefined;

    setPdfRendering(true);
    setError("");

    void loadPdfDocument(currentScan)
      .then(async ({ document }) => {
        if (!active) return;
        const nextPageCount = document.numPages;
        const safePageNumber = Math.min(Math.max(1, pdfPageNumber), nextPageCount);
        if (safePageNumber !== pdfPageNumber) {
          setPdfPageNumber(safePageNumber);
          return;
        }
        setPdfPageCount(nextPageCount);

        const page = await document.getPage(safePageNumber);
        if (!active) return;

        const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Браузер не зміг підготувати PDF-сторінку.");

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / PDF_RENDER_SCALE)}px`;
        canvas.style.height = `${Math.floor(viewport.height / PDF_RENDER_SCALE)}px`;
        context.clearRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: context,
          viewport,
          canvas,
          background: "rgb(255,255,255)",
        }).promise;
        if (active && isCanvasEffectivelyBlank(canvas)) {
          setPdfNativeFallback(true);
          setSelectionMode(false);
          setCropRect(null);
        }
      })
      .catch(() => {
        if (!active) return;
        setPdfNativeFallback(true);
        setPdfPageCount(0);
        setSelectionMode(false);
        setCropRect(null);
      })
      .finally(() => {
        if (active) setPdfRendering(false);
      });

    return () => {
      active = false;
    };
  }, [currentScan?.id, kind, pdfPageNumber, pdfNativeFallback]);

  useEffect(() => {
    if (!viewer || navigationPageCount < 2 || mode === "minimized" || selectionMode) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key)) {
        event.preventDefault();
        if (isInteractivePdf) {
          setSelectionMode(false);
          setCropRect(null);
          setPdfPageNumber((page) => Math.min(navigationPageCount, page + 1));
        } else {
          setCurrentIndex((index) => Math.min(pageCount - 1, index + 1));
        }
      }
      if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        if (isInteractivePdf) {
          setSelectionMode(false);
          setCropRect(null);
          setPdfPageNumber((page) => Math.max(1, page - 1));
        } else {
          setCurrentIndex((index) => Math.max(0, index - 1));
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewer, pageCount, navigationPageCount, isInteractivePdf, mode, selectionMode]);

  useEffect(() => {
    const onFullscreenChange = () => {
      if (document.fullscreenElement !== viewerRef.current) {
        setFullscreenError("");
        setMode((value) => (value === "fullscreen" ? "window" : value));
      }
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!viewer || mode !== "fullscreen") return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [viewer, mode]);

  if (!viewer) return null;

  const sourceDocument = viewer.context?.document;
  const title = sourceDocument?.title || currentScan?.name || viewer.scan.name;
  const activeScan = currentScan ?? viewer.scan;
  const pageLabel = navigationPageCount > 1
    ? `Сторінка ${navigationPageNumber} з ${navigationPageCount} · ${activeScan.name}`
    : activeScan.name;

  const minimizeViewerForRecordAction = async () => {
    setFullscreenError("");
    if (document.fullscreenElement === viewerRef.current && document.exitFullscreen) {
      await document.exitFullscreen().catch(() => undefined);
    }
    setMode("minimized");
  };

  const createFinding = async () => {
    if (!sourceDocument) return;
    await minimizeViewerForRecordAction();
    onCreateFinding({
      researchId: sourceDocument.researchId,
      documentId: sourceDocument.id,
      archive: sourceDocument.archive,
      fund: sourceDocument.fund,
      description: sourceDocument.description,
      file: sourceDocument.file,
      place: sourceDocument.place,
      page: navigationPageCount > 1 ? String(navigationPageNumber) : "",
      notes: `Створено під час перегляду документа «${sourceDocument.title}». Скан: ${activeScan.name}.`,
    });
  };

  const createFindingFromCrop = async () => {
    if (!sourceDocument || !cropRect) return;
    setError("");
    setCreatingCrop(true);
    try {
      await authorizeGoogleDrive();
      const sourceName = `${sourceDocument.title || activeScan.name}-сторінка-${navigationPageNumber}-фрагмент.png`;
      const croppedFile = kind === "pdf" && pdfCanvasRef.current
        ? await cropCanvasToFile(pdfCanvasRef.current, cropRect, sourceName, zoom)
        : imageRef.current
          ? await cropImageToFile(imageRef.current, cropRect, sourceName, zoom)
          : null;
      if (!croppedFile) {
        throw new Error("Не вдалося підготувати фрагмент для збереження.");
      }
      const fragmentSelection = documentFragmentSelectionFromCrop(
        sourceDocument.id,
        activeScan,
        navigationPageNumber,
        rotation,
        cropRect,
        kind === "pdf" ? pdfCanvasRef.current : imageRef.current,
        zoom,
      );
      const fragmentScan = await saveScan(croppedFile, "finding");
      setSelectionMode(false);
      setCropRect(null);
      await minimizeViewerForRecordAction();
      onCreateFinding({
        researchId: sourceDocument.researchId,
        documentId: sourceDocument.id,
        archive: sourceDocument.archive,
        fund: sourceDocument.fund,
        description: sourceDocument.description,
        file: sourceDocument.file,
        place: sourceDocument.place,
        page: navigationPageCount > 1 ? String(navigationPageNumber) : "",
        scans: [fragmentScan],
        fragmentSelection,
        notes: `Створено з виділеного фрагмента документа «${sourceDocument.title}». Джерело: ${activeScan.name}.`,
      });
    } catch (cropError) {
      setError(cropError instanceof Error ? cropError.message : "Не вдалося створити знахідку з фрагмента.");
    } finally {
      setCreatingCrop(false);
    }
  };

  const openSourceDocument = async () => {
    if (!sourceDocument) return;
    await minimizeViewerForRecordAction();
    onOpenDocument(sourceDocument.id);
  };

  const run = async (action: () => Promise<void>) => {
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Не вдалося виконати дію.");
    }
  };

  const reconnectDriveAndRetry = async () => {
    setError("");
    previewPromisesRef.current.delete(activeScan.id);
    const cached = previewCacheRef.current.get(activeScan.id);
    if (cached?.revokeOnClose) {
      URL.revokeObjectURL(cached.url);
    }
    previewCacheRef.current.delete(activeScan.id);
    pdfCacheRef.current.delete(activeScan.id);
    pdfPromisesRef.current.delete(activeScan.id);
    await reconnectGoogleDrive();
    setBlobUrl("");
    setKind(null);
    setPreviewReloadKey((value) => value + 1);
  };

  const fallbackToHostedPreview = () => {
    const hostedPreviewUrl = hostedFilePreviewUrl(activeScan);
    if (!hostedPreviewUrl) {
      setError("Файл завантажився, але браузер не зміг показати його у внутрішньому переглядачі. Спробуйте відкрити джерело або завантажити файл.");
      return;
    }
    setError("");
    setSelectionMode(false);
    setCropRect(null);
    setKind("web");
    setBlobUrl(hostedPreviewUrl);
  };

  const goToPreviousPage = () => {
    if (isInteractivePdf && pdfPageCount > 1) {
      setSelectionMode(false);
      setCropRect(null);
      setPdfPageNumber((page) => Math.max(1, page - 1));
      return;
    }
    setCurrentIndex((index) => Math.max(0, index - 1));
  };

  const goToNextPage = () => {
    if (isInteractivePdf && pdfPageCount > 1) {
      setSelectionMode(false);
      setCropRect(null);
      setPdfPageNumber((page) => Math.min(pdfPageCount, page + 1));
      return;
    }
    setCurrentIndex((index) => Math.min(pageCount - 1, index + 1));
  };

  const changeZoom = (delta: number) => {
    setZoom((value) => clampZoom(value + delta));
    setCropRect(null);
  };

  const resetImageView = () => {
    setZoom(1);
    setRotation(0);
    setPan({ x: 0, y: 0 });
    setSelectionMode(false);
    setCropRect(null);
  };

  const rotateImage = (degrees: number) => {
    setRotation((value) => normalizeDegrees(value + degrees));
    setPan({ x: 0, y: 0 });
    setSelectionMode(false);
    setCropRect(null);
  };

  const handlePreviewWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!(kind === "image" || isInteractivePdf) || !blobUrl) return;
    event.preventDefault();
    event.stopPropagation();
    if (isSelecting || Math.abs(event.deltaY) < 4) return;
    changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (mode !== "window" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;

    const panel = viewerRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);

    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (moveEvent: globalThis.PointerEvent) => {
      const nextLeft = Math.min(Math.max(8, moveEvent.clientX - offsetX), maxLeft);
      const nextTop = Math.min(Math.max(8, moveEvent.clientY - offsetY), maxTop);
      setPosition({ left: nextLeft, top: nextTop });
    };

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (mode !== "window" || event.button !== 0) return;

    const panel = viewerRef.current;
    if (!panel) return;

    event.preventDefault();
    event.stopPropagation();

    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;
    const left = rect.left;
    const top = rect.top;

    setPosition({ left, top });
    event.currentTarget.setPointerCapture(event.pointerId);

    const resize = (moveEvent: globalThis.PointerEvent) => {
      const maxWidth = Math.max(MIN_VIEWER_WIDTH, window.innerWidth - left - 8);
      const maxHeight = Math.max(MIN_VIEWER_HEIGHT, window.innerHeight - top - 8);
      setViewerSize({
        width: Math.min(maxWidth, Math.max(MIN_VIEWER_WIDTH, startWidth + moveEvent.clientX - startX)),
        height: Math.min(maxHeight, Math.max(MIN_VIEWER_HEIGHT, startHeight + moveEvent.clientY - startY)),
      });
    };

    const stop = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const imagePoint = (event: PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = zoom || 1;
    return {
      x: Math.min(Math.max(0, (event.clientX - rect.left) / scale), rect.width / scale),
      y: Math.min(Math.max(0, (event.clientY - rect.top) / scale), rect.height / scale),
    };
  };

  const beginImagePan = (event: PointerEvent<HTMLDivElement>) => {
    if (!(kind === "image" || isInteractivePdf) || event.button !== 0) return;
    event.preventDefault();
    panStartRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateImagePan = (event: PointerEvent<HTMLDivElement>) => {
    if (!isPanning || !panStartRef.current) return;
    const start = panStartRef.current;
    setPan({
      x: start.panX + event.clientX - start.clientX,
      y: start.panY + event.clientY - start.clientY,
    });
  };

  const finishImagePan = (event: PointerEvent<HTMLDivElement>) => {
    if (!isPanning) return;
    setIsPanning(false);
    panStartRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
  };

  const beginCropSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (!selectionMode || !(kind === "image" || isInteractivePdf) || event.button !== 0) return;
    event.preventDefault();
    const start = imagePoint(event);
    cropStartRef.current = start;
    setIsSelecting(true);
    setCropRect({ x: start.x, y: start.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateCropSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSelecting || !cropStartRef.current) return;
    const end = imagePoint(event);
    const start = cropStartRef.current;
    setCropRect({
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    });
  };

  const finishCropSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (!isSelecting) return;
    setIsSelecting(false);
    cropStartRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
    setCropRect((rect) => (rect && rect.width >= 12 && rect.height >= 12 ? rect : null));
  };

  const beginImageInteraction = (event: PointerEvent<HTMLDivElement>) => {
    if (selectionMode) {
      beginCropSelection(event);
    } else {
      beginImagePan(event);
    }
  };

  const updateImageInteraction = (event: PointerEvent<HTMLDivElement>) => {
    if (selectionMode) {
      updateCropSelection(event);
    } else {
      updateImagePan(event);
    }
  };

  const finishImageInteraction = (event: PointerEvent<HTMLDivElement>) => {
    if (selectionMode) {
      finishCropSelection(event);
    } else {
      finishImagePan(event);
    }
  };

  const enterFullscreen = async () => {
    setFullscreenError("");
    setMode("fullscreen");
    const panel = viewerRef.current;
    if (!panel?.requestFullscreen) {
      setFullscreenError("Браузер відкрив перегляд на всю вкладку без системного повноекранного режиму.");
      return;
    }

    try {
      await panel.requestFullscreen();
    } catch {
      setFullscreenError("Браузер не дозволив системний повноекранний режим. Перегляд відкрито на всю вкладку.");
    }
  };

  const leaveFullscreen = async () => {
    setFullscreenError("");
    if (document.fullscreenElement === viewerRef.current && document.exitFullscreen) {
      await document.exitFullscreen().catch(() => undefined);
    }
    setMode("window");
  };

  const viewerStyle: CSSProperties | undefined =
    mode === "window"
      ? {
          ...(position ? { left: position.left, top: position.top, right: "auto", bottom: "auto" } : {}),
          ...(viewerSize ? { width: viewerSize.width, height: viewerSize.height } : {}),
        }
      : undefined;
  const imageTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`;
  const canSelectFragment =
    (kind === "image" || isInteractivePdf) &&
    Boolean(blobUrl) &&
    !loading &&
    !error &&
    !pdfRendering &&
    rotation === 0;
  const hasValidCrop = Boolean(cropRect && cropRect.width >= 12 && cropRect.height >= 12);

  const viewerContent = (
    <>
      {mode === "minimized" ? (
        <aside className="workspace-viewer-minimized" aria-label="Згорнутий перегляд документа">
        <div>
          <span>Відкритий скан</span>
          <strong>{title}</strong>
        </div>
        <button type="button" className="button button-secondary" onClick={() => setMode("window")}>
          Розгорнути
        </button>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Закрити перегляд">
          ×
        </button>
        </aside>
      ) : null}

    <aside
      ref={viewerRef}
      className={`workspace-viewer ${mode === "fullscreen" ? "workspace-viewer-fullscreen" : ""} ${
        mode === "minimized" ? "workspace-viewer-hidden" : ""
      }`}
      style={viewerStyle}
      aria-label="Перегляд документа"
      aria-hidden={mode === "minimized" ? true : undefined}
    >
      <div className="workspace-viewer-header" onPointerDown={startDrag}>
        <div>
          <span className="eyebrow">Перегляд документа</span>
          <h2>{title}</h2>
          <small>{pageLabel}</small>
        </div>
        <div className="workspace-viewer-header-actions">
          {(kind === "image" || isInteractivePdf) && blobUrl ? (
            <div className="workspace-viewer-toolstrip" onPointerDown={(event) => event.stopPropagation()}>
              <button
                type="button"
                className="icon-button"
                onClick={() => changeZoom(-ZOOM_STEP)}
                aria-label="Зменшити зображення"
                title="Зменшити"
              >
                -
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => changeZoom(ZOOM_STEP)}
                aria-label="Збільшити зображення"
                title="Збільшити"
              >
                +
              </button>
              {kind === "image" ? (
                <>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => rotateImage(-90)}
                    aria-label="Повернути ліворуч"
                    title="Повернути ліворуч"
                  >
                    ↺
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => rotateImage(90)}
                    aria-label="Повернути праворуч"
                    title="Повернути праворуч"
                  >
                    ↻
                  </button>
                </>
              ) : null}
              <button type="button" className="button button-secondary" onClick={resetImageView}>
                100%
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void (mode === "fullscreen" ? leaveFullscreen() : enterFullscreen())}
          >
            {mode === "fullscreen" ? "Згорнути" : "На весь екран"}
          </button>
          <button type="button" className="button button-secondary" onClick={() => setMode("minimized")}>
            Сховати
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Закрити перегляд">
            ×
          </button>
        </div>
      </div>

      <div className="workspace-viewer-body" onWheelCapture={handlePreviewWheel}>
        {fullscreenError ? (
          <div className="workspace-viewer-notice">{fullscreenError}</div>
        ) : null}
        {loading && !blobUrl ? (
          <div className="workspace-viewer-state">Завантажуємо джерело…</div>
        ) : error ? (
          <div className="workspace-viewer-state error">
            <strong>{error}</strong>
            <div className="workspace-viewer-state-actions">
              {activeScan.storage === "google-drive" ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => void run(reconnectDriveAndRetry)}
                >
                  Підключити Google Drive
                </button>
              ) : null}
              <button type="button" className="button button-secondary" onClick={() => void run(() => openScan(activeScan))}>
                Відкрити джерело
              </button>
            </div>
          </div>
        ) : kind === "image" && blobUrl ? (
          <div
            className={`workspace-image-selection-stage ${selectionMode ? "selecting" : ""} ${
              isPanning ? "panning" : ""
            }`}
            style={{ transform: imageTransform }}
            onPointerDown={beginImageInteraction}
            onPointerMove={updateImageInteraction}
            onPointerUp={finishImageInteraction}
            onPointerCancel={finishImageInteraction}
          >
            <img
              ref={imageRef}
              src={blobUrl}
              alt={activeScan.name}
              draggable={false}
              onError={fallbackToHostedPreview}
            />
            {cropRect ? (
              <span
                className="workspace-selection-rect"
                style={{
                  left: cropRect.x,
                  top: cropRect.y,
                  width: cropRect.width,
                  height: cropRect.height,
                }}
              />
            ) : null}
            {selectionMode ? (
              <span className="workspace-selection-hint">
                Протягніть рамку по фрагменту скану
              </span>
            ) : null}
          </div>
        ) : kind === "pdf" && blobUrl && pdfNativeFallback ? (
          <iframe title={activeScan.name} src={blobUrl} />
        ) : kind === "pdf" && blobUrl ? (
          <div
            className={`workspace-image-selection-stage workspace-pdf-selection-stage ${selectionMode ? "selecting" : ""} ${
              isPanning ? "panning" : ""
            }`}
            style={{ transform: imageTransform }}
            onPointerDown={beginImageInteraction}
            onPointerMove={updateImageInteraction}
            onPointerUp={finishImageInteraction}
            onPointerCancel={finishImageInteraction}
          >
            <canvas ref={pdfCanvasRef} aria-label={activeScan.name} />
            {cropRect ? (
              <span
                className="workspace-selection-rect"
                style={{
                  left: cropRect.x,
                  top: cropRect.y,
                  width: cropRect.width,
                  height: cropRect.height,
                }}
              />
            ) : null}
            {selectionMode ? (
              <span className="workspace-selection-hint">
                Протягніть рамку по фрагменту PDF-сторінки
              </span>
            ) : null}
          </div>
        ) : kind === "web" && blobUrl ? (
          <iframe title={activeScan.name} src={blobUrl} />
        ) : null}
        {(loading || pdfRendering) && blobUrl ? (
          <div className="workspace-page-loading">Завантажуємо сторінку…</div>
        ) : null}
      </div>

      <div className="workspace-viewer-actions">
        <div>
          {sourceDocument ? (
            <span>Документ: {sourceDocument.title}</span>
          ) : (
            <span>Прикріплений файл</span>
          )}
        </div>
        {sourceDocument ? (
          <>
            {navigationPageCount > 1 ? (
              <div className="workspace-page-controls" aria-label="Перемикання сторінок документа">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={navigationPageNumber <= 1}
                  onClick={goToPreviousPage}
                >
                  ←
                </button>
                <span>{navigationPageNumber} / {navigationPageCount}</span>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={navigationPageNumber >= navigationPageCount}
                  onClick={goToNextPage}
                >
                  →
                </button>
              </div>
            ) : null}
            {canSelectFragment ? (
              <>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setSelectionMode((value) => !value);
                    setCropRect(null);
                  }}
                >
                  {selectionMode ? "Скасувати фрагмент" : "Виділити фрагмент"}
                </button>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!hasValidCrop || creatingCrop}
                  onClick={() => void createFindingFromCrop()}
                >
                  {creatingCrop ? "Створення…" : "Знахідка з фрагмента"}
                </button>
              </>
            ) : null}
            <button type="button" className="button button-secondary" onClick={() => void openSourceDocument()}>
              Повернутись до документа
            </button>
            <button type="button" className="button button-primary" onClick={() => void createFinding()}>
              Створити знахідку
            </button>
          </>
        ) : null}
        <button type="button" className="button button-secondary" onClick={() => void run(() => downloadScan(activeScan))}>
          Завантажити
        </button>
      </div>
      {mode === "window" ? (
        <button
          type="button"
          className="workspace-resize-handle"
          onPointerDown={startResize}
          aria-label="Змінити розмір вікна перегляду"
          title="Змінити розмір"
        />
      ) : null}
    </aside>
    </>
  );

  return typeof document === "undefined"
    ? viewerContent
    : createPortal(viewerContent, document.body);
}

function previewKind(scan: ScanAttachment, blob: Blob): PreviewKind | null {
  const mimeType = (blob.type || scan.mimeType || "").toLocaleLowerCase();
  const extension = scan.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (mimeType === "application/pdf" || extension === "pdf") return "pdf";
  if (mimeType === "text/html" || ["html", "htm"].includes(extension)) {
    return "web";
  }
  if (
    mimeType.startsWith("image/") ||
    ["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg"].includes(extension)
  ) {
    return "image";
  }
  return null;
}

function normalizePreviewBlob(scan: ScanAttachment, blob: Blob): Blob {
  const currentType = blob.type.toLocaleLowerCase();
  const extension = scan.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  const expectedType = previewMimeTypeFromExtension(extension);
  if (
    expectedType &&
    (!currentType || currentType === "application/octet-stream" || currentType === "binary/octet-stream")
  ) {
    return new Blob([blob], { type: expectedType });
  }
  return blob;
}

function previewMimeTypeFromExtension(extension: string): string {
  switch (extension) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "html":
    case "htm":
      return "text/html";
    default:
      return "";
  }
}

function hostedFilePreviewUrl(scan: ScanAttachment): string {
  if (scan.storage === "google-drive" && scan.storagePath) {
    return `https://drive.google.com/file/d/${encodeURIComponent(scan.storagePath)}/preview`;
  }
  const target = scan.webViewLink || scan.storagePath;
  if (!target) return "";
  try {
    const url = new URL(target);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.href;
  } catch {
    return "";
  }
}

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfJs, worker]) => {
      pdfJs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfJs;
    });
  }
  return pdfJsModulePromise;
}

function documentFragmentSelectionFromCrop(
  documentId: string,
  scan: ScanAttachment,
  pageNumber: number,
  rotation: number,
  rect: CropRect,
  sourceElement: HTMLElement | null,
  zoom: number,
): DocumentFragmentSelection | undefined {
  if (!sourceElement) return undefined;
  const rendered = sourceElement.getBoundingClientRect();
  const renderedWidth = rendered.width / Math.max(zoom, MIN_ZOOM);
  const renderedHeight = rendered.height / Math.max(zoom, MIN_ZOOM);
  if (!renderedWidth || !renderedHeight) return undefined;

  return {
    documentId,
    sourceFileId: scan.storagePath || scan.id,
    pageNumber,
    rotation,
    rect: {
      x: clampUnit(rect.x / renderedWidth),
      y: clampUnit(rect.y / renderedHeight),
      width: clampUnit(rect.width / renderedWidth),
      height: clampUnit(rect.height / renderedHeight),
    },
    createdAt: new Date().toISOString(),
  };
}

async function cropImageToFile(
  image: HTMLImageElement,
  rect: CropRect,
  sourceName: string,
  zoom: number,
): Promise<File> {
  await image.decode().catch(() => undefined);
  const rendered = image.getBoundingClientRect();
  if (!image.naturalWidth || !image.naturalHeight || !rendered.width || !rendered.height) {
    throw new Error("Не вдалося визначити розмір зображення для вирізання фрагмента.");
  }

  const renderedWidth = rendered.width / Math.max(zoom, MIN_ZOOM);
  const renderedHeight = rendered.height / Math.max(zoom, MIN_ZOOM);
  const scaleX = image.naturalWidth / renderedWidth;
  const scaleY = image.naturalHeight / renderedHeight;
  const sourceX = Math.max(0, Math.round(rect.x * scaleX));
  const sourceY = Math.max(0, Math.round(rect.y * scaleY));
  const sourceWidth = Math.min(
    image.naturalWidth - sourceX,
    Math.max(1, Math.round(rect.width * scaleX)),
  );
  const sourceHeight = Math.min(
    image.naturalHeight - sourceY,
    Math.max(1, Math.round(rect.height * scaleY)),
  );

  if (sourceWidth < 8 || sourceHeight < 8) {
    throw new Error("Виділений фрагмент занадто малий.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Браузер не зміг підготувати фрагмент зображення.");

  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  const blob = await canvasToBlob(canvas, "image/png");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return new File([blob], `${safeFilePart(sourceName.replace(/\.[^.]+$/, "")) || "fragment"}-${stamp}.png`, {
    type: "image/png",
  });
}

async function cropCanvasToFile(
  sourceCanvas: HTMLCanvasElement,
  rect: CropRect,
  sourceName: string,
  zoom: number,
): Promise<File> {
  const rendered = sourceCanvas.getBoundingClientRect();
  if (!sourceCanvas.width || !sourceCanvas.height || !rendered.width || !rendered.height) {
    throw new Error("Не вдалося визначити розмір PDF-сторінки для вирізання фрагмента.");
  }

  const renderedWidth = rendered.width / Math.max(zoom, MIN_ZOOM);
  const renderedHeight = rendered.height / Math.max(zoom, MIN_ZOOM);
  const scaleX = sourceCanvas.width / renderedWidth;
  const scaleY = sourceCanvas.height / renderedHeight;
  const sourceX = Math.max(0, Math.round(rect.x * scaleX));
  const sourceY = Math.max(0, Math.round(rect.y * scaleY));
  const sourceWidth = Math.min(
    sourceCanvas.width - sourceX,
    Math.max(1, Math.round(rect.width * scaleX)),
  );
  const sourceHeight = Math.min(
    sourceCanvas.height - sourceY,
    Math.max(1, Math.round(rect.height * scaleY)),
  );

  if (sourceWidth < 8 || sourceHeight < 8) {
    throw new Error("Виділений фрагмент занадто малий.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Браузер не зміг підготувати фрагмент PDF.");

  context.drawImage(
    sourceCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  const blob = await canvasToBlob(canvas, "image/png");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return new File([blob], `${safeFilePart(sourceName.replace(/\.[^.]+$/, "")) || "pdf-fragment"}-${stamp}.png`, {
    type: "image/png",
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Не вдалося створити файл фрагмента."));
      }
    }, type);
  });
}

function isCanvasEffectivelyBlank(canvas: HTMLCanvasElement): boolean {
  if (!canvas.width || !canvas.height) return true;

  const sampleSize = 64;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = sampleSize;
  sampleCanvas.height = sampleSize;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  if (!sampleContext) return false;

  try {
    sampleContext.drawImage(canvas, 0, 0, sampleSize, sampleSize);
    const pixels = sampleContext.getImageData(0, 0, sampleSize, sampleSize).data;
    let visiblePixels = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 255;
      const green = pixels[index + 1] ?? 255;
      const blue = pixels[index + 2] ?? 255;
      const alpha = pixels[index + 3] ?? 0;
      if (alpha > 8 && (red < 245 || green < 245 || blue < 245)) {
        visiblePixels += 1;
        if (visiblePixels > 4) return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 1_000_000) / 1_000_000));
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function safeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}
