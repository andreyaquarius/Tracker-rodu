import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccessContext,
  ResolvedPdfSource,
  StoredDocumentSource,
} from "../src/services/document-sources/contracts.ts";
import {
  DOCUMENT_SOURCE_ERROR_MESSAGES_UK,
  DocumentSourceError,
  GoogleDrivePdfSourceAdapter,
  mapGoogleDriveSourceError,
  parseGoogleDriveFileReference,
} from "../src/services/document-sources/index.ts";
import type { GoogleDriveFileMetadata } from "../src/services/googleDriveStorage.ts";

const FILE_ID = "1AbCdef_ghijklmnopQRstuV";

test("Google Drive parser supports documented file share URL shapes", () => {
  for (const input of [
    `https://drive.google.com/file/d/${FILE_ID}/view`,
    `https://drive.google.com/file/u/0/d/${FILE_ID}/preview`,
    `https://drive.google.com/open?id=${FILE_ID}`,
    `https://drive.google.com/uc?export=download&id=${FILE_ID}`,
    `https://docs.google.com/document/d/${FILE_ID}/edit`,
  ]) {
    assert.deepEqual(parseGoogleDriveFileReference(input), {
      fileId: FILE_ID,
      canonicalUrl: `https://drive.google.com/file/d/${FILE_ID}/view`,
    });
  }
});

test("Google Drive parser rejects folders, non-Drive hosts and malformed IDs", () => {
  for (const input of [
    `https://drive.google.com/drive/folders/${FILE_ID}`,
    `https://evil.example.org/file/d/${FILE_ID}/view`,
    "https://drive.google.com/open?id=short",
    `http://drive.google.com/file/d/${FILE_ID}/view`,
  ]) {
    assert.equal(parseGoogleDriveFileReference(input), null);
  }
});

test("Google Drive adapter resolves PDF metadata without exposing OAuth credentials", async () => {
  let requestedFileId = "";
  const adapter = new GoogleDrivePdfSourceAdapter({
    getFileMetadata: async (fileId) => {
      requestedFileId = fileId;
      return pdfMetadata();
    },
  });
  const input = `https://drive.google.com/open?export=download&id=${FILE_ID}`;

  const source = await adapter.resolve(input, context());

  assert.equal(requestedFileId, FILE_ID);
  assert.equal(source.provider, "google_drive");
  assert.equal(source.providerFileId, FILE_ID);
  assert.equal(source.originalUrl, input);
  assert.equal(source.canonicalUrl, `https://drive.google.com/file/d/${FILE_ID}/view`);
  assert.equal(source.sourcePageUrl, source.canonicalUrl);
  assert.equal(source.mimeType, "application/pdf");
  assert.equal(source.fileSizeBytes, 123_456);
  assert.equal(source.accessMode, "google_drive_api");
  assert.deepEqual(source.fingerprint, {
    md5: "md5-value",
    revisionId: "revision-7",
    modifiedTime: "2026-07-30T12:30:00.000Z",
    contentLength: 123_456,
  });
  assert.equal(JSON.stringify(source).includes("oauth-token"), false);
});

test("Google Drive adapter rejects folders and Google-native documents as non-PDF", async () => {
  for (const mimeType of [
    "application/vnd.google-apps.folder",
    "application/vnd.google-apps.document",
    "image/jpeg",
  ]) {
    const adapter = new GoogleDrivePdfSourceAdapter({
      getFileMetadata: async () => ({ ...pdfMetadata(), mimeType }),
    });
    await assert.rejects(
      adapter.resolve(`https://drive.google.com/file/d/${FILE_ID}/view`, context()),
      (error) => error instanceof DocumentSourceError && error.code === "SOURCE_NOT_PDF",
    );
  }
});

test("Google Drive adapter never persists resource keys or OAuth-like URL secrets", async () => {
  const adapter = new GoogleDrivePdfSourceAdapter({
    getFileMetadata: async () => pdfMetadata(),
  });
  await assert.rejects(
    adapter.resolve(
      `https://drive.google.com/open?id=${FILE_ID}&resourcekey=secret-resource-key`,
      context(),
    ),
    (error) => error instanceof DocumentSourceError
      && error.code === "SENSITIVE_URL_NOT_PERSISTABLE",
  );
});

