# External PDF Viewer v2

## Що реалізовано

Переглядач працює з metadata зовнішнього PDF і не копіює оригінал у Supabase Storage. Потік розділено на:

1. адаптери Wikimedia/Wikisource, Google Drive і generic HTTPS PDF;
2. project-scoped registry `document_sources`;
3. короткочасні hashed access sessions;
4. Edge Function `pdf-gateway` із Range streaming та SSRF-перевірками;
5. PDF.js viewer із віртуалізованими мініатюрами;
6. normalized crop/provenance для знахідок;
7. client export у PDF, PNG, JPEG або ZIP на комп’ютер чи Google Drive.

У формі документа зовнішнє посилання проходить канонічну перевірку до
збереження. Для звичайної статті Вікіджерел, яка містить кілька PDF, користувач
обирає один перевірений кандидат. Зображення обкладинок та інші не-PDF файли до
списку не потрапляють. Перевірка має debounce і скасовується при зміні URL або
закритті форми.

Metadata probe дозволений лише власнику або редактору проєкту. Відкриття вже
збереженого документа доступне всім поточним учасникам проєкту, але кожна
gateway-сесія прив’язана до користувача, документа та джерела, має короткий TTL,
ліміт запитів і атомарний ліміт активних сесій.

Оригінальні PDF, plaintext OAuth tokens, signed download URL і масиви
відрендерених сторінок у БД не зберігаються. Для приватного Google Drive
короткочасний access token один раз шифрується сервером (AES-GCM) у
service-only gateway-сесії з TTL; PDF.js отримує лише opaque URL gateway.
Публічний Drive share перевіряється окремим server-only API key, відкривається
без OAuth і так само віддається PDF.js лише через opaque gateway URL. Сам ключ
не записується до `document_sources`, сесії або telemetry.

## Локальне ввімкнення

1. Скопіюйте потрібні значення з `.env.example` до `.env.local` і залиште:

```text
VITE_EXTERNAL_PDF_VIEWER_V2=true
VITE_EXTERNAL_PDF_SOURCE_REVALIDATE_MINUTES=15
VITE_PDF_VIEWER_MAX_CANVAS_PIXELS=16777216
VITE_PDF_VIEWER_MAX_CANVAS_SIDE=8192
VITE_LOCAL_EDGE_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1
```

Ліміти canvas застосовуються і до основної сторінки, і до мініатюр. Якщо
запитаний масштаб перевищує 16 777 216 пікселів або 8192 px за будь-якою
стороною, viewer зменшує внутрішній render scale до безпечного значення.

2. Створіть `.env.functions.local` на основі `.env.functions.example`.

Для приватних Google Drive PDF у ньому обов'язково задайте довгий випадковий
`ENCRYPTION_KEY` (32+ байти). Це server-only значення без префікса `VITE_`.

Для публічних Google Drive share-посилань задайте окремий server-side
`GOOGLE_DRIVE_PUBLIC_API_KEY` з увімкненим Google Drive API. Не використовуйте
для цього браузерний Picker key, обмежений HTTP referrer, і не додавайте
префікс `VITE_`.

Основні серверні обмеження мають безпечні значення за замовчуванням і за
потреби змінюються у `.env.functions.local` або Supabase Secrets:

```text
PDF_PROXY_TOKEN_TTL_SECONDS=600
PDF_PROXY_MAX_REQUESTS_PER_SESSION=512
PDF_PROXY_MAX_ACTIVE_SESSIONS_PER_USER_PROJECT=8
PDF_PROBE_MAX_REQUESTS_PER_WINDOW=30
PDF_PROBE_WINDOW_SECONDS=60
PDF_TELEMETRY_MAX_EVENTS_PER_WINDOW=120
PDF_TELEMETRY_WINDOW_SECONDS=60
PDF_TELEMETRY_SUCCESS_SAMPLE_PERCENT=10
PDF_PROXY_STREAM_IDLE_TIMEOUT_MS=30000
PDF_PROXY_MAX_RANGE_RESPONSE_BYTES=8388608
PDF_FALLBACK_MAX_BYTES_WITHOUT_RANGE=33554432
PDF_EXPORT_WORKER_URL=http://host.docker.internal:8788
PDF_EXPORT_WORKER_SECRET=replace-with-the-same-32-character-random-secret
PDF_EXPORT_WORKER_ALLOW_HTTP_LOCAL=true
PDF_EXPORT_MAX_REQUESTS_PER_WINDOW=10
PDF_EXPORT_WINDOW_SECONDS=60
PDF_EXPORT_MAX_PAGES=250
PDF_EXPORT_MAX_RESULT_BYTES=1073741824
PDF_EXPORT_WORKER_TIMEOUT_MS=240000
```

