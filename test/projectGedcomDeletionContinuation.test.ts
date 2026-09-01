import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(new URL("../src/services/projectPeople.ts", import.meta.url), "utf8");
const manager = readFileSync(
  new URL("../src/features/persons-v2/GedcomImportManagerV2.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const migration = readFileSync(
  new URL(
    "../supabase/migrations/202609010001_resumable_gedcom_dataset_deletion.sql",
    import.meta.url,
  ),
  "utf8",
);

test("GEDCOM deletion uses the agreed resumable RPC contract", () => {
  assert.match(migration, /create table if not exists private\.gedcom_deletion_jobs/u);
  assert.match(migration, /person_relations_related_person_id_idx/u);
  assert.match(migration, /phase in \('relations', 'findings', 'trees', 'archives', 'persons', 'finalize', 'completed'\)/u);
  assert.match(migration, /greatest\(1, least\(coalesce\(batch_size, 50\), 100\)\)/u);
  assert.match(migration, /pg_try_advisory_xact_lock/u);
  assert.match(migration, /process_next_gedcom_deletion_job[\s\S]*?to service_role/u);
  assert.match(service, /"start_project_gedcom_deletion"[\s\S]*?target_project_id: projectId,[\s\S]*?target_source_key: sourceKey/u);
  assert.match(service, /"continue_project_gedcom_deletion"[\s\S]*?target_job_id: progress\.jobId,[\s\S]*?batch_size: currentBatchSize/u);
  assert.match(service, /"get_project_gedcom_deletion"[\s\S]*?target_job_id: jobId/u);
  assert.match(service, /progress\.done \|\| progress\.status === "completed"/u);
});

test("GEDCOM deletion is fenced synchronously and bounded in the foreground", () => {
  assert.match(service, /const active = projectGedcomDeletionInFlight\.get\(operationKey\);[\s\S]*?if \(active\) return active/u);
  assert.match(service, /projectGedcomDeletionInFlight\.set\(operationKey, operation\)/u);
  assert.match(service, /PROJECT_GEDCOM_DELETION_MAX_CONTINUATIONS = 500/u);
  assert.match(service, /PROJECT_GEDCOM_DELETION_MAX_RUN_TIME_MS = 4 \* 60_000/u);
  assert.match(service, /Прогрес збережено — натисніть видалення набору ще раз/u);
});

test("timeouts reconcile server progress and adaptively shrink a batch", () => {
  assert.match(service, /isDatabaseStatementTimeout\(error\)/u);
  assert.match(service, /readProjectGedcomDeletionAfterFailure/u);
  assert.match(service, /currentBatchSize = Math\.max\(1, Math\.floor\(currentBatchSize \/ 2\)\)/u);
  assert.match(service, /lastErrorCode: deletionText\(record, "lastErrorCode", "last_error_code"\)/u);
  assert.match(service, /code === "57014"/u);
  assert.match(service, /\["57014", "40001", "40P01", "55P03"\]\.includes\(code\)/u);
});

test("manager blocks double clicks synchronously and exposes live progress", () => {
  assert.match(manager, /deletionInFlightRef\.current = true/u);
  assert.match(manager, /subscribeProjectGedcomDeletionProgress/u);
  assert.match(manager, /<progress/u);
  assert.match(manager, /aria-live="polite"/u);
  assert.match(manager, /case "archives": return "Очищаємо архівні привʼязки"/u);
  assert.match(styles, /\.persons-v2-gedcom-manager__item\s*>\s*\.gedcom-import-progress\s*\{[\s\S]*?flex:\s*1 0 100%/u);
  assert.match(styles, /\.persons-v2-gedcom-manager__item\s*>\s*\.gedcom-import-progress progress\s*\{[\s\S]*?width:\s*100%/u);
});
