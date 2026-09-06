import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "../.tools/photo-tags/node_modules/playwright/index.mjs";

// Start Vite on 5186 first. Only synthetic fixtures and localhost are used.
const url = "http://127.0.0.1:5186/test/fixtures/photo-tags/";
const out = new URL("../outputs/photo-tags-qa/", import.meta.url);
await mkdir(out, { recursive: true });
console.log("Launching synthetic QA browser");
const browser = await chromium.launch({ channel: "chrome", headless: true, timeout: 20000 });
console.log("Browser ready");
const localOnly = (route) => {
  const hostname = new URL(route.request().url()).hostname;
  return hostname === "127.0.0.1" ? route.continue() : route.abort();
};
const context = await browser.newContext({ viewport: { width: 1280, height: 980 } });
await context.route("**/*", localOnly);
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const button = (name) => page.getByRole("button", { name, exact: true });
async function waitReady() { await button("Позначити людину").waitFor(); await page.waitForFunction(() => !document.querySelector('button.button-primary')?.disabled); }
async function choose(query, name) {
  await page.getByLabel("Пошук особи в проєкті").fill(query);
  await page.getByRole("button", { name: new RegExp(name) }).click();
}
async function saved() { await button("Зберегти позначку").click(); await button("Зберегти позначку").waitFor({ state: "hidden" }); }
try {
  await page.goto(url); await waitReady();
  await button("Позначити людину").click();
  const image = page.locator(".photo-people__image");
  const box = await image.boundingBox();
  await page.mouse.move(box.x + box.width * 0.18, box.y + box.height * 0.18);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.43, box.y + box.height * 0.81, { steps: 8 }); await page.mouse.up();
  await choose("Анна", "Тестова Анна"); await saved();
  await page.getByRole("heading", { name: "Фото, на яких позначено особу (1)", exact: true }).waitFor();
  await page.locator(".person-tagged-photos__tile img").waitFor();
  assert.equal(await page.locator(".photo-people__rect:not(.is-draft)").count(), 1);

  // Complete keyboard alternative and a failed write that preserves the draft.
  await button("Позначити людину").click();
  for (const [label, value] of [["Ліворуч (%)", "57"], ["Зверху (%)", "18"], ["Ширина (%)", "28"], ["Висота (%)", "63"]]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await choose("Богдан", "Тестовий Богдан");
  await button("Помилка наступного збереження").click();
  await button("Зберегти позначку").click();
  await page.getByRole("alert").filter({ hasText: "Синтетична помилка мережі" }).waitFor();
  assert.equal(await page.getByLabel("Ліворуч (%)", { exact: true }).inputValue(), "57");
  await saved();
  await page.reload(); await waitReady();
  assert.equal(await page.locator(".photo-people__rect").count(), 2);
  await button("Збільшити фото").click();
  assert.ok(Math.abs(await page.getByRole("button", { name: "Позначка: Тестовий Богдан", exact: true }).evaluate((el) => parseFloat(el.style.left)) - 57) < 0.0001);
  await button("Зменшити фото").click();
  console.log("Desktop create/reload/zoom passed");
  await page.screenshot({ path: fileURLToPath(new URL("desktop.png", out)), fullPage: true, timeout: 15000 });

  // Open from album, focus the right rectangle, follow its person link.
  await button("Закрити фото").click();
  await button("Відкрити з позначкою: Групове фото.png").click();
  assert.equal(await page.getByRole("button", { name: "Позначка: Тестова Анна", exact: true }).getAttribute("aria-pressed"), "true");
  await button("Відкрити картку особи").click();
  await page.getByText("Поточна особа: anna", { exact: true }).waitFor();
  await button("Відкрити фото").click(); await waitReady();
  await page.getByRole("button", { name: "Позначка: Тестовий Богдан", exact: true }).click();
  await button("Редагувати позначку").click();
  await page.getByLabel("Ліворуч (%)", { exact: true }).fill("58"); await saved();
  await button("Відкрити картку особи").click();
  await page.getByText("Поточна особа: bogdan", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Фото, на яких позначено особу (1)", exact: true }).waitFor();
  await button("Відкрити з позначкою: Групове фото.png").click();
  await button("Видалити позначку").click(); await button("Так, прибрати").click();
  await page.getByText("Ще немає доступних фотографій із позначкою цієї особи.").waitFor();
  assert.equal(await page.locator(".photo-people__rect").count(), 1);
  assert.equal(await image.locator("img").count(), 1);
  console.log("Album/edit/delete/navigation passed");

  // Mobile touchscreen drag and theme with the same actual React component.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.route("**/*", localOnly);
  const phone = await mobile.newPage(); await phone.goto(url);
  await phone.getByRole("button", { name: "Позначити людину", exact: true }).click();
  const mobileBox = await phone.locator(".photo-people__image").boundingBox();
  const cdp = await mobile.newCDPSession(phone);
  const touch = async (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  await touch("touchStart", mobileBox.x + mobileBox.width * 0.15, mobileBox.y + mobileBox.height * 0.15);
  await touch("touchMove", mobileBox.x + mobileBox.width * 0.4, mobileBox.y + mobileBox.height * 0.65);
  await touch("touchEnd");
  assert.ok(Math.abs(Number(await phone.getByLabel("Ширина (%)", { exact: true }).inputValue()) - 25) < 1);
  await phone.getByLabel("Пошук особи в проєкті").fill("Анна");
  await phone.getByRole("button", { name: /Тестова Анна/ }).click();
  await phone.getByRole("button", { name: "Зберегти позначку", exact: true }).click();
  await phone.getByRole("button", { name: "Зберегти позначку", exact: true }).waitFor({ state: "hidden" });
  await phone.getByRole("button", { name: "Змінити тему", exact: true }).click();
  assert.equal(await phone.locator(".photo-people").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(17, 28, 48)");
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({ path: fileURLToPath(new URL("mobile-dark.png", out)), fullPage: true, timeout: 15000 });
  await mobile.close();

  await page.goto(`${url}?viewer`);
  await page.getByText("Доступний перегляд позначок.", { exact: true }).waitFor();
  assert.equal(await button("Позначити людину").count(), 0);
  await page.goto(`${url}?loadError`);
  await page.getByRole("region", { name: "Люди на фото", exact: true }).getByRole("alert").filter({ hasText: "Немає доступу" }).waitFor();
  assert.equal(await image.locator("img").count(), 0);
  await page.goto(`${url}?imageError`);
  await page.getByRole("alert").filter({ hasText: "Файл недоступний" }).waitFor();
  assert.equal(await button("Позначити людину").isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log("Browser QA passed: mouse, touch, keyboard coordinates, multiple tags, reload, edit/delete, album/focus/navigation, zoom, mobile/dark, viewer and errors.");
} finally { await browser.close(); }
