import assert from "node:assert/strict";
import test from "node:test";
import {
  DocumentSourceError,
  normalizeExternalDocumentUrl,
  redactExternalDocumentUrl,
  toPublicDocumentSourceError,
} from "../src/services/document-sources/index.ts";

test("normalization preserves public canonical query parameters and removes fragments", () => {
  const result = normalizeExternalDocumentUrl(
    "https://uk.wikisource.org/w/index.php?title=Index%3AArchive.pdf&oldid=42&page=7#section",
  );

  assert.equal(
    result.url,
    "https://uk.wikisource.org/w/index.php?title=Index%3AArchive.pdf&oldid=42&page=7",
  );
  assert.deepEqual(result.removedSensitiveParameters, []);
});

test("normalization removes token, key, signature, AWS, Google and signed-url companions", () => {
  const result = normalizeExternalDocumentUrl(
    "https://cdn.example.org/archive.pdf?id=public-7"
      + "&access_token=never-log"
      + "&api-key=never-persist"
      + "&resourceKey=drive-secret"
      + "&X-Amz-Algorithm=AWS4-HMAC-SHA256"
      + "&X-Amz-Credential=credential"
      + "&X-Amz-Signature=signature"
      + "&X-Goog-Date=20260730T120000Z"
      + "&GoogleAccessId=service@example.org"
      + "&Signature=cloud-signature"
      + "&Expires=9999999999"
      + "&Policy=encoded-policy",
  );

  assert.equal(result.url, "https://cdn.example.org/archive.pdf?id=public-7");
  assert.ok(result.removedSensitiveParameters.includes("access_token"));
  assert.ok(result.removedSensitiveParameters.includes("resourceKey"));
  assert.ok(result.removedSensitiveParameters.includes("X-Amz-Signature"));
  assert.ok(result.removedSensitiveParameters.includes("X-Goog-Date"));
  assert.ok(result.removedSensitiveParameters.includes("Expires"));
  assert.doesNotMatch(JSON.stringify(result), /never-log|never-persist|drive-secret|cloud-signature|encoded-policy/u);
});

test("parameter matching is case-insensitive and catches token/signature variants", () => {
  const result = normalizeExternalDocumentUrl(
    "https://files.example.org/a.pdf?Page=12&DownloadToken=secret&oauth_signature=signed&DeveloperKey=keyed",
  );

  assert.equal(result.url, "https://files.example.org/a.pdf?Page=12");
  assert.deepEqual(result.removedSensitiveParameters, [
    "DownloadToken",
    "oauth_signature",
    "DeveloperKey",
  ]);
});

test("normalization rejects embedded credentials, insecure schemes and control characters", () => {
  assert.throws(
    () => normalizeExternalDocumentUrl("https://researcher:password@example.org/archive.pdf"),
    (error) => error instanceof DocumentSourceError && error.code === "INVALID_URL",
  );
  assert.throws(
    () => normalizeExternalDocumentUrl("http://example.org/archive.pdf"),
    (error) => error instanceof DocumentSourceError && error.code === "UNSUPPORTED_SCHEME",
  );
  assert.throws(
    () => normalizeExternalDocumentUrl("https://example.org/archive.pdf\n?token=secret"),
    (error) => error instanceof DocumentSourceError && error.code === "INVALID_URL",
  );
});

test("diagnostic redaction never exposes credentials or sensitive query values", () => {
  const redacted = redactExternalDocumentUrl(
    "https://admin:password@example.org/archive.pdf?id=42&token=secret&X-Goog-Signature=signed#private",
  );

  assert.equal(redacted, "https://example.org/archive.pdf?id=42");
  assert.doesNotMatch(redacted, /admin|password|secret|signed|private/u);
  assert.equal(redactExternalDocumentUrl("not a URL"), "[invalid-url]");
  assert.equal(redactExternalDocumentUrl("http://example.org/a.pdf"), "[unsupported-url]");
});

test("public error mapping is stable and does not copy raw upstream errors", () => {
  const publicError = toPublicDocumentSourceError(
    new Error("https://private.example/file.pdf?token=do-not-leak"),
    "TIMEOUT",
  );

  assert.deepEqual(publicError, {
    code: "TIMEOUT",
    message: "Зовнішнє джерело не відповіло вчасно.",
    action: "retry",
  });
  assert.doesNotMatch(JSON.stringify(publicError), /private\.example|do-not-leak/u);
});
