import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSameAddressSet,
  isPublicIpAddress,
  parseSingleByteRange,
  PdfGatewaySecurityError,
  resolvePublicHostAddresses,
  resolveValidatedRedirect,
  validatePublicPdfUrl,
} from "../supabase/functions/pdf-gateway/security.ts";

test("PDF gateway accepts persistence-safe public HTTPS URLs", () => {
  const url = validatePublicPdfUrl(
    "https://archive.example.org:443/files/book.pdf?page=25&lang=uk#page=25",
  );
  assert.equal(url.href, "https://archive.example.org/files/book.pdf?page=25&lang=uk");
  assert.equal(validatePublicPdfUrl("https://[2606:4700:4700::1111]/file.pdf").protocol, "https:");
});

test("PDF gateway rejects local, private, special and credential-bearing URLs", () => {
  for (const rejected of [
    "http://example.org/file.pdf",
    "https://user:password@example.org/file.pdf",
    "https://example.org:8443/file.pdf",
    "https://localhost/file.pdf",
    "https://service.internal/file.pdf",
    "https://127.0.0.1/file.pdf",
    "https://2130706433/file.pdf",
    "https://169.254.169.254/latest/meta-data",
    "https://10.10.10.10/file.pdf",
    "https://172.20.1.1/file.pdf",
    "https://192.168.1.1/file.pdf",
    "https://[::1]/file.pdf",
    "https://[fc00::1]/file.pdf",
    "https://[fe80::1]/file.pdf",
    "https://[::ffff:127.0.0.1]/file.pdf",
    "https://[2001:db8::1]/file.pdf",
  ]) {
    assert.throws(
      () => validatePublicPdfUrl(rejected),
      PdfGatewaySecurityError,
      rejected,
    );
  }
});

test("PDF gateway rejects signed, token and key query parameters", () => {
  for (const rejected of [
    "https://example.org/file.pdf?token=secret",
    "https://example.org/file.pdf?access_token=secret",
    "https://example.org/file.pdf?apiKey=secret",
    "https://example.org/file.pdf?signature=secret",
    "https://example.org/file.pdf?X-Amz-Credential=secret",
    "https://example.org/file.pdf?X-Goog-Signature=secret",
    "https://example.org/file.pdf?AWSAccessKeyId=secret",
  ]) {
    assert.throws(
      () => validatePublicPdfUrl(rejected),
      (error: unknown) => error instanceof PdfGatewaySecurityError
        && error.code === "SOURCE_URL_NOT_SAFE",
      rejected,
    );
  }
});

test("public IP classification fails closed for non-global ranges", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("1.1.1.1"), true);
  assert.equal(isPublicIpAddress("192.0.2.10"), false);
  assert.equal(isPublicIpAddress("198.51.100.10"), false);
  assert.equal(isPublicIpAddress("203.0.113.10"), false);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicIpAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicIpAddress("2002:7f00:1::"), false);
});

test("DNS guard rejects any answer set containing a private address", async () => {
  await assert.rejects(
    resolvePublicHostAddresses(
      "example.org",
      async () => ["93.184.216.34", "127.0.0.1"],
    ),
    (error: unknown) => error instanceof PdfGatewaySecurityError
      && error.code === "HOST_NOT_ALLOWED",
  );
  assert.deepEqual(
    await resolvePublicHostAddresses(
      "example.org",
      async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    ),
    ["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"],
  );
});

test("DNS rebinding comparison detects a changed address set", () => {
  assert.doesNotThrow(() => assertSameAddressSet(
    ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
    ["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"],
  ));
  assert.throws(
    () => assertSameAddressSet(["93.184.216.34"], ["1.1.1.1"]),
    (error: unknown) => error instanceof PdfGatewaySecurityError
      && error.code === "DNS_REBINDING_DETECTED",
  );
});

test("every redirect target is parsed and revalidated", () => {
  const current = validatePublicPdfUrl("https://archive.example.org/files/book.pdf");
  assert.equal(
    resolveValidatedRedirect(current, "../cdn/book.pdf").href,
    "https://archive.example.org/cdn/book.pdf",
  );
  assert.throws(
    () => resolveValidatedRedirect(current, "https://169.254.169.254/metadata"),
    PdfGatewaySecurityError,
  );
});

test("Range parser accepts one byte range and rejects ambiguous inputs", () => {
  assert.deepEqual(parseSingleByteRange("bytes=0-65535"), {
    header: "bytes=0-65535",
    start: 0,
    end: 65535,
  });
  assert.deepEqual(parseSingleByteRange("bytes=65536-"), {
    header: "bytes=65536-",
    start: 65536,
    end: undefined,
  });
  assert.deepEqual(parseSingleByteRange("bytes=-1024"), {
    header: "bytes=-1024",
    suffixLength: 1024,
  });
  assert.equal(parseSingleByteRange(null), null);
  for (const rejected of ["items=0-1", "bytes=", "bytes=2-1", "bytes=0-1,3-4", "bytes=-0"]) {
    assert.throws(() => parseSingleByteRange(rejected), PdfGatewaySecurityError);
  }
});
