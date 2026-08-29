import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settlementMigration = readFileSync(
  new URL(
    "../supabase/migrations/202608290005_zagulyaky_public_settlement_identity.sql",
    import.meta.url,
  ),
  "utf8",
);
const bridgeMigration = readFileSync(
  new URL(
    "../supabase/migrations/202608290007_historical_places_legacy_event_bridge.sql",
    import.meta.url,
  ),
  "utf8",
);
const historicalPlacesService = readFileSync(
  new URL("../src/services/historicalPlacesService.ts", import.meta.url),
  "utf8",
);
const historicalPlacesPage = readFileSync(
  new URL("../src/pages/HistoricalPlacesPage.tsx", import.meta.url),
  "utf8",
);

function sqlFunction(source: string, qualifiedName: string): string {
  const escapedName = qualifiedName.replaceAll(".", "\\.");
  const start = source.search(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapedName}\\s*\\(`,
    "i",
  ));
  assert.notEqual(start, -1, `Missing SQL function ${qualifiedName}`);
  const functionTail = source.slice(start);
  const delimiter = functionTail.match(/\bas\s+(\$[a-z_][a-z0-9_]*\$)/i)?.[1] ?? "$function$";
  const bodyStart = source.indexOf(delimiter, start);
  const end = source.indexOf(`${delimiter};`, bodyStart + delimiter.length);
  assert.notEqual(end, -1, `${qualifiedName} must have a bounded body`);
  return source.slice(start, end + `${delimiter};`.length);
}

const settlementLabelFunction = sqlFunction(
  settlementMigration,
  "security_private.zagulyaky_is_settlement_label_v1",
);
const settlementKeyFunction = sqlFunction(
  settlementMigration,
  "security_private.zagulyaky_public_place_key_v1",
);
const bridgeImplementation = sqlFunction(
  bridgeMigration,
  "security_private.bridge_legacy_person_event_places_v1",
);
const bridgeWrapper = sqlFunction(
  bridgeMigration,
  "public.bridge_legacy_person_event_places_v1",
);

test("the public settlement picker rejects bare administrative and country labels", () => {
  assert.match(settlementLabelFunction, /regexp_split_to_array\(p_label,\s*','\)/i);
  for (const administrativeLabel of [
    "губернія", "область", "повіт", "уезд", "район", "округ",
    "громада", "волость", "воєводство", "край", "держава", "імперія",
  ]) {
    assert.match(settlementLabelFunction, new RegExp(administrativeLabel, "iu"));
  }
  for (const countryLabel of ["україна", "росія", "польща", "білорусь", "молдова", "румунія", "срср"]) {
    assert.match(settlementLabelFunction, new RegExp(countryLabel, "iu"));
  }
  assert.match(
    settlementLabelFunction,
    /if normalized_component ~ '[^']*губернія[^']*' then[\s\S]*?continue;[\s\S]*?if normalized_component ~ '\^\(україна[^']*' then[\s\S]*?continue;[\s\S]*?return true;/iu,
  );
  assert.match(settlementLabelFunction, /return false;[\s\S]*?end;/iu);
  assert.match(settlementMigration, /zagulyaky_is_settlement_label_v1\(v_display_name\)/iu);
});

test("contextual coordinate drift is reconciled only inside the bounded private registry", () => {
  assert.match(settlementKeyFunction, /zagulyaky_raw_place_fingerprint_v1\(v_geo\)/u);
  assert.match(settlementKeyFunction, /zagulyaky_canonical_place_aliases/iu);
  assert.doesNotMatch(settlementKeyFunction, /contextual-settlement-v2/iu);
  assert.match(settlementMigration, /do \$reconcile_contextual_places\$/iu);
  assert.match(settlementMigration, /zagulyaky_place_distance_km_v1\([\s\S]*?\) <= 0\.5/iu);
  assert.match(settlementMigration, /set place_id = duplicate_pair\.keeper_id/iu);
  assert.doesNotMatch(
    settlementMigration,
    /^\s*(?:update|insert\s+into|delete\s+from)\s+public\.zagulyaky_records\b/imu,
  );
  assert.doesNotMatch(settlementMigration, /update\s+security_private\.zagulyaky_canonical_places[\s\S]{0,250}\b(?:latitude|longitude)\s*=/iu);
});

test("legacy event-place bridge is an explicit dry-run-first operation", () => {
  assert.match(bridgeImplementation, /p_apply boolean default false/iu);
  assert.match(bridgeImplementation, /if coalesce\(p_apply,\s*false\) then/iu);
  const applyStart = bridgeImplementation.search(/if coalesce\(p_apply,\s*false\) then/iu);
  const beforeApply = bridgeImplementation.slice(0, applyStart);
  assert.doesNotMatch(beforeApply, /create_project_place_v2|update\s+public\.person_timeline_events/iu);
  assert.match(bridgeImplementation, /'applied',\s*coalesce\(p_apply,\s*false\)/iu);
  assert.match(historicalPlacesPage, /const previewLegacyPlaces = \(\) =>/u);
  assert.match(historicalPlacesPage, /bridgeLegacyPersonEventPlaces\(props\.projectId,\s*false\)/u);
  assert.match(historicalPlacesPage, /Перевірити старі події/u);
  assert.match(
    historicalPlacesPage,
    /if \(!confirmed\) return;[\s\S]*?bridgeLegacyPersonEventPlaces\(props\.projectId,\s*true\)/u,
  );
});

test("legacy bridge is project-scoped and authenticated-only", () => {
  assert.match(bridgeImplementation, /if p_project_id is null then[\s\S]*?PROJECT_ID_REQUIRED/iu);
  assert.match(bridgeImplementation, /require_historical_project_edit_v1\(p_project_id\)/iu);
  assert.match(bridgeImplementation, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*?p_project_id::text/iu);
  const projectFilters = bridgeImplementation.match(/event_row\.project_id\s*=\s*p_project_id/giu) ?? [];
  assert.ok(projectFilters.length >= 3, "every preview and apply event scan stays project scoped");
  assert.match(bridgeWrapper, /security invoker/iu);
  assert.doesNotMatch(bridgeWrapper, /security definer/iu);
  assert.match(
    bridgeMigration,
    /revoke all on function[\s\S]*?public\.bridge_legacy_person_event_places_v1\(uuid, boolean, integer\)[\s\S]*?from public, anon, authenticated, service_role;/iu,
  );
  const grant = bridgeMigration.match(
    /grant execute on function[\s\S]*?public\.bridge_legacy_person_event_places_v1\(uuid, boolean, integer\)[\s\S]*?to authenticated;/iu,
  )?.[0] ?? "";
  assert.ok(grant, "bridge execution grant must exist");
  assert.doesNotMatch(grant, /\banon\b/iu);
  assert.doesNotMatch(grant, /\bservice_role\b/iu);
  assert.match(historicalPlacesService, /requiredText\([\s\S]*?projectId,[\s\S]*?"legacy-import"/u);
});

test("bridge preserves source wording and creates only private needs-review places", () => {
  const eventUpdate = bridgeImplementation.match(
    /update public\.person_timeline_events event_row([\s\S]*?)get diagnostics v_linked_events = row_count;/iu,
  )?.[1] ?? "";
  assert.match(eventUpdate, /place_original_text\s*=\s*case[\s\S]*?then event_row\.place_name[\s\S]*?else event_row\.place_original_text/iu);
  assert.match(eventUpdate, /place_resolution_status\s*=\s*'needs_review'/iu);
  assert.doesNotMatch(eventUpdate, /\bplace_name\s*=/iu);

  const createPayload = bridgeImplementation.match(
    /create_project_place_v2\(\s*p_project_id,\s*jsonb_build_object\(([\s\S]*?)\)\s*\);/iu,
  )?.[1] ?? "";
  assert.match(createPayload, /'canonicalName',\s*candidate\.original_name/iu);
  assert.match(createPayload, /'needsIdentification',\s*true/iu);
  assert.match(createPayload, /'status',\s*'needs_review'/iu);
  assert.match(createPayload, /'verificationStatus',\s*'unverified'/iu);
  assert.match(createPayload, /'requiresReview',\s*true/iu);
  assert.doesNotMatch(createPayload, /isPublic|is_public/iu);
  assert.match(
    historicalPlacesPage,
    /Перенесення не змінює написання в джерелі й створює лише приватні місця зі статусом «Потребує перевірки»/u,
  );
  assert.match(bridgeImplementation, /char_length\(original_name\) between 1 and 500/iu);
  assert.match(bridgeImplementation, /'invalidNames',\s*v_invalid_names/iu);
  assert.match(historicalPlacesService, /invalidNames:\s*nonNegativeInteger/u);
});

test("ambiguous legacy names are reported and never linked automatically", () => {
  assert.match(bridgeImplementation, /count\(\*\) filter \(where match_count > 1\)::integer/iu);
  assert.match(
    bridgeImplementation,
    /where batch\.match_count <= 1[\s\S]*?order by batch\.first_created_at[\s\S]*?limit v_limit/iu,
  );
  assert.match(bridgeImplementation, /where selected_for_batch[\s\S]*?order by first_created_at/iu);
  assert.match(
    bridgeImplementation,
    /candidate\.resolved_place_id is not null[\s\S]*?historical_place_search_normalize_v1\(event_row\.place_name\)\s*=\s*candidate\.normalized_name/iu,
  );
  assert.match(historicalPlacesService, /ambiguousNames:\s*nonNegativeInteger\(value\(row, "ambiguousNames", "ambiguous_names"\),\s*0\)/u);
  assert.match(historicalPlacesPage, /Неоднозначних назв:[^`]*їх буде пропущено/u);
});

