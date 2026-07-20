import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GedcomImportMediaDraft } from "../src/types/familyTree.ts";
import { buildGedcomAppImport } from "../src/utils/gedcomAppImport.ts";
import { exportFamilyTreeProjectionToGedcom } from "../src/utils/gedcom.ts";
import { buildGedcomImportDraft } from "../src/utils/gedcomImport.ts";
import { buildFamilyTreeProjection } from "../src/utils/familyTreeProjection.ts";
import { attachTrackerPersonPhotos } from "../src/features/family-tree-view/adapters/trackerPersonPhotos.ts";
import type { FamilyGraphData } from "../src/features/family-tree-view/types.ts";
import {
  DEFAULT_PERSON_AVATAR_CROP,
  isPhotoReferenceAvailable,
  normalizePersonAvatarCrop,
  normalizePersonPhotoState,
  personAvatarImageStyle,
  personPhotoMetadataForStorage,
  personPhotoStateFromMetadata,
  personPhotosFromGedcomMedia,
  primaryPersonPhoto,
  primaryPersonPhotoFromCustomFields,
  PERSON_SCANS_METADATA_KEY,
  updatePersonAvatarCrop,
} from "../src/utils/personPhotos.ts";

test("normalizes avatar crop defaults and clamps finite values", () => {
  assert.deepEqual(normalizePersonAvatarCrop(undefined), DEFAULT_PERSON_AVATAR_CROP);
  assert.deepEqual(normalizePersonAvatarCrop("invalid"), DEFAULT_PERSON_AVATAR_CROP);
  assert.deepEqual(normalizePersonAvatarCrop({ x: Number.NaN, y: "20", zoom: null }), {
    x: 50,
    y: 50,
    zoom: 1,
  });
  assert.deepEqual(normalizePersonAvatarCrop({ x: -15, y: 140, zoom: 8 }), {
    x: 0,
    y: 100,
    zoom: 3,
  });
  assert.deepEqual(normalizePersonAvatarCrop({ x: 24.5, y: 61.25, zoom: 1.75 }), {
    x: 24.5,
    y: 61.25,
    zoom: 1.75,
  });
});

test("builds deterministic avatar image styles from normalized crop metadata", () => {
  assert.deepEqual(personAvatarImageStyle({ x: 25, y: 75, zoom: 2 }), {
    objectPosition: "25% 75%",
    transform: "scale(2)",
    transformOrigin: "25% 75%",
  });
  assert.deepEqual(personAvatarImageStyle({ x: -1, y: 101, zoom: 0 }), {
    objectPosition: "0% 100%",
    transform: "scale(1)",
    transformOrigin: "0% 100%",
  });
  assert.deepEqual(personAvatarImageStyle({ avatarCrop: { x: 30, y: 40, zoom: 1.5 } }), {
    objectPosition: "30% 40%",
    transform: "scale(1.5)",
    transformOrigin: "30% 40%",
  });
});

test("updates avatar crop immutably for only the requested photo", () => {
  const first = personPhotosFromGedcomMedia(
    [media("https://example.test/first.jpg", true)],
    "2026-07-12T00:00:00.000Z",
    () => "first",
  ).photos[0];
  const second = { ...first, id: "second", name: "second.jpg" };
  const sourcePhotos = [first, second];

  const updated = updatePersonAvatarCrop(sourcePhotos, "second", {
    x: 10,
    y: 90,
    zoom: 2.5,
  });

  assert.notEqual(updated, sourcePhotos);
  assert.equal(updated[0], first);
  assert.notEqual(updated[1], second);
  assert.equal(second.avatarCrop, undefined);
  assert.deepEqual(updated[1].avatarCrop, { x: 10, y: 90, zoom: 2.5 });
});

test("converts remote GEDCOM media into available person photos and keeps the primary marker", () => {
  let id = 0;
  const result = personPhotosFromGedcomMedia([
    media("https://example.test/first.jpg", false),
    media("https://example.test/main.png", true),
  ], "2026-07-12T00:00:00.000Z", () => `photo-${++id}`);

  assert.equal(result.photos.length, 2);
  assert.equal(result.primaryPhotoId, "photo-2");
  assert.equal(result.photos[1].storage, "external-url");
  assert.equal(result.photos[1].availability, "available");
  assert.equal(result.photos[1].webViewLink, "https://example.test/main.png");
  assert.equal(result.photos[1].deleteOnRemove, false);
  assert.equal(isPhotoReferenceAvailable(primaryPersonPhoto(result.photos, result.primaryPhotoId)), true);
});

