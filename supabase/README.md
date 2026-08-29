# Supabase

## External PDF gateway and worker

`pdf-gateway` does not persist original external PDFs in Supabase Storage. In
production, DNS-pinned Range streaming and vector export of large page subsets
require the `services/pdf-export-worker` container with `qpdf`.

Configure the worker with at least:

```text
PDF_EXPORT_WORKER_SECRET=<random 32+ character secret>
PDF_EXPORT_MAX_SOURCE_BYTES=2147483648
PDF_EXPORT_MAX_PAGES=250
PDF_EXPORT_MAX_CONCURRENT=2
PDF_STREAM_MAX_CONCURRENT=32
PDF_STREAM_MAX_RESPONSE_BYTES=33554432
```

Configure the same secret and the clean HTTPS worker URL as Supabase Function
Secrets:

```text
PDF_EXPORT_WORKER_URL=https://your-pdf-worker.example
PDF_EXPORT_WORKER_SECRET=<the same 32+ character secret>
```

The worker accepts only short-lived HMAC-signed requests from the Edge
Function, validates every DNS result, and pins the HTTPS connection to the
validated public IP for every redirect. Temporary files exist only for the
`qpdf` export inside a private `/tmp` directory and are deleted on success,
failure, or client disconnect. Range viewing does not create temporary files.

Цей каталог містить схему основного серверного сховища Трекера Роду,
налаштування Supabase Storage, Realtime та Edge Functions.

## Міграції

1. `202606090001_initial_schema.sql` — профілі, проєкти, ролі, запрошення, основні та кастомні записи, політики доступу.
2. `202606090002_storage.sql` — приватне файлове сховище та правила доступу до файлів.
3. `202606090003_project_backups.sql` — резервні копії проєктів у Supabase Storage.
4. `202606090004_realtime.sql` — живе оновлення спільних проєктів.
5. `202606100005_section_hierarchy.sql` — багаторівневі розділи та індекс їхньої навігації.
6. `202606110006_security_hardening.sql` — фіксований `search_path` і права виконання службових функцій.
7. `202606120007_ai_hypothesis_agent.sql` — зашифровані налаштування ШІ та історія перевірок гіпотез.

Наведений вище список описує базові міграції, але не є повним реєстром. Під час
розгортання потрібно застосовувати **всі** файли з `supabase/migrations` у
порядку timestamp у назві. Перед повторним запуском або зміною схеми створіть
резервну копію.

## Важливо

- У клієнтському застосунку використовується лише публічний `anon` ключ.
- `service_role` ключ та інші приватні секрети не мають потрапляти до Git або браузера.
- Перед імпортом старих даних потрібна резервна копія.
- Після зміни SQL перевіряйте RLS-політики та доступ для ролей власника,
  редактора і глядача.

## Поштові запрошення

Функція `functions/send-project-invitation` надсилає листи через Resend. Для неї
потрібно встановити секрети:

- `RESEND_API_KEY` — API-ключ Resend;
- `INVITATION_EMAIL_FROM` — підтверджений відправник, наприклад
  `Трекер Роду <invite@example.com>`;
- `APP_URL` — повна адреса застосунку з кінцевим `/`.

Після встановлення секретів розгорніть Edge Function
`send-project-invitation`. Секрети зберігаються лише в Supabase і не повинні
додаватися до `.env` клієнтського застосунку.

## ШІ-агент перевірки гіпотез

Після застосування міграції `202606120007_ai_hypothesis_agent.sql` створіть
серверний секрет:

- `ENCRYPTION_KEY` — випадковий довгий секрет щонайменше з 32 символів.
- `GOOGLE_DRIVE_PUBLIC_API_KEY` — окремий server-side ключ Google Drive API
  для PDF, відкритих за публічним share-посиланням; не використовувати
  browser Picker key із HTTP-referrer обмеженням.
- `GEMINI_API_KEY` — ваш серверний Google Gemini API-ключ для включених
  аналізів на тарифах `free`, `researcher` і `professional`.
  Серверний ключ використовує фіксовану модель `gemini-3.5-flash`.

Розгорніть Edge Functions:

- `save-ai-key`;
- `test-ai-key`;
- `delete-ai-key`;
- `review-hypothesis`.

На тарифах `free`, `researcher` і `professional` серверний `GEMINI_API_KEY`
використовується в межах включеного місячного пулу 5, 50 і 100 ШІ-кредитів
відповідно. Для дії в проєкті кредит списується з пулу власника проєкту, а
редактор записується в аудиті як виконавець. Кожна підтримана AI-дія атомарно
резервує один тарифний кредит до звернення до Gemini незалежно від того,
використовується серверний чи власний API-ключ. Власний ключ не додає кредитів
і не дозволяє продовжити роботу після вичерпання місячного пулу.

`ENCRYPTION_KEY` не можна змінювати після збереження користувацьких API-ключів:
після зміни старі ключі неможливо буде розшифрувати. Ключі Google AI Studio
ніколи не додаються до `.env` Vite, GitHub або коду застосунку.

Повна покрокова інструкція: `docs/AI_AGENT_SETUP.md`.

## Тарифи й 30-денний trial

Міграція `202606190015_trial_access.sql` створює тарифні плани, підписки,
періодичне використання та аудит. Актуальні генеалогічні місткості додає
`202607200001_tree_centered_subscription_limits.sql`. Новий Auth-користувач
атомарно отримує 30 днів можливостей `professional`, але trial має кінцевий
ліміт 15 000 осіб, 5 редакторів і 100 ШІ-кредитів. Після завершення ефективним
стає `free`; дані, проєкти та членства не видаляються, а перевищення ліміту
блокує лише створення нових сутностей. Старі користувачі автоматично отримують
`free`, а не новий trial.

Родове дерево і новий модуль «Особи» входять до всіх активних тарифів. Детальні
правила підрахунку осіб, дерев, редакторів та GEDCOM-reservation описані у
`docs/TREE_CENTERED_TARIFFS.md`.

Лічильники `persons` і `family_trees` підтримують statement-level тригери
`AFTER INSERT/UPDATE/DELETE` з transition tables та блокуванням рядка лічильника
власника. Для GEDCOM сервер спочатку атомарно перевіряє й резервує місткість, а
вже потім дозволяє пакетне збереження; окремого row-level `BEFORE INSERT`
quota-тригера немає.

Перед тестуванням додайте свій профіль до серверного списку адміністраторів:

```sql
insert into public.app_admins (user_id)
select user_id from public.profiles
where lower(email) = lower('admin@example.com')
on conflict (user_id) do nothing;
```

Після цього тарифи можна призначати на сторінці `/settings/subscription`.
До підключення платіжного провайдера платні ціни залишаються `NULL`, а зміни
підписок доступні лише адміністратору через захищені RPC.
