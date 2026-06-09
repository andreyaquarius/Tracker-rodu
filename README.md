# Трекер Роду

**Не губи сліди свого роду**

Трекер Роду — вебзастосунок для ведення генеалогічних, краєзнавчих та інших
історичних досліджень.

Робочий сайт: [https://trekerrodu.com.ua](https://trekerrodu.com.ua)

## Можливості

- дослідження, документи, особи, завдання, знахідки та гіпотези;
- матриця перевірених років і пошук прогалин;
- запити до архівів із прикріпленням запиту та відповіді;
- власні поля у стандартних розділах;
- конструктор окремих розділів для краєзнавчих та інших проєктів;
- глобальний пошук із групуванням результатів;
- зберігання сканів, фотографій, аудіо та документів;
- декілька проєктів в одному обліковому записі;
- запрошення учасників із ролями **власник**, **редактор** і **лише перегляд**;
- живе оновлення спільних даних і захист від конфліктного редагування;
- резервні копії та відновлення проєкту.

## Архітектура

Основне сховище застосунку:

- **Supabase PostgreSQL** — записи, проєкти, учасники та права доступу;
- **Supabase Auth** — вхід через Google або email і пароль;
- **Supabase Storage** — вкладення та резервні копії;
- **Supabase Realtime** — живе оновлення спільних проєктів;
- **Row Level Security** — ізоляція проєктів і перевірка ролей користувачів.

Локальне сховище браузера використовується лише як кеш і для перенесення даних
зі старих версій. Google Drive більше не є основною базою даних; старе
підключення збережене як необов’язковий механізм сумісності та резервування.

## Технології

- React 19;
- TypeScript;
- Vite;
- Supabase;
- Fuse.js;
- GitHub Actions і GitHub Pages.

## Локальний запуск

Потрібні Node.js 22 або новіший і npm.

```bash
npm install
copy .env.example .env
npm run dev
```

Застосунок буде доступний за адресою:

```text
http://localhost:5173
```

Перевірка типів і виробнича збірка:

```bash
npm run lint
npm run build
npm run preview
```

## Змінні середовища

Створіть `.env` на основі `.env.example`:

```env
VITE_GOOGLE_CLIENT_ID=your_google_client_id_here
VITE_GOOGLE_API_KEY=your_google_api_key_here
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key_here
```

У браузері використовується лише публічний ключ Supabase. `service_role` та
інші приватні ключі не можна додавати до `.env`, GitHub або клієнтського коду.

## Supabase

SQL-міграції розташовані в каталозі
[`supabase/migrations`](supabase/migrations):

1. `202606090001_initial_schema.sql` — таблиці, ролі, запрошення та RLS;
2. `202606090002_storage.sql` — приватне сховище вкладень;
3. `202606090003_project_backups.sql` — резервні копії проєктів;
4. `202606090004_realtime.sql` — Realtime для спільної роботи.

Додаткові налаштування:

- у **Authentication → Providers** увімкніть Google та Email;
- у **Authentication → URL Configuration** додайте:
  - `https://trekerrodu.com.ua`;
  - `http://localhost:5173/`;
- для реєстрації через email налаштуйте підтвердження пошти;
- для вкладень і резервних копій застосуйте Storage-міграції.

Докладніше: [`supabase/README.md`](supabase/README.md).

## Google OAuth

У Google Cloud OAuth Client ID додайте дозволені JavaScript origins:

```text
http://localhost:5173
https://trekerrodu.com.ua
https://www.trekerrodu.com.ua
```

Redirect URI для входу через Supabase:

```text
https://YOUR_PROJECT.supabase.co/auth/v1/callback
```

Google OAuth використовується для входу до облікового запису. Доступ до Google
Drive, якщо він потрібен для сумісності зі старими резервними копіями,
підключається окремо всередині застосунку.

## Поштові запрошення

Edge Function
[`send-project-invitation`](supabase/functions/send-project-invitation/index.ts)
надсилає листи через Resend.

Для неї потрібні секрети Supabase:

```text
RESEND_API_KEY
INVITATION_EMAIL_FROM
APP_URL=https://trekerrodu.com.ua/
```

Відправник `INVITATION_EMAIL_FROM` повинен використовувати підтверджений у
Resend домен.

## Публікація

Сайт автоматично збирається та публікується через
[`deploy.yml`](.github/workflows/deploy.yml) після push до гілки `main`.

У GitHub Actions потрібно створити секрети:

```text
VITE_GOOGLE_CLIENT_ID
VITE_GOOGLE_API_KEY
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

GitHub Pages використовує власний домен із файлу [`public/CNAME`](public/CNAME):

```text
trekerrodu.com.ua
```

Для основного домену потрібні чотири `A`-записи GitHub Pages, а для `www` —
`CNAME` на `andreyaquarius.github.io`.

## Безпека даних

- кожен запис належить конкретному проєкту;
- доступ перевіряється політиками Supabase RLS;
- глядачі не можуть змінювати дані;
- редактори працюють із записами, але не змінюють структуру проєкту;
- лише власник керує учасниками, полями, власними розділами та проєктом;
- вкладення зберігаються у приватних контейнерах Supabase Storage;
- конфліктне збереження застарілої версії запису блокується.

## Ліцензія

Проєкт наразі не має окремо визначеної відкритої ліцензії.
