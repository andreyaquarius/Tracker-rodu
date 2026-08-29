import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PlaceSummary } from "../src/types/historicalPlaces.ts";
import {
  clearFindingDocumentPlace,
  confirmFindingDocumentPlace,
  confirmFindingHistoricalPlaceDecision,
  currentConfirmedFindingPlace,
  exactFindingEventDate,
  FindingHistoricalPlaceWorkflowError,
  findingHistoricalPlaceDecisionFromState,
  findingHistoricalPlaceContextKey,
  getFindingDocumentPlace,
  selectFindingHistoricalPlace,
} from "../src/services/findingHistoricalPlaceWorkflow.ts";

const workflowSource = readFileSync(
  new URL("../src/services/findingHistoricalPlaceWorkflow.ts", import.meta.url),
  "utf8",
);
const panelSource = readFileSync(
  new URL("../src/components/FindingHistoricalPlacePanel.tsx", import.meta.url),
  "utf8",
);
const crudSource = readFileSync(
  new URL("../src/pages/CrudPage.tsx", import.meta.url),
  "utf8",
);
const aiSource = readFileSync(
  new URL("../src/components/FindingAiIndexingPanel.tsx", import.meta.url),
  "utf8",
);

const context = {
  projectId: "project-1",
  documentId: "document-1",
  originalText: " села Трубіевки ",
  eventDate: "1862-07-01",
};

test("finding date context accepts only a real complete date", () => {
  assert.equal(exactFindingEventDate("1862-07-01"), "1862-07-01");
  assert.equal(exactFindingEventDate(" 1862-07-01 "), "1862-07-01");
  assert.equal(exactFindingEventDate("1862"), null);
  assert.equal(exactFindingEventDate("1862-02-30"), null);
  assert.equal(exactFindingEventDate(""), null);
});

test("exact place wording is part of the decision identity and is not trimmed", () => {
  assert.notEqual(
    findingHistoricalPlaceContextKey(context),
    findingHistoricalPlaceContextKey({ ...context, originalText: context.originalText.trim() }),
  );
});

test("a suggested place is never confirmed automatically", () => {
  const place = samplePlace();
  const selected = selectFindingHistoricalPlace(context, place);
  assert.equal(selected.confirmed, false);
  assert.equal(currentConfirmedFindingPlace(context, selected), null);

  const confirmed = confirmFindingHistoricalPlaceDecision(context, selected);
  assert.equal(confirmed.confirmed, true);
  assert.equal(currentConfirmedFindingPlace(context, confirmed), place);
});

test("changing source text, date or document invalidates an earlier confirmation", () => {
  const confirmed = confirmFindingHistoricalPlaceDecision(
    context,
    selectFindingHistoricalPlace(context, samplePlace()),
  );
  assert.equal(currentConfirmedFindingPlace({ ...context, documentId: "document-2" }, confirmed), null);
  assert.equal(currentConfirmedFindingPlace({ ...context, originalText: "Трубіївка" }, confirmed), null);
  assert.equal(currentConfirmedFindingPlace({ ...context, eventDate: "1863-01-01" }, confirmed), null);
  assert.equal(currentConfirmedFindingPlace({ ...context, eventDate: "близько 1862" }, confirmed), null);
  assert.throws(
    () => confirmFindingHistoricalPlaceDecision(
      { ...context, eventDate: "1863-01-01" },
      confirmed,
    ),
    /змінилися/u,
  );
});

test("confirmation uses the strict migration 007 RPC and preserves original text", async () => {
  assert.match(workflowSource, /atDate:\s*exactFindingEventDate\(input\.eventDate\)/u);
  assert.match(workflowSource, /"confirm_finding_document_place_v1"/u);
  for (const parameter of [
    "p_finding_id", "p_document_id", "p_place_id", "p_original_text",
    "p_resolution_status", "p_expected_finding_updated_at",
  ]) {
    assert.match(workflowSource, new RegExp(`${parameter}:`, "u"));
  }
  assert.match(workflowSource, /p_original_text:\s*input\.originalText/u);
  assert.doesNotMatch(workflowSource, /p_original_text:\s*input\.originalText\.trim\(\)/u);
  assert.match(workflowSource, /PGRST202/u);
  assert.match(workflowSource, /міграція історичних місць для знахідок ще не застосована/u);
  assert.doesNotMatch(workflowSource, /addHistoricalDocumentPlaceLink/u);

  let capturedName = "";
  let capturedParameters: Record<string, unknown> = {};
  const saved = await confirmFindingDocumentPlace({
    ...context,
    findingId: "finding-1",
    placeId: "place-1",
    expectedFindingUpdatedAt: "2026-08-28T10:00:00.000Z",
  }, {
    rpc: async (name, parameters) => {
      capturedName = name;
      capturedParameters = parameters;
      return {
        data: { id: "link-1", originalText: context.originalText, idempotent: false },
        error: null,
      };
    },
  });
  assert.equal(capturedName, "confirm_finding_document_place_v1");
  assert.deepEqual(capturedParameters, {
    p_finding_id: "finding-1",
    p_document_id: "document-1",
    p_place_id: "place-1",
    p_original_text: " села Трубіевки ",
    p_resolution_status: "confirmed",
    p_expected_finding_updated_at: "2026-08-28T10:00:00.000Z",
  });
  assert.equal(saved.originalText, context.originalText);
});

