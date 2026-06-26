# Обмеження реєстрації

## Що блокується

- email-адреси з доменом або піддоменом `.ru`;
- запити з country code `RU` або `RUS`, якщо такий код переданий інфраструктурою в HTTP-заголовках.

## Рівні захисту

1. Frontend / client service:
   - перевіряє email перед `auth.signUp()`;
   - викликає Edge Function `registration-guard` для попередньої перевірки email та country headers.

2. Supabase Edge Function `registration-guard`:
   - не зберігає IP;
   - не використовує секрети;
   - читає лише country headers, якщо їх передає CDN / Supabase gateway.

3. Supabase SQL trigger `public.handle_new_user()`:
   - блокує `.ru` email вже на рівні бази;
   - спрацьовує і для email/password, і для OAuth-реєстрацій;
   - не дає створити профіль і trial-доступ для заблокованого email.

## Обмеження геоблокування

Поточний застосунок створює користувача напряму через Supabase Auth. Через це
React-код не має надійного серверного IP/country контексту. Edge Function може
заблокувати країну лише тоді, коли gateway або CDN передає country header.

Для жорсткого блокування користувачів з території РФ до створення auth user
потрібно підключити Supabase Auth Hook або CDN/WAF-правило, яке викликає ту саму
логіку до завершення реєстрації.

## Що треба застосувати вручну

SQL-міграція:

`supabase/migrations/202606260003_block_restricted_registrations.sql`

Edge Function для деплою:

`registration-guard`