3. В окремому PowerShell зберіть і запустіть тимчасовий PDF worker. Він
використовує `qpdf`, DNS pinning і приватний `/tmp`; оригінал та результат
видаляються після завершення або помилки:

```powershell
docker build -t tracker-rodu-pdf-worker services/pdf-export-worker
docker run --rm --name tracker-rodu-pdf-worker -p 8788:8080 `
  -e PDF_EXPORT_WORKER_SECRET=replace-with-the-same-32-character-random-secret `
  tracker-rodu-pdf-worker
```

`PDF_EXPORT_WORKER_ALLOW_HTTP_LOCAL=true` дозволяє лише локальний
`http://host.docker.internal:<port>` між контейнерами. У production це значення
має бути відсутнім або `false`, а worker — доступним виключно через HTTPS.

4. У PowerShell виконайте:

```powershell
npm.cmd exec supabase -- start
npm.cmd exec supabase -- migration up --local
npm.cmd exec supabase -- functions serve pdf-gateway --env-file .env.functions.local
npm.cmd run dev
```

Не додавайте `--no-verify-jwt`: локальний тест має відповідати production auth.

5. У Supabase Studio `http://127.0.0.1:54323` виконайте:

```sql
update public.app_feature_flags
set is_enabled = true, updated_at = now()
where key = 'external_pdf_viewer_v2';
```

6. Відкрийте `http://localhost:5173`.

Міграції `202607300001`–`202608030002` створюють реєстр джерел і provenance,
короткочасні gateway-сесії, додаткові security constraints, окремий rate limit
операційної телеметрії, зашифровану короткочасну авторизацію Google Drive та
безпечне підтвердження fingerprint разом із перевіреними metadata нової версії.

## Ручна перевірка

- Commons `File:` URL відкриває PDF у внутрішньому viewer.
- Wikisource `Index:` відкриває базовий PDF.
- Wikisource `Page:.../25` відкриває фізичну сторінку 25.
- Generic HTTPS PDF без CORS переходить на gateway; `Range` повертає `206`.
- Приватний Google Drive PDF відкривається через opaque gateway URL; Drive
  Bearer не передається у URL, PDF.js або persisted metadata.
- Публічний Google Drive PDF відкривається без OAuth; server API key не
  повертається у браузер і не зберігається у metadata документа.
- Перехід одразу на сторінку 900 не створює сотні canvas.
- При великому zoom або сторінці нестандартного розміру canvas основної сторінки
  та мініатюри не перевищує налаштовані ліміти пікселів і сторони.
- Crop можна перемістити/змінити, створити знахідку і повторно відкрити на тій самій сторінці.
- Експорт `1-5, 8` формує PDF без растеризації; PNG/JPEG та ZIP формуються лише для вибраних сторінок.
- Закриття viewer або скасування операції не продовжує crop/export workflow.
- Вимкнення DB flag або `VITE_EXTERNAL_PDF_VIEWER_V2=false` повертає legacy flow.
- Старий однозначний PDF при першому відкритті редактором проходить resolver і
  ліниво додається до `document_sources`; неперевірена проєкція старого
  вкладення до реєстру не записується.
- Після зміни fingerprint з’являється попередження. Підтвердження нової версії
  атомарно оновлює fingerprint і перевірені metadata/канонічний URL лише у
  джерелі; старі fingerprint/metadata у вже створених знахідках лишаються.

