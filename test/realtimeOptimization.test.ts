import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  realtimeRecordMutation,
  removeRealtimeRecord,
  upsertRealtimeRecord,
} from "../src/utils/realtimeChanges.ts";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const realtime = readFileSync(
  new URL("../src/services/projectRealtime.ts", import.meta.url),
  "utf8",
);

function change(overrides: Partial<Parameters<typeof realtimeRecordMutation>[0]> = {}) {
  return {
    group: "people" as const,
    module: "persons",
    action: "person_updated",
    entityId: "person-1",
    details: {},
    ...overrides,
  };
}

test("Realtime exposes compact entity changes from activity_log", () => {
  assert.match(realtime, /type ProjectRealtimeEntityChange/);
  assert.match(
    realtime,
    /details\.entityId\s*\?\?\s*details\.relatedId\s*\?\?\s*record\.entity_id/,
  );
  assert.match(realtime, /pendingChanges = new Map/);
  assert.match(realtime, /onGroupsChanged\(changed, true, entityChanges\)/);
});

test("Realtime subscription lifecycle is scoped to project and user IDs", () => {
  assert.match(app, /const realtimeProjectId = workspace\?\.projectId \?\? ""/);
  assert.match(app, /const realtimeUserId = account\?\.id \?\? ""/);
  assert.match(app, /\}, \[realtimeProjectId, realtimeUserId\]\);/);
  assert.match(app, /realtimeViewRef\.current\.page/);
});

test("safe CRUD actions are classified for point updates", () => {
  assert.deepEqual(realtimeRecordMutation(change()), {
    module: "persons",
    entityId: "person-1",
    operation: "upsert",
  });
  assert.deepEqual(
    realtimeRecordMutation(change({ action: "record_deleted" })),
    {
      module: "persons",
      entityId: "person-1",
      operation: "delete",
    },
  );
  assert.equal(
    realtimeRecordMutation(change({ action: "bulk_import_completed" })),
    null,
  );
  assert.deepEqual(
    realtimeRecordMutation(change({
      action: "relation_updated",
      entityId: "relation-1",
    })),
    {
      module: "personRelations",
      entityId: "relation-1",
      operation: "upsert",
    },
  );
  assert.deepEqual(
    realtimeRecordMutation(change({
      action: "relation_deleted",
      entityId: "relation-1",
    })),
    {
      module: "personRelations",
      entityId: "relation-1",
      operation: "delete",
    },
  );
  assert.equal(
    realtimeRecordMutation(change({ module: "custom:military" })),
    null,
  );
});

test("point patches preserve unrelated records", () => {
  const records = [
    { id: "one", value: 1 },
    { id: "two", value: 2 },
  ];
  assert.deepEqual(upsertRealtimeRecord(records, { id: "two", value: 3 }), [
    { id: "one", value: 1 },
    { id: "two", value: 3 },
  ]);
  assert.deepEqual(upsertRealtimeRecord(records, { id: "three", value: 3 }), [
    { id: "three", value: 3 },
    ...records,
  ]);
  assert.deepEqual(removeRealtimeRecord(records, "one"), [
    { id: "two", value: 2 },
  ]);
});

test("App uses point loaders and retains full-group fallback", () => {
  assert.match(app, /getProjectPerson\(projectId, entityId\)/);
  assert.match(app, /getProjectPersonRelation\(projectId, entityId\)/);
  assert.match(app, /getProjectFinding\(projectId, entityId\)/);
  assert.match(app, /fallbackGroups\.delete\(group\)/);
  assert.match(app, /refreshGroups\(new Set\(\["activity", \.\.\.fallbackGroups\]\)\)/);
  assert.match(app, /loadProjectDashboard\(projectId, \{ force: true \}\)/);
});
