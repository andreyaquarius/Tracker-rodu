import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import type { DocumentFragmentSelection, ScanAttachment } from "../types";
import type { StoredDocumentSource } from "../services/document-sources/contracts.ts";
import {
  downloadScan,
  getExternalScanPreviewStrategy,
  getScanBlob,
  getScanPreviewSource,
  normalizeScanPreviewBlob,
  openScan,
  saveScan,
} from "../services/scanStorage";
import {
  authorizeGoogleDrive,
  pickGoogleDriveFolder,
  reconnectGoogleDrive,
  uploadFileToGoogleDrive,
  type GoogleDrivePickerFolder,
} from "../services/googleDriveStorage";
import {
  createDocumentSourceViewerSession,
  exportDocumentSourcePdfPages,
} from "../services/documentSourceViewerAccess.ts";
import {
  trackProductAnalyticsAction,
  trackProductAnalyticsOperation,
} from "../services/productAnalytics.ts";
import { confirmDocumentSourceVersion } from "../services/documentSourceRevalidation.ts";
import {
  resolveMediaWikiPdfPagePreview,
  type MediaWikiPdfPagePreview,
} from "../services/mediaWikiPdfSource.ts";
import type {
  CreateFindingDocumentReferenceInput,
  NormalizedPageSelectionInput,
} from "../services/findingDocumentReferences.ts";
import {
  choosePdfSubsetExportStrategy,
  createPageImagesZip,
  createPdfSubsetBlob,
  createRasterizedPdfSubsetBlob,
  downloadGeneratedFile,
  firstKnownPositiveSize,
  parsePageRange,
  pdfClientExportLimits,
  pdfExportDeduplicationKey,
  pdfExportFileName,
  renderPdfPageImage,
  validateKnownClientExportSize,
  type PdfExportFormat,
  type PdfSubsetExportStrategy,
} from "../services/pdfPageExport.ts";
import {
  BoundedResourceCache,
  BoundedThumbnailRenderQueue,
  createVirtualizedThumbnailPlan,
  LatestPdfRenderController,
} from "../services/pdfViewerVirtualization.ts";
import {
  boundPdfViewportScale,
  PdfCanvasBudgetError,
} from "../services/pdfCanvasBudget.ts";
import {
  CROP_RESIZE_HANDLES,
  createCropRect,
  moveCropRect,
  normalizeQuarterRotation,
  resizeCropRect,
  screenPointToPagePoint,
  viewportRectToNormalizedCrop,
  type CropPoint,
  type CropRect,
  type CropResizeHandle,
  type CropSize,
} from "../services/pdfViewerCropGeometry.ts";
import { renderPdfFragmentSnapshot } from "../services/pdfFragmentSnapshot.ts";
import {
  findingDocumentSelectionViewportRect,
  type FindingDocumentRestoreState,
  type FindingDocumentSourceVersionStatus,
} from "../services/findingDocumentReopen.ts";
import {
  createPdfOperationalRequestId,
  emitPdfOperationalEvent,
  pdfFileSizeBucket,
  safePdfOperationalErrorCode,
} from "../services/pdfOperationalTelemetry.ts";
import {
  DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
  DOCUMENT_IMAGE_PRESETS,
  documentImageCssFilter,
  documentSharpenKernel,
  normalizeDocumentImageAdjustments,
  normalizeSignedRotation,
  rotatedDocumentBounds,
  splitPdfRotation,
  type DocumentImageAdjustments,
  type DocumentImagePresetId,
} from "../services/documentImageTools.ts";

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
  /** Persisted physical PDF page/crop restored when a finding is reopened. */
  restore?: FindingDocumentRestoreState;
  sourceVersionStatus?: FindingDocumentSourceVersionStatus;
  openedAt: number;
};

type PreviewKind = "image" | "pdf" | "web";
type ViewerMode = "window" | "minimized" | "fullscreen";
type ViewerPosition = { left: number; top: number };
type ViewerSize = { width: number; height: number };
type ImagePan = { x: number; y: number };
type DocumentFitMode = "page" | "width";
type RotationInteraction = {
  pointerId: number;
  centerX: number;
  centerY: number;
  startPointerAngle: number;
  startRotation: number;
  latestRotation: number;
};
type CropInteraction =
  | { mode: "create"; anchor: CropPoint }
  | { mode: "move"; anchor: CropPoint; initial: CropRect }
  | { mode: "resize"; anchor: CropPoint; initial: CropRect; handle: CropResizeHandle };
type ExternalSourceReason = "web-page" | "authenticated-source" | "embedded-blocked";
type CachedPreview = {
  kind: PreviewKind;
  url: string;
  revokeOnClose: boolean;
  blob?: Blob;
  /** Ephemeral gateway auth only. Never persisted in attachment metadata. */
  httpHeaders?: Readonly<Record<string, string>>;
  /** Stable source metadata only; never includes an access URL or OAuth token. */
  documentSource?: StoredDocumentSource;
  /** Ephemeral access metadata used only to renew an expiring gateway session. */
  accessMode?: "direct_cors" | "secure_proxy" | "google_drive_api";
  expiresAt?: string | null;
  sourceVersionStatus?: FindingDocumentSourceVersionStatus;
  canConfirmSourceVersion?: boolean;
};
type PdfDocumentCache = {
  document: PDFDocumentProxy;
  loadingTask: PDFDocumentLoadingTask;
  pageLabels: Promise<readonly string[] | null>;
};

export type ExternalPdfViewerV2Context = {
  enabled: boolean;
  projectId: string;
  projectName: string;
  userId: string;
  documentId: string;
  canEdit: boolean;
};

async function resolveStreamablePdfPreview(
  scan: ScanAttachment,
  sourceContext?: ExternalPdfViewerV2Context,
  signal?: AbortSignal,
): Promise<CachedPreview | null> {
  if (!sourceContext?.enabled) return null;

  const session = await createDocumentSourceViewerSession({
    projectId: sourceContext.projectId,
    documentId: sourceContext.documentId,
    userId: sourceContext.userId,
    attachment: scan,
    canEdit: sourceContext.canEdit,
    ...(signal ? { signal } : {}),
  });
  if (session) {
    const descriptor = session.access;
    return {
      kind: "pdf",
      url: descriptor.url,
      revokeOnClose: false,
      documentSource: session.source,
      accessMode: descriptor.accessMode,
      expiresAt: descriptor.expiresAt,
      sourceVersionStatus: session.sourceVersionStatus,
      canConfirmSourceVersion: session.canConfirmSourceVersion,
      ...("httpHeaders" in descriptor && descriptor.httpHeaders
        ? { httpHeaders: descriptor.httpHeaders }
        : {}),
    };
  }

  if (scan.storage !== "external-url") return null;

  const strategy = getExternalScanPreviewStrategy(scan);
  // Keep the established bounded Blob path for ordinary external files.
  // MediaWiki file pages are the special case: archival PDFs can be hundreds
  // of megabytes, while Wikimedia explicitly supports CORS byte ranges.
  if (strategy.mode !== "mediawiki-file") return null;

  const source = await getScanPreviewSource(scan);
  if (source.kind !== "pdf") return null;
  return {
    kind: "pdf",
    url: source.url,
    revokeOnClose: source.revokeOnClose,
  };
}
type PdfJsModule = typeof import("pdfjs-dist");

const MIN_VIEWER_WIDTH = 420;
const MIN_VIEWER_HEIGHT = 360;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.01;
// Render the first visible page at the browser's effective pixel density.
// A fixed 2x minimum made large archival scans decode and paint four times as
// many pixels before the user could see anything. Zooming still raises the
// render scale on demand, while HiDPI screens continue to use their capped DPR.
const PDF_RENDER_SCALE = 1;
const PDF_THUMBNAIL_WIDTH = 104;
const PDF_THUMBNAIL_WINDOW_RADIUS = 3;
const PDF_VIEWER_RANGE_CHUNK_SIZE = positiveViewerSetting(
  import.meta.env.VITE_PDF_VIEWER_RANGE_CHUNK_SIZE,
  1024 * 1024,
);
const PDF_VIEWER_MAX_DEVICE_PIXEL_RATIO = Math.max(1, positiveViewerSetting(
  import.meta.env.VITE_PDF_VIEWER_MAX_DEVICE_PIXEL_RATIO,
  2,
));
const PDF_VIEWER_MAX_RENDER_SCALE = Math.max(PDF_RENDER_SCALE, positiveViewerSetting(
  import.meta.env.VITE_PDF_VIEWER_MAX_RENDER_SCALE,
  4,
));
const PDF_VIEWER_MAX_CONCURRENT_RENDERS = Math.max(1, Math.floor(positiveViewerSetting(
  import.meta.env.VITE_PDF_VIEWER_MAX_CONCURRENT_RENDERS,
  1,
)));
const PDF_VIEWER_MAX_CANVAS_PIXELS = Math.max(1, Math.floor(positiveViewerSetting(
  import.meta.env.VITE_PDF_VIEWER_MAX_CANVAS_PIXELS,
  16_777_216,
)));
const PDF_VIEWER_MAX_CANVAS_SIDE = Math.max(1, Math.floor(positiveViewerSetting(
  import.meta.env.VITE_PDF_VIEWER_MAX_CANVAS_SIDE,
  8_192,
)));
const PDFJS_WASM_URL = `${import.meta.env.BASE_URL}pdfjs-wasm/`;
// Documents opened here can come from arbitrary external archives. Keep both
// PDF.js execution paths locked down even when the upstream defaults change.
const PDFJS_SECURITY_OPTIONS = Object.freeze({
  enableScripting: false,
  isEvalSupported: false,
});
const PDF_CANVAS_RESOURCE_LIMIT_MESSAGE =
  "Не вдалося безпечно відобразити PDF-сторінку: її розміри перевищують ресурсний ліміт переглядача.";

const MANUSCRIPT_PRESET_BUTTONS: ReadonlyArray<{
  id: DocumentImagePresetId;
  label: string;
  title: string;
}> = [
  { id: "original", label: "Оригінал", title: "Прибрати всі візуальні фільтри" },
  { id: "grayscale", label: "Ч/б", title: "Перевести сторінку у відтінки сірого" },
  { id: "faded-text", label: "Слабкий текст", title: "Підсилити вицвіле чорнило" },
  { id: "high-contrast", label: "Чіткий текст", title: "Максимально відокремити текст від фону" },
  { id: "negative", label: "Негатив", title: "Інвертувати світлі й темні ділянки" },
  { id: "sepia", label: "Сепія", title: "Пом’якшити надто холодний або синюватий скан" },
];

const MANUSCRIPT_ADJUSTMENT_CONTROLS: ReadonlyArray<{
  key: Exclude<keyof DocumentImageAdjustments, "invert">;
  label: string;
  minimum: number;
  maximum: number;
}> = [
  { key: "brightness", label: "Яскравість", minimum: 40, maximum: 200 },
  { key: "contrast", label: "Контраст", minimum: 40, maximum: 300 },
  { key: "grayscale", label: "Чорно-біле", minimum: 0, maximum: 100 },
  { key: "sepia", label: "Сепія", minimum: 0, maximum: 100 },
  { key: "saturation", label: "Насиченість", minimum: 0, maximum: 200 },
  { key: "sharpness", label: "Чіткість", minimum: 0, maximum: 100 },
];

type PdfExportDestination = "download" | "google-drive";
type PdfExportImageScale = 1 | 1.5 | 2;
type PdfExportJpegQuality = 70 | 85 | 95;
type CropSnapshotDestination = "google-drive" | "download" | "none";
type FindingCaptureMode = "fragment" | "full-page";
export type FindingDocumentReferenceDraft = Omit<CreateFindingDocumentReferenceInput, "findingId">;

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

interface DocumentWorkspaceViewerProps {
  viewer: ActiveDocumentScanViewer | null;
  externalPdfViewerV2?: Omit<ExternalPdfViewerV2Context, "documentId">;
  onClose: () => void;
  onOpenDocument: (documentId: string) => void;
  onCreateFinding: (initialValues: Record<string, unknown>) => void;
}

