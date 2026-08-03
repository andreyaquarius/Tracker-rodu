import assert from "node:assert/strict";
import test from "node:test";
import {
  GoogleDrivePublicError,
  googleDrivePublicMediaUrl,
  googleDrivePublicMetadataUrl,
  parseGoogleDrivePublicMetadata,
  parseGoogleDrivePublicReference,
} from "../supabase/functions/pdf-gateway/googleDrivePublic.ts";

const FILE_ID = "1AbCdef_ghijklmnopQRstuV";
const API_KEY = "AIzaSyExamplePublicDriveServerKey_123456789";

test("public Drive gateway parser accepts stable file share shapes only", () => {
  for (const value of [
    `https://drive.google.com/file/d/${FILE_ID}/view`,
    `https://drive.google.com/open?id=${FILE_ID}`,
    `https://drive.google.com/uc?export=download&id=${FILE_ID}`,
  ]) {
    assert.deepEqual(parseGoogleDrivePublicReference(value), {
      fileId: FILE_ID,
      canonicalUrl: `https://drive.google.com/file/d/${FILE_ID}/view`,
    });
  }
  assert.throws(
    () => parseGoogleDrivePublicReference(`https://evil.example.org/file/d/${FILE_ID}`),
    (error) => error instanceof GoogleDrivePublicError && error.code === "REFERENCE_INVALID",
  );
});

test("public Drive API URLs keep the server key out of persisted metadata", () => {
  const metadataUrl = googleDrivePublicMetadataUrl(FILE_ID, API_KEY);
  const mediaUrl = googleDrivePublicMediaUrl(FILE_ID, API_KEY);
  assert.equal(metadataUrl.hostname, "www.googleapis.com");
  assert.equal(metadataUrl.searchParams.get("key"), API_KEY);
  assert.match(metadataUrl.searchParams.get("fields") ?? "", /capabilities\(canDownload\)/u);
  assert.equal(mediaUrl.searchParams.get("alt"), "media");
  assert.equal(mediaUrl.searchParams.get("key"), API_KEY);
  assert.equal(
    parseGoogleDrivePublicReference(`https://drive.google.com/file/d/${FILE_ID}/view`).canonicalUrl
      .includes(API_KEY),
    false,
  );
});

test("public Drive metadata requires a downloadable PDF and bounded fields", () => {
  assert.deepEqual(parseGoogleDrivePublicMetadata({
    id: FILE_ID,
    name: "Archive.pdf",
    mimeType: "application/pdf",
    size: "123456",
    modifiedTime: "2026-08-03T10:00:00.000Z",
    md5Checksum: "md5",
    headRevisionId: "revision-1",
    capabilities: { canDownload: true },
    trashed: false,
  }, FILE_ID), {
    id: FILE_ID,
    name: "Archive.pdf",
    mimeType: "application/pdf",
    size: 123456,
    modifiedTime: "2026-08-03T10:00:00.000Z",
    md5Checksum: "md5",
    headRevisionId: "revision-1",
  });

  assert.throws(
    () => parseGoogleDrivePublicMetadata({
      id: FILE_ID,
      name: "Private.pdf",
      mimeType: "application/pdf",
      capabilities: { canDownload: false },
    }, FILE_ID),
    (error) => error instanceof GoogleDrivePublicError && error.code === "DOWNLOAD_FORBIDDEN",
  );
});