## Production rollout

Етап 7 виконується fail-closed: міграція створює DB flag вимкненим, повторне
застосування міграції не змінює вибір адміністратора, а frontend потребує
одночасно build-time дозволу і DB flag. Перед будь-яким production rollout
запустіть:

```powershell
npm.cmd run verify:pdf-rollout
```

CI додатково перевіряє точний HTTPS origin, повний набір упорядкованих PDF-
міграцій, наявність `ENCRYPTION_KEY` та `GOOGLE_DRIVE_PUBLIC_API_KEY` серед
Supabase Function Secrets, збірку контейнера PDF worker і наявність
`pdf-gateway` після deploy. Значення секретів команда не читає і не виводить.

Перед увімкненням прапорця:

1. У GitHub `Settings → Secrets and variables → Actions → Variables` задайте:

```text
APP_URL=https://your-production-domain.example
ALLOWED_ORIGIN=https://your-production-domain.example
VITE_EXTERNAL_PDF_SOURCE_REVALIDATE_MINUTES=15
VITE_PDF_VIEWER_MAX_CANVAS_PIXELS=16777216
VITE_PDF_VIEWER_MAX_CANVAS_SIDE=8192
```

`APP_URL` та `ALLOWED_ORIGIN` обов’язкові для workflow Edge Functions. Це
навмисний fail-closed захист: production origin не вгадується і не замінюється
на `*`.

Окремо перевірте, що у Supabase Edge Function Secrets уже є чинні
`ENCRYPTION_KEY` і `GOOGLE_DRIVE_PUBLIC_API_KEY`. Не додавайте їх до
frontend/GitHub Pages secrets.

У GitHub `Settings → Secrets and variables → Actions → Secrets` задайте:

```text
PDF_EXPORT_WORKER_URL=https://your-pdf-worker.example
PDF_EXPORT_WORKER_SECRET=<той самий випадковий секрет 32+ символи, що й у worker>
```

Спочатку розгорніть контейнер із `services/pdf-export-worker`, перевірте
`GET /health`, а потім запускайте workflow Supabase. URL і HMAC-секрет
передаються до `pdf-gateway` як server-only secrets. Workflow навмисно
зупиняється, якщо worker не налаштований: у production через нього проходять і
DNS-pinned Range-запити переглядача, і векторний експорт великих PDF.

2. Зробіть backup таблиць `documents`, `document_sources` і
`finding_document_references`. Залиште DB flag вимкненим.

3. Перевірте та застосуйте зміни:

```powershell
npm.cmd exec supabase -- link --project-ref <PROJECT_REF>
npm.cmd exec supabase -- migration list --linked
npm.cmd exec supabase -- db push --linked --dry-run
npm.cmd exec supabase -- db push --linked --yes
npm.cmd exec supabase -- secrets set APP_URL=<APP_URL> ALLOWED_ORIGIN=<ALLOWED_ORIGIN> GOOGLE_DRIVE_PUBLIC_API_KEY=<SERVER_DRIVE_API_KEY> PDF_EXPORT_WORKER_URL=<HTTPS_WORKER_URL> PDF_EXPORT_WORKER_SECRET=<WORKER_SECRET> --project-ref <PROJECT_REF>
npm.cmd exec supabase -- functions deploy pdf-gateway --project-ref <PROJECT_REF>
```

4. Перевірте `pdf-gateway` з дозволеного production origin: auth, metadata
probe, `Range`/`206`, відхилення чужого документа та приватної IP-адреси.

5. Розгорніть frontend і лише після smoke-test увімкніть
`external_pdf_viewer_v2`. Frontend і Supabase workflows запускаються окремо,
тому при змінах PDF-контуру не залишайте DB flag увімкненим між несумісними
деплоями.

Остаточне перемикання після успішного smoke-test:

```sql
update public.app_feature_flags
set is_enabled = true, updated_at = now()
where key = 'external_pdf_viewer_v2';
```

