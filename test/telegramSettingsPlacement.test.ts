import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();

test("Telegram connection and AI permission controls live in Settings, not Notes", () => {
  const settingsPage = readFileSync(resolve(root, "src/pages/SettingsPage.tsx"), "utf8");
  const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
  const settings = readFileSync(
    resolve(root, "src/components/settings/TelegramBotSettings.tsx"),
    "utf8",
  );
  const notes = readFileSync(
    resolve(root, "src/components/notes/TelegramNotesPanel.tsx"),
    "utf8",
  );

  assert.match(settingsPage, /components\/settings\/TelegramBotSettings/);
  assert.match(settingsPage, /<TelegramBotSettings account=\{account\} \/>/);
  assert.match(app, /<SettingsPage\s+db=\{activeDb\}\s+account=\{account\}/s);

  assert.match(settings, /createTelegramLink/);
  assert.match(settings, /loadTelegramLinkStatus/);
  assert.match(settings, /setTelegramAiOptIn/);
  assert.match(settings, /unlinkTelegramAccount/);
  assert.match(settings, /Від’єднати Telegram/);
  assert.match(settings, /Дозволити ШІ готувати приватні чернетки Загуляк/);

  assert.doesNotMatch(notes, /createTelegramLink/);
  assert.doesNotMatch(notes, /loadTelegramLinkStatus/);
  assert.doesNotMatch(notes, /setTelegramAiOptIn/);
  assert.doesNotMatch(notes, /unlinkTelegramAccount/);
  assert.doesNotMatch(notes, /telegram-notes-link/);
});
