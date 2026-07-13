import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130015_resumable_gedcom_import_rollback.sql",
    import.meta.url,
  ),
  "utf8",
);
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const buttonSource = readFileSync(
  new URL("../src/components/GedcomImportButton.tsx", import.meta.url),
  "utf8",
);
const mutationSource = readFileSync(
  new URL("../src/services/familyTreeMutationService.ts", import.meta.url),
  "utf8",
);
const personsPageSource = readFileSync(
  new URL("../src/pages/PersonsPage.tsx", import.meta.url),
  "utf8",
);
const productionTreePageSource = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const archiveSource = readFileSync(
  new URL("../src/services/gedcomArchiveService.ts", import.meta.url),
  "utf8",
);
const workerSource = readFileSync(
  new URL("../supabase/functions/process-gedcom-import-rollbacks/index.ts", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../.github/workflows/gedcom-import-rollbacks.yml", import.meta.url),
  "utf8",
);

test("journals every new GEDCOM entity before any project write", () => {
  assert.match(migration, /create table if not exists private\.gedcom_import_operations/i);
  assert.match(migration, /create table if not exists private\.gedcom_import_operation_entities/i);
  assert.match(migration, /primary key \(operation_id, entity_type, entity_id\)/i);
  assert.match(migration, /GEDCOM_IMPORT_ENTITY_BATCH_TOO_LARGE/i);

  const prepareIndex = appSource.indexOf("prepareGedcomImportOperation({");
  const firstWriteIndex = appSource.indexOf("await runPersistenceStage(", prepareIndex);
  assert.ok(prepareIndex >= 0 && firstWriteIndex > prepareIndex);
  assert.match(appSource, /filter\(\(person\) => !storedPersonIds\.has\(person\.id\)\)/);
  assert.match(appSource, /filter\(\(finding\) => !storedFindingIds\.has\(finding\.id\)\)/);
});

test("failed imports roll back in bounded dependency order", () => {
  assert.match(
    migration,
    /when 'gedcom_import_batch' then 1[\s\S]*?when 'family_tree' then 2[\s\S]*?when 'finding' then 3[\s\S]*?when 'person_relation' then 4[\s\S]*?when 'document' then 5[\s\S]*?when 'person' then 6/i,
  );
  assert.match(migration, /least\(coalesce\(batch_size, 250\), 500\)/i);
  assert.match(migration, /delete from public\.%I where project_id = \$1 and id = any\(\$2\)/i);
  assert.match(migration, /delete_gedcom_archive_children_batch[\s\S]*?delete from public\.gedcom_xref_maps[\s\S]*?limit greatest/i);
  assert.match(migration, /delete_gedcom_tree_children_batch[\s\S]*?delete from public\.legacy_person_relation_graph_edges/i);
  assert.doesNotMatch(migration, /family_tree_legacy_relation_sync/i);
  assert.match(appSource, /rollbackGedcomImportOperationToCompletion\(importOperationId\)/);
  assert.match(buttonSource, /rollbackGedcomImportOperationToCompletion\(importOperationId\)/);
});

test("server fences late writes and refuses journals for existing records", () => {
  assert.match(migration, /GEDCOM_IMPORT_ENTITY_ALREADY_EXISTS/);
  assert.match(migration, /create or replace function private\.enforce_gedcom_import_write_fence/);
  assert.match(migration, /for share of operation/);
  assert.match(migration, /GEDCOM_IMPORT_OPERATION_FENCED/);
  assert.match(migration, /requested_by uuid references public\.profiles\(user_id\) on delete set null/i);
  assert.match(migration, /rollback_operation_id/);
  assert.match(appSource, /createGedcomImportBatchFence\(importOperationId\)/);
  assert.match(appSource, /beforeBatch: assertImportBatchActive/);
});

test("journaled GEDCOM relations do not leak into the legacy default graph", () => {
  assert.match(
    migration,
    /create or replace function private\.should_project_legacy_relation_to_family_graph\([\s\S]*?for share of operation[\s\S]*?operation_status is null or operation_status = 'completed'/i,
    "the graph guard must serialize with operation completion and rollback",
  );
  assert.match(
    migration,
    /create trigger person_relations_family_graph_sync[\s\S]*?when \(private\.should_project_legacy_relation_to_family_graph\(new\.project_id, new\.id\)\)[\s\S]*?execute function public\.family_tree_sync_legacy_relation\(\)/i,
    "legacy graph projection must be skipped for relation IDs owned by an active import",
  );
  assert.doesNotMatch(
    migration,
    /drop trigger if exists person_relations_family_graph_delete_sync/i,
    "relation deletion must retain the existing graph cleanup trigger",
  );
});

test("operation commits only after tree creation and discards partial trees", () => {
  const createIndex = buttonSource.indexOf("const createdTree = await onCreateFamilyTree({");
  const completeIndex = buttonSource.indexOf("await completeGedcomImportOperation(importOperationId)");
  assert.ok(createIndex >= 0 && completeIndex > createIndex);
  assert.match(buttonSource, /registerGedcomImportTree\(importOperationId, createdTree\.treeId\)/);
  const productionCreateIndex = productionTreePageSource.indexOf("const result = await createFamilyTreeFromLegacyImport({");
  const productionRegisterIndex = productionTreePageSource.indexOf(
    "await registerGedcomImportTree(input.importOperationId, result.treeId)",
    productionCreateIndex,
  );
  const archiveIndex = productionTreePageSource.indexOf("const savedArchive = await saveGedcomArchive({", productionCreateIndex);
  assert.ok(productionCreateIndex >= 0 && productionRegisterIndex > productionCreateIndex);
  assert.ok(archiveIndex > productionRegisterIndex, "tree registration must precede archive persistence");
  assert.match(
    personsPageSource,
    /createFamilyTreeFromLegacyImport\([\s\S]*?await registerGedcomImportTree\(importOperationId, result\.treeId\)[\s\S]*?return result/,
  );
  assert.match(
    archiveSource,
    /batch = batchResult\.data[\s\S]*?await registerGedcomImportArchive\(input\.rollbackOperationId, batch\.id\)[\s\S]*?buildGedcomArchiveXrefRows/,
    "archive batch must be registered before any xref rows are written",
  );
  assert.match(
    mutationSource,
    /catch \(error\) \{[\s\S]*?deleteFamilyTree\(\{ projectId: input\.projectId, treeId \}\)[\s\S]*?throw error/,
  );
  assert.match(
    migration,
    /status = 'completed'[\s\S]*?candidate\.operation_id = target_operation_id[\s\S]*?limit 500/i,
    "a successful 100k-row import must not delete its whole journal in one statement",
  );
  assert.match(
    migration,
    /if current_entity_type = 'family_tree'[\s\S]*?set is_default = true/i,
    "rollback must restore a default tree after discarding the imported default",
  );
});

test("stale import rollback is service-only and scheduled", () => {
  assert.match(
    migration,
    /heartbeat_at < clock_timestamp\(\) - interval '15 minutes'/i,
  );
  assert.match(
    migration,
    /SERVICE_ROLE_REQUIRED[\s\S]*?grant execute on function public\.process_next_stale_gedcom_import_rollback\(integer\)[\s\S]*?to service_role/i,
  );
  assert.match(workerSource, /TASK_REMINDER_CRON_SECRET/);
  assert.match(workerSource, /process_next_stale_gedcom_import_rollback/);
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
  assert.match(workflow, /process-gedcom-import-rollbacks/);
});
