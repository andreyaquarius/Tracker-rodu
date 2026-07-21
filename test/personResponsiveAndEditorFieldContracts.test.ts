import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const profile = source("../src/features/persons-v2/PersonProfileV2.tsx");
const editor = source("../src/features/persons-v2/PersonEditorV2.tsx");
const modal = source("../src/components/PersonFormModal.tsx");
const treeDialog = source("../src/components/familyTree/FamilyTreePersonDialog.tsx");
const styles = source("../src/styles.css");

function labelBlock(moduleSource: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = moduleSource.match(
    new RegExp(`<label[^>]*>\\s*<span>${escapedLabel}</span>[\\s\\S]*?</label>`, "u"),
  );
  assert.ok(match, `Expected an always-mounted \"${label}\" label`);
  return match[0];
}

test("person profile responds to its content width and safely wraps a long identity", () => {
  assert.match(profile, /className="persons-v2-profile__identity-copy"/u);
  assert.match(
    styles,
    /\.persons-v2-profile\s*\{[\s\S]*?container-name:\s*persons-profile;[\s\S]*?container-type:\s*inline-size;/u,
  );
  assert.match(
    styles,
    /\.persons-v2-profile__identity-copy\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/u,
  );
  assert.match(
    styles,
    /\.persons-v2-profile__identity h1\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;/u,
  );
  assert.match(
    styles,
    /\.persons-v2-profile__header-actions\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?flex-wrap:\s*wrap;/u,
  );
  assert.match(
    styles,
    /@container persons-profile \(max-width: 1320px\)\s*\{[\s\S]*?\.persons-v2-profile__header-actions\s*\{[\s\S]*?grid-column:\s*1 \/ -1;[\s\S]*?grid-row:\s*3;/u,
  );
  assert.match(styles, /@container persons-profile \(max-width: 780px\)/u);
  assert.match(styles, /@container persons-profile \(max-width: 560px\)/u);
});

test("both person editors keep education in a raw controlled draft while typing", () => {
  assert.match(
    editor,
    /const \[educationDraft, setEducationDraft\] = useState\(\(\) => personEducation\(firstDraft\)\.join\("\\n"\)\);/u,
  );
  assert.match(editor, /setEducationDraft\(personEducation\(nextDraft\)\.join\("\\n"\)\);/u);
  assert.match(editor, /setEducationDraft\(personEducation\(savedDraft\)\.join\("\\n"\)\);/u);
  assert.match(
    editor,
    /<span>Освіта<\/span>[\s\S]*?value=\{educationDraft\}[\s\S]*?setEducationDraft\(event\.target\.value\);[\s\S]*?updateStandardFields\(\{ education: event\.target\.value \}\);/u,
  );
  assert.doesNotMatch(editor, /value=\{personEducation\(form\)\.join\("\\n"\)\}/u);

  assert.match(
    modal,
    /const \[educationDraft, setEducationDraft\] = useState\(\(\) => personEducation\(form\)\.join\("\\n"\)\);/u,
  );
  assert.match(
    modal,
    /<span>Освіта<\/span>[\s\S]*?value=\{educationDraft\}[\s\S]*?setEducationDraft\(event\.target\.value\);[\s\S]*?updateStandardFields\(\{ education: event\.target\.value \}\);/u,
  );
  assert.doesNotMatch(modal, /value=\{personEducation\(form\)\.join\("\\n"\)\}/u);
});

test("maiden surname remains mounted and becomes enabled only for a female person", () => {
  const editorMaidenSurname = labelBlock(editor, "Дівоче прізвище");
  assert.match(editorMaidenSurname, /value=\{form\.maidenSurname\}/u);
  assert.match(editorMaidenSurname, /disabled=\{form\.gender !== "жінка"\}/u);
  assert.match(editorMaidenSurname, /onChange=\{\(event\) => update\("maidenSurname", event\.target\.value\)\}/u);
  assert.doesNotMatch(editor, /\{form\.gender === "жінка"\s*\?\s*\([\s\S]*?<span>Дівоче прізвище<\/span>/u);

  const modalMaidenSurname = labelBlock(modal, "Дівоче прізвище");
  assert.match(modalMaidenSurname, /value=\{form\.maidenSurname\}/u);
  assert.match(modalMaidenSurname, /disabled=\{form\.gender !== "жінка"\}/u);
  assert.match(modalMaidenSurname, /onChange=\{\(event\) => update\("maidenSurname", event\.target\.value\)\}/u);
  assert.doesNotMatch(modal, /\{form\.gender === "жінка"\s*\?\s*\([\s\S]*?<span>Дівоче прізвище<\/span>/u);

  const treeMaidenSurname = labelBlock(treeDialog, "Дівоче прізвище");
  assert.match(treeDialog, /const isFemalePerson = person\.gender === "жінка";/u);
  assert.match(treeMaidenSurname, /value=\{person\.maidenSurname \?\? ""\}/u);
  assert.match(treeMaidenSurname, /disabled=\{!isFemalePerson\}/u);
  assert.match(
    treeMaidenSurname,
    /onChange=\{\(event\) => updatePerson\(\{ maidenSurname: event\.target\.value \}\)\}/u,
  );
  assert.doesNotMatch(treeDialog, /\{isFemalePerson\s*\?\s*\([\s\S]*?<span>Дівоче прізвище<\/span>/u);
});
