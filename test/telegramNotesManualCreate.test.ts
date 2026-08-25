import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const panelSource = readFileSync(
  resolve(root, "src/components/notes/TelegramNotesPanel.tsx"),
  "utf8",
);

test("manual notes open through the shared editor with every editable note field", () => {
  assert.match(panelSource, /createTelegramNote/);
  assert.match(panelSource, /\+ Створити нотатку/);
  assert.match(panelSource, /onCreate=\{startCreate\}/);
  assert.match(panelSource, /function NoteEditor\(/);

  // The same editor is used for both an existing note and a freshly-created
  // draft, so a manual note cannot lose fields available on a Telegram note.
  assert.match(panelSource, /creating \? \([\s\S]*?<NoteEditor[\s\S]*?mode="create"[\s\S]*?draft=\{creating\}/);
  assert.match(panelSource, /mode="edit"[\s\S]*?draft=\{editing\}/);
  assert.match(panelSource, /<span>Назва<\/span>/);
  assert.match(panelSource, /<span>Текст нотатки<\/span>/);
  assert.match(panelSource, /<span>Посилання на джерело<\/span>/);
  assert.match(panelSource, /<span>Платформа джерела<\/span>/);
  assert.match(panelSource, /<span>Стан нотатки<\/span>/);
  assert.match(panelSource, /<span>Стан джерела<\/span>/);
  assert.match(panelSource, /<span>Пріоритет<\/span>/);

  // Defaults make a free-form note a normal saved note, while preserving the
  // same metadata controls users have when they later edit a bot note.
  assert.match(panelSource, /function emptyNoteDraft\(\)[\s\S]*?status:\s*"saved"/);
  assert.match(panelSource, /sourceStatus:\s*"unverified"/);
  assert.match(panelSource, /priority:\s*"normal"/);
  assert.match(panelSource, /sourcePlatform:\s*"other"/);
  assert.match(panelSource, /const saveCreate = async[\s\S]*?await createTelegramNote\(/);
  assert.match(panelSource, /setNotes\(\(current\) => \[created,/);
  assert.match(panelSource, /setNotice\("Нотатку створено\."\)/);
});
