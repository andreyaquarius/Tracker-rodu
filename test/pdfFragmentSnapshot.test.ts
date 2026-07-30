import assert from "node:assert/strict";
import test from "node:test";
import {
  renderPdfFragmentSnapshot,
  type PdfFragmentSnapshotDocument,
  type PdfFragmentSnapshotPage,
  type PdfSnapshotCanvas,
  type PdfSnapshotCanvasContext,
} from "../src/services/pdfFragmentSnapshot.ts";

test("renders only the requested document page and precisely crops a rotated canonical selection", async () => {
  const fixture = snapshotFixture();
  const requestedPages: number[] = [];
  const document = {
    async getPage(pageNumber: number) {
      requestedPages.push(pageNumber);
      return fixture.page;
    },
  } as unknown as PdfFragmentSnapshotDocument;

  const blob = await renderPdfFragmentSnapshot({
    document,
    pageNumber: 7,
    crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
    rotation: 90,
    scale: 2,
    mimeType: "image/png",
    canvasFactory: fixture.canvasFactory,
  });

  assert.deepEqual(requestedPages, [7]);
  assert.equal(fixture.renderCalls.length, 1);
  assert.equal(fixture.renderCalls[0]?.viewport.width, 1_600);
  assert.equal(fixture.renderCalls[0]?.viewport.height, 1_200);
  assert.equal(fixture.canvases.length, 2);
  assertNumbersAlmostEqual(fixture.canvases[1]?.drawCalls[0]?.slice(1) as number[], [
    880, 120, 400, 360,
    0, 0, 400, 360,
  ]);
  assert.equal(blob.type, "image/png");
  assert.equal(fixture.canvases[0]?.width, 0, "full-page render canvas is released");
  assert.equal(fixture.canvases[1]?.height, 0, "crop canvas is released after encoding");
});

test("accepts an already loaded page and caps scale, output side and full-page resources", async () => {
  const fixture = snapshotFixture({ width: 10_000, height: 20_000 });
  const blob = await renderPdfFragmentSnapshot({
    page: fixture.page,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    scale: 10,
    maxScale: 10,
    maxSide: 300,
    maxCanvasSide: 1_000,
    maxRenderPixels: 500_000,
    mimeType: "image/jpeg",
    jpegQuality: 0.75,
    canvasFactory: fixture.canvasFactory,
  });

  const renderCanvas = fixture.canvases[0]!;
  const outputCanvas = fixture.canvases[1]!;
  assert.ok(fixture.renderCalls[0]!.canvasWidth <= 1_000);
  assert.ok(fixture.renderCalls[0]!.canvasHeight <= 1_000);
  assert.ok(fixture.renderCalls[0]!.canvasWidth * fixture.renderCalls[0]!.canvasHeight <= 500_000);
  assert.ok(outputCanvas.initialWidth <= 300);
  assert.ok(outputCanvas.initialHeight <= 300);
  assert.deepEqual(outputCanvas.fillCalls, [[0, 0, outputCanvas.initialWidth, outputCanvas.initialHeight]]);
  assert.equal(blob.type, "image/jpeg");
  assert.equal(renderCanvas.width, 0);
});

test("AbortSignal cancels the active PDF.js render task and releases its canvas", async () => {
  const fixture = snapshotFixture({ deferredRender: true });
  const controller = new AbortController();
  const snapshot = renderPdfFragmentSnapshot({
    page: fixture.page,
    crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    rotation: 0,
    signal: controller.signal,
    canvasFactory: fixture.canvasFactory,
  });
  await tick();
  controller.abort();

  await assert.rejects(snapshot, (error) => error instanceof Error && error.name === "AbortError");
  assert.equal(fixture.cancelled, true);
  assert.equal(fixture.canvases[0]?.width, 0);
  assert.equal(fixture.canvases.length, 1, "crop canvas is never allocated after cancellation");
});

