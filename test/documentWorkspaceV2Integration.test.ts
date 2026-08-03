import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewer = readFileSync(
  new URL("../src/components/DocumentWorkspaceViewer.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const crud = readFileSync(new URL("../src/pages/CrudPage.tsx", import.meta.url), "utf8");
const deployment = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const viteConfig = readFileSync(new URL("../vite.config.mjs", import.meta.url), "utf8");

test("Viewer v2 mounts a bounded thumbnail window and cancels stale main renders", () => {
  assert.match(viewer, /createVirtualizedThumbnailPlan\(\{/u);
  assert.match(viewer, /BoundedThumbnailRenderQueue/u);
  assert.match(viewer, /LatestPdfRenderController/u);
  assert.match(viewer, /const lease = renderController\.begin\(\)/u);
  assert.match(viewer, /lease\.track\(page\.render/u);
  assert.match(viewer, /return \(\) => renderController\.cancel\(\)/u);
  assert.match(viewer, /className="workspace-pdf-thumbnails"/u);
  assert.doesNotMatch(viewer, /Array\.from\(\{\s*length:\s*pdfPageCount/u);
});

test("large PDF first-page rendering is prioritized over thumbnails", () => {
  assert.match(viewer, /const PDF_RENDER_SCALE = 1/u);
  assert.match(viewer, /const PDFJS_WASM_URL = `\$\{import\.meta\.env\.BASE_URL\}pdfjs-wasm\/`/u);
  assert.match(viewer, /wasmUrl:\s*PDFJS_WASM_URL/u);
  assert.match(viewer, /useWasm:\s*true/u);
  assert.match(viewer, /useWorkerFetch:\s*true/u);
  assert.match(viewer, /if \(pdfRendering\) \{[\s\S]*?queue\.cancelAll\(\)/u);
  assert.match(viewer, /scheduleViewerIdleWork\(\(\) => \{/u);
  assert.match(viewer, /if \(!currentScan \|\| !scanLooksLikePdf\(currentScan\)\) return/u);
  assert.match(viewer, /void loadPdfJs\(\)\.catch/u);
  assert.match(viewer, /preloadPdfWorker\(worker\.default\)/u);
  assert.match(viewer, /resolveMediaWikiPdfPagePreview/u);
  assert.match(viewer, /className="workspace-pdf-fast-preview"/u);
  assert.match(viewer, /knownPdfPageCount\(currentScan\)/u);
  assert.match(viteConfig, /pdfJsWasmAssets\(\)/u);
  assert.match(viteConfig, /fileName:\s*`\$\{PDFJS_WASM_PUBLIC_PATH\}\/\$\{name\}`/u);
});

test("Viewer v2 UI and source sessions have a complete feature-flag rollback", () => {
  assert.match(app, /VITE_EXTERNAL_PDF_VIEWER_V2/u);
  assert.match(app, /externalPdfViewerV2Enabled && workspace && account/u);
  assert.match(viewer, /if \(!sourceContext\?\.enabled\) return null/u);
  assert.match(viewer, /const viewerV2Enabled = sourceContext\?\.enabled === true/u);
  assert.match(viewer, /viewerV2Enabled && exportOpen/u);
  assert.match(viewer, /viewerV2Enabled \? \([\s\S]*?workspace-pdf-thumbnails/u);
  assert.match(viewer, /kind !== "pdf" \|\| !viewerV2Enabled/u);
  assert.match(viewer, /const pdfRotationLayers = splitPdfRotation\(viewerV2Enabled \? rotation : 0\)/u);
  assert.match(viewer, /const effectivePdfRotation = pdfRotationLayers\.renderRotation/u);
  assert.match(viewer, /viewerV2Enabled \? viewer\.restore\?\.pageIndex : undefined/u);
  assert.match(viewer, /kind === "image" \|\| \(viewerV2Enabled && isInteractivePdf\)/u);
});

test("production build receives the viewer flag and every bounded PDF limit", () => {
  for (const variable of [
    "VITE_EXTERNAL_PDF_VIEWER_V2",
    "VITE_PDF_CLIENT_EXPORT_MAX_BYTES",
    "VITE_PDF_CLIENT_EXPORT_MAX_PAGES",
    "VITE_PDF_EXPORT_MAX_IMAGE_SIDE",
    "VITE_PDF_EXPORT_IMAGE_SCALE",
    "VITE_PDF_EXPORT_MAX_ZIP_PIXELS",
    "VITE_PDF_EXPORT_MAX_ZIP_MEMORY_BYTES",
    "VITE_PDF_VIEWER_RANGE_CHUNK_SIZE",
    "VITE_PDF_VIEWER_MAX_DEVICE_PIXEL_RATIO",
    "VITE_PDF_VIEWER_MAX_RENDER_SCALE",
    "VITE_PDF_VIEWER_MAX_CONCURRENT_RENDERS",
    "VITE_PDF_VIEWER_MAX_CANVAS_PIXELS",
    "VITE_PDF_VIEWER_MAX_CANVAS_SIDE",
  ]) {
    assert.match(deployment, new RegExp(`${variable}:`));
  }
});

test("main PDF pages and thumbnails share the same absolute canvas resource budget", () => {
  assert.match(viewer, /boundPdfViewportScale\(\{/u);
  assert.match(viewer, /requestedScale:\s*renderScale/u);
  assert.match(viewer, /requestedScale:\s*PDF_THUMBNAIL_WIDTH/u);
  assert.match(viewer, /maxPixels:\s*PDF_VIEWER_MAX_CANVAS_PIXELS/u);
  assert.match(viewer, /maxSide:\s*PDF_VIEWER_MAX_CANVAS_SIDE/u);
  assert.match(viewer, /renderError instanceof PdfCanvasBudgetError/u);
  assert.match(viewer, /ресурсний ліміт переглядача/u);
});

test("viewer operations can cancel pending PDF loads, crops and Drive exports", () => {
  assert.match(viewer, /pdfLoadingTasksRef/u);
  assert.match(viewer, /loadPdfDocument\(activeScan, abortController\.signal\)/u);
  assert.match(viewer, /loadPdfDocument\(currentScan, abortController\.signal\)/u);
  assert.match(viewer, /saveScan\(croppedFile, "finding", \{[\s\S]*?signal: abortController\.signal/u);
  assert.match(viewer, /uploadFileToGoogleDrive\([\s\S]*?signal: abortController\.signal/u);
  assert.match(viewer, /const closePdfExport = \(\) => \{[\s\S]*?\.abort\(\)/u);
  assert.match(viewer, /const closeCropDialog = \(\) => \{[\s\S]*?\.abort\(\)/u);
  assert.match(viewer, /saveScan\(croppedFile, "finding", \{[\s\S]*?driveFolderPath:\s*\["Знахідки"\]/u);
});

test("Viewer v2 supports page jumps, fit, rotation and explicit exports", () => {
  assert.match(viewer, /applyPageNumberInput/u);
  assert.match(viewer, /fitPdfView\("width"\)/u);
  assert.match(viewer, /fitPdfView\("page"\)/u);
  assert.match(viewer, /rotateImage\(-90\)/u);
  assert.match(viewer, /Експорт сторінок/u);
  assert.match(viewer, /createPdfSubsetBlob/u);
  assert.match(viewer, /createRasterizedPdfSubsetBlob/u);
  assert.match(viewer, /choosePdfSubsetExportStrategy/u);
  assert.match(viewer, /pdfSubsetStrategy === "vector"[\s\S]*?pdfDocument\.getData\(\)/u);
  assert.match(viewer, /Великий PDF або файл невідомого розміру/u);
  assert.match(viewer, /createPageImagesZip/u);
  assert.match(viewer, /uploadFileToGoogleDrive/u);
  assert.match(viewer, /markedExportPages/u);
  assert.match(viewer, /Позначити сторінку \{pageNumber\} для експорту/u);
  assert.match(viewer, /Позначені \(\{markedExportPages\.size\}\)/u);
  assert.match(viewer, /pickGoogleDriveFolder\("Оберіть папку для експорту документа"\)/u);
  assert.match(viewer, /destinationFolderId:\s*exportDriveFolder\.id/u);
  assert.match(viewer, /google-drive-folder:\$\{exportDriveFolder\.id\}/u);
  assert.match(viewer, /За замовчуванням: «Експорт документів» у папці проєкту/u);
  assert.match(viewer, /1,5× — збалансований/u);
  assert.match(viewer, /85% — рекомендовано/u);
  assert.match(viewer, /renderPdfPageImage\([\s\S]*?imageExportOptions/u);
  assert.match(viewer, /createPageImagesZip\([\s\S]*?imageExportOptions/u);
  assert.match(viewer, /imageScale:\s*exportImageScale/u);
  assert.match(viewer, /jpegQuality:\s*exportJpegQuality \/ 100/u);
});

test("document image tools support manuscript filters and centered direct rotation without mutating the source", () => {
  assert.match(viewer, /Обробка рукописного документа/u);
  assert.match(viewer, /className="workspace-image-rotation-control"/u);
  assert.match(viewer, /beginRotationInteraction/u);
  assert.match(viewer, /Потягніть кругову стрілку/u);
  assert.match(viewer, /rotatedDocumentBounds/u);
  assert.match(viewer, /translate\(-50%, -50%\)/u);
  assert.match(viewer, /Інверсія кольорів/u);
  assert.match(viewer, /MANUSCRIPT_ADJUSTMENT_CONTROLS/u);
  assert.match(viewer, /documentImageCssFilter\(imageAdjustments, sharpenFilterId\)/u);
  assert.match(viewer, /documentSharpenKernel\(imageAdjustments\.sharpness\)/u);
  assert.match(viewer, /style=\{imageFilterStyle\}/u);
  assert.match(viewer, /const visualRotation = kind === "pdf"[\s\S]*?pdfPageReady[\s\S]*?finePdfRotation/u);
  assert.match(viewer, /cropRotationSupported/u);
  assert.match(viewer, /оригінальний файл залишається незмінним/u);
});

test("PDF provenance crosses the create form only as transient data and is inserted after finding save", () => {
  assert.match(viewer, /documentReferenceDraft/u);
  assert.match(viewer, /documentSourceId:\s*source\.id/u);
  assert.match(viewer, /sourceFingerprint:\s*\{ \.\.\.source\.fingerprint \}/u);
  assert.match(crud, /initial\.documentReferenceDraft/u);
  assert.match(crud, /defaults\.documentReferenceDraft/u);

  const saveFindingIndex = app.indexOf("const saveFinding =");
  const databaseSaveIndex = app.indexOf("saveProjectFinding(", saveFindingIndex);
  const referenceSaveIndex = app.indexOf("createFindingDocumentReference(projectId", saveFindingIndex);
  assert.ok(saveFindingIndex >= 0);
  assert.ok(databaseSaveIndex > saveFindingIndex);
  assert.ok(referenceSaveIndex > databaseSaveIndex, "the finding FK target must exist before provenance insert");
});

test("a finding can reopen its physical PDF page and normalized crop without rewriting provenance", () => {
  assert.match(viewer, /restore\?: FindingDocumentRestoreState/u);
  assert.match(viewer, /viewer\.restore\?\.pageIndex/u);
  assert.match(viewer, /findingDocumentSelectionViewportRect/u);
  assert.match(viewer, /sourceVersionStatus === "changed"/u);
  assert.match(viewer, /Зовнішній PDF було оновлено/u);
  assert.match(crud, /Відкрити сторінку PDF/u);
  assert.match(app, /resolveFindingDocumentReopenTargets/u);
  assert.match(app, /sourceVersionStatus:\s*target\.source\.versionStatus/u);
});
