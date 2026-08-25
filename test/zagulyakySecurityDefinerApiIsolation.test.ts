import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608250005_zagulyaky_security_definer_api_isolation.sql",
    import.meta.url,
  ),
  "utf8",
);

const pgtapContract = readFileSync(
  new URL("../supabase/tests/security_definer_api_surface_test.sql", import.meta.url),
  "utf8",
);

const movedRpcNames = [
  "admin_list_zagulyaky_claims_v1",
  "admin_list_zagulyaky_queue_v1",
  "admin_review_zagulyaka_v1",
  "attach_my_zagulyaka_file_v1",
  "confirm_zagulyaka_v1",
  "create_zagulyaka_claim_v1",
  "create_zagulyaka_draft_v1",
  "delete_my_zagulyaka_attachment_v2",
  "delete_my_zagulyaka_draft_v3",
  "delete_my_zagulyaky_saved_place_v1",
  "delete_my_zagulyaky_saved_source_preset_v1",
  "get_my_zagulyaka_draft_v1",
  "get_my_zagulyaky_page_v1",
  "get_my_zagulyaky_v1",
  "get_zagulyaky_public_stats_v1",
  "list_my_zagulyaky_saved_places_v1",
  "list_my_zagulyaky_saved_source_presets_v1",
  "replace_my_zagulyaka_details_v1",
  "search_zagulyaky_documents_v1",
  "search_zagulyaky_people_v1",
  "set_zagulyaka_bookmark_v1",
  "submit_zagulyaka_v1",
  "update_my_zagulyaka_draft_v1",
  "upsert_my_zagulyaky_saved_place_v1",
  "upsert_my_zagulyaky_saved_source_preset_v1",
  "withdraw_zagulyaka_v1",
] as const;

const publicRpcNames = ["get_public_zagulyaka_v1", ...movedRpcNames] as const;
const privateImplementationNames = [
  "get_public_zagulyaka_api_v1",
  ...movedRpcNames,
] as const;
const signedOnlyRpcNames = movedRpcNames.filter(
  (name) =>
    ![
      "get_zagulyaky_public_stats_v1",
      "search_zagulyaky_documents_v1",
      "search_zagulyaky_people_v1",
    ].includes(name),
);

function extractedNames(pattern: RegExp): string[] {
  return [...migration.matchAll(pattern)].map((match) => match[1]).sort();
}

test("all Zagulyaky Advisor implementations move behind invoker-compatible facades", () => {
  const moved = extractedNames(
    /^alter function public\.([a-z0-9_]+)\([^;]*?\)\s+set schema security_private;/gim,
  );
  const wrappers = extractedNames(/^create function public\.([a-z0-9_]+)\(/gim);

  assert.deepEqual(moved, [...privateImplementationNames].sort());
  assert.deepEqual(wrappers, [...publicRpcNames].sort());
  assert.equal(moved.length, 27);
  assert.equal(wrappers.length, 27);

  assert.match(
    migration,
    /alter function public\.get_public_zagulyaka_v1\(text\)\s+rename to get_public_zagulyaka_api_v1;/i,
  );
  assert.match(
    migration,
    /alter function public\.get_public_zagulyaka_api_v1\(text\)\s+set schema security_private;/i,
  );
  assert.match(
    migration,
    /create function public\.get_public_zagulyaka_v1\(p_slug text\)[\s\S]*?security invoker[\s\S]*?security_private\.get_public_zagulyaka_api_v1\(\$1\)/i,
  );

  const wrapperBlocks = migration.match(
    /create function public\.[\s\S]*?\$wrapper\$;/gim,
  ) ?? [];
  assert.equal(wrapperBlocks.length, 27);
  for (const block of wrapperBlocks) {
    assert.match(block, /security invoker/i);
    assert.match(block, /set search_path = pg_catalog/i);
    assert.doesNotMatch(block, /security definer/i);
  }
});

test("anonymous access remains limited to four public catalogue implementations", () => {
  assert.match(
    migration,
    /grant usage on schema security_private to anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /SECURITY_PRIVATE_SCHEMA_MUST_NOT_BE_EXPOSED/i,
  );

  const anonymousGrantBlocks = (migration.match(
    /grant execute on function[\s\S]*?;/gim,
  ) ?? []).filter((block) => /to anon, authenticated, service_role;/i.test(block));
  assert.equal(anonymousGrantBlocks.length, 2);

  for (const block of anonymousGrantBlocks) {
    assert.match(block, /get_public_zagulyaka_(?:api_)?v1/i);
    assert.match(block, /get_zagulyaky_public_stats_v1/i);
    assert.match(block, /search_zagulyaky_documents_v1/i);
    assert.match(block, /search_zagulyaky_people_v1/i);
    assert.doesNotMatch(block, /create_zagulyaka_draft_v1/i);
    assert.doesNotMatch(block, /admin_review_zagulyaka_v1/i);
  }

  assert.doesNotMatch(
    migration,
    /grant execute on function security_private\.get_public_zagulyaka_v1\(text\)\s+to anon/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function security_private\.search_zagulyaky_v1\([^)]*\)\s+to anon/i,
  );
});

test("signed-in roles retain every non-catalogue RPC on both layers", () => {
  const signedInGrantBlocks = (migration.match(
    /grant execute on function[\s\S]*?;/gim,
  ) ?? []).filter((block) => /to authenticated, service_role;/i.test(block));

  assert.equal(signedInGrantBlocks.length, 2);
  const privateGrant = signedInGrantBlocks.find((block) => /security_private\./i.test(block));
  const publicGrant = signedInGrantBlocks.find((block) => /public\./i.test(block));
  assert.ok(privateGrant);
  assert.ok(publicGrant);

  for (const name of signedOnlyRpcNames) {
    assert.match(privateGrant, new RegExp(`security_private\\.${name}\\(`, "i"));
    assert.match(publicGrant, new RegExp(`public\\.${name}\\(`, "i"));
  }
});

test("the database regression test covers the new Advisor surface and ACL split", () => {
  assert.match(pgtapContract, /select plan\(18\);/i);
  assert.match(
    pgtapContract,
    /the regression list covers all 67 protected Security Advisor entry points/i,
  );
  assert.match(
    pgtapContract,
    /security_private\.get_public_zagulyaka_api_v1\(text\)/i,
  );
  assert.match(
    pgtapContract,
    /anonymous callers can execute only the intended trusted catalogue implementations/i,
  );
  assert.match(
    pgtapContract,
    /Security Advisor has no API-executable SECURITY DEFINER function in exposed schemas/i,
  );
});
