import test from "node:test";
import assert from "node:assert/strict";
import type { Person, ScanAttachment } from "../src/types/index.ts";
import {
  backupGedcomPhotosToGoogleDrive,
  buildGedcomPhotoBackupPlan,
  applyPersonPhotoBackups,
  attachLocalGedcomPhotoFiles,
  redactExternalPhotoSource,
  type GedcomPhotoBackupCandidate,
} from "../src/services/gedcomPhotoBackup.ts";

test("builds the post-import plan from imported photos and applies canonical person remaps", () => {
  const imported = person("incoming", [
    photo("remote", "https://cdn.example/new.jpg?Expires=1784548800"),
    photo("local", "C:\\Photos\\ancestor.jpg", { availability: "missing-local" }),
    photo("http", "http://cdn.example/unsafe.jpg"),
  ], "remote");
  const plan = buildGedcomPhotoBackupPlan(
    [imported],
    { incoming: "canonical" },
    [person("canonical")],
    Date.parse("2026-07-19T12:00:00.000Z"),
  );

  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0]?.personId, "canonical");
  assert.equal(plan.missingLocalCount, 1);
  assert.equal(plan.unsupportedHttpCount, 1);
  assert.equal(plan.knownExpiryCount, 1);
  assert.equal(plan.totalPhotoCount, 3);
});

test("matches a selected GEDCOM photo directory in one batch", () => {
  const imported = person("incoming", [
    photo("local", "C:\\Family archive\\Photos\\ancestor.jpg", { availability: "missing-local" }),
  ], "local");
  const plan = buildGedcomPhotoBackupPlan([imported]);
  const selected = new File(["portrait"], "ancestor.jpg", { type: "image/jpeg" });
  Object.defineProperty(selected, "webkitRelativePath", {
    configurable: true,
    value: "Photos/ancestor.jpg",
  });

  const resolution = attachLocalGedcomPhotoFiles(plan, [selected]);

  assert.equal(resolution.matchedCount, 1);
  assert.equal(resolution.unmatchedCount, 0);
  assert.equal(resolution.plan.missingLocalCount, 0);
  assert.equal(resolution.plan.candidates[0]?.localFile, selected);
});

test("does not offer a photo already copied to Drive on a repeated import", () => {
  const source = "https://cdn.example/photo.jpg";
  const imported = person("new-id", [photo("incoming-photo", source)]);
  const stored = photo("stored-photo", "drive-id", {
    storage: "google-drive",
    sourceReference: source,
  });
  const plan = buildGedcomPhotoBackupPlan(
    [imported],
    { "new-id": "existing-id" },
    [person("existing-id", [stored])],
  );

  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.alreadyStoredCount, 1);
});

test("signed URL credentials are ignored for identity and removed after Drive backup", () => {
  const firstUrl = "https://cdn.example/photo.jpg?id=42&X-Amz-Date=20260719T000000Z&X-Amz-Signature=secret-one";
  const refreshedUrl = "https://cdn.example/photo.jpg?X-Amz-Signature=secret-two&id=42&X-Amz-Date=20260720T000000Z";
  const stored = photo("stored-photo", "drive-id", {
    storage: "google-drive",
    sourceReference: redactExternalPhotoSource(firstUrl),
  });
  const plan = buildGedcomPhotoBackupPlan(
    [person("incoming", [photo("incoming-photo", refreshedUrl)])],
    { incoming: "canonical" },
    [person("canonical", [stored])],
  );

  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.alreadyStoredCount, 1);
  assert.equal(stored.sourceReference?.includes("Signature"), false);
  assert.match(stored.sourceReference ?? "", /id=42/u);
});

test("copies independent photos with partial failure and persists successful replacements", async () => {
  const first = person("p1", [photo("a", "https://cdn.example/a.jpg")], "a");
  const second = person("p2", [photo("b", "https://blocked.example/b.jpg")], "b");
  const plan = buildGedcomPhotoBackupPlan([first, second]);
  const persisted: string[] = [];

  const result = await backupGedcomPhotosToGoogleDrive(plan, {
    target: { projectId: "project", projectName: "Project" },
    persist: async ({ personId, replacements }) => {
      persisted.push(personId);
      return {
        appliedSourceReferences: replacements.map((item) => item.source.sourceReference ?? ""),
      };
    },
  }, {
    loadPhoto: async (candidate) => {
      if (candidate.personId === "p2") throw new Error("Браузер не дозволив прочитати файл (CORS).");
      return new Blob(["image"], { type: "image/jpeg" });
    },
    storePhoto: async (candidate) => storedPhoto(candidate),
  });

  assert.equal(result.copied, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.code, "cors");
  assert.deepEqual(persisted, ["p1"]);
});

