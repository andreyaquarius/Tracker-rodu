# Налаштування ШІ-агента

ШІ-агент працює тільки через Supabase Edge Functions. API-ключі Google AI Studio
не додаються до `.env` застосунку та не публікуються в GitHub.

## 1. Застосувати міграцію

У Supabase відкрийте `SQL Editor`, вставте вміст файла:

`supabase/migrations/202606120007_ai_hypothesis_agent.sql`

Натисніть `Run`. Після успішного виконання мають з’явитися таблиці:

- `user_ai_settings`;
- `ai_hypothesis_reviews`.

## 2. Створити секрет шифрування

Згенеруйте випадковий секрет у PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

У Supabase відкрийте `Edge Functions → Secrets` і додайте:

- Name: `ENCRYPTION_KEY`
- Value: згенерований рядок

Збережіть цей секрет у надійному менеджері паролів. Не додавайте його до GitHub.
Якщо втратити або змінити секрет, раніше збережені API-ключі користувачів
неможливо буде розшифрувати.

## 3. Розгорнути Edge Functions

Потрібно розгорнути:

```text
save-ai-key
test-ai-key
delete-ai-key
review-hypothesis
analyze-table-import
```

Через Supabase CLI:

```powershell
npx supabase login
npx supabase link --project-ref ВАШ_PROJECT_REF
npx supabase functions deploy save-ai-key
npx supabase functions deploy test-ai-key
npx supabase functions deploy delete-ai-key
npx supabase functions deploy review-hypothesis
npx supabase functions deploy analyze-table-import
```

Перевірка JWT для цих функцій має залишатися увімкненою.

## 4. Перевірити роботу

1. Відкрийте `Налаштування → ШІ-агент`.
2. Вставте власний ключ із Google AI Studio.
3. Залиште модель `gemini-3.5-flash`.
4. Натисніть `Зберегти ключ`.
5. Натисніть `Перевірити ключ`.
6. Відкрийте гіпотезу та натисніть `Перевірити з ШІ`.

Після успішного аналізу запис з’явиться в таблиці `ai_hypothesis_reviews`.

## Безпека

- ключ зберігається у PostgreSQL тільки після шифрування AES-GCM;
- розшифрування виконується лише всередині Edge Function;
- frontend отримує тільки останні чотири символи ключа;
- Edge Functions не записують ключ у журнал;
- Gemini отримує лише текстові дані, пов’язані з вибраною гіпотезою;
- файли та скани до Gemini не надсилаються.
