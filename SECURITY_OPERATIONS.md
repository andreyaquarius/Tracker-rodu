# SECURITY_OPERATIONS.md — Ручні налаштування та регламент

Цей документ описує те, що **не можна** виправити лише кодом у репозиторії: налаштування Supabase, GitHub, Google Cloud, DNS і хостингу, а також перевірки перед кожним production-деплоєм і регламент журналювання/бекапів/відновлення.

> Позначки: 🔴 критично перед production · 🟠 важливо · 🟢 бажано.

---

## 1. Supabase

### 1.1 Auth (Authentication → Providers / Policies)
- 🔴 **Site URL** = `https://trekerrodu.com.ua`. **Redirect allowlist** — лише цей домен (і, за потреби, staging). Прибрати будь-які `*`/`localhost` у production-проєкті. (Захищає від open-redirect у OAuth/реєстрації — F-02 контекст.)
- 🔴 **Leaked password protection: Enabled** (Auth → Policies). Закриває F-09 (перевірка пароля за HaveIBeenPwned).
- 🔴 **Minimum password length ≥ 10** і ввімкнені вимоги складності. Після зміни — синхронно підняти `minLength` у `src/pages/LoginPage.tsx` (зараз 6).
- 🟠 **Confirm email: Enabled** — підтвердження адреси при реєстрації (частково пом'якшує F-10).
- 🟠 **Custom SMTP** (власний поштовий провайдер) замість вбудованого — для надійної доставки листів відновлення/підтвердження.
- 🟠 **Auth rate limits** — обмежити частоту реєстрацій, входів і `resetPasswordForEmail` (пом'якшує brute-force і F-11).
- 🟢 Перевірити тривалість JWT / refresh-token rotation (увімкнено за замовчуванням).

### 1.2 Секрети Edge Functions (Project Settings → Edge Functions → Secrets)
- 🔴 `ENCRYPTION_KEY` — довгий випадковий рядок (≥ 32 байти), **інший** для production. Ним шифруються ключі Gemini (AES-GCM).
- 🔴 `SUPABASE_SERVICE_ROLE_KEY` — **тільки** у секретах функцій; ніколи у фронтенді/репозиторії. (Підтверджено: у `dist/` немає.)
- 🔴 `APP_URL` = `https://trekerrodu.com.ua` і **`ALLOWED_ORIGIN`** = `https://trekerrodu.com.ua` — без них CORS падає у фолбек `*` (F-06).
- 🟠 `RESEND_API_KEY`, `INVITATION_EMAIL_FROM` (адреса на верифікованому домені Resend).
- 🟢 Після зміни `ENCRYPTION_KEY` наявні збережені ключі Gemini стануть нечитабельними — користувачі мають зберегти ключ повторно (очікувано).

### 1.3 Storage (Storage → Buckets) — F-14
- 🔴 Підтвердити, що `project-attachments` і `project-backups` — **private** (не public).
- 🟠 Виставити реалістичний `file_size_limit` (наприклад, 50–100 МБ) замість 2 ГіБ на `project-attachments`.
- 🟠 Задати `allowed_mime_types` на бакетах відповідно до підтримуваних форматів.
- 🟢 Перевірити, що Storage-політики збігаються з міграцією (`<project_id>/…`, члени читають, редактори пишуть, бекапи — лише власник).

### 1.4 База даних
- 🔴 Прогнати **Security Advisor** і **Performance Advisor** (Dashboard → Advisors); закрити будь-які «RLS disabled»/«SECURITY DEFINER view».
- 🟠 Встановити розумний `statement_timeout` для ролі `authenticated` (захист від ресурсного виснаження важкими запитами).
- 🔴 Увімкнути **PITR / щоденні бекапи** (Project Settings → Database → Backups). Без цього п.6 не виконується.
- 🟢 Періодично перевіряти список увімкнених розширень і ролей.

### 1.5 RLS-регрес (рекомендований автоматизований тест)
Запускати на shadow/staging-БД (не на production, без реальних даних) перед деплоєм міграцій. Сценарій (псевдо-pgTAP):
1. Створити двох тест-користувачів A і B, по проєкту в кожного.
2. Як B спробувати `select/insert/update/delete` рядків проєкту A в кожній доменній таблиці → має повертати 0 рядків / помилку RLS.
3. Як `viewer` спробувати `insert/update/delete` → відмова; `select` → дозвіл.
4. Перевірити `accept_project_invitation` чужого запрошення → виняток.
5. Перевірити, що `review-hypothesis` із `hypothesis_links.target_id` на чужий запис **не** повертає чужих даних (F-03).

---

## 2. GitHub

- 🔴 **Branch protection** на `main`: заборонити прямий push, вимагати PR + проходження статус-перевірок (lint, test, audit, secret-scan).
- 🔴 **Secret scanning + Push protection: Enabled** (Settings → Code security).
- 🟠 **Dependabot** (alerts + security updates) — автоматичні PR на CVE залежностей (F-02/F-13).
- 🔴 **Repository secrets** для деплою: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_GOOGLE_CLIENT_ID` — лише публічні/publishable значення. Жодного `service_role`/`ENCRYPTION_KEY` у репо-секретах фронтенду.
- 🟠 Закріпити версії GitHub Actions за commit-SHA (зараз `@v6`/`@v5`/`@v4`) — захист ланцюга постачання CI.
- 🟢 Pages: переконатися, що **Enforce HTTPS** увімкнено для кастомного домену.

---

## 3. Google Cloud (OAuth / Drive / API key)

- 🔴 **OAuth client** (`VITE_GOOGLE_CLIENT_ID`): Authorized JavaScript origins і redirect URIs — лише `https://trekerrodu.com.ua` (+ staging за потреби).
- 🟠 Drive scope лишити мінімальним — `drive.file` (вже так).
- 🔴 **F-12:** ключ `VITE_GOOGLE_API_KEY` у локальному `.env` **не використовується** і відсутній у збірці. Видалити рядок із локального `.env`; якщо ключ реальний — **відкликати** або обмежити (HTTP-referrer + API restrictions) у Google Cloud.

---

## 4. DNS / Хостинг (заголовки, яких немає на GitHub Pages)

GitHub Pages не дозволяє кастомні заголовки відповіді. Для повного покриття поставити перед сайтом проксі/CDN (наприклад, Cloudflare) і задати:
- 🔴 **HSTS**: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
- 🟠 **X-Content-Type-Options**: `nosniff` (через `<meta>` не діє — потрібен заголовок).
- 🟠 **X-Frame-Options / frame-ancestors**: `DENY` — захист від clickjacking (через `<meta>` CSP `frame-ancestors` ігнорується).
- 🟢 **Permissions-Policy**: вимкнути непотрібні API (`camera=()`, `geolocation=()` тощо).
- 🔴 **DMARC/SPF/DKIM** для домену відправника Resend (`INVITATION_EMAIL_FROM`) — щоб листи-запрошення не підроблялися й доходили.
- 🟢 **CAA**-запис для домену — обмежити, які CA можуть видавати сертифікати.

> CSP (`script-src` без `unsafe-inline`, `connect-src`, `frame-src` тощо) вже додається `<meta>`-тегом у збірку (F-04) і працює без проксі. Проксі потрібен лише для перелічених **header-only** механізмів.

---

## 5. Чек-лист перед кожним production-деплоєм

Запускати **усі** кроки; деплой лише якщо всі зелені.

```bash
# 1. Тип-перевірка
npm run lint                       # tsc --noEmit, очікується 0 помилок

# 2. Security-тести
npm test                           # node --test, очікується усі pass

# 3. CVE у production-залежностях
npm audit --omit=dev               # без high/critical (dev-only esbuild/vite — відомо, F-13)

# 4. Збірка
npm run build                      # має завершитися успішно

# 5. Скан збірки на секрети (має бути ПОРОЖНЬО)
grep -roiE '(service_role|sb_secret_|AIza[0-9A-Za-z_-]{35}|eyJhbGciOi[A-Za-z0-9_-]{20})' dist

# 6. CSP присутній, inline-скриптів немає
grep -o 'Content-Security-Policy' dist/index.html
grep -oE '<script[^>]*>' dist/index.html      # лише модульний бандл, без inline
```

**Ручні перевірки в staging (особливо після зміни CSP/Google-origin):**
- 🔴 Вхід через Google і через email/пароль.
- 🔴 Завантаження, відкриття та видалення вкладення (Google Drive popup).
- 🔴 Глибоке посилання + оновлення сторінки (SPA-redirect через 404.html).
- 🟠 Відновлення пароля (лист доходить, нова сесія).
- 🟠 Запрошення співавтора (лист Resend), приймання, перевірка ролей.
- 🟠 ШІ-рев'ю гіпотези (Edge Function, CORS з `ALLOWED_ORIGIN`).
- 🟢 Консоль браузера без CSP-порушень (`Refused to … because it violates CSP`).

---

## 6. Журналювання, моніторинг, бекапи, відновлення

### Журналювання
- Прикладний аудит — таблиця `public.activity_log` (незмінна з клієнта: лише INSERT, `actor_id = auth.uid()`). Зберігає дію/модуль/сутність.
- Серверні логи — Supabase Dashboard → Logs (Auth, PostgREST, Edge Functions). 🟠 Перевіряти, що у відповідях/логах не друкуються секрети чи персональні дані.

### Моніторинг
- 🟠 Налаштувати алерти Supabase на сплески 4xx/5xx PostgREST, помилки Edge Functions, наближення до квот.
- 🟢 Реагувати на Advisor-попередження як на інцидент.

### Бекапи
- 🔴 Увімкнути PITR / щоденні бекапи БД (§1.4).
- Прикладні бекапи проєкту — бакет `project-backups` (приватний, лише власник), керується `src/pages/BackupPage.tsx` / `src/services/projectBackups.ts`.
- 🟢 Періодично перевіряти, що бекапи реально створюються та доступні власнику.

### Відновлення (runbook)
1. Визначити момент відновлення (інцидент/втрата даних).
2. БД: відновити з PITR/щоденного бекапа на staging, перевірити цілісність (RLS, кількість рядків), потім — на production.
3. Прикладний рівень: відновлення проєкту з резервної копії через UI (`BackupPage`) — імпорт валідовано `normalizeDatabase` (звіряє `appName`/`version`, ремапить ID).
4. Після відновлення прогнати чек-лист §5 і Security Advisor.
5. 🟠 Провести post-mortem; за потреби ротувати `ENCRYPTION_KEY`/`SERVICE_ROLE`/Resend-ключ.

---

## 7. Зведення прийнятих ризиків

| Ризик | Стан | Умова перегляду |
|-------|------|-----------------|
| F-13 esbuild dev-only | прийнято | при апгрейді Vite до сумісного мажора |
| F-15 редагування власного профілю | прийнято | якщо email почне впливати на авторизацію |
| F-11 розсилка запрошень | частково прийнято | додати rate-limit при зловживанні |
| CSP сумісність із Google | контрольований | обов'язкова staging-перевірка перед кожним деплоєм |
