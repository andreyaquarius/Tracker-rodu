import assert from "node:assert/strict";
import test from "node:test";
import type {
  SourceValidationResult,
  StoredDocumentSource,
} from "../src/services/document-sources/contracts.ts";
import {
  documentSourceValidationIsDue,
  revalidateDocumentSourceIfDue,
  validationResolvedMetadata,
  validationResultShouldPersist,
} from "../src/services/documentSourceRevalidation.ts";

const source: StoredDocumentSource = {
  id: "11111111-1111-4111-8111-111111111111",
  documentId: "22222222-2222-4222-8222-222222222222",
  provider: "direct_pdf",
  originalUrl: "https://archive.example/document.pdf",
  canonicalUrl: "https://archive.example/document.pdf",
  mimeType: "application/pdf",
  accessMode: "secure_proxy",
  fingerprint: { etag: "old", contentLength: 100 },
  warnings: [],
  status: "active",
  lastValidatedAt: "2026-07-30T10:00:00.000Z",
  createdAt: "2026-07-30T09:00:00.000Z",
  updatedAt: "2026-07-30T10:00:00.000Z",
};

const context = {
  userId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  documentId: source.documentId,
};

test("validation due uses a bounded freshness window and never reprobes pending changes", () => {
  assert.equal(documentSourceValidationIsDue(
    source,
    new Date("2026-07-30T10:14:59.000Z"),
    15 * 60 * 1000,
  ), false);
  assert.equal(documentSourceValidationIsDue(
    source,
    new Date("2026-07-30T10:15:00.000Z"),
    15 * 60 * 1000,
  ), true);
  assert.equal(documentSourceValidationIsDue({ ...source, status: "changed" }), false);
});

test("viewers do not trigger provider probes or state writes", async () => {
  let probes = 0;
  let writes = 0;
  const result = await revalidateDocumentSourceIfDue({
    source,
    context,
    canEdit: false,
    now: () => new Date("2026-07-30T11:00:00.000Z"),
    registry: {
      revalidate: async () => {
        probes += 1;
        throw new Error("must not run");
      },
    },
    persist: async () => {
      writes += 1;
      return source;
    },
  });
  assert.equal(probes, 0);
  assert.equal(writes, 0);
  assert.equal(result.versionStatus, "unknown");
});

test("changed fingerprint is persisted as pending and reported for confirmation", async () => {
  const changed: SourceValidationResult = {
    status: "changed",
    oldFingerprint: source.fingerprint,
    newFingerprint: { etag: "new", contentLength: 120 },
    resolvedMetadata: {
      canonicalUrl: "https://cdn.archive.example/revision-2/document.pdf",
      providerHost: "cdn.archive.example",
      fileSizeBytes: 120,
      pageCount: 8,
      accessMode: "secure_proxy",
    },
    validatedAt: "2026-07-30T11:00:00.000Z",
    requiresUserReview: true,
  };
  let persistedResult: SourceValidationResult | null = null;
  let expectedSource: StoredDocumentSource | null = null;
  const result = await revalidateDocumentSourceIfDue({
    source,
    context,
    canEdit: true,
    now: () => new Date("2026-07-30T11:00:00.000Z"),
    registry: { revalidate: async () => changed },
    persist: async (_projectId, _sourceId, validation, expected) => {
      persistedResult = validation;
      expectedSource = expected;
      return { ...source, status: "changed", lastValidatedAt: validation.validatedAt };
    },
  });
  assert.deepEqual(persistedResult, changed);
  assert.equal(expectedSource, source);
  assert.equal(result.source.fingerprint.etag, "old");
  assert.equal(result.versionStatus, "changed");
  assert.equal(result.canConfirmVersion, true);
  assert.deepEqual(validationResolvedMetadata(changed), {
    canonical_url: "https://cdn.archive.example/revision-2/document.pdf",
    provider_host: "cdn.archive.example",
    file_size_bytes: 120,
    page_count: 8,
    access_mode: "secure_proxy",
  });
});

test("transient failures do not turn a healthy source unavailable", async () => {
  const transient: SourceValidationResult = {
    status: "unavailable",
    oldFingerprint: source.fingerprint,
    validatedAt: "2026-07-30T11:00:00.000Z",
    errorCode: "TIMEOUT",
  };
  let writes = 0;
  const result = await revalidateDocumentSourceIfDue({
    source,
    context,
    canEdit: true,
    now: () => new Date("2026-07-30T11:00:00.000Z"),
    registry: { revalidate: async () => transient },
    persist: async () => {
      writes += 1;
      return source;
    },
  });
  assert.equal(writes, 0);
  assert.equal(result.source, source);
  assert.equal(result.versionStatus, "unknown");
  assert.equal(validationResultShouldPersist(transient), false);
});

test("a persistence outage does not block opening an already authorized source", async () => {
  const changed: SourceValidationResult = {
    status: "changed",
    oldFingerprint: source.fingerprint,
    newFingerprint: { etag: "new" },
    resolvedMetadata: {
      canonicalUrl: source.canonicalUrl ?? source.originalUrl,
      providerHost: "archive.example",
      accessMode: source.accessMode,
    },
    validatedAt: "2026-07-30T11:00:00.000Z",
    requiresUserReview: true,
  };
  const result = await revalidateDocumentSourceIfDue({
    source,
    context,
    canEdit: true,
    now: () => new Date("2026-07-30T11:00:00.000Z"),
    registry: { revalidate: async () => changed },
    persist: async () => {
      throw new Error("rolling migration");
    },
  });
  assert.equal(result.source, source);
  assert.equal(result.versionStatus, "changed");
  assert.equal(result.canConfirmVersion, false);
});

test("per-user Google authorization failures never change the shared source status", async () => {
  for (const errorCode of ["OAUTH_REQUIRED", "GOOGLE_DRIVE_PERMISSION_DENIED"] as const) {
    const runtimeFailure: SourceValidationResult = {
      status: "needs_auth",
      oldFingerprint: source.fingerprint,
      validatedAt: "2026-07-30T11:00:00.000Z",
      errorCode,
    };
    let writes = 0;
    const result = await revalidateDocumentSourceIfDue({
      source,
      context,
      canEdit: true,
      now: () => new Date("2026-07-30T11:00:00.000Z"),
      registry: { revalidate: async () => runtimeFailure },
      persist: async () => {
        writes += 1;
        return { ...source, status: "needs_auth" };
      },
    });

    assert.equal(validationResultShouldPersist(runtimeFailure), false);
    assert.equal(writes, 0);
    assert.equal(result.source, source);
    assert.equal(result.source.status, "active");
    assert.equal(result.versionStatus, "unknown");
    assert.equal(result.canConfirmVersion, false);
  }
});

test("transient provider failures are not persisted", () => {
  assert.equal(validationResultShouldPersist({
    status: "unavailable",
    oldFingerprint: source.fingerprint,
    validatedAt: "2026-07-30T11:00:00.000Z",
    errorCode: "GOOGLE_DRIVE_QUOTA_EXCEEDED",
  }), false);
});
