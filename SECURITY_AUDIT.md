# SECURITY_AUDIT.md — Захисний аудит безпеки «Трекер Роду»

- **Версія застосунку:** 1.0.0 (`tracker-rodu`)
- **Дата аудиту:** 2026-06-16
- **Гілка аудиту:** `security-audit`
- **Стек:** React 19 + Vite 6 (SPA, статичний хостинг на GitHub Pages) · Supabase (PostgreSQL + Auth + Edge Functions) · Google Drive (`drive.file`) для вкладень · Google Gemini для ШІ-аналізу · Resend для пошти
- **Тип аудиту:** виключно захисний (white-box перегляд коду та конфігурації). Руйнівні атаки, видалення реальних даних і тестування сторонніх систем **не** проводилися.
- **Стандарти:** OWASP ASVS 5.0, OWASP Top 10:2025, OWASP API Security Top 10:2023.

> ⚠️ **Цей файл — звіт і план.** Виправлення вносяться окремими логічними комітами після цього документа. Перебіг виправлень — у `SECURITY_FIXES.md`, ручні налаштування та регламент — у `SECURITY_OPERATIONS.md`.

---

## 1. Що було перевірено

| # | Область | Метод | Статус |
|---|---------|-------|--------|
| 1 | Архітектура застосунку | Перегляд `src/`, `supabase/`, `index.html`, CI | ✅ |
| 2 | Інвентаризація таблиць/RPC/функцій/бакетів/інтеграцій | Перегляд міграцій і коду | ✅ |
| 3 | OWASP ASVS 5.0 / Top 10:2025 / API Top 10 | Зіставлення з кодом | ✅ |
| 4 | Автентифікація, сесії, відновлення пароля | `supabaseAuth.ts`, `LoginPage.tsx`, Supabase Auth | ✅ |
| 5 | Міжкористувацький доступ (читання/зміна/видалення/експорт/завантаження) | RLS + сервіси + Edge Functions | ✅ |
| 6 | RLS на всіх таблицях (SELECT/INSERT/UPDATE/DELETE) | Усі міграції | ✅ |
| 7 | `USING` та `WITH CHECK` | Аналіз кожної політики | ✅ |
| 8 | Views / triggers / RPC / `SECURITY DEFINER` — обхід RLS | Аналіз функцій і тригерів | ✅ |
| 9 | Секрети у фронтенді/репозиторії/історії Git/збірці | `git log -S`, скан `dist/`, `.env` | ✅ |
| 10 | Supabase Storage: публічність, політики, signed URL, MIME, розміри | Міграції storage + код | ✅ |
| 11 | IDOR/BOLA, broken auth, mass assignment, injection, XSS, CSRF, SSRF, path traversal, open redirect, CORS, ресурсне виснаження | Весь код | ✅ |
| 12 | Імпорт/експорт даних | `exportImport.ts`, `database.ts`, `excelExport.ts`, `BackupPage.tsx` | ✅ |
| 13 | Залежності та відомі CVE | `npm audit` | ✅ |
| 14 | GitHub Actions, CI/CD, production-конфіг | `.github/workflows/deploy.yml` | ✅ |
| 15 | Шифрування при передаванні та зберіганні | HTTPS, AES-GCM для ключів ШІ | ✅ |
| 16 | Журналювання, моніторинг, бекапи, відновлення | `activity_log`, `project_backups`, `BackupPage` | ✅ (частково — потребує ручних налаштувань) |

---

## 2. Архітектура

```
Браузер (React SPA, GitHub Pages, https://trekerrodu.com.ua)
  │
  ├─ supabase-js (ключ sb_publishable_…, лише публічний)
  │     ├─ PostgREST  → таблиці public.*  (захищено RLS)
  │     ├─ RPC        → accept_project_invitation, get_dashboard_stats
  │     ├─ Realtime   → publication supabase_realtime
  │     ├─ Auth       → Google OAuth + email/пароль
  │     └─ Edge Functions (JWT користувача в Authorization):
  │           ├─ save-ai-key / delete-ai-key / test-ai-key   (service_role + ENCRYPTION_KEY)
  │           ├─ review-hypothesis                            (service_role + Gemini)
  │           └─ send-project-invitation                     (anon-scoped + Resend)
  │
  ├─ Google Identity Services + Picker (OAuth токен, scope drive.file)
  │     └─ Google Drive API → файли, створені застосунком або явно вибрані користувачем
  │
  └─ localStorage: сесія Supabase + кеш проєктних даних (tracker-rodu-project-*)
```

