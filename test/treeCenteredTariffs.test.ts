import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = readSource(
  "../supabase/migrations/202607200001_tree_centered_subscription_limits.sql",
);

test("database plan matrix matches the published tree-centred capacities", () => {
  const row = (plan: string, key: string, value: string, unlimited: boolean) => new RegExp(
    `\\('${plan}',\\s*'${key}',\\s*${value},\\s*${unlimited}\\)`,
    "iu",
  );

  assert.match(migration, row("free", "projects", "1", false));
  assert.match(migration, row("free", "family_trees_total", "1", false));
  assert.match(migration, row("free", "persons_total", "500", false));
  assert.match(migration, row("free", "editors_total", "0", false));
  assert.match(migration, row("free", "ai_credits_per_month", "5", false));

  assert.match(migration, row("researcher", "projects", "null", true));
  assert.match(migration, row("researcher", "family_trees_total", "null", true));
  assert.match(migration, row("researcher", "persons_total", "15000", false));
  assert.match(migration, row("researcher", "editors_total", "2", false));
  assert.match(migration, row("researcher", "ai_credits_per_month", "50", false));

  assert.match(migration, row("professional", "projects", "null", true));
  assert.match(migration, row("professional", "family_trees_total", "null", true));
  assert.match(migration, row("professional", "persons_total", "null", true));
  assert.match(migration, row("professional", "editors_total", "5", false));
  assert.match(migration, row("professional", "ai_credits_per_month", "100", false));
});

test("trial keeps Professional features but has a finite 15,000-person capacity", () => {
  assert.match(
    migration,
    /subscription\.status\s*=\s*'trialing'[\s\S]*limits\.limit_key\s*=\s*'persons_total'[\s\S]*then\s+15000/iu,
  );
  assert.match(
    migration,
    /limits\.limit_key\s*=\s*'persons_total'[\s\S]*then\s+false[\s\S]*else\s+limits\.is_unlimited/iu,
  );
});

