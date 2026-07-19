# Асинхронний експорт GEDCOM

Експорт родового дерева виконується сервером і не залежить від відкритої вкладки браузера.

- дерева до 5 000 осіб обробляє `process-gedcom-exports` у Supabase Edge Functions;
- більші дерева обробляє `.github/workflows/gedcom-exports.yml` у Node.js із лімітом heap 4 GB;
- готовий файл зберігається у приватному bucket `gedcom-exports`;
- користувач отримує email із підписаним посиланням, чинним не довше 7 днів;
- прострочені файли видаляються тим самим плановим worker-ом через Storage API.

## Розгортання

1. Застосувати міграцію `supabase/migrations/202607190001_async_gedcom_exports.sql`.
2. Розгорнути Edge Function `process-gedcom-exports` (наявний workflow розгортання функцій підхоплює її автоматично).
3. У Supabase Edge Function secrets перевірити:
   - `RESEND_API_KEY`;
   - `TASK_REMINDER_CRON_SECRET`;
   - `GEDCOM_EXPORT_EMAIL_FROM` або один із наявних fallback-відправників: `TASK_REMINDER_EMAIL_FROM`, `ANNOUNCEMENT_EMAIL_FROM`, `INVITATION_EMAIL_FROM`, `RESEND_FROM_EMAIL`.
4. У GitHub Actions secrets перевірити:
   - `SUPABASE_PROJECT_REF`;
   - `SUPABASE_SECRET_KEY` — сучасний серверний ключ формату `sb_secret_...`;
   - `TASK_REMINDER_CRON_SECRET` — те саме значення, що й у Supabase.
5. Запустити workflow `Process GEDCOM exports` вручну один раз і переконатися, що він бачить чергу.

У Supabase Dashboard → Storage → Settings глобальний максимальний розмір файлу має бути не меншим за очікуваний GEDCOM. Ліміт bucket `gedcom-exports` дорівнює 512 MiB, але він не може перевищити глобальний ліміт проєкту; синтетичний файл для 50 000 осіб у поточному тесті займає приблизно 26 MiB.

Supabase автоматично надає Edge Functions JSON-змінні `SUPABASE_SECRET_KEYS` і `SUPABASE_PUBLISHABLE_KEYS`; створювати їх повторно у Custom secrets не потрібно. Worker віддає перевагу сучасним ключам, а `SUPABASE_SERVICE_ROLE_KEY` підтримує лише як тимчасовий fallback під час переходу.

`SUPABASE_SECRET_KEY` є серверним секретом: його не можна додавати до Vite-змінних, клієнтського `.env` або логів браузера. Legacy API keys варто вимикати лише після успішного ручного запуску workflow `Process GEDCOM exports` із новим ключем.

## Перевірка

```powershell
node --test test/gedcomExportService.test.ts test/gedcomAsyncMigration.test.ts test/gedcomExportSnapshot.test.ts test/gedcomExportWorker.test.ts test/familyTreeToolsMenuContract.test.ts
node_modules\.bin\supabase.CMD test db supabase/tests/gedcom_async_export_test.sql
$env:RUN_GEDCOM_SCALE_TESTS='1'
node --expose-gc --test test/gedcomExportScale.test.ts
npm.cmd run benchmark:gedcom -- 2480 10000 20000 50000
```

Scale-тест перевіряє формування GEDCOM у пам’яті. Фактичний час читання PostgreSQL, завантаження Storage та доставки email залежить від розміру пов’язаних подій/джерел і мережі.
