import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAppRoute } from "../src/utils/appRoutes.ts";
import { zagulyakyTabPath } from "../src/utils/zagulyakyRoutePath.ts";

test("parses public catalogue, private Zaguliaky, and account-level Notes routes", () => {
  assert.deepEqual(parseAppRoute("/zahuliaky"), {
    kind: "zagulyaky",
    tab: "people",
  });
  assert.deepEqual(parseAppRoute("/zahuliaky/documents/"), {
    kind: "zagulyaky",
    tab: "documents",
  });
  assert.deepEqual(parseAppRoute("/zahuliaky/my"), {
    kind: "zagulyaky",
    tab: "mine",
  });
  assert.deepEqual(parseAppRoute("/notes"), { kind: "notes" });
  assert.deepEqual(parseAppRoute("/zahuliaky/notes"), { kind: "notes" });
});

test("routes the private My records tab to the parseable /zahuliaky/my URL", () => {
  assert.equal(zagulyakyTabPath("people"), "/zahuliaky");
  assert.equal(zagulyakyTabPath("documents"), "/zahuliaky/documents");
  assert.equal(zagulyakyTabPath("mine"), "/zahuliaky/my");
  assert.deepEqual(parseAppRoute(zagulyakyTabPath("mine")), {
    kind: "zagulyaky",
    tab: "mine",
  });
});

test("parses public Zaguliaky detail routes and decodes their slugs", () => {
  assert.deepEqual(parseAppRoute("/zahuliaky/people/ivan-kalenskyi"), {
    kind: "zagulyaky",
    tab: "people",
    recordKind: "person",
    recordSlug: "ivan-kalenskyi",
  });
  assert.deepEqual(parseAppRoute("/zahuliaky/documents/%D0%94%D0%90%D0%9A%D0%9E-127"), {
    kind: "zagulyaky",
    tab: "documents",
    recordKind: "document",
    recordSlug: "ДАКО-127",
  });
});

test("rejects unsupported Zaguliaky route shapes", () => {
  assert.deepEqual(parseAppRoute("/zahuliaky/people"), { kind: "unknown" });
  assert.deepEqual(parseAppRoute("/zahuliaky/unknown/record"), { kind: "unknown" });
  assert.deepEqual(parseAppRoute("/zahuliaky/documents/one/extra"), { kind: "unknown" });
});

test("parses the private Zaguliaky moderation route", () => {
  assert.deepEqual(parseAppRoute("/admin/zagulyaky"), {
    kind: "admin",
    page: "zagulyaky",
  });
});

test("App renders Zaguliaky before the authenticated-app gate", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const routeRender = source.indexOf('if (route.kind === "zagulyaky")');
  const loginGate = source.indexOf("if (!account)", routeRender);

  assert.ok(routeRender >= 0, "Zaguliaky route render is present");
  assert.ok(loginGate > routeRender, "the public catalogue renders before LoginPage");
  assert.match(source, /account=\{account\}/);
  assert.match(source, /applyZagulyakySeo\(route\)/);
  assert.match(source, /activatePublicAnalyticsPage\(location\.pathname\)/);
});