export function DocumentWorkspaceViewer({
  viewer,
  externalPdfViewerV2,
  onClose,
  onOpenDocument,
  onCreateFinding,
}: DocumentWorkspaceViewerProps) {
  const componentId = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
  const imageToolsPanelId = `workspace-image-tools-${componentId}`;
  const sharpenFilterId = `workspace-document-sharpen-${componentId}`;
  const viewerRef = useRef<HTMLElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const pdfPageViewportRef = useRef<HTMLDivElement | null>(null);
  const selectionStageRef = useRef<HTMLDivElement | null>(null);
  const cropInteractionRef = useRef<CropInteraction | null>(null);
  const panStartRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const rotationInteractionRef = useRef<RotationInteraction | null>(null);
  const rotationValueRef = useRef(0);
  const fitModeRef = useRef<DocumentFitMode | null>("page");
  const fitPendingRef = useRef(true);
  const fitFrameRef = useRef<number | null>(null);
  const fittedPdfKeyRef = useRef("");
  const presentedPdfPageKeyRef = useRef("");
  const previewCacheRef = useRef(new Map<string, CachedPreview>());
  const previewPromisesRef = useRef(new Map<string, Promise<CachedPreview>>());
  const pdfCacheRef = useRef(new Map<string, PdfDocumentCache>());
  const pdfPromisesRef = useRef(new Map<string, Promise<PdfDocumentCache>>());
  const pdfLoadControllersRef = useRef(new Map<string, AbortController>());
  const pdfLoadingTasksRef = useRef(new Map<string, PDFDocumentLoadingTask>());
  const mainPdfRenderRef = useRef<LatestPdfRenderController | null>(null);
  const restoredFindingSelectionRef = useRef("");
  const cropOperationAbortRef = useRef<AbortController | null>(null);
  const exportOperationAbortRef = useRef<AbortController | null>(null);
  const pdfTelemetryRequestIdRef = useRef("");
  const pdfTelemetryStartedAtRef = useRef(0);
  const pdfTelemetryEventKeysRef = useRef(new Set<string>());
  const thumbnailQueueRef = useRef<BoundedThumbnailRenderQueue<string, string> | null>(null);
  const thumbnailCacheRef = useRef<BoundedResourceCache<string, string> | null>(null);
  const fastPagePreviewCacheRef = useRef(new Map<string, MediaWikiPdfPagePreview>());
  if (!mainPdfRenderRef.current) mainPdfRenderRef.current = new LatestPdfRenderController();
  if (!thumbnailCacheRef.current) {
    thumbnailCacheRef.current = new BoundedResourceCache<string, string>({
      capacity: 18,
      dispose: (url) => URL.revokeObjectURL(url),
    });
  }
  if (!thumbnailQueueRef.current) {
    thumbnailQueueRef.current = new BoundedThumbnailRenderQueue<string, string>({
      maxConcurrency: PDF_VIEWER_MAX_CONCURRENT_RENDERS,
      maxPending: 18,
      disposeResult: (url) => URL.revokeObjectURL(url),
    });
  }
  const [mode, setMode] = useState<ViewerMode>("window");
  const [position, setPosition] = useState<ViewerPosition | null>(null);
  const [viewerSize, setViewerSize] = useState<ViewerSize | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [blobUrl, setBlobUrl] = useState("");
  const [kind, setKind] = useState<PreviewKind | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [pdfPageLabel, setPdfPageLabel] = useState("");
  const [pdfRendering, setPdfRendering] = useState(false);
  const [pdfPageReady, setPdfPageReady] = useState(false);
  const [fastPagePreview, setFastPagePreview] = useState<MediaWikiPdfPagePreview | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [rotationInput, setRotationInput] = useState("0");
  const [imageToolsOpen, setImageToolsOpen] = useState(false);
  const [imageAdjustments, setImageAdjustments] = useState<DocumentImageAdjustments>(() => ({
    ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS,
  }));
  const [pdfRenderZoom, setPdfRenderZoom] = useState(1);
  const [pan, setPan] = useState<ImagePan>({ x: 0, y: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [externalSourceReason, setExternalSourceReason] = useState<ExternalSourceReason | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [creatingCrop, setCreatingCrop] = useState(false);
  const [cropDialogOpen, setCropDialogOpen] = useState(false);
  const [cropSnapshotDestination, setCropSnapshotDestination] = useState<CropSnapshotDestination>("google-drive");
  const [findingCaptureMode, setFindingCaptureMode] = useState<FindingCaptureMode>("fragment");
  const [fullscreenError, setFullscreenError] = useState("");
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [thumbnailUrls, setThumbnailUrls] = useState<Record<number, string>>({});
  const [markedExportPages, setMarkedExportPages] = useState<Set<number>>(() => new Set());
  const [pageNumberInput, setPageNumberInput] = useState("1");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportRange, setExportRange] = useState("1");
  const [exportFormat, setExportFormat] = useState<PdfExportFormat>("pdf");
  const [exportDestination, setExportDestination] = useState<PdfExportDestination>("download");
  const [exportDriveFolder, setExportDriveFolder] = useState<GoogleDrivePickerFolder | null>(null);
  const [exportImageScale, setExportImageScale] = useState<PdfExportImageScale>(2);
  const [exportJpegQuality, setExportJpegQuality] = useState<PdfExportJpegQuality>(85);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [exportResultUrl, setExportResultUrl] = useState("");
  const [sourceVersionMessage, setSourceVersionMessage] = useState("");
  const [confirmingSourceVersion, setConfirmingSourceVersion] = useState(false);

  rotationValueRef.current = rotation;

  const pages = viewer?.scans?.length ? viewer.scans : viewer ? [viewer.scan] : [];
  const currentScan = pages[currentIndex] ?? viewer?.scan ?? null;
  const currentPreview = currentScan
    ? previewCacheRef.current.get(currentScan.id)
    : undefined;
  const currentPdfExportLimits = pdfClientExportLimits();
  const currentPdfSubsetStrategy = choosePdfSubsetExportStrategy(
    firstKnownPositiveSize(currentPreview?.documentSource?.fileSizeBytes, currentScan?.size),
    1,
    currentPdfExportLimits,
  );
  const pdfExportUsesRasterizedPages = exportFormat === "pdf"
    && currentPdfSubsetStrategy === "rasterized";
  const effectiveSourceVersionStatus = viewer?.sourceVersionStatus === "changed"
    || currentPreview?.sourceVersionStatus === "changed"
    ? "changed"
    : viewer?.sourceVersionStatus ?? currentPreview?.sourceVersionStatus ?? "unknown";
  const pageCount = pages.length;
  const isInteractivePdf = kind === "pdf";
  const navigationPageCount = isInteractivePdf ? pdfPageCount : pageCount;
  const navigationPageNumber = isInteractivePdf ? pdfPageNumber : Math.min(currentIndex + 1, Math.max(1, pageCount));
  const sourceContext = viewer?.context && externalPdfViewerV2
    && externalPdfViewerV2.enabled
    ? {
        ...externalPdfViewerV2,
        documentId: viewer.context.document.id,
      }
    : undefined;
  const viewerV2Enabled = sourceContext?.enabled === true;
  const pdfRotationLayers = splitPdfRotation(viewerV2Enabled ? rotation : 0);
  const effectivePdfRotation = pdfRotationLayers.renderRotation;
  const finePdfRotation = pdfRotationLayers.cssRotation;

  if (!pdfTelemetryRequestIdRef.current) {
    pdfTelemetryRequestIdRef.current = createPdfOperationalRequestId();
    pdfTelemetryStartedAtRef.current = performance.now();
  }

  const emitViewerTelemetryOnce = (
    key: string,
    input: Omit<Parameters<typeof emitPdfOperationalEvent>[1], "requestId">,
  ): boolean => {
    if (pdfTelemetryEventKeysRef.current.has(key)) return false;
    pdfTelemetryEventKeysRef.current.add(key);
    if (sourceContext) {
      void emitPdfOperationalEvent(sourceContext.projectId, {
        ...input,
        requestId: pdfTelemetryRequestIdRef.current,
      });
    }
    return true;
  };

  const disposePreviewForScan = (scanId: string) => {
    const preview = previewCacheRef.current.get(scanId);
    if (preview?.revokeOnClose) URL.revokeObjectURL(preview.url);
    previewCacheRef.current.delete(scanId);
    previewPromisesRef.current.delete(scanId);
    const pdf = pdfCacheRef.current.get(scanId);
    if (pdf) void pdf.loadingTask.destroy().catch(() => undefined);
    pdfLoadControllersRef.current.get(scanId)?.abort();
    const loadingTask = pdfLoadingTasksRef.current.get(scanId);
    if (loadingTask && loadingTask !== pdf?.loadingTask) {
      void loadingTask.destroy().catch(() => undefined);
    }
    pdfCacheRef.current.delete(scanId);
    pdfPromisesRef.current.delete(scanId);
    pdfLoadControllersRef.current.delete(scanId);
    pdfLoadingTasksRef.current.delete(scanId);
  };

  const loadPreview = (scan: ScanAttachment, signal?: AbortSignal): Promise<CachedPreview> => {
    const cached = previewCacheRef.current.get(scan.id);
    if (cached && !cachedPreviewNeedsRefresh(cached)) return Promise.resolve(cached);
    if (cached) disposePreviewForScan(scan.id);
    const pending = previewPromisesRef.current.get(scan.id);
    if (pending) return pending;

    const promise = resolveStreamablePdfPreview(scan, sourceContext, signal)
      .then(async (streamingPreview) => {
        if (streamingPreview) {
          previewCacheRef.current.set(scan.id, streamingPreview);
          return streamingPreview;
        }

        const blob = await getScanBlob(scan);
        const previewBlob = normalizeScanPreviewBlob(scan, blob);
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

  const loadPdfDocument = (
    scan: ScanAttachment,
    signal?: AbortSignal,
  ): Promise<PdfDocumentCache> => {
    const cached = pdfCacheRef.current.get(scan.id);
    if (cached) return waitForViewerPromise(Promise.resolve(cached), signal);
    const pending = pdfPromisesRef.current.get(scan.id);
    if (pending) return waitForViewerPromise(pending, signal);

    const loadController = new AbortController();
    pdfLoadControllersRef.current.set(scan.id, loadController);

    const promise = Promise.resolve(
      previewCacheRef.current.get(scan.id) ?? loadPreview(scan, loadController.signal),
    )
      .then(async (preview) => {
        throwIfViewerOperationAborted(loadController.signal);
        const pdfJs = await loadPdfJs();
        throwIfViewerOperationAborted(loadController.signal);
        const loadingTask = preview.blob
          ? pdfJs.getDocument({
              ...PDFJS_SECURITY_OPTIONS,
              data: new Uint8Array(await waitForViewerPromise(
                preview.blob.arrayBuffer(),
                loadController.signal,
              )),
              // Large archival scans commonly use JPEG2000/JBIG2. Serve PDF.js'
              // local WASM decoders from the application origin so decoding stays
              // fast without a CDN dependency or relaxing the CSP.
              wasmUrl: PDFJS_WASM_URL,
              useWorkerFetch: true,
              useWasm: true,
              canvasMaxAreaInBytes: PDF_VIEWER_MAX_CANVAS_PIXELS * 4,
            })
          : pdfJs.getDocument({
              ...PDFJS_SECURITY_OPTIONS,
              url: preview.url,
              ...(preview.httpHeaders ? { httpHeaders: preview.httpHeaders } : {}),
              withCredentials: false,
              disableRange: false,
              // Do not stream or prefetch a 500+ MB archival file in the
              // background. PDF.js requests only the byte ranges required for
              // the current page and keeps the canvas/finding tools available.
              disableStream: true,
              disableAutoFetch: true,
              rangeChunkSize: PDF_VIEWER_RANGE_CHUNK_SIZE,
              wasmUrl: PDFJS_WASM_URL,
              useWorkerFetch: true,
              useWasm: true,
              canvasMaxAreaInBytes: PDF_VIEWER_MAX_CANVAS_PIXELS * 4,
            });
        pdfLoadingTasksRef.current.set(scan.id, loadingTask);
        const destroyOnAbort = () => {
          void loadingTask.destroy().catch(() => undefined);
        };
        loadController.signal.addEventListener("abort", destroyOnAbort, { once: true });
        try {
          const document = await loadingTask.promise;
          throwIfViewerOperationAborted(loadController.signal);
          const pageLabels = document.getPageLabels().catch(() => null);
          const cache = { document, loadingTask, pageLabels };
          pdfCacheRef.current.set(scan.id, cache);
          const viewerOpenedDuration = Math.max(
            0,
            Math.round(performance.now() - pdfTelemetryStartedAtRef.current),
          );
          const firstViewerOpen = emitViewerTelemetryOnce(`opened:${viewer?.openedAt ?? 0}:${scan.id}`, {
            event: "pdf_viewer_opened",
            provider: preview.documentSource?.provider ?? "unknown",
            ...(preview.accessMode ? { accessMode: preview.accessMode } : {}),
            statusCode: 200,
            durationMs: viewerOpenedDuration,
            pageCount: document.numPages,
            fileSizeBucket: pdfFileSizeBucket(
              preview.documentSource?.fileSizeBytes ?? scan.size,
            ),
          });
          if (firstViewerOpen) {
            trackProductAnalyticsAction("document_viewer_open");
          }
          return cache;
        } finally {
          loadController.signal.removeEventListener("abort", destroyOnAbort);
          if (pdfLoadingTasksRef.current.get(scan.id) === loadingTask) {
            pdfLoadingTasksRef.current.delete(scan.id);
          }
        }
      })
      .finally(() => {
        if (pdfPromisesRef.current.get(scan.id) === promise) {
          pdfPromisesRef.current.delete(scan.id);
        }
        if (pdfLoadControllersRef.current.get(scan.id) === loadController) {
          pdfLoadControllersRef.current.delete(scan.id);
        }
      });

    pdfPromisesRef.current.set(scan.id, promise);
    return waitForViewerPromise(promise, signal);
  };

  const preloadPage = (index: number) => {
    const scan = pages[index];
    if (!scan || previewCacheRef.current.has(scan.id)) return;
    void loadPreview(scan).catch(() => undefined);
  };

  useEffect(() => {
    return () => {
      cropOperationAbortRef.current?.abort();
      cropOperationAbortRef.current = null;
      exportOperationAbortRef.current?.abort();
      exportOperationAbortRef.current = null;
      for (const preview of previewCacheRef.current.values()) {
        if (preview.revokeOnClose) {
          URL.revokeObjectURL(preview.url);
        }
      }
      previewCacheRef.current.clear();
      previewPromisesRef.current.clear();
      for (const controller of pdfLoadControllersRef.current.values()) controller.abort();
      pdfLoadControllersRef.current.clear();
      for (const loadingTask of pdfLoadingTasksRef.current.values()) {
        void loadingTask.destroy().catch(() => undefined);
      }
      pdfLoadingTasksRef.current.clear();
      for (const pdf of pdfCacheRef.current.values()) void pdf.loadingTask.destroy().catch(() => undefined);
      pdfCacheRef.current.clear();
      pdfPromisesRef.current.clear();
    };
  }, [viewer?.openedAt]);

  useEffect(() => () => {
    mainPdfRenderRef.current?.dispose();
    thumbnailQueueRef.current?.dispose();
    thumbnailCacheRef.current?.clear();
    if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);
  }, []);

  useEffect(() => {
    pdfTelemetryRequestIdRef.current = createPdfOperationalRequestId();
    pdfTelemetryStartedAtRef.current = performance.now();
    pdfTelemetryEventKeysRef.current.clear();
    if (!viewer) return;
    mainPdfRenderRef.current?.cancel();
    thumbnailQueueRef.current?.cancelAll();
    thumbnailCacheRef.current?.clear();
    const requestedIndex = typeof viewer.pageIndex === "number"
      ? viewer.pageIndex
      : pages.findIndex((scan) => scan.id === viewer.scan.id);
    setCurrentIndex(Math.max(0, Math.min(pages.length - 1, requestedIndex >= 0 ? requestedIndex : 0)));
    setMode("window");
    setPosition(null);
    setViewerSize(null);
    setBlobUrl("");
    setKind(null);
    const restoredPage = Math.max(
      1,
      (viewerV2Enabled ? viewer.restore?.pageIndex : undefined) ?? viewer.scan.initialPage ?? 1,
    );
    setPdfPageNumber(restoredPage);
    setPdfPageCount(knownPdfPageCount(viewer?.scan));
    setPdfPageReady(false);
    setFastPagePreview(null);
    setPdfPageLabel("");
    setPdfRendering(false);
    setZoom(1);
    setFitScale(1);
    fitModeRef.current = "page";
    fitPendingRef.current = true;
    fittedPdfKeyRef.current = "";
    presentedPdfPageKeyRef.current = "";
    rotationInteractionRef.current = null;
    setIsRotating(false);
    const restoredRotation = viewerV2Enabled
      ? normalizeQuarterRotation(viewer.restore?.selection?.rotation ?? 0)
      : 0;
    setRotation(restoredRotation);
    setRotationInput(String(normalizeSignedRotation(restoredRotation)));
    setImageToolsOpen(false);
    setImageAdjustments({ ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS });
    setPdfRenderZoom(1);
    setPan({ x: 0, y: 0 });
    setError("");
    setExternalSourceReason(null);
    setThumbnailUrls({});
    setMarkedExportPages(new Set());
    setPageNumberInput(String(restoredPage));
    setExportOpen(false);
    setExportRange(String(restoredPage));
    setExportFormat("pdf");
    setExportDestination("download");
    setExportDriveFolder(null);
    setExportImageScale(2);
    setExportJpegQuality(85);
    setExportMessage("");
    setExportResultUrl("");
    setSourceVersionMessage("");
    setConfirmingSourceVersion(false);
    setCropDialogOpen(false);
    setCropSnapshotDestination("google-drive");
    setFindingCaptureMode("fragment");
    restoredFindingSelectionRef.current = "";
  }, [viewer?.openedAt, viewerV2Enabled]);

  useEffect(() => {
    if (!currentScan || !scanLooksLikePdf(currentScan)) return;
    // Source migration/revalidation and the PDF.js bundle are independent.
    // Start loading the viewer runtime while the source session is being
    // prepared instead of paying both costs sequentially on the first page.
    void loadPdfJs().catch(() => undefined);
  }, [currentScan?.id]);

  useEffect(() => {
    const pageKey = currentScan ? `${currentScan.id}:${pdfPageNumber}` : "";
    if (presentedPdfPageKeyRef.current !== pageKey) {
      presentedPdfPageKeyRef.current = pageKey;
      setPdfPageReady(false);
    }
    setFastPagePreview(null);
    if (
      !viewerV2Enabled
      || !currentScan
      || currentScan.sourceProvider !== "wikimedia"
      || !currentScan.providerFileTitle
    ) {
      return undefined;
    }

    const cacheKey = `${currentScan.providerFileTitle}:${pdfPageNumber}:1600`;
    const cached = fastPagePreviewCacheRef.current.get(cacheKey);
    if (cached) {
      setFastPagePreview(cached);
      return undefined;
    }

    let active = true;
    const abortController = new AbortController();
    void resolveMediaWikiPdfPagePreview({
      providerFileTitle: currentScan.providerFileTitle,
      pageNumber: pdfPageNumber,
      sourcePageUrl: currentScan.sourcePageUrl,
      width: 1_600,
      signal: abortController.signal,
    }).then(async (preview) => {
      if (!preview) return;
      await preloadRemoteImage(preview.url, abortController.signal);
      if (!active) return;
      const cache = fastPagePreviewCacheRef.current;
      if (cache.size >= 24) {
        const oldestKey = cache.keys().next().value;
        if (typeof oldestKey === "string") cache.delete(oldestKey);
      }
      cache.set(cacheKey, preview);
      setFastPagePreview(preview);
    }).catch(() => undefined);

    return () => {
      active = false;
      abortController.abort();
    };
  }, [
    viewerV2Enabled,
    currentScan?.id,
    currentScan?.sourceProvider,
    currentScan?.providerFileTitle,
    currentScan?.sourcePageUrl,
    pdfPageNumber,
  ]);

  useEffect(() => {
    let active = true;
    const abortController = new AbortController();

    setError("");
    setSelectionMode(false);
    setCropRect(null);
    const restoredPage = viewerV2Enabled && currentScan?.id === viewer?.scan.id
      ? viewer.restore?.pageIndex
      : undefined;
    setPdfPageNumber(Math.max(1, restoredPage ?? currentScan?.initialPage ?? 1));
    setPdfPageCount(knownPdfPageCount(currentScan));
    setPdfPageReady(false);
    setPdfPageLabel("");
    setPdfRendering(false);
    setExternalSourceReason(null);
    cropInteractionRef.current = null;
    panStartRef.current = null;

    if (!currentScan) return undefined;

    if (currentScan.storage === "external-url") {
      try {
        const strategy = getExternalScanPreviewStrategy(currentScan);
        if (strategy.mode === "source-page" && strategy.reason === "authenticated-source") {
          setKind("web");
          setBlobUrl("");
          setLoading(false);
          setExternalSourceReason(strategy.reason);
          return undefined;
        }
      } catch (strategyError) {
        setLoading(false);
        setError(
          strategyError instanceof Error
            ? strategyError.message
            : "Зовнішнє посилання має некоректний формат.",
        );
        return undefined;
      }
    }

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
    void loadPreview(currentScan, abortController.signal)
      .then((preview) => {
        if (!active) return;
        setKind(preview.kind);
        setBlobUrl(preview.url);
        preloadPage(currentIndex + 1);
        preloadPage(currentIndex - 1);
      })
      .catch((loadError) => {
        if (!active) return;
        if (currentScan.storage === "external-url") {
          setKind(null);
          setBlobUrl("");
          setExternalSourceReason(null);
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Не вдалося відкрити зовнішній документ у Переглядачі.",
          );
          return;
        }
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
      abortController.abort();
    };
  }, [currentScan?.id, currentIndex, previewReloadKey, viewerV2Enabled]);

  useEffect(() => {
    if (!currentScan || !blobUrl) return undefined;
    const preview = previewCacheRef.current.get(currentScan.id);
    if (!preview?.expiresAt) return undefined;
    const expiresAt = Date.parse(preview.expiresAt);
    if (!Number.isFinite(expiresAt)) return undefined;
    const refreshIn = Math.max(0, expiresAt - Date.now() - 30_000);
    const timeout = window.setTimeout(() => {
      mainPdfRenderRef.current?.cancel();
      thumbnailQueueRef.current?.cancelAll();
      disposePreviewForScan(currentScan.id);
      setBlobUrl("");
      setKind(null);
      setPreviewReloadKey((value) => value + 1);
    }, Math.min(refreshIn, 2_147_000_000));
    return () => window.clearTimeout(timeout);
  }, [currentScan?.id, blobUrl]);

  useEffect(() => {
    setPageNumberInput(String(navigationPageNumber));
  }, [navigationPageNumber]);

  useEffect(() => {
    if (!exportOpen) setExportRange(String(pdfPageNumber));
  }, [pdfPageNumber, exportOpen]);

  useEffect(() => {
    fitModeRef.current = "page";
    fitPendingRef.current = true;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [currentScan?.id, pdfPageNumber]);

  useEffect(() => {
    if (kind !== "pdf" || !viewerV2Enabled) {
      setPdfRenderZoom(1);
      return undefined;
    }
    const timeout = window.setTimeout(() => setPdfRenderZoom(zoom), 180);
    return () => window.clearTimeout(timeout);
  }, [kind, zoom, viewerV2Enabled]);

  useEffect(() => {
    // Returning to the provenance page/rotation must restore the canonical
    // overlay again. Zoom alone deliberately does not invalidate it because
    // the whole page stage scales as one unit.
    restoredFindingSelectionRef.current = "";
  }, [viewer?.openedAt, pdfPageNumber, rotation]);

  useEffect(() => {
    const canvas = pdfCanvasRef.current;
    const renderController = mainPdfRenderRef.current;

    if (!currentScan || kind !== "pdf" || !canvas || !renderController) {
      return undefined;
    }
    const lease = renderController.begin();

    setPdfRendering(true);
    setError("");

    void loadPdfDocument(currentScan)
      .then(async ({ document, pageLabels }) => {
        if (!lease.isCurrent()) return;
        const nextPageCount = document.numPages;
        const safePageNumber = Math.min(Math.max(1, pdfPageNumber), nextPageCount);
        if (safePageNumber !== pdfPageNumber) {
          setPdfPageNumber(safePageNumber);
          return;
        }
        setPdfPageCount(nextPageCount);
        void pageLabels.then((labels) => {
          if (lease.isCurrent()) setPdfPageLabel(labels?.[safePageNumber - 1] ?? String(safePageNumber));
        });

        const page = await document.getPage(safePageNumber);
        if (!lease.isCurrent()) return;

        const cappedDevicePixelRatio = Math.min(
          PDF_VIEWER_MAX_DEVICE_PIXEL_RATIO,
          Math.max(1, window.devicePixelRatio || 1),
        );
        const renderScale = viewerV2Enabled
          ? Math.min(
              PDF_VIEWER_MAX_RENDER_SCALE,
              Math.max(PDF_RENDER_SCALE, cappedDevicePixelRatio * Math.max(1, pdfRenderZoom)),
            )
          : PDF_RENDER_SCALE;
        const baseViewport = page.getViewport({ scale: 1, rotation: effectivePdfRotation });
        let canvasBudget: ReturnType<typeof boundPdfViewportScale>;
        try {
          canvasBudget = boundPdfViewportScale({
            baseWidth: baseViewport.width,
            baseHeight: baseViewport.height,
            requestedScale: renderScale,
            maxPixels: PDF_VIEWER_MAX_CANVAS_PIXELS,
            maxSide: PDF_VIEWER_MAX_CANVAS_SIDE,
          });
        } catch (budgetError) {
          page.cleanup();
          throw budgetError;
        }
        const viewport = page.getViewport({
          scale: canvasBudget.scale,
          rotation: effectivePdfRotation,
        });
        const context = canvas.getContext("2d");
        if (!context) {
          page.cleanup();
          throw new Error("Браузер не зміг підготувати PDF-сторінку.");
        }

        canvas.width = canvasBudget.pixelWidth;
        canvas.height = canvasBudget.pixelHeight;
        canvas.style.width = `${Math.floor(viewport.width / canvasBudget.scale)}px`;
        canvas.style.height = `${Math.floor(viewport.height / canvasBudget.scale)}px`;
        context.clearRect(0, 0, canvas.width, canvas.height);

        try {
          const result = await lease.track(page.render({
            canvas,
            viewport,
            background: "rgb(255,255,255)",
          }));
          if (result.status === "completed" && lease.isCurrent()) {
            setPdfPageReady(true);
            const fitKey = `${currentScan.id}:${safePageNumber}:${normalizeDegrees(rotation)}`;
            if (fittedPdfKeyRef.current !== fitKey || fitPendingRef.current) {
              fittedPdfKeyRef.current = fitKey;
              fitPendingRef.current = true;
              requestFitDocumentView(fitModeRef.current ?? "page", rotation);
            }
            const preview = previewCacheRef.current.get(currentScan.id);
            const firstRenderDuration = Math.max(
              0,
              Math.round(performance.now() - pdfTelemetryStartedAtRef.current),
            );
            const firstPageRender = emitViewerTelemetryOnce(
                `first-render:${viewer?.openedAt ?? 0}:${currentScan.id}`,
                {
                  event: "pdf_first_page_rendered",
                  provider: preview?.documentSource?.provider ?? "unknown",
                  ...(preview?.accessMode ? { accessMode: preview.accessMode } : {}),
                  statusCode: 200,
                  durationMs: firstRenderDuration,
                  pageCount: document.numPages,
                  fileSizeBucket: pdfFileSizeBucket(
                    preview?.documentSource?.fileSizeBytes ?? currentScan.size,
                  ),
                },
            );
            if (firstPageRender) {
              trackProductAnalyticsOperation(
                "document_first_page_render",
                "success",
                firstRenderDuration,
                document.numPages,
              );
            }
            const restore = viewerV2Enabled ? viewer?.restore : undefined;
            const restoreRotation = restore?.selection?.rotation;
            const restoreKey = restore?.selection && restore.pageIndex === safePageNumber
              ? `${viewer?.openedAt ?? 0}:${currentScan.id}:${safePageNumber}:${effectivePdfRotation}`
              : "";
            if (
              restore?.selection &&
              restoreKey &&
              restoredFindingSelectionRef.current !== restoreKey &&
              normalizeQuarterRotation(effectivePdfRotation) === normalizeQuarterRotation(restoreRotation ?? 0)
            ) {
              const restoredRect = findingDocumentSelectionViewportRect(
                  { restore },
                  {
                    width: viewport.width / canvasBudget.scale,
                    height: viewport.height / canvasBudget.scale,
                  },
              );
              if (restoredRect) {
                setSelectionMode(false);
                setCropRect(restoredRect);
                restoredFindingSelectionRef.current = restoreKey;
              }
            }
          }
        } finally {
          page.cleanup();
        }
      })
      .catch((renderError: unknown) => {
        if (!lease.isCurrent()) return;
        if (renderError instanceof PdfCanvasBudgetError) {
          setError(PDF_CANVAS_RESOURCE_LIMIT_MESSAGE);
          setSelectionMode(false);
          setCropRect(null);
          return;
        }
        setPdfPageReady(false);
        setError(
          renderError instanceof Error && renderError.message.trim()
            ? renderError.message
            : "Не вдалося відобразити сторінку PDF. Спробуйте ще раз.",
        );
        setSelectionMode(false);
        setCropRect(null);
      })
      .finally(() => {
        if (lease.isCurrent()) setPdfRendering(false);
      });

    return () => renderController.cancel();
  }, [
    viewerV2Enabled,
    currentScan?.id,
    kind,
    pdfPageNumber,
    effectivePdfRotation,
    pdfRenderZoom,
    viewer?.openedAt,
  ]);

  useEffect(() => {
    const queue = thumbnailQueueRef.current;
    const cache = thumbnailCacheRef.current;
    if (
      !viewerV2Enabled
      || !currentScan
      || kind !== "pdf"
      || pdfPageCount < 1
      || !queue
      || !cache
    ) {
      queue?.cancelAll();
      cache?.clear();
      setThumbnailUrls({});
      return undefined;
    }

    if (pdfRendering) {
      // The main page always wins. Rendering even one thumbnail in parallel
      // can trigger a second JPEG2000/JBIG2 decode of a large archival page and
      // keep the visible canvas blank for a long time.
      queue.cancelAll();
      return undefined;
    }

    let active = true;
    const plan = createVirtualizedThumbnailPlan({
      totalPages: pdfPageCount,
      firstVisiblePage: Math.max(1, pdfPageNumber - PDF_THUMBNAIL_WINDOW_RADIUS),
      lastVisiblePage: Math.min(pdfPageCount, pdfPageNumber + PDF_THUMBNAIL_WINDOW_RADIUS),
      currentPage: pdfPageNumber,
      overscan: 1,
      currentPageRadius: 1,
    });
    const keys = new Set(plan.mountedPages.map((page) => `${currentScan.id}:${page}`));
    queue.retain(keys);
    cache.retain(keys);
    setThumbnailUrls(Object.fromEntries(plan.mountedPages.flatMap((page) => {
      const url = cache.peek(`${currentScan.id}:${page}`);
      return url ? [[page, url]] : [];
    })));

    const cancelIdleWork = scheduleViewerIdleWork(() => {
      void loadPdfDocument(currentScan).then(({ document }) => {
        for (const [priority, pageNumber] of plan.renderQueue.entries()) {
          const key = `${currentScan.id}:${pageNumber}`;
          const cached = cache.get(key);
          if (cached) {
            if (active) setThumbnailUrls((current) => ({ ...current, [pageNumber]: cached }));
            continue;
          }
          void queue.schedule({
            key,
            priority,
            run: (signal) => renderPdfThumbnail(document, pageNumber, signal),
          }).then((result) => {
            if (result.status !== "completed") return;
            if (!active || !keys.has(key)) return;
            cache.set(key, result.value);
            setThumbnailUrls((current) => ({ ...current, [pageNumber]: result.value }));
          }).catch(() => undefined);
        }
      }).catch(() => undefined);
    });

    return () => {
      active = false;
      cancelIdleWork();
    };
  }, [
    viewerV2Enabled,
    currentScan?.id,
    kind,
    pdfPageCount,
    pdfPageNumber,
    pdfRendering,
  ]);

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

  const findingReferenceDraft = (
    selection?: NormalizedPageSelectionInput,
  ): FindingDocumentReferenceDraft | undefined => {
    if (!sourceDocument || !sourceContext?.enabled) return undefined;
    const source = previewCacheRef.current.get(activeScan.id)?.documentSource;
    if (!source) return undefined;
    return {
      documentId: sourceDocument.id,
      documentSourceId: source.id,
      pageIndex: navigationPageNumber,
      pageLabel: isInteractivePdf ? (pdfPageLabel || String(navigationPageNumber)) : String(navigationPageNumber),
      ...(selection ? { selection } : {}),
      sourceFingerprint: { ...source.fingerprint },
    };
  };

  const createFinding = async () => {
    if (!sourceDocument) return;
    trackProductAnalyticsAction("finding_create_from_document");
    const documentReferenceDraft = findingReferenceDraft();
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
      ...(documentReferenceDraft ? { documentReferenceDraft } : {}),
      notes: `Створено під час перегляду документа «${sourceDocument.title}». Скан: ${activeScan.name}.`,
    });
  };

  const createFindingFromCrop = async (
    destination: CropSnapshotDestination,
    captureMode: FindingCaptureMode = "fragment",
  ) => {
    if (!sourceDocument || (captureMode === "fragment" && !cropRect)) return;
    cropOperationAbortRef.current?.abort();
    const abortController = new AbortController();
    cropOperationAbortRef.current = abortController;
    setError("");
    setCreatingCrop(true);
    try {
      const isFullPage = captureMode === "full-page";
      const sourceName = isFullPage
        ? `${sourceDocument.title || activeScan.name}-сторінка-${navigationPageNumber}.png`
        : `${sourceDocument.title || activeScan.name}-сторінка-${navigationPageNumber}-фрагмент.png`;
      const captureRotation = kind === "pdf" ? effectivePdfRotation : rotation;
      const fragmentSelection = isFullPage
        ? fullPageDocumentSelection(
            sourceDocument.id,
            activeScan,
            navigationPageNumber,
            captureRotation,
          )
        : documentFragmentSelectionFromCrop(
            sourceDocument.id,
            activeScan,
            navigationPageNumber,
            captureRotation,
            cropRect!,
            kind === "pdf" ? pdfCanvasRef.current : imageRef.current,
            fitScale * zoom,
          );
      if (!fragmentSelection) {
        throw new Error("Не вдалося визначити координати виділеного фрагмента.");
      }
      let sourcePageDimensions: Pick<NormalizedPageSelectionInput, "sourcePageWidthPt" | "sourcePageHeightPt"> = {};
      let croppedFile: File | null = null;
      if (kind === "pdf") {
        const { document: pdfDocument } = await loadPdfDocument(activeScan, abortController.signal);
        throwIfViewerOperationAborted(abortController.signal);
        const sourcePage = await pdfDocument.getPage(navigationPageNumber);
        throwIfViewerOperationAborted(abortController.signal);
        try {
          const sourceViewport = sourcePage.getViewport({ scale: 1, rotation: 0 });
          sourcePageDimensions = {
            sourcePageWidthPt: sourceViewport.width,
            sourcePageHeightPt: sourceViewport.height,
          };
          if (destination !== "none") {
            const limits = pdfClientExportLimits();
            const snapshot = await renderPdfFragmentSnapshot({
              page: sourcePage,
              crop: fragmentSelection.rect,
              rotation: normalizeQuarterRotation(fragmentSelection.rotation),
              scale: limits.imageScale,
              maxSide: limits.maxImageSide,
              mimeType: "image/png",
              signal: abortController.signal,
            });
            croppedFile = timestampedFile(snapshot, sourceName, "image/png");
          }
        } finally {
          sourcePage.cleanup();
        }
      } else if (destination !== "none" && imageRef.current) {
        const imageCrop = isFullPage
          ? fullRenderedElementCrop(imageRef.current, fitScale * zoom)
          : cropRect!;
        croppedFile = await cropImageToFile(imageRef.current, imageCrop, sourceName, fitScale * zoom);
        throwIfViewerOperationAborted(abortController.signal);
      }
      if (destination !== "none" && !croppedFile) {
        throw new Error("Не вдалося підготувати фрагмент для збереження.");
      }
      throwIfViewerOperationAborted(abortController.signal);
      const documentReferenceBase = fragmentSelection
        ? findingReferenceDraft({
            pageIndex: fragmentSelection.pageNumber,
            ...fragmentSelection.rect,
            rotation: fragmentSelection.rotation,
            ...sourcePageDimensions,
          })
        : undefined;
      let fragmentScan: ScanAttachment | undefined;
      if (destination === "google-drive" && croppedFile) {
        await authorizeGoogleDrive();
        throwIfViewerOperationAborted(abortController.signal);
        fragmentScan = await saveScan(croppedFile, "finding", {
          driveFolderPath: ["Знахідки"],
          signal: abortController.signal,
        });
        throwIfViewerOperationAborted(abortController.signal);
      } else if (destination === "download" && croppedFile) {
        throwIfViewerOperationAborted(abortController.signal);
        downloadGeneratedFile(croppedFile, croppedFile.name);
      }
      const documentReferenceDraft = documentReferenceBase
        ? {
            ...documentReferenceBase,
            ...(fragmentScan?.storage === "google-drive" && fragmentScan.storagePath
              ? {
                  snapshot: {
                    provider: "google_drive" as const,
                    fileId: fragmentScan.storagePath,
                    ...(fragmentScan.webViewLink ? { url: fragmentScan.webViewLink } : {}),
                    mimeType: "image/png" as const,
                  },
                }
              : {}),
          }
        : undefined;
      setSelectionMode(false);
      setCropRect(null);
      setCropDialogOpen(false);
      setFindingCaptureMode("fragment");
      await minimizeViewerForRecordAction();
      throwIfViewerOperationAborted(abortController.signal);
      trackProductAnalyticsAction("finding_create_from_document");
      onCreateFinding({
        researchId: sourceDocument.researchId,
        documentId: sourceDocument.id,
        archive: sourceDocument.archive,
        fund: sourceDocument.fund,
        description: sourceDocument.description,
        file: sourceDocument.file,
        place: sourceDocument.place,
        page: navigationPageCount > 1 ? String(navigationPageNumber) : "",
        ...(fragmentScan ? { scans: [fragmentScan] } : {}),
        fragmentSelection,
        ...(documentReferenceDraft ? { documentReferenceDraft } : {}),
        notes: isFullPage
          ? `Створено з повної сторінки документа «${sourceDocument.title}». Джерело: ${activeScan.name}.`
          : `Створено з виділеного фрагмента документа «${sourceDocument.title}». Джерело: ${activeScan.name}.`,
      });
    } catch (cropError) {
      if (!isViewerOperationAbort(cropError)) {
        setError(cropError instanceof Error
          ? cropError.message
          : captureMode === "full-page"
            ? "Не вдалося створити знахідку з повної сторінки."
            : "Не вдалося створити знахідку з фрагмента.");
      }
    } finally {
      if (cropOperationAbortRef.current === abortController) {
        cropOperationAbortRef.current = null;
        setCreatingCrop(false);
      }
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

  const confirmCurrentSourceVersion = async () => {
    const preview = currentScan
      ? previewCacheRef.current.get(currentScan.id)
      : undefined;
    const source = preview?.documentSource;
    if (
      !sourceContext
      || !currentScan
      || !source
      || !preview?.canConfirmSourceVersion
      || !source.pendingFingerprint
      || !source.pendingResolvedMetadata
    ) return;

    setConfirmingSourceVersion(true);
    setSourceVersionMessage("");
    try {
      const confirmed = await confirmDocumentSourceVersion(
        sourceContext.projectId,
        source.id,
        source.pendingFingerprint,
        source.pendingResolvedMetadata,
      );
      previewCacheRef.current.set(currentScan.id, {
        ...preview,
        documentSource: confirmed,
        sourceVersionStatus: "unchanged",
        canConfirmSourceVersion: false,
      });
      setSourceVersionMessage(
        "Нову версію PDF підтверджено. Раніше створені знахідки зберегли попередню версію джерела.",
      );
    } catch {
      setSourceVersionMessage(
        "Не вдалося підтвердити нову версію PDF. Оновіть сторінку та спробуйте ще раз.",
      );
    } finally {
      setConfirmingSourceVersion(false);
    }
  };

  const reconnectDriveAndRetry = async () => {
    setError("");
    setExternalSourceReason(null);
    disposePreviewForScan(activeScan.id);
    await reconnectGoogleDrive();
    setBlobUrl("");
    setKind(null);
    setPreviewReloadKey((value) => value + 1);
  };

  const retryCurrentPreview = () => {
    setError("");
    setExternalSourceReason(null);
    setPdfPageReady(false);
    mainPdfRenderRef.current?.cancel();
    thumbnailQueueRef.current?.cancelAll();
    disposePreviewForScan(activeScan.id);
    setBlobUrl("");
    setKind(null);
    setPreviewReloadKey((value) => value + 1);
  };

  const retryImagePreview = async () => {
    const cached = previewCacheRef.current.get(activeScan.id);
    if (cached?.blob && !blobUrl.startsWith("data:")) {
      try {
        const dataUrl = await blobToDataUrl(cached.blob);
        const previousUrl = cached.url;
        previewCacheRef.current.set(activeScan.id, {
          ...cached,
          url: dataUrl,
          revokeOnClose: false,
        });
        if (cached.revokeOnClose) {
          URL.revokeObjectURL(previousUrl);
        }
        setError("");
        setKind("image");
        setBlobUrl(dataUrl);
        return;
      } catch {
        // Fall through to the hosted preview below.
      }
    }

    const hostedPreviewUrl = hostedFilePreviewUrl(activeScan);
    if (!hostedPreviewUrl) {
      setError("Файл завантажився, але браузер не зміг показати його у внутрішньому переглядачі. Спробуйте відкрити джерело або завантажити файл.");
      return;
    }
    setError("");
    setExternalSourceReason(null);
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

  const applyPageNumberInput = () => {
    if (navigationPageCount < 1) return;
    const requested = Number(pageNumberInput);
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > navigationPageCount) {
      setPageNumberInput(String(navigationPageNumber));
      setError(`Введіть номер сторінки від 1 до ${navigationPageCount}.`);
      return;
    }
    setError("");
    setSelectionMode(false);
    setCropRect(null);
    if (isInteractivePdf) {
      setMarkedExportPages(new Set());
      setPdfPageNumber(requested);
      return;
    }
    setCurrentIndex(requested - 1);
  };

  const changeZoom = (delta: number) => {
    fitModeRef.current = null;
    setZoom((value) => clampZoom(value + delta));
  };

  const fitDocumentView = (
    fit: DocumentFitMode,
    rotationOverride = rotation,
  ): boolean => {
    const stage = selectionStageRef.current;
    const viewport = kind === "pdf" ? pdfPageViewportRef.current : previewViewportRef.current;
    if (!stage || !viewport || !(stage.offsetWidth > 0) || !(stage.offsetHeight > 0)) return false;

    const showingFastPreview = Boolean(stage.querySelector(".workspace-pdf-fast-preview"));
    const visualAngle = kind === "pdf"
      ? showingFastPreview
        ? normalizeSignedRotation(rotationOverride)
        : splitPdfRotation(rotationOverride).cssRotation
      : normalizeSignedRotation(rotationOverride);
    const bounds = rotatedDocumentBounds(stage.offsetWidth, stage.offsetHeight, visualAngle);
    if (!(bounds.width > 0) || !(bounds.height > 0)) return false;

    const availableWidth = Math.max(1, viewport.clientWidth - 28);
    const availableHeight = Math.max(1, viewport.clientHeight - 28);
    const widthScale = availableWidth / bounds.width;
    const heightScale = availableHeight / bounds.height;
    const targetScale = fit === "width" ? widthScale : Math.min(widthScale, heightScale);
    const boundedScale = Math.min(MAX_ZOOM, Math.max(0.02, targetScale));

    fitModeRef.current = fit;
    setFitScale(Math.round(boundedScale * 10_000) / 10_000);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSelectionMode(false);
    setCropRect(null);
    return true;
  };

  const requestFitDocumentView = (
    fit: DocumentFitMode = "page",
    rotationOverride = rotation,
  ) => {
    fitModeRef.current = fit;
    fitPendingRef.current = true;
    if (fitFrameRef.current !== null) window.cancelAnimationFrame(fitFrameRef.current);
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null;
      if (fitDocumentView(fit, rotationOverride)) fitPendingRef.current = false;
    });
  };

  const resetImageView = () => {
    requestFitDocumentView("page");
  };

  const applyRotation = (degrees: number) => {
    const normalized = normalizeDegrees(degrees);
    const previousPdfRotation = splitPdfRotation(rotation).renderRotation;
    const nextPdfRotation = splitPdfRotation(normalized).renderRotation;
    setRotation(normalized);
    setRotationInput(String(normalizeSignedRotation(normalized)));
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSelectionMode(false);
    setCropRect(null);
    fitModeRef.current = "page";
    fitPendingRef.current = true;
    if (kind === "pdf" && previousPdfRotation !== nextPdfRotation) setPdfPageReady(false);
    requestFitDocumentView("page", normalized);
  };

  const commitRotationInput = () => {
    const nextRotation = Number(rotationInput.replace(",", "."));
    if (!Number.isFinite(nextRotation)) {
      setRotationInput(String(normalizeSignedRotation(rotation)));
      return;
    }
    applyRotation(nextRotation);
  };

  const updateImageAdjustment = (
    key: keyof DocumentImageAdjustments,
    value: number,
  ) => {
    setImageAdjustments((current) => normalizeDocumentImageAdjustments({
      ...current,
      [key]: value,
    }));
  };

  const applyManuscriptPreset = (preset: DocumentImagePresetId) => {
    setImageAdjustments({ ...DOCUMENT_IMAGE_PRESETS[preset] });
  };

  const resetImageProcessing = () => {
    setImageAdjustments({ ...DEFAULT_DOCUMENT_IMAGE_ADJUSTMENTS });
  };

  const fitPdfView = (fit: DocumentFitMode) => {
    requestFitDocumentView(fit);
  };

  const rotateImage = (degrees: number) => {
    applyRotation(rotation + degrees);
  };

  useEffect(() => {
    const viewport = kind === "pdf" ? pdfPageViewportRef.current : previewViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const fit = fitModeRef.current;
      if (fit) requestFitDocumentView(fit, rotationValueRef.current);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [kind, isInteractivePdf, mode, viewerSize?.width, viewerSize?.height]);

  const openPdfExport = () => {
    setExportRange(
      markedExportPages.size > 0
        ? [...markedExportPages].sort((left, right) => left - right).join(", ")
        : String(pdfPageNumber),
    );
    setExportFormat("pdf");
    setExportMessage("");
    setExportResultUrl("");
    setExportOpen(true);
  };

  const toggleMarkedExportPage = (pageNumber: number) => {
    setMarkedExportPages((current) => {
      const next = new Set(current);
      if (next.has(pageNumber)) next.delete(pageNumber);
      else next.add(pageNumber);
      return next;
    });
  };

  const closePdfExport = () => {
    exportOperationAbortRef.current?.abort();
    setExportOpen(false);
  };

  const closeCropDialog = () => {
    cropOperationAbortRef.current?.abort();
    setCropDialogOpen(false);
    setFindingCaptureMode("fragment");
  };

  const chooseExportDriveFolder = async () => {
    if (exporting) return;
    setExportMessage("");
    try {
      const folder = await pickGoogleDriveFolder("Оберіть папку для експорту документа");
      if (!folder) return;
      setExportDriveFolder(folder);
      setExportDestination("google-drive");
      setExportMessage(`Папку «${folder.name}» вибрано для експорту.`);
    } catch (folderError) {
      setExportMessage(folderError instanceof Error
        ? folderError.message
        : "Не вдалося вибрати папку Google Drive.");
    }
  };

  const exportPdfPages = async () => {
    if (!currentScan || !sourceDocument || !isInteractivePdf || pdfPageCount < 1) return;
    trackProductAnalyticsAction("document_page_export");
    const telemetryRequestId = createPdfOperationalRequestId();
    const telemetryStartedAt = performance.now();
    let exportedPageCount: number | undefined;
    let exportedBytes: number | undefined;
    exportOperationAbortRef.current?.abort();
    const abortController = new AbortController();
    exportOperationAbortRef.current = abortController;
    setExporting(true);
    setExportMessage("");
    setExportResultUrl("");
    try {
      const limits = pdfClientExportLimits();
      const imageExportOptions = {
        scale: exportImageScale,
        jpegQuality: exportJpegQuality / 100,
      };
      const selectedPages = parsePageRange(exportRange, pdfPageCount, limits.maxPages);
      exportedPageCount = selectedPages.length;
      const { document: pdfDocument } = await loadPdfDocument(currentScan, abortController.signal);
      throwIfViewerOperationAborted(abortController.signal);
      let result: Blob;
      let fileName: string;
      let pdfSubsetStrategy: PdfSubsetExportStrategy | undefined;
      if (exportFormat === "pdf") {
        fileName = pdfExportFileName(sourceDocument.title, selectedPages, "pdf");
        const persistedSource = previewCacheRef.current.get(currentScan.id)?.documentSource;
        const knownSize = firstKnownPositiveSize(
          persistedSource?.fileSizeBytes,
          currentScan.size,
        );
        pdfSubsetStrategy = choosePdfSubsetExportStrategy(knownSize, selectedPages.length, limits);
        if (pdfSubsetStrategy === "vector") {
          validateKnownClientExportSize(knownSize, selectedPages.length, limits);
          const sourceBytes = await pdfDocument.getData();
          throwIfViewerOperationAborted(abortController.signal);
          result = await createPdfSubsetBlob(sourceBytes, selectedPages, limits, abortController.signal);
        } else {
          const cachedPreview = previewCacheRef.current.get(currentScan.id);
          const serverResult = persistedSource && sourceContext
            ? await exportDocumentSourcePdfPages({
                projectId: sourceContext.projectId,
                documentId: sourceContext.documentId,
                userId: sourceContext.userId,
                source: persistedSource,
                pages: selectedPages,
                fileName,
                accessUrl: cachedPreview?.url,
                signal: abortController.signal,
              })
            : null;
          if (serverResult) {
            result = serverResult;
            pdfSubsetStrategy = "server";
            setExportMessage("Вибрані сторінки скопійовано сервером без растеризації.");
          } else {
            setExportMessage(
              "Серверний export worker не налаштовано: послідовно формуємо обмежену растрову копію лише вибраних сторінок…",
            );
            result = await createRasterizedPdfSubsetBlob(
              pdfDocument,
              selectedPages,
              limits,
              abortController.signal,
              imageExportOptions,
            );
          }
        }
      } else if (exportFormat === "png" || exportFormat === "jpeg") {
        if (selectedPages.length !== 1) {
          throw new Error("Для кількох зображень оберіть ZIP (PNG) або ZIP (JPEG).");
        }
        result = await renderPdfPageImage(
          pdfDocument,
          selectedPages[0]!,
          exportFormat,
          limits,
          abortController.signal,
          imageExportOptions,
        );
        fileName = pdfExportFileName(
          sourceDocument.title,
          selectedPages,
          exportFormat === "jpeg" ? "jpg" : "png",
        );
      } else {
        const imageFormat = exportFormat === "zip-jpeg" ? "jpeg" : "png";
        result = await createPageImagesZip(
          pdfDocument,
          selectedPages,
          imageFormat,
          sourceDocument.title,
          limits,
          abortController.signal,
          imageExportOptions,
        );
        fileName = pdfExportFileName(sourceDocument.title, selectedPages, "zip");
      }
      throwIfViewerOperationAborted(abortController.signal);
      exportedBytes = result.size;
      const rasterizedResultNote = pdfSubsetStrategy === "rasterized"
        ? " Вибрані сторінки додано як високоякісні зображення; весь оригінал не завантажувався."
        : pdfSubsetStrategy === "server"
          ? " Сторінки скопійовано без растеризації через тимчасовий серверний процес; оригінал не зберігався."
          : "";

      if (exportDestination === "download") {
        downloadGeneratedFile(result, fileName);
        setExportMessage(
          `Файл «${fileName}» сформовано та передано браузеру для завантаження.${rasterizedResultNote}`,
        );
      } else {
        if (!sourceContext) throw new Error("Для збереження в Google Drive потрібен активний проєкт.");
        await authorizeGoogleDrive();
        throwIfViewerOperationAborted(abortController.signal);
        const file = new File([result], fileName, { type: result.type || "application/octet-stream" });
        const persistedSource = previewCacheRef.current.get(currentScan.id)?.documentSource;
        const knownSize = firstKnownPositiveSize(
          persistedSource?.fileSizeBytes,
          currentScan.size,
        );
        const destinationPath = ["Експорт документів"];
        const destinationIdentity = exportDriveFolder
          ? [
              `google-drive-folder:${exportDriveFolder.id}`,
              ...(exportDriveFolder.resourceKey
                ? [`resource-key:${exportDriveFolder.resourceKey}`]
                : []),
            ]
          : destinationPath;
        const deduplicationKey = pdfExportDeduplicationKey({
          documentId: sourceDocument.id,
          sourceIdentity: persistedSource?.id
            ?? currentScan.documentSourceId
            ?? currentScan.storagePath
            ?? currentScan.id,
          sourceVersion: JSON.stringify(
            persistedSource?.fingerprint
              ?? currentScan.sourceFingerprint
              ?? {
                revisionId: currentScan.driveRevisionId ?? "",
                modifiedTime: currentScan.driveModifiedTime ?? "",
                size: knownSize ?? 0,
              },
          ),
          pages: selectedPages,
          format: exportFormat,
          destinationPath: destinationIdentity,
          ...(pdfSubsetStrategy ? { renderMode: pdfSubsetStrategy } : {}),
          ...(exportFormat === "pdf" && pdfSubsetStrategy !== "rasterized" ? {} : {
            imageScale: exportImageScale,
            ...(exportFormat === "jpeg" || exportFormat === "zip-jpeg" || pdfSubsetStrategy === "rasterized"
              ? { jpegQuality: exportJpegQuality / 100 }
              : {}),
          }),
        });
        const uploaded = await uploadFileToGoogleDrive(
          { projectId: sourceContext.projectId, projectName: sourceContext.projectName },
          file,
          createClientOperationId("pdf-export"),
          exportDriveFolder
            ? {
                destinationFolderId: exportDriveFolder.id,
                destinationFolderName: exportDriveFolder.name,
                destinationFolderResourceKey: exportDriveFolder.resourceKey,
                deduplicationKey,
                signal: abortController.signal,
              }
            : {
                folderPath: destinationPath,
                deduplicationKey,
                signal: abortController.signal,
              },
        );
        throwIfViewerOperationAborted(abortController.signal);
        setExportResultUrl(uploaded.webViewLink);
        setExportMessage(
          exportDriveFolder
            ? `Файл «${fileName}» збережено у папці «${exportDriveFolder.name}».${rasterizedResultNote}`
            : `Файл «${fileName}» збережено у Google Drive.${rasterizedResultNote}`,
        );
      }
      if (sourceContext) {
        const preview = previewCacheRef.current.get(currentScan.id);
        void emitPdfOperationalEvent(sourceContext.projectId, {
          event: "pdf_page_export_succeeded",
          requestId: telemetryRequestId,
          provider: preview?.documentSource?.provider ?? "unknown",
          ...(preview?.accessMode ? { accessMode: preview.accessMode } : {}),
          statusCode: 200,
          durationMs: Math.max(0, Math.round(performance.now() - telemetryStartedAt)),
          ...(exportedPageCount ? { pageCount: exportedPageCount } : {}),
          fileSizeBucket: pdfFileSizeBucket(exportedBytes),
          ...(exportedBytes === undefined ? {} : { transferredBytes: exportedBytes }),
        });
      }
      trackProductAnalyticsOperation(
        "document_page_export",
        "success",
        performance.now() - telemetryStartedAt,
        exportedPageCount,
      );
    } catch (exportError) {
      if (!isViewerOperationAbort(exportError)) {
        if (sourceContext) {
          const preview = previewCacheRef.current.get(currentScan.id);
          void emitPdfOperationalEvent(sourceContext.projectId, {
            event: "pdf_page_export_failed",
            requestId: telemetryRequestId,
            provider: preview?.documentSource?.provider ?? "unknown",
            ...(preview?.accessMode ? { accessMode: preview.accessMode } : {}),
            errorCode: safePdfOperationalErrorCode(
              exportError,
              exportDestination === "google-drive" ? "DRIVE_ERROR" : "EXPORT_FAILED",
            ),
            durationMs: Math.max(0, Math.round(performance.now() - telemetryStartedAt)),
            ...(exportedPageCount ? { pageCount: exportedPageCount } : {}),
            fileSizeBucket: pdfFileSizeBucket(exportedBytes),
            ...(exportedBytes === undefined ? {} : { transferredBytes: exportedBytes }),
          });
        }
        setExportMessage(exportError instanceof Error ? exportError.message : "Не вдалося експортувати сторінки.");
        trackProductAnalyticsOperation(
          "document_page_export",
          "failure",
          performance.now() - telemetryStartedAt,
          exportedPageCount,
        );
      } else {
        trackProductAnalyticsOperation(
          "document_page_export",
          "cancelled",
          performance.now() - telemetryStartedAt,
          exportedPageCount,
        );
      }
    } finally {
      if (exportOperationAbortRef.current === abortController) {
        exportOperationAbortRef.current = null;
        setExporting(false);
      }
    }
  };

  const handlePreviewWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!(kind === "image" || isInteractivePdf) || !blobUrl) return;
    if ((event.target as HTMLElement).closest(
      ".workspace-pdf-thumbnails, .workspace-export-dialog, .workspace-image-tools-panel",
    )) return;
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

  const cropPageGeometry = (): { pointBounds: CropRect; pageSize: CropSize } | null => {
    const stage = selectionStageRef.current;
    if (!stage || !(stage.offsetWidth > 0) || !(stage.offsetHeight > 0)) return null;
    const bounds = stage.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) return null;
    return {
      pointBounds: {
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
      pageSize: { width: stage.offsetWidth, height: stage.offsetHeight },
    };
  };

  const cropPoint = (clientX: number, clientY: number): CropPoint | null => {
    const geometry = cropPageGeometry();
    if (!geometry) return null;
    return screenPointToPagePoint(
      { x: clientX, y: clientY },
      geometry.pointBounds,
      geometry.pageSize,
    );
  };

  const captureCropPointer = (pointerId: number) => {
    try {
      selectionStageRef.current?.setPointerCapture(pointerId);
    } catch {
      // The browser can reject capture if the pointer has already ended.
    }
  };

  const beginRotationInteraction = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const stage = selectionStageRef.current;
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const startPointerAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    rotationInteractionRef.current = {
      pointerId: event.pointerId,
      centerX,
      centerY,
      startPointerAngle,
      startRotation: normalizeSignedRotation(rotation),
      latestRotation: rotation,
    };
    fitModeRef.current = "page";
    setPan({ x: 0, y: 0 });
    setSelectionMode(false);
    setCropRect(null);
    setIsRotating(true);
  };

  const updateRotationInteraction = (event: PointerEvent<HTMLButtonElement>) => {
    const interaction = rotationInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerAngle = Math.atan2(
      event.clientY - interaction.centerY,
      event.clientX - interaction.centerX,
    ) * 180 / Math.PI;
    let delta = pointerAngle - interaction.startPointerAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const nextRotation = normalizeDegrees(interaction.startRotation + delta);
    interaction.latestRotation = nextRotation;
    rotationValueRef.current = nextRotation;
    setRotation(nextRotation);
    setRotationInput(String(normalizeSignedRotation(nextRotation)));
  };

  const finishRotationInteraction = (event: PointerEvent<HTMLButtonElement>) => {
    const interaction = rotationInteractionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released by the browser.
    }
    rotationInteractionRef.current = null;
    setIsRotating(false);
    applyRotation(interaction.latestRotation);
  };

  const beginImagePan = (event: PointerEvent<HTMLDivElement>) => {
    if (!(kind === "image" || isInteractivePdf) || event.button !== 0) return;
    event.preventDefault();
    fitModeRef.current = null;
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
    const start = cropPoint(event.clientX, event.clientY);
    if (!start) return;
    cropInteractionRef.current = { mode: "create", anchor: start };
    setIsSelecting(true);
    setCropRect({ x: start.x, y: start.y, width: 0, height: 0 });
    captureCropPointer(event.pointerId);
  };

  const beginCropMove = (event: PointerEvent<HTMLSpanElement>) => {
    if (!selectionMode || !cropRect || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = cropPoint(event.clientX, event.clientY);
    if (!start) return;
    cropInteractionRef.current = { mode: "move", anchor: start, initial: { ...cropRect } };
    setIsSelecting(true);
    captureCropPointer(event.pointerId);
  };

  const beginCropResize = (handle: CropResizeHandle, event: PointerEvent<HTMLSpanElement>) => {
    if (!selectionMode || !cropRect || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = cropPoint(event.clientX, event.clientY);
    if (!start) return;
    cropInteractionRef.current = { mode: "resize", anchor: start, initial: { ...cropRect }, handle };
    setIsSelecting(true);
    captureCropPointer(event.pointerId);
  };

  const updateCropSelection = (event: PointerEvent<HTMLDivElement>) => {
    const interaction = cropInteractionRef.current;
    if (!interaction) return;
    const point = cropPoint(event.clientX, event.clientY);
    const geometry = cropPageGeometry();
    if (!point || !geometry) return;
    if (interaction.mode === "create") {
      setCropRect(createCropRect(interaction.anchor, point, geometry.pageSize));
      return;
    }
    const delta = {
      x: point.x - interaction.anchor.x,
      y: point.y - interaction.anchor.y,
    };
    setCropRect(interaction.mode === "move"
      ? moveCropRect(interaction.initial, delta, geometry.pageSize)
      : resizeCropRect(interaction.initial, interaction.handle, delta, geometry.pageSize));
  };

  const finishCropSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (!cropInteractionRef.current) return;
    setIsSelecting(false);
    cropInteractionRef.current = null;
    try {
      selectionStageRef.current?.releasePointerCapture(event.pointerId);
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
  const visualRotation = kind === "pdf"
    ? pdfPageReady
      ? finePdfRotation
      : normalizeSignedRotation(rotation)
    : normalizeSignedRotation(rotation);
  const viewScale = fitScale * zoom;
  const imageTransform = `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${viewScale}) rotate(${visualRotation}deg)`;
  const imageFilter = documentImageCssFilter(imageAdjustments, sharpenFilterId);
  const imageFilterStyle: CSSProperties = { filter: imageFilter };
  const sharpenKernel = documentSharpenKernel(imageAdjustments.sharpness);
  const activeImagePreset = MANUSCRIPT_PRESET_BUTTONS.find(({ id }) => (
    documentImageAdjustmentsEqual(imageAdjustments, DOCUMENT_IMAGE_PRESETS[id])
  ))?.id;
  const cropRotationSupported = kind === "pdf"
    ? finePdfRotation === 0
    : normalizeSignedRotation(rotation) === 0;
  const canSelectFragment =
    (kind === "image" || isInteractivePdf) &&
    Boolean(blobUrl) &&
    !loading &&
    !error &&
    !pdfRendering &&
    cropRotationSupported;
  const hasValidCrop = Boolean(cropRect && cropRect.width >= 12 && cropRect.height >= 12);
  const thumbnailPlan = createVirtualizedThumbnailPlan({
    totalPages: viewerV2Enabled && isInteractivePdf ? pdfPageCount : 0,
    firstVisiblePage: Math.max(1, pdfPageNumber - PDF_THUMBNAIL_WINDOW_RADIUS),
    lastVisiblePage: Math.min(pdfPageCount, pdfPageNumber + PDF_THUMBNAIL_WINDOW_RADIUS),
    currentPage: pdfPageNumber,
    overscan: 1,
    currentPageRadius: 1,
  });
  const visibleFastPagePreview = fastPagePreview?.pageNumber === pdfPageNumber
    ? fastPagePreview
    : null;
  const rotationControl = (kind === "image" || (viewerV2Enabled && isInteractivePdf)) && blobUrl ? (
    <div
      className="workspace-image-rotation-control"
      aria-label="Поворот сторінки"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="icon-button"
        onClick={() => rotateImage(-90)}
        aria-label="Повернути ліворуч на 90 градусів"
        title="Повернути ліворуч на 90°"
      >
        ↺
      </button>
      <button
        type="button"
        className={`workspace-image-rotation-handle ${isRotating ? "active" : ""}`}
        onPointerDown={beginRotationInteraction}
        onPointerMove={updateRotationInteraction}
        onPointerUp={finishRotationInteraction}
        onPointerCancel={finishRotationInteraction}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            event.stopPropagation();
            rotateImage(-step);
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            rotateImage(step);
          }
        }}
        aria-label="Потягніть кругову стрілку, щоб повернути сторінку"
        title="Потягніть стрілку навколо центра сторінки"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19 8a8 8 0 1 0 1 7" />
          <path d="M19 3v5h-5" />
        </svg>
      </button>
      <label className="workspace-image-rotation-angle">
        <span className="visually-hidden">Точний кут повороту</span>
        <input
          type="text"
          inputMode="decimal"
          value={rotationInput}
          onChange={(event) => setRotationInput(event.currentTarget.value)}
          onBlur={commitRotationInput}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          aria-label="Точний кут повороту у градусах"
        />
        <span aria-hidden="true">°</span>
      </label>
      <button
        type="button"
        className="icon-button"
        onClick={() => rotateImage(90)}
        aria-label="Повернути праворуч на 90 градусів"
        title="Повернути праворуч на 90°"
      >
        ↻
      </button>
      <button
        type="button"
        className="workspace-image-rotation-reset"
        onClick={() => applyRotation(0)}
        disabled={normalizeSignedRotation(rotation) === 0}
        title="Вирівняти сторінку"
      >
        0°
      </button>
    </div>
  ) : null;
  const rotationCropNotice = !cropRotationSupported ? (
    <p className="workspace-image-rotation-note">
      Для точного виділення фрагмента вирівняйте сторінку до 0°, 90°, 180° або 270°.
    </p>
  ) : null;

  const viewerContent = (
    <>
      <svg className="workspace-image-filter-definitions" aria-hidden="true" focusable="false">
        <defs>
          <filter
            id={sharpenFilterId}
            x="-5%"
            y="-5%"
            width="110%"
            height="110%"
            colorInterpolationFilters="sRGB"
          >
            <feConvolveMatrix
              order="3"
              kernelMatrix={sharpenKernel}
              divisor="1"
              bias="0"
              edgeMode="duplicate"
              preserveAlpha="true"
            />
          </filter>
        </defs>
      </svg>
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
              {viewerV2Enabled && isInteractivePdf ? (
                <>
                  <button type="button" className="button button-secondary" onClick={() => fitPdfView("width")}>
                    За шириною
                  </button>
                  <button type="button" className="button button-secondary" onClick={() => fitPdfView("page")}>
                    Умістити
                  </button>
                </>
              ) : null}
              <button type="button" className="button button-secondary" onClick={resetImageView}>
                100%
              </button>
              <button
                type="button"
                className={`button button-secondary ${imageToolsOpen ? "active" : ""}`}
                onClick={() => setImageToolsOpen((open) => !open)}
                aria-expanded={imageToolsOpen}
                aria-controls={imageToolsPanelId}
              >
                Обробка
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

      <div ref={previewViewportRef} className="workspace-viewer-body" onWheelCapture={handlePreviewWheel}>
        {imageToolsOpen && (kind === "image" || isInteractivePdf) && blobUrl ? (
          <section
            id={imageToolsPanelId}
            className="workspace-image-tools-panel"
            aria-label="Інструменти обробки зображення"
          >
            <header className="workspace-image-tools-header">
              <div>
                <strong>Обробка рукописного документа</strong>
                <small>Налаштування змінюють лише перегляд — оригінальний файл залишається незмінним.</small>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setImageToolsOpen(false)}
                aria-label="Закрити інструменти обробки"
              >
                ×
              </button>
            </header>

            <div className="workspace-image-presets" aria-label="Швидкі режими обробки">
              {MANUSCRIPT_PRESET_BUTTONS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`button button-secondary ${activeImagePreset === preset.id ? "active" : ""}`}
                  onClick={() => applyManuscriptPreset(preset.id)}
                  aria-pressed={activeImagePreset === preset.id}
                  title={preset.title}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="workspace-image-adjustments">
              {MANUSCRIPT_ADJUSTMENT_CONTROLS.map((control) => (
                <label key={control.key} className="workspace-image-adjustment">
                  <span>
                    <strong>{control.label}</strong>
                    <output>{imageAdjustments[control.key]}%</output>
                  </span>
                  <input
                    type="range"
                    min={control.minimum}
                    max={control.maximum}
                    step={1}
                    value={imageAdjustments[control.key]}
                    onChange={(event) => updateImageAdjustment(
                      control.key,
                      event.currentTarget.valueAsNumber,
                    )}
                    aria-label={control.label}
                  />
                </label>
              ))}

              <label className="workspace-image-invert-toggle">
                <input
                  type="checkbox"
                  checked={imageAdjustments.invert === 100}
                  onChange={(event) => updateImageAdjustment("invert", event.currentTarget.checked ? 100 : 0)}
                />
                <span>
                  <strong>Інверсія кольорів</strong>
                  <small>Корисно для негативів і дуже темного фону.</small>
                </span>
              </label>
            </div>

            <footer className="workspace-image-tools-footer">
              <button type="button" className="button button-secondary" onClick={resetImageProcessing}>
                Скинути обробку
              </button>
              <span>Поворот і масштаб сторінки зберігаються.</span>
            </footer>
          </section>
        ) : null}
        {effectiveSourceVersionStatus === "changed" ? (
          <div className="workspace-viewer-notice" role="status">
            Зовнішній PDF було оновлено. Номер сторінки або виділений фрагмент може не відповідати новій версії.
          </div>
        ) : null}
        {effectiveSourceVersionStatus === "changed" && currentPreview?.canConfirmSourceVersion ? (
          <div className="workspace-viewer-notice" role="status">
            <span>Поточний файл є новою версією зовнішнього PDF.</span>
            <button
              type="button"
              className="button button-secondary"
              disabled={confirmingSourceVersion}
              onClick={() => void confirmCurrentSourceVersion()}
            >
              {confirmingSourceVersion ? "Підтверджуємо…" : "Підтвердити нову версію"}
            </button>
          </div>
        ) : null}
        {sourceVersionMessage ? (
          <div className="workspace-viewer-notice" role="status">{sourceVersionMessage}</div>
        ) : null}
        {fullscreenError ? (
          <div className="workspace-viewer-notice">{fullscreenError}</div>
        ) : null}
        {externalSourceReason ? (
          <div className="workspace-viewer-state workspace-viewer-external-source">
            <strong>
              {externalSourceReason === "authenticated-source"
                ? "Історичний запис FamilySearch захищений правилами доступу"
                : externalSourceReason === "embedded-blocked"
                  ? "Внутрішній перегляд недоступний"
                  : "Документ відкривається на сайті джерела"}
            </strong>
            <p>
              {externalSourceReason === "authenticated-source"
                ? "FamilySearch не дозволяє стороннім застосункам вбудовувати історичні записи. Трекер Роду не запитує ваш пароль і не копіює файли cookie FamilySearch."
                : externalSourceReason === "embedded-blocked"
                  ? "Посилання збережене. Файл міг потребувати входу, бути видаленим, перевищувати допустимий розмір або мати обмеження браузера на вбудований перегляд."
                  : "Посилання веде на вебсторінку, а не безпосередньо на PDF чи зображення. Такі сторінки надійніше переглядати на самому ресурсі."}
            </p>
            <p className="workspace-viewer-external-note">
              {externalSourceReason === "authenticated-source"
                ? "Щоб працювати з дозволеною копією у цьому переглядачі, завантажте її з FamilySearch і додайте до документа або у Google Drive. Офіційне OAuth-підключення саме по собі не надає права показувати історичні зображення поза FamilySearch."
                : "Якщо ресурс вимагає авторизації, виконайте вхід у відкритій вкладці — чинна сесія браузера залишиться на сайті джерела."}
            </p>
            <div className="workspace-viewer-state-actions">
              {externalSourceReason === "authenticated-source" && sourceDocument ? (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => void openSourceDocument()}
                >
                  Додати копію до документа
                </button>
              ) : null}
              <button
                type="button"
                className="button button-primary"
                onClick={() => void run(() => openScan(activeScan))}
              >
                {externalSourceReason === "authenticated-source"
                  ? "Увійти на FamilySearch"
                  : "Відкрити на сайті джерела"}
              </button>
            </div>
          </div>
        ) : loading && !blobUrl ? (
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
              <button type="button" className="button button-primary" onClick={retryCurrentPreview}>
                Спробувати ще раз
              </button>
              <button type="button" className="button button-secondary" onClick={() => void run(() => openScan(activeScan))}>
                Відкрити джерело
              </button>
            </div>
          </div>
        ) : kind === "image" && blobUrl ? (
          <>
            {rotationControl}
            {rotationCropNotice}
            <div
              ref={selectionStageRef}
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
                style={imageFilterStyle}
                draggable={false}
                onLoad={() => requestFitDocumentView("page", rotationValueRef.current)}
                onError={() => void retryImagePreview()}
              />
              {cropRect ? (
                <span
                  className={`workspace-selection-rect ${selectionMode ? "editable" : ""}`}
                  style={{
                    left: cropRect.x,
                    top: cropRect.y,
                    width: cropRect.width,
                    height: cropRect.height,
                  }}
                  onPointerDown={selectionMode && viewerV2Enabled ? beginCropMove : undefined}
                >
                  {selectionMode && viewerV2Enabled ? CROP_RESIZE_HANDLES.map((handle) => (
                    <span
                      key={handle}
                      className="workspace-selection-handle"
                      data-handle={handle}
                      onPointerDown={(event) => beginCropResize(handle, event)}
                    />
                  )) : null}
                </span>
              ) : null}
              {selectionMode ? (
                <span className="workspace-selection-hint">
                  Протягніть рамку по фрагменту скану
                </span>
              ) : null}
            </div>
          </>
        ) : kind === "pdf" && blobUrl ? (
          <div className={`workspace-pdf-layout ${viewerV2Enabled ? "" : "without-thumbnails"}`}>
            {viewerV2Enabled ? (
              <nav className="workspace-pdf-thumbnails" aria-label="Мініатюри сторінок PDF">
              {thumbnailPlan.mountedPages[0] && thumbnailPlan.mountedPages[0] > 1 ? (
                <button
                  type="button"
                  className="workspace-thumbnail-jump"
                  onClick={() => setPdfPageNumber(1)}
                >
                  1…
                </button>
              ) : null}
              {thumbnailPlan.mountedPages.map((pageNumber) => (
                <div
                  key={pageNumber}
                  className={`workspace-pdf-thumbnail ${pageNumber === pdfPageNumber ? "active" : ""} ${
                    markedExportPages.has(pageNumber) ? "marked" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="workspace-pdf-thumbnail-preview"
                    aria-current={pageNumber === pdfPageNumber ? "page" : undefined}
                    aria-label={`Відкрити сторінку ${pageNumber}`}
                    onClick={() => {
                      setSelectionMode(false);
                      setCropRect(null);
                      setPdfPageNumber(pageNumber);
                    }}
                  >
                    {thumbnailUrls[pageNumber] || (
                      pageNumber === pdfPageNumber && visibleFastPagePreview
                    ) ? (
                      <img
                        src={thumbnailUrls[pageNumber] || visibleFastPagePreview?.url || ""}
                        alt=""
                      />
                    ) : (
                      <span className="workspace-thumbnail-placeholder">Завантаження…</span>
                    )}
                    <strong>{pageNumber}</strong>
                  </button>
                  <label className="workspace-thumbnail-export-mark" title="Позначити сторінку для експорту">
                    <input
                      type="checkbox"
                      checked={markedExportPages.has(pageNumber)}
                      onChange={() => toggleMarkedExportPage(pageNumber)}
                    />
                    <span className="visually-hidden">Позначити сторінку {pageNumber} для експорту</span>
                  </label>
                </div>
              ))}
              {thumbnailPlan.mountedPages.at(-1) && thumbnailPlan.mountedPages.at(-1)! < pdfPageCount ? (
                <button
                  type="button"
                  className="workspace-thumbnail-jump"
                  onClick={() => setPdfPageNumber(pdfPageCount)}
                >
                  …{pdfPageCount}
                </button>
              ) : null}
              </nav>
            ) : null}
            <div ref={pdfPageViewportRef} className="workspace-pdf-page-viewport">
              {rotationControl}
              {rotationCropNotice}
              <div
                ref={selectionStageRef}
                className={`workspace-image-selection-stage workspace-pdf-selection-stage ${selectionMode ? "selecting" : ""} ${
                  isPanning ? "panning" : ""
                }`}
                style={{ transform: imageTransform }}
                onPointerDown={beginImageInteraction}
                onPointerMove={updateImageInteraction}
                onPointerUp={finishImageInteraction}
                onPointerCancel={finishImageInteraction}
              >
                {visibleFastPagePreview && !pdfPageReady ? (
                  <img
                    className="workspace-pdf-fast-preview"
                    src={visibleFastPagePreview.url}
                    alt={`${activeScan.name}, сторінка ${pdfPageNumber}`}
                    width={visibleFastPagePreview.width}
                    height={visibleFastPagePreview.height}
                    style={imageFilterStyle}
                    draggable={false}
                    onLoad={() => requestFitDocumentView("page", rotationValueRef.current)}
                  />
                ) : null}
                <canvas
                  ref={pdfCanvasRef}
                  className={!pdfPageReady ? "workspace-pdf-canvas-pending" : undefined}
                  aria-label={activeScan.name}
                  style={imageFilterStyle}
                />
                {cropRect ? (
                  <span
                    className={`workspace-selection-rect ${selectionMode ? "editable" : ""}`}
                    style={{
                      left: cropRect.x,
                      top: cropRect.y,
                      width: cropRect.width,
                      height: cropRect.height,
                    }}
                    onPointerDown={selectionMode && viewerV2Enabled ? beginCropMove : undefined}
                  >
                    {selectionMode && viewerV2Enabled ? CROP_RESIZE_HANDLES.map((handle) => (
                      <span
                        key={handle}
                        className="workspace-selection-handle"
                        data-handle={handle}
                        onPointerDown={(event) => beginCropResize(handle, event)}
                      />
                    )) : null}
                  </span>
                ) : null}
                {selectionMode ? (
                  <span className="workspace-selection-hint">
                    Протягніть рамку по фрагменту PDF-сторінки
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : kind === "web" && blobUrl ? (
          <iframe title={activeScan.name} src={blobUrl} />
        ) : null}
        {(loading || pdfRendering) && blobUrl ? (
          <div className="workspace-page-loading">
            {visibleFastPagePreview && !pdfPageReady
              ? "Сторінку показано · готуємо інструменти PDF…"
              : "Завантажуємо сторінку…"}
          </div>
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
                <label className="workspace-page-input">
                  <span className="visually-hidden">Перейти до сторінки</span>
                  <input
                    type="number"
                    min={1}
                    max={navigationPageCount}
                    value={pageNumberInput}
                    onChange={(event) => setPageNumberInput(event.target.value)}
                    onBlur={applyPageNumberInput}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applyPageNumberInput();
                    }}
                  />
                  <span>/ {navigationPageCount}</span>
                </label>
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
                   onClick={() => {
                    if (viewerV2Enabled) {
                      setFindingCaptureMode("fragment");
                      setCropDialogOpen(true);
                    }
                    else void createFindingFromCrop("google-drive");
                  }}
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
            {viewerV2Enabled && isInteractivePdf ? (
              <button
                type="button"
                className="button button-primary"
                disabled={creatingCrop || pdfRendering}
                onClick={() => {
                  setFindingCaptureMode("full-page");
                  setCropDialogOpen(true);
                }}
              >
                Знахідка зі сторінки
              </button>
            ) : null}
            {viewerV2Enabled && isInteractivePdf ? (
              <button type="button" className="button button-secondary" onClick={openPdfExport}>
                Експорт сторінок
              </button>
            ) : null}
          </>
        ) : null}
        <button
          type="button"
          className="button button-secondary"
          onClick={() => void run(() => activeScan.storage === "external-url" ? openScan(activeScan) : downloadScan(activeScan))}
        >
          {activeScan.storage === "external-url" ? "Відкрити джерело" : "Завантажити"}
        </button>
      </div>
      {viewerV2Enabled && exportOpen ? (
        <div className="workspace-export-backdrop" role="presentation" onMouseDown={closePdfExport}>
          <section
            className="workspace-export-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-export-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="workspace-export-header">
              <div>
                <span className="eyebrow">PDF-експорт</span>
                <h3 id="workspace-export-title">Зберегти сторінки</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={closePdfExport}
                aria-label="Закрити експорт"
              >
                ×
              </button>
            </div>
            <label>
              <span>Сторінки</span>
              <input
                value={exportRange}
                onChange={(event) => setExportRange(event.target.value)}
                placeholder="Наприклад: 1-5, 8, 12-15"
                disabled={exporting}
              />
              <small>Поточна сторінка: {pdfPageNumber}. У документі: {pdfPageCount}.</small>
            </label>
            <div className="workspace-export-range-shortcuts" aria-label="Швидкий вибір сторінок">
              <button
                type="button"
                className="button button-secondary"
                disabled={exporting}
                onClick={() => setExportRange(String(pdfPageNumber))}
              >
                Поточна
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={exporting || markedExportPages.size === 0}
                onClick={() => setExportRange([...markedExportPages].sort((left, right) => left - right).join(", "))}
              >
                Позначені ({markedExportPages.size})
              </button>
              {markedExportPages.size > 0 ? (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={exporting}
                  onClick={() => setMarkedExportPages(new Set())}
                >
                  Очистити позначення
                </button>
              ) : null}
            </div>
            <label>
              <span>Формат</span>
              <select
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value as PdfExportFormat)}
                disabled={exporting}
              >
                <option value="pdf">Один PDF (автоматичний режим)</option>
                <option value="png">PNG (одна сторінка)</option>
                <option value="jpeg">JPEG (одна сторінка)</option>
                <option value="zip-png">ZIP із PNG</option>
                <option value="zip-jpeg">ZIP із JPEG</option>
              </select>
            </label>
            {pdfExportUsesRasterizedPages ? (
              <div className="workspace-export-message" aria-live="polite">
                <span>
                  Великий PDF або файл невідомого розміру: переглядач завантажить лише вибрані сторінки
                  й збере їх у новий PDF як зображення. Увесь оригінал у пам’ять не потрапить.
                </span>
              </div>
            ) : null}
            {exportFormat !== "pdf" || pdfExportUsesRasterizedPages ? (
              <div className="workspace-export-image-options">
                <label>
                  <span>Масштаб зображення</span>
                  <select
                    value={exportImageScale}
                    onChange={(event) => setExportImageScale(Number(event.target.value) as PdfExportImageScale)}
                    disabled={exporting}
                  >
                    <option value={1}>1× — компактний</option>
                    <option value={1.5}>1,5× — збалансований</option>
                    <option value={2}>2× — деталізований</option>
                  </select>
                </label>
                {exportFormat === "jpeg" || exportFormat === "zip-jpeg" || pdfExportUsesRasterizedPages ? (
                  <label>
                    <span>Якість JPEG</span>
                    <select
                      value={exportJpegQuality}
                      onChange={(event) => setExportJpegQuality(Number(event.target.value) as PdfExportJpegQuality)}
                      disabled={exporting}
                    >
                      <option value={70}>70% — менший файл</option>
                      <option value={85}>85% — рекомендовано</option>
                      <option value={95}>95% — найвища якість</option>
                    </select>
                  </label>
                ) : null}
              </div>
            ) : null}
            <fieldset>
              <legend>Місце збереження</legend>
              <label>
                <input
                  type="radio"
                  name="pdf-export-destination"
                  checked={exportDestination === "download"}
                  onChange={() => setExportDestination("download")}
                  disabled={exporting}
                />
                На комп’ютер
              </label>
              <label>
                <input
                  type="radio"
                  name="pdf-export-destination"
                  checked={exportDestination === "google-drive"}
                  onChange={() => setExportDestination("google-drive")}
                  disabled={exporting || !sourceContext}
                />
                У Google Drive
              </label>
            </fieldset>
            {exportDestination === "google-drive" ? (
              <div className="workspace-export-drive-folder">
                <div>
                  <strong>Папка Google Drive</strong>
                  <span>
                    {exportDriveFolder
                      ? exportDriveFolder.name
                      : "За замовчуванням: «Експорт документів» у папці проєкту"}
                  </span>
                </div>
                <div className="workspace-export-drive-folder-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={exporting || !sourceContext}
                    onClick={() => void chooseExportDriveFolder()}
                  >
                    {exportDriveFolder ? "Змінити папку" : "Обрати папку"}
                  </button>
                  {exportDriveFolder ? (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={exporting}
                      onClick={() => setExportDriveFolder(null)}
                    >
                      Використати типову
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {exportMessage ? (
              <div className="workspace-export-message" aria-live="polite">
                <span>{exportMessage}</span>
                {exportResultUrl ? (
                  <a href={exportResultUrl} target="_blank" rel="noreferrer">Відкрити в Google Drive</a>
                ) : null}
              </div>
            ) : null}
            <div className="workspace-export-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={closePdfExport}
              >
                {exporting ? "Скасувати" : "Закрити"}
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={exporting}
                onClick={() => void exportPdfPages()}
              >
                {exporting ? "Формування…" : "Зберегти"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {viewerV2Enabled && cropDialogOpen ? (
        <div className="workspace-export-backdrop" role="presentation" onMouseDown={closeCropDialog}>
          <section
            className="workspace-export-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-crop-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="workspace-export-header">
              <div>
                <span className="eyebrow">
                  {findingCaptureMode === "full-page" ? "Повна сторінка PDF" : "Фрагмент PDF"}
                </span>
                <h3 id="workspace-crop-title">Створити знахідку</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={closeCropDialog}
                aria-label="Закрити"
              >
                ×
              </button>
            </div>
            <p>
              {findingCaptureMode === "full-page"
                ? "Номер сторінки, її розміри та джерело будуть збережені у знахідці незалежно від вибраного варіанта."
                : "Координати та джерело будуть збережені у знахідці незалежно від вибраного варіанта."}
            </p>
            <fieldset>
              <legend>{findingCaptureMode === "full-page" ? "Копія сторінки" : "Копія фрагмента"}</legend>
              <label>
                <input
                  type="radio"
                  name="crop-snapshot-destination"
                  checked={cropSnapshotDestination === "google-drive"}
                  onChange={() => setCropSnapshotDestination("google-drive")}
                  disabled={creatingCrop}
                />
                Зберегти копію у Google Drive
              </label>
              <label>
                <input
                  type="radio"
                  name="crop-snapshot-destination"
                  checked={cropSnapshotDestination === "download"}
                  onChange={() => setCropSnapshotDestination("download")}
                  disabled={creatingCrop}
                />
                Завантажити копію на комп’ютер
              </label>
              <label>
                <input
                  type="radio"
                  name="crop-snapshot-destination"
                  checked={cropSnapshotDestination === "none"}
                  onChange={() => setCropSnapshotDestination("none")}
                  disabled={creatingCrop}
                />
                Без копії — лише джерело та координати
              </label>
            </fieldset>
            <div className="workspace-export-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={closeCropDialog}
              >
                Скасувати
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={creatingCrop}
                onClick={() => void createFindingFromCrop(cropSnapshotDestination, findingCaptureMode)}
              >
                {creatingCrop ? "Створення…" : "Продовжити"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
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
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
    return "web";
  }
  if (mimeType === "application/pdf" || extension === "pdf") return "pdf";
  if (["html", "htm"].includes(extension)) return "web";
  if (
    mimeType.startsWith("image/") ||
    ["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg"].includes(extension)
  ) {
    return "image";
  }
  return null;
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

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не вдалося підготувати зображення для внутрішнього перегляду."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result.startsWith("data:")) {
        reject(new Error("Браузер не повернув зображення для внутрішнього перегляду."));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([pdfJs, worker]) => {
      pdfJs.GlobalWorkerOptions.workerSrc = worker.default;
      preloadPdfWorker(worker.default);
      return pdfJs;
    }).catch((error: unknown) => {
      // A transient chunk/network failure must not poison every later attempt
      // to open a PDF during the lifetime of the page.
      pdfJsModulePromise = null;
      throw error;
    });
  }
  return pdfJsModulePromise;
}

function preloadPdfWorker(workerUrl: string): void {
  if (typeof document === "undefined" || !workerUrl) return;
  const alreadyPreloaded = [...document.head.querySelectorAll<HTMLLinkElement>(
    "link[data-pdf-worker-preload]",
  )].some((link) => link.dataset.pdfWorkerPreload === workerUrl);
  if (alreadyPreloaded) return;
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = workerUrl;
  link.crossOrigin = "anonymous";
  link.dataset.pdfWorkerPreload = workerUrl;
  document.head.append(link);
}

function scanLooksLikePdf(scan: ScanAttachment): boolean {
  const mimeType = scan.mimeType.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";
  return mimeType === "application/pdf" || /\.pdf$/iu.test(scan.name.trim());
}

function knownPdfPageCount(scan: ScanAttachment | null | undefined): number {
  const count = scan?.sourcePageCount;
  return Number.isSafeInteger(count) && (count ?? 0) > 0 ? count! : 0;
}

function preloadRemoteImage(url: string, signal: AbortSignal): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      const error = new Error("Image preload aborted");
      error.name = "AbortError";
      finish(error);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    image.decoding = "async";
    image.setAttribute("fetchpriority", "high");
    image.onload = () => finish();
    image.onerror = () => finish(new Error("Wikimedia page preview could not be loaded."));
    image.src = url;
    if (image.complete && image.naturalWidth > 0) finish();
  });
}

function scheduleViewerIdleWork(callback: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const idleWindow = window as Window & {
    requestIdleCallback?: (handler: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 1_000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 160);
  return () => window.clearTimeout(handle);
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

  const normalizedRect = sourceElement instanceof HTMLCanvasElement
    ? viewportRectToNormalizedCrop(
        rect,
        { width: renderedWidth, height: renderedHeight },
        normalizeQuarterRotation(rotation),
      )
    : {
        x: clampUnit(rect.x / renderedWidth),
        y: clampUnit(rect.y / renderedHeight),
        width: clampUnit(rect.width / renderedWidth),
        height: clampUnit(rect.height / renderedHeight),
      };

  return {
    documentId,
    sourceFileId: scan.storagePath || scan.id,
    pageNumber,
    rotation,
    rect: normalizedRect,
    createdAt: new Date().toISOString(),
  };
}

function fullPageDocumentSelection(
  documentId: string,
  scan: ScanAttachment,
  pageNumber: number,
  rotation: number,
): DocumentFragmentSelection {
  return {
    documentId,
    sourceFileId: scan.storagePath || scan.id,
    pageNumber,
    rotation: normalizeQuarterRotation(rotation),
    rect: { x: 0, y: 0, width: 1, height: 1 },
    createdAt: new Date().toISOString(),
  };
}

function fullRenderedElementCrop(element: HTMLElement, zoom: number): CropRect {
  const rendered = element.getBoundingClientRect();
  const safeZoom = Math.max(zoom, MIN_ZOOM);
  return {
    x: 0,
    y: 0,
    width: Math.max(1, rendered.width / safeZoom),
    height: Math.max(1, rendered.height / safeZoom),
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

function timestampedFile(blob: Blob, sourceName: string, mimeType: string): File {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return new File([blob], `${safeFilePart(sourceName.replace(/\.[^.]+$/, "")) || "fragment"}-${stamp}.png`, {
    type: mimeType,
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

async function renderPdfThumbnail(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw new DOMException("Thumbnail render cancelled", "AbortError");
  const page = await pdf.getPage(pageNumber);
  if (signal.aborted) {
    page.cleanup();
    throw new DOMException("Thumbnail render cancelled", "AbortError");
  }
  const baseViewport = page.getViewport({ scale: 1 });
  let canvasBudget: ReturnType<typeof boundPdfViewportScale>;
  try {
    canvasBudget = boundPdfViewportScale({
      baseWidth: baseViewport.width,
      baseHeight: baseViewport.height,
      requestedScale: PDF_THUMBNAIL_WIDTH / Math.max(1, baseViewport.width),
      maxPixels: PDF_VIEWER_MAX_CANVAS_PIXELS,
      maxSide: PDF_VIEWER_MAX_CANVAS_SIDE,
    });
  } catch (budgetError) {
    page.cleanup();
    throw budgetError;
  }
  const viewport = page.getViewport({ scale: canvasBudget.scale });
  const canvas = document.createElement("canvas");
  canvas.width = canvasBudget.pixelWidth;
  canvas.height = canvasBudget.pixelHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    page.cleanup();
    throw new Error("Браузер не зміг підготувати мініатюру PDF.");
  }
  const task = page.render({ canvas, viewport, background: "rgb(255,255,255)" });
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
    if (signal.aborted) throw new DOMException("Thumbnail render cancelled", "AbortError");
    const blob = await canvasToBlob(canvas, "image/jpeg");
    return URL.createObjectURL(blob);
  } finally {
    signal.removeEventListener("abort", cancel);
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

function createClientOperationId(prefix: string): string {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

function cachedPreviewNeedsRefresh(preview: CachedPreview, safetyWindowMs = 30_000): boolean {
  if (!preview.expiresAt) return false;
  const expiresAt = Date.parse(preview.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now() + safetyWindowMs;
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

function documentImageAdjustmentsEqual(
  left: DocumentImageAdjustments,
  right: Readonly<DocumentImageAdjustments>,
): boolean {
  return (
    left.brightness === right.brightness
    && left.contrast === right.contrast
    && left.grayscale === right.grayscale
    && left.sepia === right.sepia
    && left.invert === right.invert
    && left.saturation === right.saturation
    && left.sharpness === right.sharpness
  );
}

function safeFilePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function positiveViewerSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function waitForViewerPromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Viewer operation cancelled", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => {
      reject(new DOMException("Viewer operation cancelled", "AbortError"));
    });
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function throwIfViewerOperationAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Viewer operation cancelled", "AbortError");
  }
}

function isViewerOperationAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
