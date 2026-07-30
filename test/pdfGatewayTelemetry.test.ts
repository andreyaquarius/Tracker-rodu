import assert from "node:assert/strict";
import test from "node:test";
import {
  createPdfProxyTelemetryRecord,
  parseClientPdfOperationalEvent,
  shouldSamplePdfProxySuccess,
  shouldWritePdfProxyRecord,
} from "../supabase/functions/pdf-gateway/telemetry.ts";

const PROJECT_ID = "e3510d6a-d5c4-4d0f-8171-75068d7f0968";
const REQUEST_ID = "3b241101-e2bb-4255-8caf-4136c566a962";

test("gateway strips the membership scope before writing a client event", () => {
  const parsed = parseClientPdfOperationalEvent({
    projectId: PROJECT_ID,
    event: "pdf_first_page_rendered",
    requestId: REQUEST_ID,
    provider: "direct_pdf",
    accessMode: "secure_proxy",
    statusCode: 200,
    durationMs: 400,
    pageCount: 12,
    fileSizeBucket: "1_to_10_mib",
    transferredBytes: 2048,
  });
  assert.equal(parsed.projectId, PROJECT_ID);
  assert.deepEqual(parsed.record, {
    component: "pdf_gateway",
    event: "pdf_first_page_rendered",
    request_id: REQUEST_ID,
    provider: "direct_pdf",
    access_mode: "secure_proxy",
    status_code: 200,
    duration_ms: 400,
    page_count: 12,
    file_size_bucket: "1_to_10_mib",
    transferred_bytes: 2048,
  });
  assert.equal(JSON.stringify(parsed.record).includes(PROJECT_ID), false);
});

test("gateway rejects every unexpected or private telemetry field", () => {
  for (const [field, value] of Object.entries({
    userId: "private-user",
    documentId: "private-document",
    sourceId: "private-source",
    url: "https://example.test/private.pdf",
    title: "Private.pdf",
    fileName: "Private.pdf",
    token: "secret",
    headers: { Authorization: "Bearer secret" },
    message: "private error message",
    metadata: { private: true },
  })) {
    assert.throws(
      () => parseClientPdfOperationalEvent({
        projectId: PROJECT_ID,
        event: "pdf_viewer_opened",
        requestId: REQUEST_ID,
        [field]: value,
      }),
      /TELEMETRY_EVENT_INVALID/u,
      field,
    );
  }
  assert.throws(
    () => parseClientPdfOperationalEvent({
      projectId: PROJECT_ID,
      event: "pdf_proxy_request",
      requestId: REQUEST_ID,
    }),
    /TELEMETRY_EVENT_INVALID/u,
  );
});

test("proxy success sampling is deterministic while failures are always retained", () => {
  assert.equal(shouldSamplePdfProxySuccess(REQUEST_ID, 0), false);
  assert.equal(shouldSamplePdfProxySuccess(REQUEST_ID, 100), true);
  assert.equal(
    shouldSamplePdfProxySuccess(REQUEST_ID, 10),
    shouldSamplePdfProxySuccess(REQUEST_ID, 10),
  );
  const success = createPdfProxyTelemetryRecord({
    requestId: REQUEST_ID,
    provider: "wikimedia",
    statusCode: 206,
    durationMs: 25,
    transferredBytes: 1024,
  });
  const failure = createPdfProxyTelemetryRecord({
    requestId: REQUEST_ID,
    provider: "wikimedia",
    statusCode: 504,
    errorCode: "UPSTREAM_TIMEOUT",
    durationMs: 25,
    transferredBytes: 0,
  });
  assert.equal(shouldWritePdfProxyRecord(success, 0), false);
  assert.equal(shouldWritePdfProxyRecord(failure, 0), true);
});
