import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { initialZagulyakaDraftForAuthor } from "../src/utils/zagulyakyDraftDefaults.ts";
import { emptyZagulyakaDraft } from "../src/types/zagulyaky.ts";

test("a new Zagulyaka draft prepares the signed-in author's name for optional public attribution", () => {
  const draft = initialZagulyakaDraftForAuthor("person", "  Андрій Каленський  ");

  assert.equal(draft.publicAttributionName, "Андрій Каленський");
  assert.equal(draft.publicAttribution, false, "attribution remains opt-in");
});

test("opening a saved draft keeps its stored attribution, including an intentionally blank value", () => {
  const saved = {
    ...emptyZagulyakaDraft("document"),
    publicAttribution: true,
    publicAttributionName: "Родовий архів",
  };

  const loaded = initialZagulyakaDraftForAuthor("document", "Оновлене ім’я акаунта", saved);
  assert.notStrictEqual(loaded, saved, "the editor receives a mutable copy");
  assert.equal(loaded.publicAttributionName, "Родовий архів");

  const intentionallyBlank = initialZagulyakaDraftForAuthor(
    "document",
    "Оновлене ім’я акаунта",
    { ...saved, publicAttributionName: "" },
  );
  assert.equal(intentionallyBlank.publicAttributionName, "");
});

test("the attribution field remains editable in the draft dialog", () => {
  const dialog = readFileSync(
    new URL("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(dialog, /initialZagulyakaDraftForAuthor\(initialKind, account\.name, initialDraft\)/);
  assert.match(dialog, /value=\{draft\.publicAttributionName\}[\s\S]*?onChange=\{\(event\) => update\("publicAttributionName", event\.target\.value\)\}/);
});