test("private Zaguliaky drafts and standalone Notes are auth-only without workspace loads", () => {
  const pageSource = readFileSync(new URL("../src/pages/ZagulyakyPage.tsx", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(
    pageSource,
    /\{account \? \(\s*<button type="button" className=\{activeTab === "mine"/s,
    "the public catalogue must not render the My records tab for guests",
  );
  assert.match(
    appSource,
    /const isPrivateZagulyakyRoute = isZagulyakyRoute && route\.tab === "mine";/,
  );
  assert.match(
    appSource,
    /isZagulyakyRoute && !isPrivateZagulyakyRoute/,
    "only people/documents remain public Zagulyaky routes",
  );
  assert.match(
    appSource,
    /const skipsWorkspaceState = route\.kind === "public" \|\| isZagulyakyRoute \|\| route\.kind === "notes";/,
    "private catalogue drafts and Notes must remain independent from a selected project",
  );
  assert.match(
    appSource,
    /!skipsWorkspaceState && requestedDataGroups\.has\("researches"\)/,
    "opening My records must not start unrelated workspace dashboard loads",
  );
  assert.match(
    appSource,
    /if \(route\.kind === "notes" \|\| \(route\.kind === "zagulyaky" && route\.tab === "mine"\)\) \{/,
    "a guest opening private Notes or Zaguliaky drafts must retain its return path before sign-in",
  );
  assert.match(
    appSource,
    /const postAuthReturn = consumePrivatePostAuthReturn\(\);\s*if \(postAuthReturn\) \{\s*routerNavigate\(postAuthReturn, \{ replace: true \}\);/s,
    "the authenticated session must resume the saved private route",
  );
});

test("Login page exposes the public Zaguliaky catalogue before sign-in", () => {
  const source = readFileSync(new URL("../src/pages/LoginPage.tsx", import.meta.url), "utf8");

  assert.match(source, /<nav className="login-public-nav" aria-label="Публічна навігація">/);
  assert.match(source, /<a href="\/zahuliaky">Загуляки<\/a>/);
});

test("authenticated workspace navigation exposes My Zagulyaky records", () => {
  const sidebarSource = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  const layoutSource = readFileSync(new URL("../src/components/Layout.tsx", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(sidebarSource, /onOpenZagulyaky: \(\) => void/);
  assert.match(sidebarSource, /onClick=\{openZagulyaky\}/);
  assert.match(sidebarSource, /aria-label="Відкрити мої записи Загуляк"/);
  assert.match(sidebarSource, />\s*Загуляки\s*<\/button>/);
  assert.match(layoutSource, /onOpenZagulyaky=\{props\.onOpenZagulyaky\}/);
  assert.match(appSource, /onOpenZagulyaky=\{\(\) => routerNavigate\("\/zahuliaky\/my"\)\}/);
});

test("Notes are a standalone Tracker Rodu section, not a Zagulyaky tab", () => {
  const pageSource = readFileSync(new URL("../src/pages/ZagulyakyPage.tsx", import.meta.url), "utf8");
  const notesPageSource = readFileSync(new URL("../src/pages/NotesPage.tsx", import.meta.url), "utf8");
  const notesPanelSource = readFileSync(new URL("../src/components/notes/TelegramNotesPanel.tsx", import.meta.url), "utf8");
  const sidebarSource = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  const layoutSource = readFileSync(new URL("../src/components/Layout.tsx", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(pageSource, /TelegramNotesPanel/);
  assert.match(notesPageSource, /components\/notes\/TelegramNotesPanel/);
  assert.match(notesPageSource, /<h1 id="notes-page-title">Нотатки<\/h1>/);
  assert.match(notesPanelSource, /href="\/zahuliaky\/my">Мої чернетки Загуляк<\/a>/);
  assert.match(sidebarSource, /onOpenNotes: \(\) => void/);
  assert.match(sidebarSource, /onClick=\{openNotes\}/);
  assert.match(sidebarSource, /aria-label="Відкрити особисті нотатки"/);
  assert.match(layoutSource, /onOpenNotes=\{props\.onOpenNotes\}/);
  assert.match(appSource, /onOpenNotes=\{\(\) => routerNavigate\("\/notes"\)\}/);
  assert.match(appSource, /route\.kind === "notes" \? \(\s*<NotesPage account=\{account\} \/>/s);
  assert.match(appSource, /routerNavigate\(`\/notes\$\{location\.search\}\$\{location\.hash\}`, \{ replace: true \}\)/);
});

test("My records can reopen editable private drafts and submit them again", () => {
  const pageSource = readFileSync(new URL("../src/pages/ZagulyakyPage.tsx", import.meta.url), "utf8");
  const serviceSource = readFileSync(new URL("../src/services/zagulyakyService.ts", import.meta.url), "utf8");
  const dialogSource = readFileSync(new URL("../src/components/zagulyaky/ZagulyakaDraftDialog.tsx", import.meta.url), "utf8");

  assert.match(pageSource, /\["draft", "needs_changes", "withdrawn"\]\.includes\(record\.status\)/);
  assert.match(pageSource, /loadMyZagulyakaDraft\(record\.id, account\.id\)/);
  assert.match(pageSource, /initialHandle=\{editingDraft\.handle\}/);
  assert.match(pageSource, /Увійдіть, щоб переглянути свої записи/);
  assert.match(serviceSource, /\.rpc\("get_my_zagulyaka_draft_v1"/);
  assert.match(dialogSource, /await submitZagulyakaDraft\(handle, account\.id\)/);
});