test("does not put a non-image GEDCOM object into the person photo gallery", () => {
  const result = personPhotosFromGedcomMedia([
    { ...media("https://example.test/archive.pdf", false), format: "pdf" },
  ], "2026-07-12T00:00:00.000Z", () => "not-a-photo");

  assert.deepEqual(result, { photos: [], primaryPhotoId: "" });
});

test("does not persist an embedded data/base64 GEDCOM photo as attachment metadata", () => {
  const result = personPhotosFromGedcomMedia([
    { ...media("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", true), format: "png" },
  ], "2026-07-12T00:00:00.000Z", () => "embedded-photo");

  assert.deepEqual(result, { photos: [], primaryPhotoId: "" });
  assert.doesNotMatch(JSON.stringify(result), /base64|iVBOR/i);
});

test("keeps an unavailable local GEDCOM photo as metadata without pretending to upload it", () => {
  const result = personPhotosFromGedcomMedia([
    media("C:\\MyHeritage\\Photos\\ancestor.jpg", true),
  ], "2026-07-12T00:00:00.000Z", () => "photo-local");
  const photo = result.photos[0];

  assert.equal(photo.name, "ancestor.jpg");
  assert.equal(photo.storage, "external-url");
  assert.equal(photo.storagePath, "C:\\MyHeritage\\Photos\\ancestor.jpg");
  assert.equal(photo.webViewLink, undefined);
  assert.equal(photo.availability, "missing-local");
  assert.equal(photo.sourceKind, "gedcom");
  assert.match(photo.statusMessage ?? "", /виберіть цей файл вручну/i);
  assert.equal(isPhotoReferenceAvailable(photo), false);
});

test("imports a local GEDCOM OBJE as a missing photo reference and reports manual recovery", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Petro /Ancestor/",
    "1 OBJE",
    "2 FILE C:\\MyHeritage\\Photos\\ancestor.jpg",
    "2 FORM jpg",
    "2 TITL Портрет предка",
    "2 _PRIM_CUTOUT Y",
    "0 TRLR",
  ].join("\n"));
  const imported = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });

  assert.equal(imported.people[0].photos?.length, 1);
  assert.equal(imported.people[0].photos?.[0].availability, "missing-local");
  assert.equal(imported.people[0].photos?.[0].webViewLink, undefined);
  assert.equal(imported.people[0].primaryPhotoId, imported.people[0].photos?.[0].id);
  assert.match(imported.warnings.join("\n"), /потрібно вибрати вручну/i);
});

test("normalizes a removed primary photo to the first remaining gallery item", () => {
  const first = personPhotosFromGedcomMedia(
    [media("https://example.test/first.jpg", false)],
    "2026-07-12T00:00:00.000Z",
    () => "first",
  ).photos[0];
  const second = { ...first, id: "second", name: "second.jpg" };

  assert.deepEqual(normalizePersonPhotoState([first, second], "missing"), {
    photos: [first, second],
    primaryPhotoId: "first",
  });
  assert.deepEqual(normalizePersonPhotoState([], "first"), {
    photos: [],
    primaryPhotoId: "",
  });
});

test("round-trips photo gallery metadata without embedding image bytes", () => {
  const photos = personPhotosFromGedcomMedia(
    [media("https://example.test/photo.jpg", true)],
    "2026-07-12T00:00:00.000Z",
    () => "photo",
  ).photos;
  photos[0].avatarCrop = { x: 35, y: 42, zoom: 1.6 };
  const stored = personPhotoMetadataForStorage({ photos, primaryPhotoId: "photo" });
  assert.deepEqual(personPhotoStateFromMetadata(stored), stored);
  assert.deepEqual(stored.photos[0].avatarCrop, { x: 35, y: 42, zoom: 1.6 });
  assert.equal("data" in stored.photos[0], false);
  assert.equal("base64" in stored.photos[0], false);
});

test("extracts and attaches only available primary photo metadata to tree people", () => {
  const available = {
    id: "portrait",
    name: "portrait.jpg",
    mimeType: "image/jpeg",
    size: 2048,
    createdAt: "2026-07-12T00:00:00.000Z",
    storage: "google-drive" as const,
    storagePath: "drive-file-id",
    driveRevisionId: "revision-1",
  };
  const customFields = {
    [PERSON_SCANS_METADATA_KEY]: {
      photos: [available],
      primaryPhotoId: available.id,
    },
  };
  assert.deepEqual(primaryPersonPhotoFromCustomFields(customFields), available);

  const graph: FamilyGraphData = {
    persons: [
      { id: "visible", displayName: "Visible" },
      { id: "masked", displayName: "Private", badges: { privacy: "masked" } },
    ],
    unions: [],
    parentChildRelations: [],
  };
  const enriched = attachTrackerPersonPhotos(graph, [
    { id: "visible", photos: [available], primaryPhotoId: available.id },
    { id: "masked", photos: [available], primaryPhotoId: available.id },
  ]);

  assert.deepEqual(enriched.persons[0].photo, available);
  assert.equal(enriched.persons[1].photo, undefined);
  assert.doesNotMatch(JSON.stringify(enriched.persons[0].photo), /base64|data:image/i);
});

