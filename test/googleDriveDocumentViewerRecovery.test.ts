import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyDocumentSourceViewerError,
  shouldOfferGoogleDriveReconnect,
} from "../src/services/documentSourceViewerError.ts";
import {
  DocumentSourceError,
  type DocumentSourceErrorCode,
} from "../src/services/document-sources/errors.ts";

const driveScan = { storage: "google-drive" as const };
const viewerSource = readFileSync(
  new URL("../src/components/DocumentWorkspaceViewer.tsx", import.meta.url),
  "utf8",
);

test("document viewer keeps the typed Google Drive recovery code and action", () => {
  for (const code of ["OAUTH_REQUIRED", "GOOGLE_DRIVE_PERMISSION_DENIED"] as const) {
    const error = classifyDocumentSourceViewerError(new DocumentSourceError(code), driveScan);

    assert.equal(error?.code, code);
    assert.equal(error?.action, "connect_google_drive");
    assert.equal(shouldOfferGoogleDriveReconnect(error, driveScan), true);
  }
});

test("document viewer never offers Drive reconnection for unrelated failures", () => {
  const unrelatedCodes: DocumentSourceErrorCode[] = [
    "SOURCE_NOT_FOUND",
    "GOOGLE_DRIVE_QUOTA_EXCEEDED",
    "PDF_CORRUPT",
    "SOURCE_NOT_PDF",
    "NETWORK_ERROR",
    "TIMEOUT",
    "ACCESS_DENIED",
  ];

  for (const code of unrelatedCodes) {
    const error = classifyDocumentSourceViewerError(new DocumentSourceError(code), driveScan);
    assert.equal(error?.code, code);
    assert.equal(
      shouldOfferGoogleDriveReconnect(error, driveScan),
      false,
      `${code} must not show a misleading Google Drive OAuth action`,
    );
  }
});

test("legacy Google Drive failures are classified before choosing a recovery action", () => {
  const missing = classifyDocumentSourceViewerError({ status: 404 }, driveScan);
  const quota = classifyDocumentSourceViewerError({ status: 429 }, driveScan);
  const expired = classifyDocumentSourceViewerError({ status: 401 }, driveScan);

  assert.equal(missing?.code, "SOURCE_NOT_FOUND");
  assert.equal(quota?.code, "GOOGLE_DRIVE_QUOTA_EXCEEDED");
  assert.equal(expired?.code, "OAUTH_REQUIRED");
  assert.equal(shouldOfferGoogleDriveReconnect(missing, driveScan), false);
  assert.equal(shouldOfferGoogleDriveReconnect(quota, driveScan), false);
  assert.equal(shouldOfferGoogleDriveReconnect(expired, driveScan), true);
});

test("provider identity prevents a generic OAuth error from becoming a Drive CTA", () => {
  const directPdfScan = { storage: "external-url" as const, sourceProvider: "direct_pdf" as const };
  const driveBackedExternalScan = { storage: "external-url" as const, sourceProvider: "google_drive" as const };
  const oauthError = new DocumentSourceError("OAUTH_REQUIRED");

  const directError = classifyDocumentSourceViewerError(oauthError, directPdfScan);
  const driveError = classifyDocumentSourceViewerError(oauthError, driveBackedExternalScan);

  assert.equal(shouldOfferGoogleDriveReconnect(directError, directPdfScan), false);
  assert.equal(shouldOfferGoogleDriveReconnect(driveError, driveBackedExternalScan), true);
});

test("DocumentWorkspaceViewer carries the typed source error into its Drive CTA decision", () => {
  assert.match(
    viewerSource,
    /const \[documentSourceError, setDocumentSourceError\] = useState<PublicDocumentSourceError \| null>\(null\)/u,
  );
  assert.match(
    viewerSource,
    /const sourceError = classifyDocumentSourceViewerError\(loadError, currentScan\);\s*setDocumentSourceError\(sourceError\)/u,
  );
  assert.match(
    viewerSource,
    /shouldOfferGoogleDriveReconnect\(documentSourceError, activeScan\)/u,
  );
  assert.match(
    viewerSource,
    /const recoveryError = documentSourceError;[\s\S]{0,500}catch \(reconnectError\) \{\s*setDocumentSourceError\(recoveryError\);\s*throw reconnectError;/u,
  );
  assert.doesNotMatch(
    viewerSource,
    /\{activeScan\.storage === "google-drive" \? \(\s*<button[\s\S]{0,300}Підключити Google Drive/u,
  );
});