test("person and tree usage belongs to the owner across all owned projects", () => {
  assert.match(
    migration,
    /when\s+'family_trees_total'\s+then\s*\([\s\S]*join public\.family_trees tree on tree\.project_id = project\.id[\s\S]*project\.owner_id = profile\.user_id/iu,
  );
  assert.match(
    migration,
    /when\s+'persons_total'\s+then\s*\([\s\S]*join public\.persons person on person\.project_id = project\.id[\s\S]*project\.owner_id = profile\.user_id/iu,
  );
  assert.match(migration, /create table if not exists private\.subscription_capacity_counters/iu);
  assert.match(migration, /persons_(?:z_)?account_capacity_insert[\s\S]*after insert on public\.persons/iu);
  assert.match(migration, /family_trees_account_capacity_insert[\s\S]*after insert on public\.family_trees/iu);
  assert.match(
    migration,
    /after insert on public\.persons[\s\S]*referencing new table as account_capacity_new_rows[\s\S]*for each statement/iu,
  );
  assert.match(
    migration,
    /after insert on public\.family_trees[\s\S]*referencing new table as account_capacity_new_rows[\s\S]*for each statement/iu,
  );
  assert.match(migration, /persons_(?:z_)?account_capacity_update[\s\S]*after update on public\.persons[\s\S]*referencing old table as account_capacity_old_rows new table as account_capacity_new_rows/iu);
  assert.match(migration, /family_trees_account_capacity_delete[\s\S]*after delete on public\.family_trees/iu);
  assert.match(migration, /update private\.subscription_capacity_counters counter[\s\S]*counter\.used \+ capacity_change\.delta/iu);
});

test("editor seats are account-wide, distinct, update-safe and exclude viewers", () => {
  assert.match(
    migration,
    /owner_editor_count[\s\S]*member\.role\s*=\s*'editor'[\s\S]*union[\s\S]*invitation\.role\s*=\s*'editor'[\s\S]*invitation\.status\s*=\s*'pending'/iu,
  );
  assert.match(migration, /editor_identity_from_email[\s\S]*lower\((?:pg_catalog\.)?btrim/iu);
  assert.match(migration, /new_contributes\s*:=\s*new\.role\s*=\s*'editor'/iu);
  assert.match(migration, /invitation\.expires_at\s*>\s*now\(\)/iu);
  assert.match(migration, /normalize_project_invitation_expiry/iu);
  assert.match(migration, /project_members_editor_capacity_insert[\s\S]*after insert/iu);
  assert.match(migration, /project_members_editor_capacity_update[\s\S]*after update of[\s\S]*role/iu);
  assert.match(migration, /project_invitations_editor_capacity_insert[\s\S]*after insert/iu);
  assert.match(migration, /project_invitations_editor_capacity_update[\s\S]*after update of[\s\S]*role/iu);
  assert.match(migration, /PLAN_LIMIT_REACHED:editors_total/iu);
});

test("GEDCOM capacity is reserved and rejected before the first person write", () => {
  const sealStart = migration.indexOf(
    "create or replace function security_private.seal_gedcom_import_operation",
  );
  const sealEnd = migration.indexOf("-- AI credits belong", sealStart);
  const seal = migration.slice(sealStart, sealEnd);

  assert.ok(sealStart >= 0 && sealEnd > sealStart);
  assert.match(seal, /entity\.entity_type\s*=\s*'person'/iu);
  assert.match(seal, /current_people\s*\+\s*reserved_people\s*\+\s*incoming_people/iu);
  assert.match(seal, /GEDCOM_PERSON_LIMIT_REACHED/iu);
  assert.match(seal, /current_trees\s*\+\s*reserved_trees\s*\+\s*1/iu);
  assert.match(seal, /GEDCOM_TREE_LIMIT_REACHED/iu);
  assert.ok(
    seal.indexOf("GEDCOM_PERSON_LIMIT_REACHED") < seal.indexOf("set status = 'importing'"),
    "limit rejection is evaluated before import persistence is enabled",
  );
});

test("AI usage in a shared project is charged to the owner and keeps actor audit", () => {
  const aiStart = migration.indexOf(
    "create or replace function security_private.begin_ai_credit_usage",
  );
  const aiEnd = migration.indexOf(
    "create or replace function security_private.subscription_limit_snapshot",
    aiStart,
  );
  const ai = migration.slice(aiStart, aiEnd);

  assert.ok(aiStart >= 0 && aiEnd > aiStart);
  assert.match(ai, /billing_owner_id\s*:=\s*public\.project_owner_id\(target_project_id\)/iu);
  assert.match(ai, /insert into public\.subscription_usage[\s\S]*billing_owner_id/iu);
  assert.match(ai, /'actor_id',\s*actor_id/iu);
  assert.match(ai, /'billing_owner_id',\s*billing_owner_id/iu);
});

test("family tree entitlement is core authenticated access, not a beta allow-list", () => {
  assert.match(
    migration,
    /create or replace function security_private\.can_use_family_tree_feature\(\)[\s\S]*select auth\.uid\(\) is not null/iu,
  );
  assert.match(
    migration,
    /project_capacity\s*:=\s*jsonb_build_object\([\s\S]*subscription_limit_snapshot\(project_owner\)[\s\S]*subscription_usage_snapshot\(project_owner/iu,
  );
  assert.match(migration, /'projectCapacity',\s*project_capacity/iu);
});

test("tree-centred tariff errors are stable and explain editor/viewer separation", () => {
  const source = readSource("../src/services/subscriptionService.ts");

  assert.match(source, /GEDCOM_PERSON_LIMIT_REACHED/iu);
  assert.match(source, /"PLAN_LIMIT_REACHED:persons_total"/u);
  assert.match(source, /"PLAN_LIMIT_REACHED:family_trees_total"/u);
  assert.match(source, /"PLAN_LIMIT_REACHED:editors_total"[\s\S]*глядачів.+без обмежень/iu);
  assert.match(source, /GEDCOM_PERSON_LIMIT_REACHED:[\s\S]*GEDCOM.+нових осіб/iu);
  assert.match(source, /GEDCOM_TREE_LIMIT_REACHED:[\s\S]*ще одне родове дерево/iu);
});

test("subscription client exposes account capacity keys and published fail-safe limits", () => {
  const types = readSource("../src/types/subscription.ts");
  const service = readSource("../src/services/subscriptionService.ts");
  const hook = readSource("../src/hooks/useSubscription.ts");

  for (const key of ["persons_total", "family_trees_total", "editors_total"]) {
    assert.match(types, new RegExp(`\\| \\"${key}\\"`));
    assert.match(service, new RegExp(`\\b${key}:`));
  }

  assert.match(service, /persons_total:\s*\{[^}]*value:\s*500/iu);
  assert.match(service, /persons_total:\s*\{[^}]*value:\s*15_000/iu);
  assert.match(service, /persons_total:\s*\{[^}]*value:\s*null[^}]*isUnlimited:\s*true/iu);
  assert.match(service, /editors_total:\s*\{[^}]*value:\s*0/iu);
  assert.match(service, /editors_total:\s*\{[^}]*value:\s*2/iu);
  assert.match(service, /editors_total:\s*\{[^}]*value:\s*5/iu);
  assert.match(hook, /canCreateFamilyTree:[\s\S]*family_trees_total/iu);
  assert.match(hook, /canCreatePerson:[\s\S]*persons_total/iu);
  assert.match(hook, /canInviteEditor:[\s\S]*editors/iu);
});

test("viewer invitations stay available when editor capacity is exhausted", () => {
  const source = readSource("../src/components/ProjectTeamModal.tsx");

  assert.match(source, /role\s*===\s*"editor"\s*&&\s*!canInviteEditor/iu);
  assert.equal(
    source.match(/subscriptionErrorCode\([^)]*\)\s*===\s*"PLAN_LIMIT_REACHED:editors_total"/gu)?.length,
    3,
    "create invitation and both role-update paths handle the authoritative server limit",
  );
  assert.doesNotMatch(source, /if\s*\(\s*!canInviteEditor\s*\)\s*\{\s*onUpgradeRequired/iu);
  assert.match(source, /<option value="viewer">Лише перегляд<\/option>/u);
});

test("GEDCOM import checks account person capacity after reconciliation and before persistence", () => {
  const source = readSource("../src/App.tsx");
  const countPosition = source.indexOf("peopleToImport.length > remainingPersons");
  const reservationPosition = source.indexOf("prepareGedcomImportOperation({", countPosition);

  assert.ok(countPosition >= 0, "reconciled new-person count is checked");
  assert.ok(
    reservationPosition > countPosition,
    "the client check runs before the durable import reservation is sealed",
  );
  assert.match(source, /getCapacityLimit\("persons_total"\)/u);
  assert.match(source, /getCapacityUsage\("persons_total"\)/u);
});

test("tariff operations documentation records trial, downgrade and owner-pool rules", () => {
  const source = readSource("../docs/TREE_CENTERED_TARIFFS.md");

  assert.match(source, /persons_total = 15000/u);
  assert.match(source, /MANAGE_EXISTING/u);
  assert.match(source, /спільного місячного пулу\s+власника/iu);
  assert.match(source, /Ролі `viewer`[\s\S]*не враховуються[\s\S]*`editors_total`/iu);
  assert.match(source, /до першого запису/iu);
  assert.match(source, /`AFTER INSERT\/UPDATE\/DELETE \.\.\. FOR EACH STATEMENT`/u);
  assert.match(source, /Окремого row-level `BEFORE INSERT`[\s\S]*quota-тригера немає/u);
});
