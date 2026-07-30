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
```
3. У PowerShell виконайте:

```powershell
npm.cmd exec supabase -- start
npm.cmd exec supabase -- migration up --local
npm.cmd exec supabase -- functions serve pdf-gateway --env-file .env.functions.local
npm.cmd run dev
```

Не додавайте `--no-verify-jwt`: локальний тест має відповідати production auth.

4. У Supabase Studio `http://127.0.0.1:54323` виконайте:

```sql
update public.app_feature_flags
set is_enabled = true, updated_at = now()
where key = 'external_pdf_viewer_v2';
```

5. Відкрийте `http://localhost:5173`.

Міграції `202607300001`–`202607300007` створюють реєстр джерел і provenance,
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

Окремо перевірте, що у Supabase Edge Function Secrets уже є чинний
`ENCRYPTION_KEY`. Не додавайте його до frontend/GitHub Pages secrets.

2. Зробіть backup таблиць `documents`, `document_sources` і
`finding_document_references`. Залиште DB flag вимкненим.

3. Перевірте та застосуйте зміни:

```powershell
npm.cmd exec supabase -- link --project-ref <PROJECT_REF>
npm.cmd exec supabase -- migration list --linked
npm.cmd exec supabase -- db push --linked --dry-run
npm.cmd exec supabase -- db push --linked --yes
npm.cmd exec supabase -- secrets set APP_URL=<APP_URL> ALLOWED_ORIGIN=<ALLOWED_ORIGIN> --project-ref <PROJECT_REF>
npm.cmd exec supabase -- functions deploy pdf-gateway --project-ref <PROJECT_REF>
```

4. Перевірте `pdf-gateway` з дозволеного production origin: auth, metadata
probe, `Range`/`206`, відхилення чужого документа та приватної IP-адреси.

5. Розгорніть frontend і лише після smoke-test увімкніть
`external_pdf_viewer_v2`. Frontend і Supabase workflows запускаються окремо,
тому при змінах PDF-контуру не залишайте DB flag увімкненим між несумісними
деплоями.

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
npm.cmd test
npm.cmd run test:integration
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

Поточна production-safe стратегія експорту є клієнтською і має жорсткі ліміти розміру, сторінок, пікселів та пам’яті. Для великого PDF або невідомого розміру операція відхиляється до виклику `PDFDocumentProxy.getData()`. Server streaming/ephemeral export потребує окремого runtime з надійним PDF-інструментом і не повинен імітуватися через повне завантаження великого PDF в пам’ять Edge Function.

Публічне Google Drive share-посилання зараз проходить через чинний
OAuth-backed Drive adapter: користувач має підключити Google Drive. Окремий
anonymous public-share режим не реалізований. Для приватного Drive access token
отримується browser OAuth, один раз передається Edge Function через TLS,
зберігається лише зашифрованим у короткочасній service-only сесії й ніколи не
повертається PDF.js, не потрапляє в URL, metadata, telemetry або application
logs. Довготривалого refresh-token vault немає: після завершення Google-сесії
користувач підключає Drive повторно.

У репозиторії немає browser E2E harness для PDF. Наявні unit, security,
integration та contract тести не є доказом повного сценарію
UI → PDF.js → deployed Edge → RLS. Перед увімкненням прапорця потрібен ручний
smoke-test за матрицею вище.

Gateway відхиляє loopback, private, link-local і зарезервовані адреси, повторює
перевірку DNS для кожного redirect та після відповіді upstream. Водночас Deno
`fetch` не надає API, яке прив'язує перевірену DNS-відповідь до фактичного
мережевого з'єднання. Для середовища з підвищеними вимогами до захисту від DNS
rebinding направляйте вихідний трафік `pdf-gateway` через egress proxy з DNS
pinning або обмежте його allowlist-ом довірених провайдерів. Не вимикайте наявні
SSRF-перевірки як спосіб обходу цього обмеження.
