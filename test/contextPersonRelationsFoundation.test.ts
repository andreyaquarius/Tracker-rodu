import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608290009_context_person_relations_foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const dbTest = readFileSync(
  new URL("../supabase/tests/context_person_relations_test.sql", import.meta.url),
  "utf8",
);

test("context relations are project-scoped and cannot enter the classic family graph", () => {
  const relationTable = sourceBlock(
    migration,
    "create table if not exists public.person_context_relations",
    "comment on table public.person_context_relations",
  );

  assert.match(relationTable, /project_id uuid not null/i);
  assert.doesNotMatch(relationTable, /\btree_id\b/i);
  assert.match(migration, /create table if not exists public\.context_graph_revisions/i);
  assert.doesNotMatch(migration, /update\s+public\.family_trees/i);
  assert.match(
    migration,
    /if not exists \([\s\S]*?public\.family_trees[\s\S]*?return old;[\s\S]*?sync_context_from_association_v1\(old\.id, true\)/i,
  );
});

test("structured finding participants are constrained to the finding and person project", () => {
  assert.match(
    migration,
    /constraint finding_participants_finding_project_fkey[\s\S]*?foreign key \(finding_id, project_id\)[\s\S]*?references public\.findings\(id, project_id\)/i,
  );
  assert.match(
    migration,
    /constraint finding_participants_person_project_fkey[\s\S]*?foreign key \(person_id, project_id\)[\s\S]*?references public\.persons\(id, project_id\)/i,
  );
  assert.match(migration, /FINDING_PARTICIPANT_FINDING_PROJECT_MISMATCH/i);
  assert.match(migration, /FINDING_PARTICIPANT_PERSON_PROJECT_MISMATCH/i);
  assert.match(migration, /validate constraint finding_participants_finding_project_fkey/i);
  assert.match(migration, /validate constraint finding_participants_person_project_fkey/i);
});

test("context RPCs fail closed for project access, living privacy, and evidence scope", () => {
  assert.match(
    migration,
    /create or replace function public\.list_person_context_relations_v1[\s\S]*?security invoker/i,
  );
  assert.match(
    migration,
    /create or replace function security_private\.list_person_context_relations_v1[\s\S]*?security definer/i,
  );
  assert.match(migration, /endpoint\.is_living[\s\S]*?endpoint\.privacy_status in \('private', 'confidential'\)/i);
  assert.match(migration, /CONTEXT_EVIDENCE_DOCUMENT_PROJECT_MISMATCH/i);
  assert.match(migration, /CONTEXT_EVIDENCE_FINDING_PROJECT_MISMATCH/i);
  assert.match(migration, /CONTEXT_EVIDENCE_EVENT_PROJECT_MISMATCH/i);
  assert.match(migration, /CONTEXT_EVIDENCE_PARTICIPANT_PROJECT_MISMATCH/i);
  assert.match(
    migration,
    /revoke all on table[\s\S]*?public\.person_context_relations[\s\S]*?from public, anon, authenticated/i,
  );
});

test("migration and pgTAP contract are transactional and cover deletion lifecycle", () => {
  assert.match(migration, /^begin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.match(
    migration,
    /'context_relation_evidence'[\s\S]*?'person_context_relations'[\s\S]*?'context_relation_types'[\s\S]*?'context_graph_revisions'/i,
  );
  assert.match(dbTest, /select plan\(42\)/i);
  assert.match(
    dbTest,
    /deleting a family tree removes its compatibility edge but preserves the project social assertion/i,
  );
  assert.match(
    dbTest,
    /cannot infer a relation touching a living private endpoint/i,
  );
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