**Ключові архітектурні факти, важливі для безпеки:**

1. **Модель тенант-ізоляції — проєкт.** Кожна доменна таблиця має `project_id`. Доступ визначається членством у `project_members` (ролі `owner` / `editor` / `viewer`). Це коректно реалізовано через RLS.
2. **Клієнт використовує лише публічний ключ** `sb_publishable_…` (новий формат Supabase). `service_role` живе тільки в Edge Functions. Підтверджено скануванням `dist/`.
3. **Вкладення зберігаються в Google Drive користувача** (`scope=drive.file` — застосунок бачить створені ним або явно вибрані через Google Picker файли). Бакети Supabase Storage `project-attachments` / `project-backups` приватні; бакет бекапів доступний лише власнику проєкту.
4. **Серверна логіка мінімальна** — 6 Edge Functions. SSR немає, тому низка класів вразливостей (SSTI, серверний SSRF з боку застосунку) переважно не застосовна; основна поверхня — RLS, клієнтський XSS і Edge Functions.

---

## 3. Інвентаризація

### 3.1 Таблиці (`public`) та стан RLS

Усі перелічені таблиці мають `ENABLE ROW LEVEL SECURITY` і політики на всі чотири операції (де доречно).

| Таблиця | SELECT | INSERT | UPDATE | DELETE | Примітка |
|---------|--------|--------|--------|--------|----------|
| `profiles` | свій або спільний по проєкту | (лише тригер `handle_new_user`, SECURITY DEFINER) | свій | — (заборонено) | email/display_name редаговані власником запису |
| `projects` | член проєкту | `owner_id = auth.uid()` | власник | власник | |
| `project_members` | член | власник, `role<>'owner'` | власник, `user_id<>self`, `role<>'owner'` | власник, `user_id<>self` | |
| `project_invitations` | власник або одержувач (за email з JWT) | власник | власник | власник | |
| `researches`, `persons`, `person_relations`, `documents`, `year_matrix`, `tasks`, `task_persons`, `findings`, `finding_participants`, `hypotheses`, `hypothesis_links`, `archive_requests`, `archive_request_persons`, `custom_records`, `record_links`, `attachments` | член | редактор/власник | редактор/власник | редактор/власник | стандартний набір через цикл міграції |
| `custom_field_definitions`, `custom_sections`, `custom_section_fields` | член | **власник** | **власник** | **власник** | структуру править лише власник |
| `activity_log` | член | редактор + `actor_id=auth.uid()` | — | — | журнал незмінний на клієнті (цілісність аудиту) |
| `user_ai_settings` | `user_id=auth.uid()` | свій | свій | свій | зберігає `encrypted_api_key` (AES-GCM) |
| `ai_hypothesis_reviews` | член | член + `user_id=self` + `workspace_id=project_id` | — | свій | |

### 3.2 RPC / функції

