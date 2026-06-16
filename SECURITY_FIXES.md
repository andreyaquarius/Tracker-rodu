# SECURITY_FIXES.md — Перебіг виправлень

Гілка: `security-audit`. Кожне виправлення — окремий логічний коміт, бізнес-логіка не змінювалася, функціональність не видалялася. Деталі знахідок — у `SECURITY_AUDIT.md`, ручні налаштування — у `SECURITY_OPERATIONS.md`.

## Порядок комітів

| # | Коміт | Знахідка | Рівень | Тип |
|---|-------|----------|--------|-----|
| 1 | `docs(security): add … audit report and fix plan` | — | — | звіт + план |
| 2 | `fix(security): sanitize user-supplied URLs …` | F-01, F-07 | High | код + тест |
| 3 | `fix(security): patch vulnerable react-router-dom` | F-02 | High | залежність |
| 4 | `fix(security): scope review-hypothesis fetches …` | F-03 | Medium | код |
| 5 | `fix(security): clear cached project data on sign-out` | F-05 | Medium | код + тест |
| 6 | `fix(security): bind Edge Function CORS to app origin` | F-06 | Medium→Low | код |
| 7 | `fix(security): neutralize spreadsheet formula injection` | F-08 | Low | код + тест |
| 8 | `fix(security): add Content-Security-Policy …` | F-04 | Medium | код |
| 9 | `chore(security): pin explicit verify_jwt …` | F-16 | Info | конфіг |

> High → Medium → Low, як вимагає порядок робіт.

---

## F-01 / F-07 — Санітизація URL (High)

**Проблема.** Поля типу `url` рендерилися як `<a href={value}>`, а вкладення відкривалися `window.open(scan.webViewLink)` без перевірки схеми → `javascript:`-XSS і викрадення сесії з `localStorage`.

**Зміни коду.**
- Додано `src/utils/safeUrl.ts` — `sanitizeUrl()` (allowlist `http/https/mailto/tel`, видалення control-символів, https для безсхемних) і `sanitizeWebUrl()` (лише `http(s)`).
- Застосовано `sanitizeWebUrl` у `src/components/CustomFields.tsx`, `src/pages/CrudPage.tsx`, `src/pages/CustomSectionPage.tsx` (небезпечне значення → звичайний текст) і в `src/services/scanStorage.ts` (`openScan`).
- Додано `rel="noreferrer noopener"` та `window.open(..., "noopener,noreferrer")`.

**Тест.** `test/safeUrl.test.ts` — 7 кейсів: блок `javascript:`/`data:`/`vbscript:`/`file:`/`blob:`, контрабанда через `\t`/`\n`, дозвіл `http(s)`/`mailto`/`tel`, відмова на не-рядках. **Підтверджено: 7/7 pass.**

---

## F-02 — Оновлення `react-router-dom` (High)

**Проблема.** 7.9.4 у діапазоні кількох high-CVE (XSS через `javascript:`-редірект, open redirect через `//`).

**Зміни коду.** `react-router-dom` 7.9.4 → **7.18.0** (`npm audit fix`, без `--force`); floor у `package.json` піднято до `^7.18.0`; оновлено `package-lock.json`.

**Тест/перевірка.** `npm audit --omit=dev` більше не містить радників `react-router`. `npm run build` і `tsc --noEmit` проходять. (esbuild/vite dev-only лишається — F-13.)

---

## F-03 — Обмеження `review-hypothesis` проєктом (Medium, BOLA)

**Проблема.** Функція під `service_role` (RLS вимкнено) добирала суміжні сутності за `id` без `project_id`; `hypothesis_links.target_id` керований editor'ом → міжпроєктний витік.

**Зміни коду.** До всіх admin-вибірок у `supabase/functions/review-hypothesis/index.ts` додано `.eq("project_id", hypothesis.project_id)` (persons, documents, findings, researches, person-tasks). Семантика для легітимного випадку незмінна.

**Тест/перевірка.** Огляд коду; рекомендований інтеграційний тест із двома проєктами на shadow-БД (див. `SECURITY_OPERATIONS.md`). Edge Functions виконуються в Deno й не входять у `tsc`-перевірку фронтенду.

---

## F-05 — Очищення кешів при виході (Medium)

**Проблема.** Кеші `tracker-rodu-project-*` із персональними даними лишалися в `localStorage` після виходу.

