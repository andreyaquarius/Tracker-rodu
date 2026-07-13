import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130009_persons_bulk_upsert_stability.sql",
    import.meta.url,
  ),
  "utf8",
);

test("persons projection deletes have a person-first partial index", () => {
  assert.match(
    migration,
    /create index if not exists person_timeline_events_persons_projection_person_idx\s+on public\.person_timeline_events \(person_id\)\s+where metadata ->> 'source' = 'persons_projection'/i,
  );
});

test("person inserts still always build the canonical projection", () => {
  assert.match(
    migration,
    /create trigger persons_family_tree_projection_sync_insert\s+after insert on public\.persons\s+for each row\s+execute function public\.family_tree_sync_person_projection\(\)/i,
  );
});

test("no-op person updates skip projection and graph-version work", () => {
  assert.match(
    migration,
    /create trigger persons_family_tree_projection_sync[\s\S]*?after update of[\s\S]*?when \(\s*row\([\s\S]*?old\.status[\s\S]*?\) is distinct from row\([\s\S]*?new\.status[\s\S]*?\)[\s\S]*?execute function public\.family_tree_sync_person_projection\(\)/i,
  );
  assert.match(
    migration,
    /create trigger persons_bump_family_tree_graph_versions[\s\S]*?after update of[\s\S]*?when \(\s*row\([\s\S]*?old\.status[\s\S]*?\) is distinct from row\([\s\S]*?new\.status[\s\S]*?\)[\s\S]*?execute function public\.family_tree_bump_person_graph_versions\(\)/i,
  );
});
