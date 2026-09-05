import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const window = read("../src/components/familyTree/FamilyConstellationWindow.tsx");
const fullscreen = read("../src/features/family-tree-view/constellation/useConstellationFullscreen.ts");
const styles = read("../src/features/family-tree-view/constellation/constellation.css");
const modal = read("../src/components/Modal.tsx");

test("constellation requests browser fullscreen for the entire dialog, with an explicit fallback", () => {
  assert.match(fullscreen, /closest<HTMLElement>\("\.constellation-modal"\)/);
  assert.match(fullscreen, /await target.requestFullscreen\(\{ navigationUI: "hide" \}\)/);
  assert.match(fullscreen, /!target.requestFullscreen \|\| document.fullscreenEnabled === false/);
  assert.match(fullscreen, /Браузер не дозволив повний екран/);
  assert.match(window, /fullscreen=\{fullscreen.active\}/);
  assert.match(window, /fullscreen.message[\s\S]*?role="status"/);
  assert.doesNotMatch(window, /setFullscreen\(/);
});

test("fullscreen exits and asynchronous requests are scoped to the owning window", () => {
  assert.match(fullscreen, /document.addEventListener\("fullscreenchange", sync\)/);
  assert.match(fullscreen, /document.removeEventListener\("fullscreenchange", sync\)/);
  assert.match(fullscreen, /if \(!leaving.current\) onBrowserExitRef.current\(\)/);
  assert.match(fullscreen, /await entering.current/);
  assert.match(fullscreen, /if \(!alive.current \|\| !wanted.current \|\| !target.isConnected\)/);
  for (const statement of fullscreen.matchAll(/(?:void |await )document.exitFullscreen\(\)/g)) {
    assert.match(fullscreen.slice(Math.max(0, statement.index! - 100), statement.index), /document.fullscreenElement === target/);
  }
  assert.match(window, /const closeWindow = async \(\) => \{ await fullscreen.exit\(\); onClose\(\); \}/);
  assert.match(window, /const openPerson = async[\s\S]*?await fullscreen.exit\(\); onClose\(\); onOpenPerson/);
});

test("fullscreen exit stays in the fixed header while normal search, modes and menus remain usable", () => {
  assert.match(modal, /headerActions\?: ReactNode/);
  assert.match(modal, /className="modal-window-controls">\s*\{headerActions\}/);
  assert.match(window, /headerActions=\{<button[\s\S]*?disabled=\{fullscreen.pending\}/);
  assert.match(window, /aria-label=\{fullscreen.active \? "Вийти з повного екрана" : "На весь екран"\}/);
  assert.match(window, /aria-pressed=\{fullscreen.active\}/);
  assert.match(window, /window.addEventListener\("keydown", onEscape\)/);
  assert.match(window, /window.removeEventListener\("keydown", onEscape\)/);
  assert.match(styles, /\.modal.constellation-modal:is\(\.modal-fullscreen, :fullscreen\)[^}]*height: 100dvh;[^}]*max-height: none;/);
  assert.doesNotMatch(styles, /:fullscreen[^{}]*\{[^}]*display:\s*none/);
});

test("presentation restores a previous fullscreen session but browser Escape never re-enters it", () => {
  assert.match(window, /fullscreen: fullscreen.active, selectedId/);
  assert.match(window, /void fullscreen.enter\(\)/);
  assert.match(window, /if \(!restoreFullscreen \|\| !before\?\.fullscreen\) void fullscreen.exit\(\)/);
  assert.match(window, /if \(presentationBefore.current\) finishPresentation\(false\)/);
  assert.match(window, /presentationBefore.current = undefined/);
  assert.match(window, /finishPresentation\(false\)/);
});