test("exports a Drive copy in addition to the preserved original GEDCOM photo", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Petro /Ancestor/",
    "1 OBJE",
    "2 FILE https://legacy.example.test/photo.jpg",
    "2 FORM jpg",
    "2 _PRIM_CUTOUT Y",
    "0 TRLR",
  ].join("\n"));
  const imported = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });
  const original = imported.people[0].photos?.[0];
  assert.ok(original);
  imported.people[0].photos = [{
    ...original,
    storage: "google-drive",
    storagePath: "drive-file-id",
    webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
  }];
  const projection = buildFamilyTreeProjection({
    projectId: "project",
    treeId: "tree",
    persons: imported.people,
    legacyRelations: imported.relations,
    includeIsolatedPersons: true,
  });
  const exported = exportFamilyTreeProjectionToGedcom(projection, {
    preservedRecords: draft.preservedRecords,
  }).text;

  assert.match(exported, /2 FILE https:\/\/legacy\.example\.test\/photo\.jpg/);
  assert.match(exported, /2 FILE https:\/\/drive\.google\.com\/file\/d\/drive-file-id\/view/);
  assert.equal(exported.match(/2 _PRIM_CUTOUT Y/g)?.length, 1);
});

test("person photo UI and persistence reuse Drive attachment metadata without base64 storage", () => {
  const modal = source("../src/components/PersonFormModal.tsx");
  const people = source("../src/services/projectPeople.ts");
  const app = source("../src/App.tsx");
  const photoUtility = source("../src/utils/personPhotos.ts");
  const attachments = source("../src/components/ScanAttachments.tsx");
  const personPage = source("../src/pages/PersonsPage.tsx");
  const personProfileV2 = source("../src/features/persons-v2/PersonProfileV2.tsx");
  const personPreviewV2 = source("../src/features/persons-v2/PersonPreviewDrawerV2.tsx");
  const scanStorage = source("../src/services/scanStorage.ts");

  assert.match(modal, /policy="person-photo"/);
  assert.match(modal, /primaryPhotoId/);
  assert.match(modal, /driveFolderPath=/);
  assert.match(people, /personPhotoMetadataForStorage\(person\)/);
  assert.match(people, /personPhotoStateFromMetadata\(scanRecord\)/);
  assert.match(app, /fields\.photos = scanList\(record\.photos\)/);
  assert.match(attachments, /Зберегти копію у Google Drive/);
  assert.match(attachments, /const blob = await getScanBlob\(scan\)/);
  assert.match(attachments, /const uploaded = await saveScan\(file, policy/);
  assert.match(attachments, /Не вдалося зберегти копію у Google Drive/);
  assert.match(attachments, /Вибрати локальний файл і зберегти у Google Drive/);
  assert.match(attachments, /uploadedReplacement\(scan, uploaded\)/);
  assert.match(scanStorage, /Строк дії зовнішнього посилання на фото закінчився/);
  assert.match(scanStorage, /Браузер не дозволив прочитати файл.*CORS/s);
  assert.match(scanStorage, /додайте його кнопкою «Додати файли»/);
  assert.match(personPage, /primaryPersonPhoto/);
  assert.match(personPage, /<ScanAttachmentsView/);
  assert.match(personProfileV2, /onError=\{\(\) => setPhotoFailed\(true\)\}/);
  assert.match(personPreviewV2, /onError=\{\(\) => setPhotoFailed\(true\)\}/);
  assert.match(source("../src/features/family-tree-view/react/PersonCard.tsx"), /loading="lazy"/);
  assert.match(source("../src/features/family-tree-view/react/PersonCard.tsx"), /resolvePhotoSource/);
  assert.doesNotMatch(photoUtility, /base64|readAsDataURL|localStorage/i);
});

function media(file: string, isPrimary: boolean): GedcomImportMediaDraft {
  return {
    file,
    format: file.endsWith(".png") ? "png" : "jpg",
    title: "",
    fileSize: "1024",
    photoRin: "",
    isPrimary,
    isPersonalPhoto: false,
  };
}

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
