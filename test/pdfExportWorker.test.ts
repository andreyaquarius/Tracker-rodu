import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicIpAddress,
  parsePageSelection,
  PdfExportWorkerError,
  resolveAndPinPublicAddress,
  signWorkerBody,
  validateExportPayload,
  validateStreamPayload,
  verifyWorkerSignature,
} from "../services/pdf-export-worker/server.mjs";

test("export worker validates and de-duplicates an ordered page selection", () => {
  assert.deepEqual(parsePageSelection([8, 1, 2, 2, 5]), [1, 2, 5, 8]);
  assert.throws(() => parsePageSelection([0]), (error: unknown) => (
    error instanceof PdfExportWorkerError && error.code === "PAGES_INVALID"
  ));
});

test("export worker accepts public addresses and blocks private, local and documentation ranges", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test("DNS pinning rejects a mixed public/private answer instead of choosing the public record", async () => {
  await assert.rejects(
    () => resolveAndPinPublicAddress("archive.example", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    (error: unknown) => error instanceof PdfExportWorkerError && error.code === "SSRF_ADDRESS_BLOCKED",
  );
});

test("worker HMAC signature is time bounded and covers the complete body", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const timestamp = 1_800_000_000_000;
  const body = JSON.stringify({ nonce: "1234567890abcdef", pages: [1] });
  const signature = signWorkerBody(secret, timestamp, body);
  assert.doesNotThrow(() => verifyWorkerSignature({ secret, timestamp, signature, body, now: timestamp + 500 }));
  assert.throws(
    () => verifyWorkerSignature({ secret, timestamp, signature, body: `${body} `, now: timestamp + 500 }),
    (error: unknown) => error instanceof PdfExportWorkerError && error.code === "SIGNATURE_INVALID",
  );
  assert.throws(
    () => verifyWorkerSignature({ secret, timestamp, signature, body, now: timestamp + 61_000 }),
    (error: unknown) => error instanceof PdfExportWorkerError && error.code === "SIGNATURE_EXPIRED",
  );
});

test("authorized upstream export requires an exact redirect allowlist", () => {
  assert.throws(
    () => validateExportPayload({
      nonce: "1234567890abcdef",
      sourceUrl: "https://www.googleapis.com/drive/v3/files/abc?alt=media",
      pages: [1],
      fileName: "pages.pdf",
      authorization: "Bearer 012345678901234567890123456789",
    }),
    (error: unknown) => error instanceof PdfExportWorkerError && error.code === "AUTH_REDIRECT_POLICY_REQUIRED",
  );
  const valid = validateExportPayload({
    nonce: "1234567890abcdef",
    sourceUrl: "https://www.googleapis.com/drive/v3/files/abcdefghijk?alt=media",
    pages: [3, 1],
    fileName: "Metric book.pdf",
    authorization: "Bearer 012345678901234567890123456789",
    allowedRedirectHosts: ["www.googleapis.com", "drive.usercontent.google.com"],
  });
  assert.deepEqual(valid.pages, [1, 3]);
  assert.equal(valid.fileName, "Metric book.pdf");
});

test("pinned stream accepts only bounded GET/HEAD range requests", () => {
  const valid = validateStreamPayload({
    nonce: "stream-request-123456",
    sourceUrl: "https://archive.example/document.pdf",
    method: "GET",
    range: "bytes=0-1048575",
    ifRange: '"revision-1"',
  });
  assert.equal(valid.method, "GET");
  assert.equal(valid.range, "bytes=0-1048575");
  assert.equal(valid.ifRange, '"revision-1"');
  assert.throws(
    () => validateStreamPayload({
      nonce: "stream-request-123456",
      sourceUrl: "https://archive.example/document.pdf",
      method: "POST",
    }),
    (error: unknown) => error instanceof PdfExportWorkerError && error.code === "METHOD_INVALID",
  );
  assert.throws(
    () => validateStreamPayload({
      nonce: "stream-request-123456",
      sourceUrl: "https://archive.example/document.pdf",
      method: "GET",
      range: "bytes=0-1,4-5",
    }),
    (error: unknown) => error instanceof PdfExportWorkerError && error.code === "RANGE_INVALID",
  );
});

test("pinned authorized stream cannot leave its exact provider host allowlist", () => {
  const authorization = "Bearer 012345678901234567890123456789";
  assert.throws(
    () => validateStreamPayload({
      nonce: "stream-request-123456",
      sourceUrl: "https://www.googleapis.com/drive/v3/files/abcdefghijk?alt=media",
      method: "GET",
      authorization,
    }),
    (error: unknown) => error instanceof PdfExportWorkerError && error.code === "AUTH_REDIRECT_POLICY_REQUIRED",
  );
  const valid = validateStreamPayload({
    nonce: "stream-request-123456",
    sourceUrl: "https://www.googleapis.com/drive/v3/files/abcdefghijk?alt=media",
    method: "HEAD",
    authorization,
    allowedRedirectHosts: ["www.googleapis.com", "drive.usercontent.google.com"],
  });
  assert.equal(valid.method, "HEAD");
  assert.deepEqual(valid.allowedRedirectHosts, ["www.googleapis.com", "drive.usercontent.google.com"]);
});