| Функція | Тип | Доступ | Призначення |
|---------|-----|--------|-------------|
| `is_project_member(uuid)` | SQL, `SECURITY DEFINER`, `search_path=''` | authenticated | хелпер RLS |
| `can_edit_project(uuid)` | SQL, `SECURITY DEFINER`, `search_path=''` | authenticated | хелпер RLS |
| `is_project_owner(uuid)` | SQL, `SECURITY DEFINER`, `search_path=''` | authenticated | хелпер RLS |
| `accept_project_invitation(uuid)` | plpgsql, `SECURITY DEFINER`, `search_path=''` | authenticated | приймання запрошення; **перевіряє email з JWT, статус, термін** |
| `get_dashboard_stats(uuid)` | SQL, **`SECURITY INVOKER`** | authenticated | агрегати дашборда (RLS поважається) |
| `handle_new_user()` | тригер, `SECURITY DEFINER` | revoked від клієнта | створення `profiles` |
| `add_project_owner()` | тригер, `SECURITY DEFINER` | revoked від клієнта | власник → `project_members` |
| `set_project_slug()` / `project_slug_base()` | тригер/immutable, `search_path=''` | revoked від клієнта | slug проєкту |
| `set_updated_at()` | тригер | revoked від клієнта | `updated_at` |
| `storage_project_id(text)` | immutable, `search_path=''` | — | перший сегмент шляху → project_id для storage-політик |

**Висновок щодо обходу RLS:** жодна `SECURITY DEFINER`-функція не повертає довільні дані в обхід авторизації. Усі хелпери похідні від `auth.uid()`, мають замкнений `search_path`, відкликані від `anon/public`. Єдина агрегаційна функція дашборда — `SECURITY INVOKER`. Views, що оголюють дані в обхід RLS, **не виявлено**.

### 3.3 Edge Functions

| Функція | Авторизація | Секрети | Ризик |
|---------|-------------|---------|-------|
| `save-ai-key` | JWT → `auth.getUser()` | `SERVICE_ROLE`, `ENCRYPTION_KEY` | шифрує ключ Gemini (AES-GCM), пише свій рядок |
| `delete-ai-key` | JWT | `SERVICE_ROLE` | видаляє свій рядок |
| `test-ai-key` | JWT | `SERVICE_ROLE`, `ENCRYPTION_KEY` | тест-виклик Gemini |
| `review-hypothesis` | JWT + **ручна перевірка членства** | `SERVICE_ROLE`, `ENCRYPTION_KEY` | **F-03**: суміжні вибірки не обмежені `project_id` |
| `send-project-invitation` | JWT (anon-scoped, RLS діє) + `invited_by=self` | `RESEND_API_KEY`, `APP_URL` | **F-11**: лист на довільну адресу |
| `_shared/ai.ts` | — | — | CORS `*` (**F-06**), AES-GCM, валідація моделі |

### 3.4 Ролі

