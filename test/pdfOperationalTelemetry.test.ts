import assert from "node:assert/strict";
import test from "node:test";
import { DocumentSourceError } from "../src/services/document-sources/errors.ts";
import {
  createPdfOperationalRequestId,
  normalizePdfOperationalEvent,
  pdfFileSizeBucket,
  safePdfOperationalErrorCode,
} from "../src/services/pdfOperationalTelemetry.ts";

const REQUEST_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

test("PDF operational client events serialize only the explicit privacy allowlist", () => {
  const normalized = normalizePdfOperationalEvent({
    event: "pdf_viewer_opened",
    requestId: REQUEST_ID,
    provider: "wikimedia",
    accessMode: "secure_proxy",
    statusCode: 200,
    durationMs: 123,
    pageCount: 42,
    fileSizeBucket: "10_to_100_mib",
    transferredBytes: 4096,
    projectId: "must-not-enter-record",
    userId: "private-user",
    documentId: "private-document",
    url: "https://example.test/private.pdf?token=secret",
    title: "Private file name",
    token: "secret",
    headers: { Authorization: "Bearer secret" },
    message: "free text must never be logged",
  });

  assert.deepEqual(normalized, {
    event: "pdf_viewer_opened",
    requestId: REQUEST_ID,
    provider: "wikimedia",
    accessMode: "secure_proxy",
    statusCode: 200,
    durationMs: 123,
    pageCount: 42,
    fileSizeBucket: "10_to_100_mib",
    transferredBytes: 4096,
  });
  const serialized = JSON.stringify(normalized);
  for (const privateValue of ["private-user", "private-document", "private.pdf", "secret", "Private file name"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("PDF operational helper buckets sizes and maps errors without error messages", () => {
  assert.equal(pdfFileSizeBucket(undefined), "unknown");
  assert.equal(pdfFileSizeBucket(0), "lt_1_mib");
  assert.equal(pdfFileSizeBucket(1024 * 1024), "1_to_10_mib");
  assert.equal(pdfFileSizeBucket(100 * 1024 * 1024), "100_to_500_mib");
  assert.equal(pdfFileSizeBucket(500 * 1024 * 1024), "gte_500_mib");
  assert.equal(
    safePdfOperationalErrorCode(new DocumentSourceError("GOOGLE_DRIVE_PERMISSION_DENIED")),
    "ACCESS_DENIED",
  );
  assert.equal(safePdfOperationalErrorCode(new Error("private failure text")), "UNKNOWN");
});

test("PDF operational request IDs never reuse an invalid caller identifier", () => {
  assert.equal(createPdfOperationalRequestId(REQUEST_ID), REQUEST_ID);
  assert.match(createPdfOperationalRequestId("document-123"), /^[0-9a-f-]{36}$/u);
});
