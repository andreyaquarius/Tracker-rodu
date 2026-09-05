import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ScanAttachment } from "../src/types/index.ts";
import { projectAttachmentMetadataRows } from "../src/services/projectAttachmentMetadataRows.ts";
import { normalizePersonEvents } from "../src/utils/geo.ts";

const eventEditorSource = readFileSync(
  new URL("../src/components/PersonEventsEditor.tsx", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8",
);
const timelineSource = readFileSync(
  new URL("../src/features/persons-v2/PersonTimelineV2.tsx", import.meta.url),
  "utf8",
);
const databaseSource = readFileSync(
  new URL("../src/utils/database.ts", import.meta.url),
  "utf8",
);
const migrationSource = readFileSync(
  new URL(
    "../supabase/migrations/202609050003_attachment_reference_uniqueness.sql",
    import.meta.url,
  ),
  "utf8",
);

function attachment(id: string, path = "drive-file-1"): ScanAttachment {
  return {
    id,
    name: "Скан події.jpg",
    mimeType: "image/jpeg",
    size: 1024,
    createdAt: "2026-09-05T10:00:00.000Z",
    storage: "google-drive",
    storagePath: path,
    availability: "available",
  };
}

test("additional person events preserve their own attachments during normalization", () => {
  const scan = attachment("scan-1");
  const events = normalizePersonEvents([{
    id: "event-1",
    personId: "person-1",
    type: "census",
    title: "Перепис населення",
    date: "1897",
    scans: [scan],
  }], {
    id: "person-1",
    birthDate: "",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathPlace: "",
    residencePlaces: "",
  });

  assert.deepEqual(events.find((event) => event.id === "event-1")?.scans, [scan]);
});

test("attachment metadata keeps the same Drive file once per event association", () => {
  const first = attachment("scan-1");
  const duplicate = attachment("scan-2");
  const rows = projectAttachmentMetadataRows("project-1", "persons", "person-1", {
    "event:event-1": [first, duplicate],
    "event:event-2": [attachment("scan-3")],
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.field_key), ["event:event-1", "event:event-2"]);
});

test("additional-event attachment UI, timeline, metadata, backup, and schema stay connected", () => {
  assert.match(eventEditorSource, /<ScanAttachmentsEditor/u);
  assert.match(eventEditorSource, /title="Файли події"/u);
  assert.match(eventEditorSource, /scans=\{event\.scans \?\? \[\]\}/u);
  assert.match(eventEditorSource, /updateEvent\(event\.id, \{ scans \}\)/u);
  assert.match(appSource, /fields\[`event:\$\{eventId\}`\] = scanList\(event\.scans\)/u);
  assert.match(timelineSource, /personTimelineAttachments\(person, event\)/u);
  assert.match(databaseSource, /scans: mapScans\(event\.scans \?\? \[\]\)/u);
  assert.match(
    migrationSource,
    /drop constraint if exists attachments_storage_bucket_storage_path_key/u,
  );
  assert.match(
    migrationSource,
    /unique \(project_id, owner_type, owner_id, field_key, storage_bucket, storage_path\)/u,
  );
});
