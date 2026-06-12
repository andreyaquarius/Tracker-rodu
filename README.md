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
- кілька проєктів в одному обліковому записі;
- спільна робота з ролями власника, редактора і переглядача;
- резервні копії та відновлення проєкту.

## Архітектура

Єдиним постійним сховищем застосунку є Supabase:

- **PostgreSQL** — проєкти, записи, зв'язки, налаштування та права доступу;
- **Supabase Auth** — вхід через Google або email і пароль;
- **Google Drive користувача** — прикріплені скани, аудіо та документи;
- **Supabase Storage** — резервні копії проєктів;
- **Supabase Realtime** — оновлення спільних проєктів;
- **Row Level Security** — ізоляція проєктів і перевірка ролей.

Кеш у браузері використовується лише для швидшого відображення вже отриманих
даних. Він не є окремою базою та не є джерелом істини.

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

Перевірка:

```bash
npm run lint
npm run build
npm run preview
```

## Змінні середовища

Створіть `.env` на основі `.env.example`:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key_here
VITE_GOOGLE_CLIENT_ID=your_google_oauth_client_id.apps.googleusercontent.com
```

У клієнтському коді використовується лише публічний ключ Supabase. Ключ
`service_role` не можна додавати до `.env`, GitHub або браузерного коду.

## Supabase

SQL-схема розташована в каталозі [`supabase/migrations`](supabase/migrations).
Міграції створюють таблиці, RLS-політики, приватні контейнери вкладень і
резервних копій та Realtime-публікації.

У Supabase потрібно:

- увімкнути Google та Email у **Authentication → Providers**;
- додати `https://trekerrodu.com.ua` і `http://localhost:5173/` у
  **Authentication → URL Configuration**;
- застосувати всі SQL-міграції;
- розгорнути Edge Function для поштових запрошень.

Докладніше: [`supabase/README.md`](supabase/README.md).

## Google OAuth

Google використовується для входу через Supabase Auth і для зберігання вкладень
на особистому Google Drive користувача. Застосунок запитує обмежене право
`drive.file` і працює лише з папками та файлами, які створив сам.

У Google Cloud потрібно увімкнути **Google Drive API**.

У Google Cloud OAuth Client додайте дозволені origins:

```text
http://localhost:5173
https://trekerrodu.com.ua
https://www.trekerrodu.com.ua
```

Redirect URI:

```text
https://YOUR_PROJECT.supabase.co/auth/v1/callback
```

## Поштові запрошення

Edge Function
[`send-project-invitation`](supabase/functions/send-project-invitation/index.ts)
надсилає листи через Resend.

Потрібні секрети Supabase:

```text
RESEND_API_KEY
INVITATION_EMAIL_FROM
APP_URL=https://trekerrodu.com.ua/
```

## Публікація

GitHub Actions збирає та публікує сайт після push до `main`.

У GitHub Actions потрібні секрети:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
VITE_GOOGLE_CLIENT_ID
```

Власний домен задається у [`public/CNAME`](public/CNAME).

## Безпека

- кожен запис належить конкретному проєкту;
- доступ перевіряють політики Supabase RLS;
- переглядачі не можуть змінювати дані;
- редактори працюють із записами та файлами;
- лише власник керує учасниками і структурою проєкту;
- вкладення зберігаються у папці активного проєкту на Google Drive користувача;
- конфліктне збереження застарілої версії запису блокується.