test("Historical Places import UI requires an explicit user confirmation and respects read-only access", () => {
  assert.match(historicalPlacesPage, /if \(props\.readOnly \|\| legacyLoading\) return/u);
  assert.match(historicalPlacesPage, /if \(props\.readOnly \|\| legacyLoading \|\| !legacySummary\?\.candidateNames\) return/u);
  assert.match(historicalPlacesPage, /const confirmed = window\.confirm\(/u);
  assert.match(historicalPlacesPage, /Оригінальний текст у подіях буде збережено, а нові прив’язки потребуватимуть перевірки/u);
  assert.match(historicalPlacesPage, /if \(!confirmed\) return/u);
  assert.ok(
    historicalPlacesPage.indexOf("if (!confirmed) return;")
      < historicalPlacesPage.indexOf("bridgeLegacyPersonEventPlaces(props.projectId, true)"),
    "apply RPC must remain after the confirmation gate",
  );
  assert.match(historicalPlacesPage, /\{!props\.readOnly \? \(/u);
  assert.match(historicalPlacesPage, /legacyRequestIdRef\.current \+= 1;[\s\S]*?setLegacySummary\(null\)/u);
  assert.match(historicalPlacesPage, /if \(legacyRequestIdRef\.current !== requestId\) return/u);
});