test("persisted finding link restores the exact confirmed decision and clears idempotently", async () => {
  const place = samplePlace();
  const state = await getFindingDocumentPlace("finding-1", {
    rpc: async (name, parameters) => {
      assert.equal(name, "get_finding_document_place_v1");
      assert.deepEqual(parameters, { p_finding_id: "finding-1" });
      return {
        data: {
          findingId: "finding-1",
          currentDocumentId: "document-1",
          documentMatchesFinding: true,
          link: {
            id: "link-1",
            findingId: "finding-1",
            documentId: "document-1",
            placeId: "place-1",
            relationType: "mentions",
            originalText: context.originalText,
            resolutionStatus: "confirmed",
            sourceReference: "finding:finding-1",
            confidence: 100,
            note: "",
            metadata: {},
            lockVersion: 1,
            createdAt: "2026-08-28T10:00:00.000Z",
            updatedAt: "2026-08-28T10:00:00.000Z",
          },
          place,
        },
        error: null,
      };
    },
  });
  assert.ok(state);
  assert.equal(state.link.originalText, context.originalText);
  const restored = findingHistoricalPlaceDecisionFromState(context, state);
  assert.equal(restored?.place.id, "place-1");
  assert.equal(restored?.confirmed, true);
  assert.equal(
    findingHistoricalPlaceDecisionFromState({ ...context, originalText: context.originalText.trim() }, state),
    null,
  );

  let clearParameters: Record<string, unknown> = {};
  const cleared = await clearFindingDocumentPlace({
    findingId: "finding-1",
    expectedFindingUpdatedAt: "2026-08-28T11:00:00.000Z",
  }, {
    rpc: async (name, parameters) => {
      assert.equal(name, "clear_finding_document_place_v1");
      clearParameters = parameters;
      return { data: { findingId: "finding-1", cleared: true }, error: null };
    },
  });
  assert.deepEqual(clearParameters, {
    p_finding_id: "finding-1",
    p_expected_finding_updated_at: "2026-08-28T11:00:00.000Z",
  });
  assert.equal(cleared.cleared, true);
});

test("confirmation explains an unapplied migration and concurrency conflicts", async () => {
  const input = { ...context, findingId: "finding-1", placeId: "place-1" };
  await assert.rejects(
    confirmFindingDocumentPlace(input, {
      rpc: async () => ({
        data: null,
        error: { code: "PGRST202", message: "Could not find the function in the schema cache" },
      }),
    }),
    (cause: unknown) => cause instanceof FindingHistoricalPlaceWorkflowError
      && cause.code === "migration_pending"
      && /міграція історичних місць/u.test(cause.message),
  );
  await assert.rejects(
    confirmFindingDocumentPlace(input, {
      rpc: async () => ({
        data: null,
        error: { code: "40001", message: "FINDING_VERSION_CONFLICT" },
      }),
    }),
    (cause: unknown) => cause instanceof FindingHistoricalPlaceWorkflowError
      && cause.code === "request_failed"
      && /іншому вікні/u.test(cause.message),
  );
  await assert.rejects(
    confirmFindingDocumentPlace(input, {
      rpc: async () => ({
        data: null,
        error: { code: "22023", message: "FINDING_PLACE_ORIGINAL_TEXT_CONFLICT" },
      }),
    }),
    (cause: unknown) => cause instanceof FindingHistoricalPlaceWorkflowError
      && /початковий текст не було перезаписано/u.test(cause.message),
  );
});

test("finding UI keeps suggestion, confirmation and persistence as separate steps", () => {
  assert.match(panelSource, /selectFindingHistoricalPlace\(context, place\)/u);
  assert.match(panelSource, /confirmFindingHistoricalPlaceDecision\(context, currentDecision\)/u);
  assert.match(panelSource, /decision\.contextKey !== contextKey[\s\S]{0,360}onDecisionChange\(null\)/u);
  assert.match(panelSource, /Залишити невизначеним/u);
  assert.match(panelSource, /Збережено/u);
  assert.match(panelSource, /попередню прив’язку буде прибрано/u);
  assert.match(panelSource, /Без підтвердження жодного зв’язку з Place не буде створено/u);
  assert.doesNotMatch(panelSource, /setCandidates\([^)]*\)[\s\S]{0,120}onDecisionChange/u);

  const savePosition = crudSource.indexOf("settleEntitySave(() => onSave(entityToSave))");
  const linkPosition = crudSource.indexOf("await confirmFindingDocumentPlace({");
  assert.ok(savePosition >= 0 && linkPosition > savePosition, "the finding must persist before its document-place link");
  assert.match(crudSource, /currentConfirmedFindingPlace\(placeContext, findingPlaceDecision\)/u);
  assert.match(crudSource, /await clearFindingDocumentPlace\(\{/u);
  assert.match(crudSource, /findingPlacePersistedState\.link\.originalText === placeContext\.originalText/u);
  assert.match(crudSource, /findingPlaceDecision\?\.contextKey === findingHistoricalPlaceContextKey\(placeContext\)/u);
  assert.match(crudSource, /Знахідку збережено, але історичне місце не прив’язано/u);
});

test("AI indexing keeps the source place wording ahead of its normalized suggestion", () => {
  const original = aiSource.indexOf("result.result.event.eventPlaceOriginal");
  const normalized = aiSource.indexOf("result.result.event.eventPlaceNormalized", original);
  assert.ok(original >= 0 && normalized > original);
});

function samplePlace(): PlaceSummary {
  return {
    id: "place-1",
    projectId: "project-1",
    scope: "project",
    status: "active",
    verificationStatus: "unverified",
    isPublic: false,
    publishedAt: null,
    canonicalName: "Трубіївка",
    displayName: "Трубіевка",
    atDate: "1862-07-01",
    modernName: "Трубіївка",
    placeType: "village",
    latitude: 49,
    longitude: 30,
    currentCountry: "",
    currentAdmin: "Київська губернія",
    wikidataId: null,
    geonamesId: null,
    externalIds: {},
    description: "",
    matchedName: "Трубіевка",
    matchedNameType: "historical",
    names: [],
    lockVersion: 1,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}
