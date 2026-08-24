import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const panelSource = readFileSync(
  resolve(process.cwd(), "src/components/notes/TelegramNotesPanel.tsx"),
  "utf8",
);
const stylesSource = readFileSync(
  resolve(process.cwd(), "src/components/notes/TelegramNotesPanel.css"),
  "utf8",
);

test("notes open a focused detail from a compact title list", () => {
  assert.match(panelSource, /const \[selectedNoteId, setSelectedNoteId\] = useState\(""\)/);
  assert.match(panelSource, /<ul className="telegram-note-list panel" aria-label="Список збережених нотаток">/);
  assert.match(panelSource, /<NoteListItem key=\{note\.id\} note=\{note\} onOpen=\{\(\) => setSelectedNoteId\(note\.id\)\} \/>/);
  assert.match(panelSource, /function NoteListItem\(/);
  assert.match(panelSource, /function NoteDetail\(/);
  assert.match(panelSource, /!selectedNote \? \(/);
  assert.match(panelSource, /← До списку/);
  assert.match(panelSource, /selectedNote \? \(/);
  assert.match(panelSource, /note\.body \? <p className="telegram-note-detail__body">/);
  assert.doesNotMatch(panelSource, /function NoteCard\(/);
});

test("note filters stay in a compact horizontal control row", () => {
  assert.match(panelSource, /className="telegram-notes-filters__controls"/);
  assert.match(stylesSource, /\.telegram-notes-workspace \{\s*display: grid;\s*gap: 18px;/);
  assert.match(stylesSource, /\.telegram-notes-filters__controls \{\s*display: grid;\s*grid-template-columns: minmax\(220px, 1\.8fr\) repeat\(4, minmax\(130px, 1fr\)\) auto;/);
  assert.match(stylesSource, /@media \(max-width: 1120px\)/);
  assert.match(stylesSource, /@media \(max-width: 840px\)/);
});