**Зміни коду.**
- Додано `src/utils/projectCache.ts` — `clearAllProjectCaches()` (sweep за префіксом, безпечний за відсутності storage).
- Виклик у `signOutAccount` (`src/App.tsx`).

**Тест.** `test/projectCache.test.ts` — видаляє лише ключі з префіксом, зберігає сторонні; no-op без storage. **Підтверджено: pass.**

---

## F-06 — CORS Edge Functions (Medium→Low)

**Проблема.** `Access-Control-Allow-Origin: *`.

**Зміни коду.** У `supabase/functions/_shared/ai.ts` і `send-project-invitation/index.ts` origin тепер з `ALLOWED_ORIGIN`/`APP_URL` (обчислюється один раз із env), додано `Vary: Origin` і `Allow-Methods`. Фолбек `*` лише якщо env не задано — тож наявні деплої не ламаються до налаштування секрету.

**Перевірка.** Огляд; функціональний тест origin — після виставлення `ALLOWED_ORIGIN` у Supabase (ручний крок).

---

## F-08 — Захист від формула-ін'єкції в Excel (Low, defense-in-depth)

**Проблема.** Значення клітинок могли починатися з `= + - @` тощо.

**Зміни коду.** Додано `src/utils/spreadsheetSafe.ts` — `neutralizeSpreadsheetValue()`; застосовано в `inlineCell` (`src/utils/excelExport.ts`), покриває заголовки, дані й текст гіперпосилань.

**Тест.** `test/spreadsheetSafe.test.ts` — тригери отримують префікс `'`, звичайні дані без змін. **Підтверджено: pass.**

---

## F-04 — Content-Security-Policy + заголовки (Medium)

**Проблема.** На статичному хостингу не було CSP — жодного другого рубежу проти XSS.

**Зміни коду.**
- `vite.config.mjs`: плагін `injectSecurityMeta` (`apply: "build"`) додає `<meta http-equiv="Content-Security-Policy">` і `<meta name="referrer">` лише у production-збірку (dev/HMR не зачеплено). `script-src 'self'` + потрібні Google-origin, **без** `'unsafe-inline'`.
- Прибрано inline-скрипт із `index.html` → логіку SPA-redirect перенесено в `src/main.tsx`.
- `public/404.html`: inline-скрипт винесено в `public/spa-redirect.js`, додано строгий статичний CSP.

**Перевірка.** `npm run build` → `dist/index.html` містить CSP і **жодного** inline `<script>` (лише модульний бандл); `dist/404.html` має CSP і зовнішній скрипт. ⚠️ Сумісність із Google OAuth/Drive перевіряти в staging (чек-лист у `SECURITY_OPERATIONS.md`). `frame-ancestors`/HSTS/`X-Content-Type-Options` потребують справжніх заголовків (Cloudflare).

---

## F-16 — Явний `verify_jwt` (Info)

**Зміни коду.** Додано `supabase/config.toml` з `verify_jwt = true` для всіх 5 функцій (узгоджено з `auth.getUser()` у коді).

---

## Не виправлено кодом у цьому циклі (винесено в ручні налаштування / прийняті ризики)

| Знахідка | Чому | Де описано |
|----------|------|------------|
| F-09 політика паролів | налаштування Supabase Auth | `SECURITY_OPERATIONS.md` §Supabase |
| F-10 enumeration при реєстрації | UX/налаштування Auth | `SECURITY_OPERATIONS.md` |
| F-11 розсилка запрошень | rate-limit (Supabase/Resend) | `SECURITY_OPERATIONS.md` |
| F-12 невикористаний Google API-ключ | у локальному `.env` (не в репо/збірці) — відкликати вручну | `SECURITY_OPERATIONS.md` |
| F-13 esbuild dev-only | потребує мажорного апгрейду Vite | прийнятий ризик |
| F-14 ліміти Storage/MIME | налаштування бакетів | `SECURITY_OPERATIONS.md` §Storage |
| F-15 редагування профілю | без впливу на привілеї | прийнятий ризик |

---

## Підсумкова повторна перевірка

- `npx tsc --noEmit` — **OK** (0 помилок).
- `node --test "test/**/*.test.ts"` — **11/11 pass**.
- `npm run build` — **OK** (лише попередження про розмір чанку).
- `npm audit --omit=dev` — лишилися лише dev-only esbuild/vite (F-13).
- Скан `dist/` на секрети — **чисто** (немає `service_role`/`sb_secret`/`AIza`/JWT-anon).