test("an expired source cached successfully is not mislabeled when Drive upload fails", async () => {
  const expiredSource = photo("expired", "https://cdn.example/expired.jpg?exp=1700000000");
  const plan = buildGedcomPhotoBackupPlan(
    [person("p1", [expiredSource])],
    {},
    [],
    Date.parse("2026-07-19T00:00:00.000Z"),
  );
  const result = await backupGedcomPhotosToGoogleDrive(plan, {
    target: { projectId: "project", projectName: "Project" },
    persist: async () => ({ appliedSourceReferences: [] }),
  }, {
    loadPhoto: async () => new Blob(["cached"], { type: "image/jpeg" }),
    storePhoto: async () => {
      throw new Error("Google Drive quota exceeded");
    },
  });

  assert.equal(result.failures[0]?.code, "upload");
});

test("keeps Drive objects person-scoped so attachment metadata remains unique", async () => {
  const source = "https://cdn.example/shared.jpg";
  const plan = buildGedcomPhotoBackupPlan([
    person("p1", [photo("a", source)]),
    person("p2", [photo("b", source)]),
  ]);
  let storedCount = 0;
  const result = await backupGedcomPhotosToGoogleDrive(plan, {
    target: { projectId: "project", projectName: "Project" },
    persist: async ({ replacements }) => ({
      appliedSourceReferences: replacements.map((item) => item.source.sourceReference ?? ""),
    }),
  }, {
    loadPhoto: async () => new Blob(["image"], { type: "image/jpeg" }),
    storePhoto: async (candidate) => {
      storedCount += 1;
      return storedPhoto(candidate);
    },
  });

  assert.equal(storedCount, 2);
  assert.equal(result.copied, 2);
});

test("photo-only persistence preserves other profile edits and primary selection", () => {
  const source = photo("photo-id", "https://cdn.example/photo.jpg");
  const current = person("person", [source], "photo-id");
  current.notes = "Паралельно відредагована біографія";
  const stored = {
    ...source,
    storage: "google-drive" as const,
    storagePath: "drive-file-id",
    webViewLink: "https://drive.google.com/open?id=drive-file-id",
  };
  const applied = applyPersonPhotoBackups(current, [{
    source,
    stored,
    requestedPrimary: true,
    allowAppend: false,
  }]);

  assert.equal(applied.person.notes, "Паралельно відредагована біографія");
  assert.equal(applied.person.photos?.[0]?.storagePath, "drive-file-id");
  assert.equal(applied.person.primaryPhotoId, "photo-id");
  assert.deepEqual(applied.appliedSourceReferences, [source.sourceReference]);
});

test("photo-only persistence does not overwrite a concurrently replaced photo", () => {
  const importedSource = photo("photo-id", "https://cdn.example/imported.jpg");
  const userReplacement = photo("photo-id", "https://cdn.example/user-choice.jpg");
  const current = person("person", [userReplacement], "photo-id");
  const applied = applyPersonPhotoBackups(current, [{
    source: importedSource,
    stored: {
      ...importedSource,
      storage: "google-drive",
      storagePath: "drive-imported-photo",
    },
    requestedPrimary: true,
    allowAppend: false,
  }]);

  assert.equal(applied.person.photos?.[0]?.sourceReference, userReplacement.sourceReference);
  assert.equal(applied.person.photos?.[0]?.storage, "external-url");
  assert.deepEqual(applied.appliedSourceReferences, []);
});

function person(id: string, photos: ScanAttachment[] = [], primaryPhotoId = ""): Person {
  return {
    id,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    researchId: "research",
    surname: "Каленський",
    maidenSurname: "",
    givenName: id,
    patronymic: "",
    fullName: `Каленський ${id}`,
    nameVariants: "",
    surnameVariants: "",
    birthDate: "",
    birthYearFrom: "",
    birthYearTo: "",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathYearFrom: "",
    deathYearTo: "",
    deathPlace: "",
    residencePlaces: "",
    socialStatus: "",
    religion: "",
    occupation: "",
    isLiving: false,
    privacyStatus: "private",
    notes: "",
    status: "доведена",
    gender: "невідомо",
    birthScans: [],
    marriageScans: [],
    deathScans: [],
    mentionScans: [],
    photos,
    primaryPhotoId,
    events: [],
    customFields: {},
  };
}

function photo(
  id: string,
  sourceReference: string,
  overrides: Partial<ScanAttachment> = {},
): ScanAttachment {
  return {
    id,
    name: `${id}.jpg`,
    mimeType: "image/jpeg",
    size: 100,
    createdAt: "2026-07-19T00:00:00.000Z",
    storage: "external-url",
    storagePath: sourceReference,
    webViewLink: /^https?:/i.test(sourceReference) ? sourceReference : undefined,
    deleteOnRemove: false,
    availability: /^https?:/i.test(sourceReference) ? "available" : "missing-local",
    sourceKind: "gedcom",
    sourceReference,
    ...overrides,
  };
}

function storedPhoto(candidate: GedcomPhotoBackupCandidate): ScanAttachment {
  return {
    ...candidate.photo,
    storage: "google-drive",
    storagePath: `drive-${candidate.deduplicationKey}`,
    webViewLink: `https://drive.google.com/open?id=${candidate.deduplicationKey}`,
  };
}
