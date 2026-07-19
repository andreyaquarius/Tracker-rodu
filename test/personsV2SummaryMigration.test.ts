import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607180001_persons_module_v2_summary.sql",
    import.meta.url,
  ),
  "utf8",
);

const summaryFunction = migration.match(
  /create or replace function public\.list_person_summaries\(target_project_id uuid\)([\s\S]*?)\$function\$;/i,
)?.[1] ?? "";

test("persons V2 summaries execute with caller RLS and a hardened search path", () => {
  assert.match(summaryFunction, /language sql/i);
  assert.match(summaryFunction, /stable/i);
  assert.match(summaryFunction, /security invoker/i);
  assert.match(summaryFunction, /set search_path = ''/i);
  assert.doesNotMatch(summaryFunction, /security definer/i);
  assert.match(summaryFunction, /from public\.persons person/i);
  assert.match(summaryFunction, /where person\.project_id = target_project_id/i);
  assert.match(
    migration,
    /revoke all on function public\.list_person_summaries\(uuid\) from public, anon/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.list_person_summaries\(uuid\) to authenticated/i,
  );
  assert.match(migration, /comment on function public\.list_person_summaries\(uuid\)/i);
});

test("persons V2 summary exposes every catalogue aggregate", () => {
  for (const column of [
    "person_id uuid",
    "relation_count bigint",
    "task_count bigint",
    "hypothesis_count bigint",
    "archive_request_count bigint",
    "finding_count bigint",
    "document_count bigint",
    "last_event_type text",
    "last_event_date text",
  ]) {
    assert.match(summaryFunction, new RegExp(column.replace(" ", "\\s+"), "i"));
  }

  assert.match(summaryFunction, /from public\.task_persons link/i);
  assert.match(summaryFunction, /from public\.hypothesis_links link/i);
  assert.match(summaryFunction, /link\.target_type = 'person'/i);
  assert.match(summaryFunction, /from public\.archive_request_persons link/i);
  assert.match(summaryFunction, /from public\.person_timeline_events event/i);
  assert.match(summaryFunction, /row_number\(\) over/i);
});

test("legacy relations are counted in both directions without duplicate rows", () => {
  assert.match(
    summaryFunction,
    /select\s+relation\.person_id,[\s\S]*?union all[\s\S]*?relation\.related_person_id as person_id/i,
  );
  assert.match(summaryFunction, /count\(distinct link\.relation_id\)/i);
  assert.match(summaryFunction, /left join relation_counts relations on relations\.person_id = person\.id/i);
});

test("finding fallback accepts only an array and deduplicates findings", () => {
  assert.match(
    summaryFunction,
    /jsonb_typeof\([\s\S]*?__trackerRoduFindingMeta,personIds[\s\S]*?\) = 'array'/i,
  );
  assert.match(summaryFunction, /jsonb_array_elements_text/i);
  assert.match(summaryFunction, /join public\.finding_participants participant/i);
  assert.match(summaryFunction, /count\(distinct link\.finding_id\) as finding_count/i);
  assert.doesNotMatch(summaryFunction, /person_id_text::uuid/i);
});

test("document count deduplicates visible documents from findings, tasks, and hypotheses", () => {
  assert.match(
    summaryFunction,
    /person_document_links as[\s\S]*?from finding_links link[\s\S]*?union all/i,
  );
  assert.match(
    summaryFunction,
    /from public\.task_persons link[\s\S]*?join public\.tasks task[\s\S]*?task\.document_id/i,
  );
  assert.match(
    summaryFunction,
    /from public\.hypothesis_links person_link[\s\S]*?join public\.hypothesis_links document_link/i,
  );
  assert.match(summaryFunction, /person_link\.target_type = 'person'/i);
  assert.match(summaryFunction, /document_link\.target_type = 'document'/i);
  assert.match(summaryFunction, /count\(distinct document\.id\) as document_count/i);
  assert.match(
    summaryFunction,
    /from person_document_links link[\s\S]*?join public\.documents document/i,
  );
  assert.match(
    summaryFunction,
    /left join document_counts documents on documents\.person_id_text = person\.id::text/i,
  );
});

test("independent pre-aggregates keep the final result at one row per visible person", () => {
  for (const cte of [
    "relation_counts",
    "task_counts",
    "hypothesis_counts",
    "archive_request_counts",
    "finding_counts",
    "document_counts",
    "last_events",
  ]) {
    assert.match(summaryFunction, new RegExp(`left join ${cte}`, "i"));
  }
  assert.match(summaryFunction, /event\.event_rank = 1/i);
  assert.match(summaryFunction, /order by person\.updated_at desc, person\.id asc/i);
});
