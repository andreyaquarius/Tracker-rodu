import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190004_zagulyaky_rpc_acl_hardening.sql", import.meta.url),
  "utf8",
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertRevokedFromEveryApiRole(signature: string): void {
  assert.match(
    migration,
    new RegExp(
      `revoke all on function ${escapeRegExp(signature)}\\s+from public, anon, authenticated, service_role;`,
      "i",
    ),
    `${signature} must clear inherited PUBLIC and direct API-role execution before its intended grant is restored`,
  );
}

function assertGrantedExactlyTo(signature: string, roles: string): void {
  assert.match(
    migration,
    new RegExp(`grant execute on function ${escapeRegExp(signature)}\\s+to ${escapeRegExp(roles)};`, "i"),
    `${signature} must restore only its intended API roles`,
  );
}

const anonymousCatalogue = [
  "public.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid)",
  "public.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid)",
  "public.get_public_zagulyaka_v1(text)",
  "public.get_zagulyaky_public_stats_v1()",
];

const authenticatedOrService = [
  "public.create_zagulyaka_draft_v1(text,jsonb)",
  "public.update_my_zagulyaka_draft_v1(uuid,integer,jsonb)",
  "public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb)",
  "public.submit_zagulyaka_v1(uuid,integer)",
  "public.withdraw_zagulyaka_v1(uuid,integer)",
  "public.get_my_zagulyaky_v1(text,integer,integer)",
  "public.get_my_zagulyaka_draft_v1(uuid)",
  "public.confirm_zagulyaka_v1(uuid,text,text)",
  "public.create_zagulyaka_claim_v1(uuid,text,text)",
  "public.set_zagulyaka_bookmark_v1(uuid,boolean)",
  "public.attach_my_zagulyaka_file_v1(uuid,integer,text,text,text,bigint,text)",
  "public.delete_my_zagulyaka_draft_v3(uuid,integer)",
  "public.delete_my_zagulyaka_attachment_v2(uuid,uuid,integer)",
  "public.admin_list_zagulyaky_queue_v1(text,integer,integer)",
  "public.admin_review_zagulyaka_v1(uuid,integer,text,text,text,text,text)",
  "public.admin_list_zagulyaky_claims_v1(text,integer,integer)",
  "public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)",
  "public.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)",
  "public.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)",
  "public.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)",
  "public.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)",
  "public.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)",
  "public.admin_get_zagulyaka_privacy_clearance_v1(uuid)",
  "public.admin_record_zagulyaka_living_consent_v1(uuid,timestamptz,text,text)",
  "public.admin_get_zagulyaka_attachment_review_v1(uuid)",
  "public.admin_prepare_zagulyaka_attachment_publication_v2(uuid)",
  "public.admin_complete_zagulyaka_attachment_publication_v2(uuid,text)",
  "public.admin_revoke_zagulyaka_attachment_publication_v2(uuid)",
];

const serviceOnly = [
  "public.claim_zagulyaky_storage_cleanup_queue_v1(integer)",
  "public.claim_zagulyaky_storage_cleanup_task_v1(uuid)",
  "public.finalize_zagulyaky_storage_cleanup_v1(uuid,uuid,boolean,text)",
  "public.service_get_public_zagulyaka_attachment_delivery_v1(uuid)",
];

const disabledLegacyRoutes = [
  "public.delete_my_zagulyaka_draft_v1(uuid,integer)",
  "public.delete_my_zagulyaka_draft_v2(uuid,integer)",
  "public.delete_my_zagulyaka_attachment_v1(uuid,uuid,integer)",
  "public.admin_resolve_zagulyaka_claim_v1(uuid,text,text)",
  "public.admin_prepare_zagulyaka_attachment_publication_v1(uuid)",
  "public.admin_complete_zagulyaka_attachment_publication_v1(uuid,text)",
  "public.admin_revoke_zagulyaka_attachment_publication_v1(uuid)",
  "public.get_public_zagulyaka_attachment_delivery_v1(uuid)",
];

test("every current public Zagulyaky RPC has an explicit anon/PUBLIC ACL contract", () => {
  for (const signature of [
    ...anonymousCatalogue,
    ...authenticatedOrService,
    "public.claim_my_zagulyaky_storage_cleanup_v1(integer)",
    ...serviceOnly,
    ...disabledLegacyRoutes,
  ]) {
    assertRevokedFromEveryApiRole(signature);
  }
});

test("only the catalogue RPCs receive direct anonymous execution", () => {
  for (const signature of anonymousCatalogue) {
    assertGrantedExactlyTo(signature, "anon, authenticated, service_role");
  }
  for (const signature of [...authenticatedOrService, "public.claim_my_zagulyaky_storage_cleanup_v1(integer)", ...serviceOnly]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`grant execute on function ${escapeRegExp(signature)}\\s+to anon`, "i"),
      `${signature} must not be callable directly by anon`,
    );
  }
});

test("write, moderation, worker, and deprecated routes retain their exact grant boundaries", () => {
  for (const signature of authenticatedOrService) {
    assertGrantedExactlyTo(signature, "authenticated, service_role");
  }
  assertGrantedExactlyTo("public.claim_my_zagulyaky_storage_cleanup_v1(integer)", "authenticated");
  for (const signature of serviceOnly) {
    assertGrantedExactlyTo(signature, "service_role");
  }
  for (const signature of disabledLegacyRoutes) {
    assert.doesNotMatch(
      migration,
      new RegExp(`grant execute on function ${escapeRegExp(signature)}\\s+to`, "i"),
      `${signature} is a disabled legacy route and must not regain execution`,
    );
  }
});

test("anonymous attachment delivery remains behind the Edge facade, not a direct Storage RPC", () => {
  assert.match(
    migration,
    /zagulyaka-attachment Edge Function[\s\S]*?service-only facade[\s\S]*?short-lived URL/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.get_public_zagulyaka_attachment_delivery_v1\(uuid\)\s+to/i,
  );
  assertGrantedExactlyTo("public.service_get_public_zagulyaka_attachment_delivery_v1(uuid)", "service_role");
});
