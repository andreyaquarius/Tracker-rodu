import assert from "node:assert/strict";
import test from "node:test";
import type { ScanAttachment } from "../src/types/index.ts";
import {
  normalizeScanPreviewBlob,
  readBoundedResponseBlob,
  scanBlobCacheKey,
} from "../src/services/scanStorage.ts";

test("preview blobs recover image MIME types returned by Drive as octet-stream", () => {
  const original = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
    type: "application/octet-stream",
  });
  const normalized = normalizeScanPreviewBlob({ name: "portrait.JPG" }, original);

  assert.equal(normalized.type, "image/jpeg");
  assert.equal(normalized.size, original.size);
});

test("preview blobs preserve an already specific MIME type", () => {
  const original = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });

  assert.equal(normalizeScanPreviewBlob({ name: "portrait.jpg" }, original), original);
});

test("external scan cache keys separate a known 32-bit FNV collision", () => {
  const first = externalScan("https://cdn.example/1u4ko08/piloav.jpg");
  const second = externalScan("https://cdn.example/9v4rm/17nvvmh.jpg");

  assert.notEqual(scanBlobCacheKey(first), scanBlobCacheKey(second));
});

test("external response reader rejects declared and streamed oversize bodies", async () => {
  await assert.rejects(
    readBoundedResponseBlob(new Response("12345", {
      headers: { "content-length": "5", "content-type": "image/jpeg" },
    }), 4),
    /перевищує дозволені/u,
  );

  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedResponseBlob(new Response(streamed, {
      headers: { "content-type": "image/jpeg" },
    }), 5),
    /перевищує дозволені/u,
  );
});

function externalScan(storagePath: string): ScanAttachment {
  return {
    id: storagePath,
    name: "photo.jpg",
    mimeType: "image/jpeg",
    size: 0,
    createdAt: "2026-07-19T00:00:00.000Z",
    storage: "external-url",
    storagePath,
    webViewLink: storagePath,
  };
}
