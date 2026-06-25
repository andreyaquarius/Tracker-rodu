# GeneHelp integration

Інтеграція GeneHelp працює через Supabase Edge Function `genehelp`.
Користувач не вводить і не бачить партнерський або інтеграційний токен.

## Як працює

1. Користувач натискає `Попросити допомоги в GeneHelp` у лівому меню.
2. Трекер Роду відкриває вікно з назвою та описом запиту.
3. Edge Function `genehelp` перевіряє авторизованого користувача.
4. Якщо для цього користувача ще немає GeneHelp integration token, функція
   реєструє або підключає його в GeneHelp через partner onboarding endpoint.
5. Отриманий `integration_token` шифрується через `ENCRYPTION_KEY` і
   зберігається в `user_genehelp_accounts`.
6. Запит про допомогу створюється в GeneHelp уже від імені конкретного
   користувача GeneHelp.

## Що потрібно налаштувати в Supabase

1. Застосувати SQL-міграцію:

   `supabase/migrations/202606250001_genehelp_onboarding.sql`

2. Переконатися, що в Supabase secrets є:

   `ENCRYPTION_KEY`

3. Додати partner token GeneHelp як Supabase secret. Функція читає ці назви:

   `PLAIN PARTNER TOKEN`

   або, якщо Supabase не приймає назву з пробілами:

   `PLAIN_PARTNER_TOKEN`

4. Розгорнути Edge Function:

   `genehelp`

У цьому репозиторії Edge Functions деплояться через GitHub Actions з
`.github/workflows/deploy-supabase-functions.yml`, якщо зміни потрапляють у
`main`.
