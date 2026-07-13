import test from "node:test";
import assert from "node:assert/strict";
import {
  projectDeletionPhaseLabel,
  projectDeletionServerActivityLabel,
} from "../src/utils/projectDeletionUi.ts";

const deletionPhases = [
  "legacy_person_relation_graph_edges",
  "ai_hypothesis_reviews",
  "family_tree_research_issues",
  "tree_layout_positions",
  "gedcom_xref_maps",
  "family_tree_merge_history",
  "person_timeline_events",
  "person_names",
  "association_relationships",
  "parent_child_relationships",
  "parent_sets",
  "partner_relationships",
  "family_group_members",
  "family_groups",
  "family_tree_persons",
  "gedcom_import_batches",
  "family_trees",
  "finding_participants",
  "task_persons",
  "task_notifications",
  "archive_request_persons",
  "hypothesis_links",
  "record_links",
  "custom_records",
  "custom_section_fields",
  "attachments",
  "activity_log",
  "year_matrix",
  "tasks",
  "findings",
  "hypotheses",
  "archive_requests",
  "person_relations",
  "documents",
  "persons",
  "custom_field_definitions",
  "custom_sections",
  "researches",
  "project_invitations",
];

test("every database deletion phase has a specific Ukrainian label", () => {
  for (const phase of deletionPhases) {
    assert.notEqual(projectDeletionPhaseLabel(phase), "Очищаємо дані проєкту", phase);
  }
  assert.equal(
    projectDeletionPhaseLabel("finding_participants"),
    "Очищаємо учасників знахідок",
  );
});

test("server activity makes long deletion phases visibly active", () => {
  const now = Date.parse("2026-07-13T19:00:00.000Z");
  assert.equal(
    projectDeletionServerActivityLabel("2026-07-13T18:59:52.000Z", now),
    "Сервер обробляє дані зараз.",
  );
  assert.equal(
    projectDeletionServerActivityLabel("2026-07-13T18:59:20.000Z", now),
    "Остання активність сервера — 40 с тому.",
  );
  assert.match(
    projectDeletionServerActivityLabel("2026-07-13T18:57:00.000Z", now),
    /Великий етап може тривати кілька хвилин/,
  );
  assert.match(
    projectDeletionServerActivityLabel("2026-07-13T18:50:00.000Z", now),
    /фоновий обробник автоматично продовжить/,
  );
});

test("missing or malformed server timestamps have a safe status", () => {
  assert.equal(
    projectDeletionServerActivityLabel(null),
    "Очікуємо перше оновлення від сервера.",
  );
  assert.equal(
    projectDeletionServerActivityLabel("not-a-date"),
    "Очікуємо перше оновлення від сервера.",
  );
});
