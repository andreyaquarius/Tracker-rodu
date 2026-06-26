# GeneHelp integration

Інтеграція GeneHelp працює через Supabase Edge Function `genehelp`.
Користувач не вводить і не бачить партнерський або інтеграційний токен.

## Як працює

1. Користувач натискає `Попросити допомоги в GeneHelp` у лівому меню.
2. Трекер Роду відкриває вікно з назвою та описом запиту.
3. Якщо користувач ще не підключений до GeneHelp, застосунок показує окремий
   екран згоди на передачу email та імені.
4. Edge Function `genehelp` перевіряє авторизованого користувача і не запускає
   onboarding без явного прапорця згоди.
5. Якщо для цього користувача ще немає GeneHelp integration token, функція
   реєструє або підключає його в GeneHelp через partner onboarding endpoint.
6. Отриманий `integration_token` шифрується через `ENCRYPTION_KEY` і
   зберігається в `user_genehelp_accounts`.
7. Запит про допомогу створюється в GeneHelp уже від імені конкретного
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

## Історія надісланих запитів

Вікно GeneHelp має вкладку `Надіслані запити`. Вона показує локальну історію
запитів поточного користувача, які були створені через Трекер Роду.

Для цього потрібно застосувати додаткову SQL-міграцію:

`supabase/migrations/202606260001_genehelp_request_history.sql`

У таблиці зберігається тільки службова прив'язка до GeneHelp: id запиту,
назва, опис, статус, посилання та остання відповідь API. Самі роботи GeneHelp
виконуються й зберігаються на стороні GeneHelp.

## Тимчасове вмикання для користувачів

Кнопка `Попросити допомоги в GeneHelp` завжди видима адміністратору. Для інших
користувачів вона прихована, доки адміністратор не увімкне перемикач
`GeneHelp для всіх користувачів` у розділі `Тариф і підписка`.

Для адмінських перемикачів потрібно застосувати міграцію:

`supabase/migrations/202606260002_app_feature_flags.sql`

## Тестовий режим запитів

Поки інтеграція тестується, Edge Function надсилає запити в GeneHelp з
`meta.is_test = true`. Такі запити проходять через GeneHelp, але позначаються як
тестові на їхньому боці.

Перемикач знаходиться в `supabase/functions/genehelp/index.ts`:

`geneHelpRequestTestMode`