test("Google Drive access mints an opaque gateway session without exposing OAuth to PDF.js", async () => {
  let requestedFileId = "";
  let forwardedAccessToken = "";
  const adapter = new GoogleDrivePdfSourceAdapter({
    createDownloadAccess: async (fileId) => {
      requestedFileId = fileId;
      return {
        url: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
        httpHeaders: { Authorization: "Bearer ephemeral-oauth-token" },
        expiresAt: "2026-07-30T13:00:00.000Z",
      };
    },
    gateway: {
      probeDirectPdf: async () => {
        throw new Error("not used");
      },
      createAccessSession: async (_source, _context, providerAccess) => {
        forwardedAccessToken = providerAccess?.googleDriveAccessToken ?? "";
        return {
          accessMode: "google_drive_api",
          url: "https://project.supabase.co/functions/v1/pdf-gateway/stream/opaque-session",
          httpHeaders: { Authorization: "Bearer app-user-jwt", apikey: "publishable-key" },
          expiresAt: "2026-07-30T12:59:00.000Z",
          fingerprint: { revisionId: "revision-7" },
        };
      },
    },
  });
  const source = storedSource(await resolvedSource());

  const descriptor = await adapter.createAccessDescriptor(source, context());

  assert.equal(requestedFileId, FILE_ID);
  assert.equal(forwardedAccessToken, "ephemeral-oauth-token");
  assert.equal(descriptor.accessMode, "google_drive_api");
  assert.equal(
    descriptor.url,
    "https://project.supabase.co/functions/v1/pdf-gateway/stream/opaque-session",
  );
  assert.deepEqual(descriptor.httpHeaders, {
    Authorization: "Bearer app-user-jwt",
    apikey: "publishable-key",
  });
  assert.equal(descriptor.expiresAt, "2026-07-30T12:59:00.000Z");
  assert.equal(descriptor.url.includes("ephemeral-oauth-token"), false);
  assert.equal(JSON.stringify(descriptor).includes("ephemeral-oauth-token"), false);
});

test("Google Drive revalidation reports a changed Drive revision", async () => {
  const adapter = new GoogleDrivePdfSourceAdapter({
    getFileMetadata: async () => ({
      ...pdfMetadata(),
      headRevisionId: "revision-8",
      modifiedTime: "2026-07-30T13:00:00.000Z",
    }),
    now: () => new Date("2026-07-30T13:01:00.000Z"),
  });
  const source = storedSource(await resolvedSource());

  const result = await adapter.revalidate(source, context());

  assert.equal(result.status, "changed");
  if (result.status === "changed") {
    assert.equal(result.oldFingerprint.revisionId, "revision-7");
    assert.equal(result.newFingerprint.revisionId, "revision-8");
    assert.equal(result.validatedAt, "2026-07-30T13:01:00.000Z");
  }
});

test("Google Drive failures use stable localized source errors", () => {
  const oauth = mapGoogleDriveSourceError(Object.assign(new Error("OAuth access token missing"), {
    status: 401,
  }));
  assert.equal(oauth.code, "OAUTH_REQUIRED");
  assert.equal(oauth.message, DOCUMENT_SOURCE_ERROR_MESSAGES_UK.OAUTH_REQUIRED);
  assert.equal(oauth.action, "connect_google_drive");

  const quota = mapGoogleDriveSourceError(Object.assign(new Error("userRateLimitExceeded"), {
    status: 403,
  }));
  assert.equal(quota.code, "GOOGLE_DRIVE_QUOTA_EXCEEDED");

  const denied = mapGoogleDriveSourceError(Object.assign(new Error("Forbidden"), { status: 403 }));
  assert.equal(denied.code, "GOOGLE_DRIVE_PERMISSION_DENIED");
});

function pdfMetadata(): GoogleDriveFileMetadata {
  return {
    id: FILE_ID,
    name: "Archive book.pdf",
    mimeType: "application/pdf",
    size: 123_456,
    webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
    md5Checksum: "md5-value",
    modifiedTime: "2026-07-30T12:30:00.000Z",
    headRevisionId: "revision-7",
  };
}

async function resolvedSource(): Promise<ResolvedPdfSource> {
  return new GoogleDrivePdfSourceAdapter({
    getFileMetadata: async () => pdfMetadata(),
  }).resolve(`https://drive.google.com/file/d/${FILE_ID}/view`, context());
}

function storedSource(source: ResolvedPdfSource): StoredDocumentSource {
  return {
    ...source,
    id: "source-1",
    documentId: "document-1",
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function context(): AccessContext {
  return {
    userId: "user-1",
    projectId: "project-1",
    documentId: "document-1",
    requestId: "request-1",
  };
}
