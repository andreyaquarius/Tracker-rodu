import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { emptyZagulyakaDraft } from "../src/types/zagulyaky.ts";
import * as breaker from "../src/utils/zagulyakyMutationCircuitBreaker.ts";
import * as defaults from "../src/utils/zagulyakyDraftDefaults.ts";
import * as roles from "../src/utils/zagulyakyEventRoles.ts";
import * as labels from "../src/utils/zagulyakyLabels.ts";
import * as title from "../src/utils/zagulyakyTitleAutofill.ts";
import * as safeUrl from "../src/utils/safeUrl.ts";
import * as shared from "../src/utils/sharedAbortableRequest.ts";
import * as geo from "../src/utils/geo.ts";

const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const serviceSource = compile("../src/services/zagulyakyService.ts");
const dialogSource = compile("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx");
const settle = () => new Promise(resolve => setImmediate(resolve));

function serviceHarness(rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const exports: Record<string, (...args: any[]) => Promise<any>> = {};
  const circuit = breaker.createZagulyakaMutationCircuitBreaker();
  runInNewContext(serviceSource, {
    exports, Error, require: (name: string) => {
      if (name.endsWith("/supabaseAuth")) return { getSupabaseClient: () => ({ rpc }) };
      if (name.includes("authenticatedSupabaseRequest")) return { runAuthenticatedSupabaseRequest: (_: unknown, invoke: () => Promise<unknown>) => invoke() };
      if (name.includes("zagulyakyMutationCircuitBreaker")) return { runZagulyakaVersionedMutation: circuit.run, markZagulyakaRecordFresh: circuit.markRecordFresh };
      if (name.includes("sharedAbortableRequest")) return shared;
      if (name.endsWith("/geo")) return geo;
      if (name.includes("zagulyakyEventRoles")) return roles;
      if (name.includes("zagulyakyDisplayText") || name.includes("edgeFunctions")) return {};
      throw new Error(`Unexpected service dependency: ${name}`);
    },
  });
  return exports;
}

test("real draft service reports committed IDs/versions before a details failure, with no retry", async () => {
  for (const create of [true, false]) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let remembered: any;
    const failure = { code: "23514", message: "INVALID_EVENT_ROLE_CODE" };
    const service = serviceHarness(async (name, args) => {
      calls.push({ name, args });
      if (name === "replace_my_zagulyaka_details_v1") {
        assert.equal(remembered.lockVersion, 8, "UI learns committed version before details RPC starts");
        assert.equal(args.p_expected_lock_version, 8);
        return { data: null, error: failure };
      }
      return { data: { id: "draft-id", lock_version: 8 }, error: null };
    });
    const input = emptyZagulyakaDraft("person");
    input.title = "Draft";
    const callback = (handle: unknown) => { remembered = handle; };
    const operation = create
      ? service.createZagulyakaDraft(input, "owner", false, callback)
      : service.saveZagulyakaDraft({ id: "draft-id", lockVersion: 7 }, input, "owner", false, callback);
    await assert.rejects(operation, error => error === failure);
    assert.equal(remembered.id, "draft-id");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, create ? "create_zagulyaka_draft_v1" : "update_my_zagulyaka_draft_v1");
  }
});