Після перемикання перевірте старий документ без `document_sources`, новий
Wikimedia/generic PDF, приватний Google Drive PDF, `Range: bytes=0-4`, створення
знахідки та експорт. Старий запис має або ліниво пройти resolver і отримати
перевірений source, або залишитися в legacy viewer без запису неперевірених
metadata.

## Операційна телеметрія

Події життєвого циклу зовнішнього PDF надсилаються лише до авторизованого
маршруту `pdf-gateway/client-event`; у GA4 вони не потрапляють. Сервер приймає
точний allowlist полів, перевіряє чинне членство у проєкті та використовує
окремий атомарний rate limit користувача/проєкту. `projectId` потрібен лише для
авторизації та rate limit і вилучається перед структурованим Edge-логом. URL,
назви, ідентифікатори документа/особи/користувача/джерела, токени, заголовки та
довільний текст помилки відхиляються.

Успішні записи `pdf_proxy_request` семплюються за випадковим request ID;
помилки записуються завжди. Збій телеметрії не перериває перегляд, експорт або
створення знахідки.

## Автоматичні перевірки

Перед production `db push` workflow запускає TypeScript typecheck і PDF-набір
unit/integration/contract тестів. Локально виконайте:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run verify:pdf-rollout
npm.cmd test
npm.cmd run test:integration
npm.cmd run test:e2e
npm.cmd run build
npm.cmd run verify:pages
```

Node integration-тести використовують контрольовані fake upstream/gateway і
не звертаються до зовнішньої мережі. Вони не замінюють ручний browser smoke-test
із реальною Supabase Edge Function, RLS та Google OAuth.

Pure unit-тест canvas budget окремо перевіряє обмеження загальної кількості
пікселів, максимальної сторони та безпечне округлення render scale.

## Rollback

Негайний rollback без зміни схеми:

```sql
update public.app_feature_flags
set is_enabled = false, updated_at = now()
where key = 'external_pdf_viewer_v2';
```

Build-time kill switch `VITE_EXTERNAL_PDF_VIEWER_V2=false` потребує повторного frontend deploy. Таблиці provenance не видаляйте під час оперативного rollback — вони additive і не впливають на legacy документи.

## Відомі обмеження

Для малого PDF переглядач копіює вибрані оригінальні сторінки у браузері без
растеризації. Для великого PDF або невідомого розміру `pdf-gateway` передає
збережене й авторизоване джерело до HMAC-захищеного worker. Worker завантажує
оригінал у приватний тимчасовий каталог, `qpdf` копіює вибрані сторінки зі
збереженням векторів і текстового шару, результат одразу stream-иться
користувачу, а каталог гарантовано видаляється у `finally`. Supabase Storage
для цієї операції не використовується. Якщо worker навмисно не налаштований у
локальному середовищі, залишається обмежений растеризований fallback; production
workflow таку конфігурацію не пропускає.

Для приватного Drive access token
отримується browser OAuth, один раз передається Edge Function через TLS,
зберігається лише зашифрованим у короткочасній service-only сесії й ніколи не
повертається PDF.js, не потрапляє в URL, metadata, telemetry або application
logs. Довготривалого refresh-token vault немає: після завершення Google-сесії
користувач підключає Drive повторно.

Автоматичний E2E workflow перевіряє повний клієнтський контракт
resolver → opaque session → Range URL → server export без витоку upstream URL
або OAuth token. Реальний ланцюжок browser → PDF.js → deployed Edge → RLS →
зовнішній провайдер усе одно потребує ручного smoke-test, оскільки тестовий CI
не повинен містити постійний Google OAuth доступ до приватних документів.

Gateway відхиляє loopback, private, link-local і зарезервовані адреси та не
приймає upstream URL від браузера під час перегляду або експорту. У production
фактичне мережеве з’єднання виконує worker: він перевіряє всі DNS-відповіді,
відхиляє змішані public/private набори, прив’язує HTTPS-з’єднання до перевіреної
IP-адреси та повторює цю процедуру для кожного redirect. Авторизовані Google
Drive redirect додатково обмежені точним allowlist хостів.