test("aborted document lookup stops before a page render starts", async () => {
  const controller = new AbortController();
  controller.abort();
  let getPageCalls = 0;
  const document = {
    async getPage() {
      getPageCalls += 1;
      throw new Error("must not run");
    },
  } as unknown as PdfFragmentSnapshotDocument;

  await assert.rejects(renderPdfFragmentSnapshot({
    document,
    pageNumber: 1,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    signal: controller.signal,
    canvasFactory: snapshotFixture().canvasFactory,
  }), (error) => error instanceof Error && error.name === "AbortError");
  assert.equal(getPageCalls, 0);
});

test("rejects empty crops and invalid one-based document pages", async () => {
  const fixture = snapshotFixture();
  await assert.rejects(renderPdfFragmentSnapshot({
    page: fixture.page,
    crop: { x: 0.2, y: 0.2, width: 0, height: 0.3 },
    rotation: 0,
    canvasFactory: fixture.canvasFactory,
  }), /positive width and height/u);
  assert.equal(fixture.renderCalls.length, 0);

  await assert.rejects(renderPdfFragmentSnapshot({
    document: { getPage: async () => fixture.page } as unknown as PdfFragmentSnapshotDocument,
    pageNumber: 0,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    canvasFactory: fixture.canvasFactory,
  }), /positive one-based integer/u);
});

function snapshotFixture(options: {
  width?: number;
  height?: number;
  deferredRender?: boolean;
} = {}) {
  const width = options.width ?? 600;
  const height = options.height ?? 800;
  const canvases: FakeCanvas[] = [];
  const renderCalls: Array<{
    viewport: { width: number; height: number };
    canvasWidth: number;
    canvasHeight: number;
  }> = [];
  let cancelled = false;
  let rejectRender: ((error: unknown) => void) | null = null;
  const page = {
    getViewport({ scale, rotation = 0 }: { scale: number; rotation?: number }) {
      const quarterTurn = rotation === 90 || rotation === 270;
      return {
        width: (quarterTurn ? height : width) * scale,
        height: (quarterTurn ? width : height) * scale,
      };
    },
    render({ canvas, viewport }: {
      canvas: HTMLCanvasElement;
      viewport: { width: number; height: number };
    }) {
      renderCalls.push({
        viewport,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      });
      let promise: Promise<void> = Promise.resolve();
      if (options.deferredRender) {
        promise = new Promise<void>((_resolve, reject) => {
          rejectRender = reject;
        });
      }
      return {
        promise,
        cancel() {
          cancelled = true;
          rejectRender?.(new Error("RenderingCancelledException"));
        },
      };
    },
  } as unknown as PdfFragmentSnapshotPage;

  return {
    page,
    canvases,
    renderCalls,
    get cancelled() { return cancelled; },
    canvasFactory(widthValue: number, heightValue: number): PdfSnapshotCanvas {
      const canvas = new FakeCanvas(widthValue, heightValue);
      canvases.push(canvas);
      return canvas;
    },
  };
}

class FakeCanvas implements PdfSnapshotCanvas {
  width: number;
  height: number;
  readonly initialWidth: number;
  readonly initialHeight: number;
  readonly drawCalls: unknown[][] = [];
  readonly fillCalls: number[][] = [];
  readonly context: PdfSnapshotCanvasContext;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.initialWidth = width;
    this.initialHeight = height;
    this.context = {
      fillStyle: "",
      fillRect: (x, y, fillWidth, fillHeight) => {
        this.fillCalls.push([x, y, fillWidth, fillHeight]);
      },
      drawImage: (image, ...coordinates) => {
        this.drawCalls.push([image, ...coordinates]);
      },
    };
  }

  getContext(): PdfSnapshotCanvasContext {
    return this.context;
  }

  async convertToBlob(options?: { type?: string }): Promise<Blob> {
    return new Blob(["snapshot"], { type: options?.type ?? "image/png" });
  }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function assertNumbersAlmostEqual(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index]! - expected[index]!) < 1e-9,
      `index ${index}: expected ${expected[index]}, received ${actual[index]}`,
    );
  }
}