type Element = { type: unknown; props: Record<string, any> };
function dialogHarness(service: Record<string, (...args: any[]) => any>, initialHandle: object | null = null) {
  const state: { value: any }[] = [];
  let cursor = 0;
  const useState = (initial: any) => {
    const index = cursor++;
    state[index] ??= { value: typeof initial === "function" ? initial() : initial };
    return [state[index].value, (next: any) => { state[index].value = typeof next === "function" ? next(state[index].value) : next; }];
  };
  const exports: Record<string, (...args: any[]) => Element> = {};
  const jsx = (type: unknown, props: Element["props"]) => ({ type, props });
  runInNewContext(dialogSource, {
    exports, Error, window: { confirm: () => true },
    require: (name: string) => {
      if (name === "react") return { useState, useRef: (initial: unknown) => useState({ current: initial })[0], useMemo: (fn: () => unknown) => fn(), useEffect: () => {} };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name.includes("zagulyakyService")) return service;
      if (name.includes("zagulyakyDraftDefaults")) return defaults;
      if (name.includes("zagulyakyMutationCircuitBreaker")) return breaker;
      if (name.includes("zagulyakyEventRoles")) return roles;
      if (name.includes("zagulyakyLabels")) return labels;
      if (name.includes("zagulyakyTitleAutofill")) return title;
      if (name.includes("safeUrl")) return safeUrl;
      if (name.endsWith("/Modal")) return { Modal: "modal" };
      if (name.endsWith("/GeoPlaceField")) return { GeoPlaceField: "geo" };
      if (name.endsWith("/ZagulyakaRouteMap")) return { ZagulyakaRouteMap: "map" };
      throw new Error(`Unexpected dialog dependency: ${name}`);
    },
  });
  const draft = { ...emptyZagulyakaDraft("person"), title: "Unsaved user text", originalName: "Person", eventType: "birth",
    eventRoleCode: "child", foundPlace: "Place", reason: "Research", archiveReference: "Archive 1" };
  let saved = 0;
  const render = () => { cursor = 0; return exports.ZagulyakaDraftDialog({ account: { id: "owner", name: "Test" },
    initialDraft: draft, initialHandle, onClose: () => {}, onSaved: () => { saved++; } }); };
  function find(predicate: (node: Element) => boolean, node: any = render()): Element | undefined {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) { const hit = find(predicate, child); if (hit) return hit; } return; }
    if (predicate(node)) return node;
    return find(predicate, node.props?.children ?? null);
  }
  return { render, find, saved: () => saved,
    save: () => find(node => node.type === "button" && node.props.children === "Зберегти чернетку")!.props.onClick(),
    submit: () => find(node => node.type === "form")!.props.onSubmit({ preventDefault() {} }),
  };
}

test("dialog synchronously excludes duplicate save/submit before React rerenders", async () => {
  let calls = 0;
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = dialogHarness({ createZagulyakaDraft: async () => { calls++; return pending; } });
  const save = h.find(node => node.type === "button" && node.props.children === "Зберегти чернетку")!.props.onClick;
  save(); save(); await h.submit();
  assert.equal(calls, 1);
  finish({ id: "draft-id", lockVersion: 2 });
  await settle();
  assert.equal(h.saved(), 1);
});

test("dialog retains a partially committed new draft and uses its latest version on the next save", async () => {
  let creates = 0;
  const versions: number[] = [];
  const h = dialogHarness({
    createZagulyakaDraft: async (_input, _user, _rights, progress) => {
      creates++;
      progress({ id: "draft-id", lockVersion: 1 });
      throw { code: "23514", message: "INVALID_EVENT_ROLE_CODE" };
    },
    saveZagulyakaDraft: async (handle, _input, _user, _rights, progress) => {
      versions.push(handle.lockVersion);
      progress({ id: handle.id, lockVersion: handle.lockVersion + 1 });
      if (versions.length === 1) throw { message: "details failed" };
      return { id: handle.id, lockVersion: handle.lockVersion + 2 };
    },
  });
  h.save(); await settle();
  h.save(); await settle();
  h.save(); await settle();
  assert.equal(creates, 1);
  assert.deepEqual(versions, [1, 2]);
  assert.equal(h.saved(), 1, "partial failures are not presented as successful saves");
});

test("plain PostgREST conflicts preserve entered text and block all further saves in that editor", async () => {
  for (const code of ["PT409", "40001"]) {
    let calls = 0;
    const h = dialogHarness({ saveZagulyakaDraft: async () => { calls++; throw { code, message: "ZAGULYAKA_VERSION_CONFLICT" }; } }, { id: "draft-id", lockVersion: 1 });
    const oldSave = h.find(node => node.type === "button" && node.props.children === "Зберегти чернетку")!.props.onClick;
    oldSave(); await settle();
    breaker.markZagulyakaRecordFresh("author", "draft-id"); // summary refresh is NOT a form reload
    oldSave(); await h.submit(); await settle();
    assert.equal(calls, 1);
    assert.equal(h.saved(), 0);
    assert.match(h.find(node => node.props?.role === "alert")!.props.children, /Введений текст залишився у формі/);
    assert.ok(h.find(node => node.type === "input" && node.props.value === "Unsaved user text"));
    assert.equal(h.find(node => node.type === "button" && node.props.children === "Зберегти чернетку")!.props.disabled, true);
  }
});
