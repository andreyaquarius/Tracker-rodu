import type { ScanAttachment } from "../types";
import {
  DocumentSourceError,
  toPublicDocumentSourceError,
  type PublicDocumentSourceError,
} from "./document-sources/errors.ts";
import { mapGoogleDriveSourceError } from "./document-sources/googleDriveAdapter.ts";

export type DocumentSourceViewerScan = Pick<ScanAttachment, "storage" | "sourceProvider">;

export function classifyDocumentSourceViewerError(
  error: unknown,
  scan: DocumentSourceViewerScan,
): PublicDocumentSourceError | null {
  if (error instanceof DocumentSourceError) {
    return toPublicDocumentSourceError(error);
  }
  if (!isGoogleDriveDocumentSource(scan)) return null;
  return toPublicDocumentSourceError(mapGoogleDriveSourceError(error));
}

export function shouldOfferGoogleDriveReconnect(
  error: PublicDocumentSourceError | null,
  scan: DocumentSourceViewerScan,
): boolean {
  if (!error || !isGoogleDriveDocumentSource(scan)) return false;
  return error.action === "connect_google_drive"
    && (error.code === "OAUTH_REQUIRED" || error.code === "GOOGLE_DRIVE_PERMISSION_DENIED");
}

function isGoogleDriveDocumentSource(scan: DocumentSourceViewerScan): boolean {
  return scan.storage === "google-drive" || scan.sourceProvider === "google_drive";
}