- **PostgreSQL-ролі:** `authenticated` (клієнт), `service_role` (Edge Functions), `anon` (фактично заблоковано — більшість grant'ів лише для `authenticated`).
- **Доменні ролі проєкту:** `owner`, `editor`, `viewer` (enum `public.project_role`).

### 3.5 Бакети Storage

| Бакет | Публічний | Ліміт розміру | MIME-allowlist | Політики |
|-------|-----------|---------------|----------------|----------|
| `project-attachments` | ні | **2 ГіБ** | ❌ немає | члени читають, редактори пишуть (шлях `<project_id>/…`) |
| `project-backups` | ні | 100 МіБ | ❌ немає | лише власник проєкту |

> Фактично вкладення мігрували на Google Drive; бакети залишаються для бекапів і легасі. Див. F-14.

### 3.6 Зовнішні інтеграції

- **Google Identity Services / Picker / Drive API** (`drive.file`) — створення вкладень і робота з файлами, які користувач явно вибрав.
- **Google Gemini** (`generativelanguage.googleapis.com`) — серверний виклик з `review-hypothesis`/`test-ai-key` ключем користувача.
- **Resend** (`api.resend.com`) — листи-запрошення.
- **GitHub Pages** — хостинг, домен `trekerrodu.com.ua`.

---

## 4. Знахідки

Рівні ризику: **Critical / High / Medium / Low / Info**. Для кожної — безпечний доказ існування (вказівник на код, без працюючого експлойта).

### F-01 — Stored/DOM XSS через `javascript:`-URL у користувацьких полях типу «url» — **High**
- **Компонент:** `src/components/CustomFields.tsx:222`, `src/pages/CrudPage.tsx:694`, `src/pages/CustomSectionPage.tsx:546`.
- **Опис:** поля типу `url` рендеряться як `<a href={value}>` без валідації схеми. React **не** санітизує `href`. Значення `javascript:…` виконує скрипт у джерелі застосунку при кліку. Дані вводять співавтори проєкту (editor) або вони потрапляють через імпорт бекапу.
- **Наслідки:** оскільки сесія Supabase зберігається в `localStorage` (`persistSession: true`), XSS дозволяє викрасти токен і повністю захопити обліковий запис, а далі — будь-які проєкти жертви. Це міжкористувацька атака у спільному проєкті.
- **Безпечний доказ:** рядок `return <a href={text} target="_blank" rel="noreferrer">…` де `text = String(value ?? "")` походить з користувацького поля. Жодної перевірки `^https?:` немає (на відміну від `excelExport.ts:767 isWebUrl`, де перевірка є).
- **Кроки відтворення (концептуально, без експлойта):** editor створює запис, у custom-полі типу `url` вводить `javascript:…`; власник відкриває деталі запису й натискає «Відкрити посилання».
- **Рекомендація:** централізована функція `sanitizeUrl()`, що пропускає лише `http/https/mailto/tel` і повертає `#` для решти; застосувати в усіх трьох місцях і в `openScan`.
- **Зміни коду:** новий `src/utils/safeUrl.ts`; правки трьох рендер-сайтів і `scanStorage.openScan`.
- **Тест:** `test/safeUrl.test.ts` — `javascript:`, `data:`, `vbscript:`, керівні символи → блок; `https://…`, `mailto:` → дозвіл.

### F-02 — Вразлива версія `react-router-dom` 7.9.4 (відомі CVE) — **High**
- **Компонент:** `package.json` → `react-router-dom ^7.9.4`, `react-router`.
- **Опис:** `npm audit` показує кілька high-радників для 7.0.0–7.14.2, зокрема **XSS через `javascript:`-ціль редіректу**, **open redirect через protocol-relative `//`-шляхи**, DoS у обробці шляхів. Частина стосується SSR/framework-режиму (не застосовно до цього SPA), але redirect/відкритий-редірект-вектори застосовні.
- **Наслідки:** відкритий редірект і потенційний XSS через маршрутизацію.
- **Безпечний доказ:** вивід `npm audit` (розділ `react-router`), діапазон версій збігається з встановленою.
- **Рекомендація:** оновити до патченого релізу 7.x (`npm audit fix` без `--force`).
- **Зміни коду:** `package.json` + `package-lock.json`.
- **Тест:** `npm audit --omit=dev` без high/critical у production-залежностях (крок pre-deploy).

### F-03 — Міжпроєктне розкриття даних (BOLA) у `review-hypothesis` — **Medium**
- **Компонент:** `supabase/functions/review-hypothesis/index.ts:127-197`.
- **Опис:** функція працює під `service_role` (RLS вимкнено). Після коректної перевірки членства в проєкті гіпотези вона добирає суміжні сутності за `id` (`persons`, `documents`, `findings`, `tasks` за `personTaskIds`) **без фільтра `project_id`**. Ідентифікатори беруться з `hypothesis_links.target_id`, який не має FK-обмеження й заповнюється editor'ом. Отже editor може вставити у власний проєкт посилання `target_id = <UUID чужого запису>` і отримати чужі персональні дані в контексті ШІ-відповіді/`result_json`.
- **Наслідки:** витік персональних генеалогічних даних між тенантами (потрібне знання UUID; дані проходять через ШІ-резюме і зберігаються в `ai_hypothesis_reviews`).
- **Безпечний доказ:** `admin.from("persons").select(...).in("id", personIds)` — без `.eq("project_id", hypothesis.project_id)`.
- **Рекомендація:** додати `.eq("project_id", hypothesis.project_id)` до всіх суміжних вибірок (defense-in-depth; підтверджує, що дані не виходять за межі проєкту гіпотези).
- **Тест:** перевірка коду/огляд + (опц.) інтеграційний тест із двома проєктами на shadow-БД.

### F-04 — Відсутній Content-Security-Policy та security-заголовки — **Medium**
- **Компонент:** `index.html`, `public/404.html`, хостинг GitHub Pages.
- **Опис:** немає CSP, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors`. CSP без `'unsafe-inline'` у `script-src` був би сильним бар'єром саме проти F-01/F-07. GitHub Pages не дозволяє кастомні заголовки відповіді, тож CSP реалізується `<meta http-equiv>`.
- **Наслідки:** відсутній другий рубіж проти XSS; можливий clickjacking (немає `frame-ancestors`, доступного лише через заголовок — частково).
- **Рекомендація:** ін'єктувати CSP `<meta>` у production-збірку (Vite `transformIndexHtml`, лише `apply:'build'`, щоб не ламати dev/HMR), прибрати inline-скрипти (винести у модуль/зовнішній файл), додати `Referrer-Policy` та `X-Content-Type-Options` через `<meta>`/конфіг хостингу де можливо.
- **Тест:** `vite build` успішний; `dist/index.html` містить директиву CSP; ручна перевірка логіну/Drive/refresh у staging.

### F-05 — Чутливі проєктні дані в `localStorage` не очищаються при виході — **Medium**
- **Компонент:** `src/App.tsx:1525 signOutAccount`; кеші в `projectPeople.ts`, `projectDocuments.ts`, `projectWorkRecords.ts`, `projectResearches.ts`, `projectCustomStructure.ts`, `projectAnalysisRecords.ts` (ключі `tracker-rodu-project-*`).
- **Опис:** сервіси кешують повні набори даних (особи, документи, знахідки тощо) у `localStorage`. `signOutAccount` видаляє лише `ACCOUNT_ONBOARDING_KEY` і `ACTIVE_WORKSPACE_KEY`, але **не** ці кеші. На спільному пристрої наступний користувач браузера має доступ до персональних даних попереднього.
- **Наслідки:** розкриття персональних даних на спільному/публічному пристрої після виходу.
- **Безпечний доказ:** у `signOutAccount` немає виклику очищення `tracker-rodu-project-*`.
- **Рекомендація:** `clearAllProjectCaches()`, що видаляє всі ключі з префіксом `tracker-rodu-project-`, виклик у `signOutAccount`.
- **Тест:** `test/projectCache.test.ts` — після `clearAllProjectCaches` жодного ключа з префіксом не лишилось.

### F-06 — Надмірно дозвільний CORS (`Access-Control-Allow-Origin: *`) на Edge Functions — **Medium → Low**
- **Компонент:** `supabase/functions/_shared/ai.ts:3`, `supabase/functions/send-project-invitation/index.ts:3`.
- **Опис:** усі функції повертають `*`. Авторизація — через `Authorization: Bearer` (не cookie), тож класичний CSRF не виникає, проте будь-який сайт може викликати функції з украденим/переданим токеном, і політика суперечить принципу мінімальних привілеїв.
- **Рекомендація:** обмежити origin до значення `APP_URL`/`ALLOWED_ORIGINS` (з env), повертати конкретний origin за allowlist, додати `Vary: Origin`.
- **Тест:** перевірка, що відповідь містить дозволений origin лише зі списку.

### F-07 — Open redirect / небезпечна схема через `webViewLink` у `openScan` — **Low**
- **Компонент:** `src/services/scanStorage.ts:71 window.open(scan.webViewLink || …)`.
- **Опис:** при імпорті бекапу поле `webViewLink` зберігається як є (`database.ts` не валідує поля скана). `window.open('javascript:…')` історично виконує скрипт у новому вікні з джерелом opener'а. Самозаподіяно (імпорт власного файлу), але варто закрити.
- **Рекомендація:** пропускати в `window.open` лише `http/https` (через `sanitizeUrl`).
- **Тест:** охоплено `safeUrl.test.ts`.

### F-08 — Формула/CSV-ін'єкція в експорті Excel — **Low (defense-in-depth)**
- **Компонент:** `src/utils/excelExport.ts` (`inlineCell`).
- **Опис:** значення клітинок пишуться як `t="inlineStr"`, тож Excel **не** виконує їх як формули (на відміну від CSV). Ризик мінімальний, але як захист рекомендується префіксувати значення, що починаються з `= + - @ \t \r`, апострофом.
- **Рекомендація:** guard у формуванні текстових клітинок.
- **Тест:** `test/excelInjection.test.ts` — `=cmd` → `'=cmd`.

### F-09 — Слабка політика паролів — **Low** (ручне налаштування Supabase)
- **Компонент:** `LoginPage.tsx` (`minLength=6`), Supabase Auth.
- **Опис:** мінімум 6 символів, без перевірки на витоки/складність (ASVS 5.0 §2.1 рекомендує ≥ 8–12 і breach-check).
- **Рекомендація:** у Supabase Auth увімкнути «Leaked password protection» і підняти мінімальну довжину до ≥ 10; синхронно оновити `minLength` у формі.

### F-10 — Розкриття існування облікового запису при реєстрації — **Low**
- **Компонент:** `LoginPage.tsx:28` («Обліковий запис із цією адресою вже існує»).
- **Опис:** повідомлення підтверджує існування email. (При вході — навпаки, узагальнене, що добре.)
- **Рекомендація:** узагальнити текст реєстрації; за потреби — увімкнути «Confirm email» і однаковий UX.

### F-11 — Розсилання листів-запрошень на довільні адреси — **Low**
- **Компонент:** `supabase/functions/send-project-invitation/index.ts`.
- **Опис:** автентифікований власник проєкту може надсилати листи Resend на будь-яку адресу (вектор спаму). Обмежено роллю owner і станом запрошення; HTML екранується.
- **Рекомендація:** rate-limit на кількість запрошень/листів на користувача за період; за можливості — лише на адреси, що раніше зареєстровані, або з капчею.

### F-12 — Невикористаний реальний Google API-ключ у локальному `.env` — **Low / Info**
- **Компонент:** `.env` (`VITE_GOOGLE_API_KEY=AIza…`).
- **Опис:** ключ **не** закомічений (`.gitignore`), **не** використовується в коді й **відсутній** у `dist/`. Проте це реальний ключ у локальному файлі.
- **Рекомендація:** видалити рядок з `.env`/`.env.example`; якщо ключ був валідним — відкликати/обмежити в Google Cloud.

### F-13 — CVE `esbuild ≤0.28` (dev-only) — **Low / Info**
- **Компонент:** транзитивно через `vite` (devDependency).
- **Опис:** GHSA-gv7w-rqvm-qjhr стосується dev-сервера esbuild; production-збірка не наражається. Виправлення вимагає мажорного апгрейду Vite (breaking).
- **Рекомендація:** планово оновити Vite/esbuild; до того — не запускати dev-сервер у недовіреній мережі.

### F-14 — Великі ліміти Storage / ресурсне виснаження — **Info**
- **Компонент:** `project-attachments` (2 ГіБ/файл, без MIME-allowlist), `project-backups` (100 МіБ).
- **Рекомендація:** виставити реалістичні ліміти й `allowed_mime_types` на бакетах; клієнтський ліміт Drive (25 МБ) уже є.

### F-15 — Самостійне редагування `profiles.email`/`display_name` — **Info**
- **Опис:** не впливає на привілеї (запрошення звіряються з email у JWT), але дозволяє косметичну видавання себе за іншого у списку учасників.
- **Рекомендація:** за бажанням — заборонити зміну `email` у `WITH CHECK` (звіряти з `auth.jwt()->>'email'`).

### F-16 — Немає `supabase/config.toml` із явним `verify_jwt` — **Info**
- **Опис:** функції перевіряють JWT у коді (`auth.getUser()`), тож захищені. Але явна конфігурація шлюзу — гарна практика.
- **Рекомендація:** додати `config.toml` з `verify_jwt = true` для всіх функцій.

---

## 5. Що перевірено й виявилося в порядку (позитиви)

- **RLS повна та коректна:** усі доменні таблиці мають `USING` і `WITH CHECK`; запис вимагає `can_edit_project`, структуру править лише власник, журнал незмінний.
- **`SECURITY DEFINER`-хелпери безпечні:** замкнений `search_path=''`, відкликані від `anon/public`, похідні від `auth.uid()`.
- **Приймання запрошення** звіряє email із JWT, статус і термін — не можна прийняти чуже запрошення чи підвищити собі роль.
- **Розмежування ролей:** editor не може змінювати ролі/учасників; власник не може призначити другого `owner` чи змінити власну роль.
- **Секрети не витікають:** `service_role`, JWT-anon, AIza-ключі **відсутні** в `dist/` та в історії Git; клієнт використовує лише `sb_publishable_`.
- **Ключі ШІ шифруються** AES-GCM (випадковий IV) ключем із env; у БД лишається лише `last4`.
- **Транспорт:** HTTPS скрізь (Supabase, Google, Resend, GitHub Pages з TLS).
- **Ін'єкції SQL немає:** доступ лише через PostgREST/параметризовані RPC; динамічний SQL у міграціях будується через `format(%I)` з контрольованими іменами.
- **Бакети приватні;** бекапи — лише власнику.
- **Екранування** HTML у листі-запрошенні та XML в експорті Excel наявне; URL гіперпосилань у Excel обмежені `^https?:`.

---

## 6. Зведена таблиця ризиків і план виправлень

| ID | Ризик | Виправляємо | Коміт | Тест |
|----|-------|-------------|-------|------|
| F-01 | High | ✅ цей цикл | `fix(security): sanitize user URLs` | `safeUrl.test.ts` |
| F-02 | High | ✅ цей цикл | `fix(security): bump react-router-dom` | `npm audit` (pre-deploy) |
| F-03 | Medium | ✅ цей цикл | `fix(security): scope review-hypothesis` | огляд + інтеграційний (опц.) |
| F-04 | Medium | ✅ цей цикл | `fix(security): add CSP + headers` | `vite build` + ручна перевірка |
| F-05 | Medium | ✅ цей цикл | `fix(security): clear caches on signout` | `projectCache.test.ts` |
| F-06 | Medium→Low | ✅ цей цикл | `fix(security): restrict edge CORS` | огляд |
| F-07 | Low | ✅ цей цикл (разом із F-01) | `fix(security): sanitize user URLs` | `safeUrl.test.ts` |
| F-08 | Low | ✅ цей цикл | `fix(security): excel formula guard` | `excelInjection.test.ts` |
| F-09 | Low | ⚙️ ручне (Supabase) | — | — |
| F-10 | Low | ⚙️ ручне/опц. | — | — |
| F-11 | Low | ⚙️ ручне (rate-limit) | — | — |
| F-12 | Low | ✅ прибрати з `.env.example` | `chore(security): drop unused key` | — |
| F-13 | Low | 🔜 планово (Vite major) | — | `npm audit` |
| F-14 | Info | ⚙️ ручне (Storage) | — | — |
| F-15 | Info | прийнятий ризик / опц. | — | — |
| F-16 | Info | ✅ додати `config.toml` | `chore(security): edge config` | — |

**Порядок:** High → Medium → Low, кожне виправлення — окремий коміт; бізнес-логіка не змінюється.

---

## 7. Прийняті ризики (на момент звіту)

- **F-13 (esbuild dev-only):** прийнято до планового мажорного апгрейду Vite — production-збірка не наражена.
- **F-15 (редагування власного профілю):** прийнято — немає впливу на привілеї.
- **F-11 (розсилка запрошень):** частково прийнято — обмежено роллю owner; rate-limit виноситься в ручні налаштування.
- **CSP runtime-валідація:** CSP вмикається в збірці, але остаточна перевірка сумісності з Google OAuth/Drive виконується вручну в staging перед production (див. `SECURITY_OPERATIONS.md`).

Деталі ручних налаштувань і pre-deploy перевірок — у `SECURITY_OPERATIONS.md`.
