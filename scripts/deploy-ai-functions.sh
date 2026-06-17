#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-ppiymmsurabwxnzpdasl}"
FUNCTIONS=(
  save-ai-key
  test-ai-key
  delete-ai-key
  review-hypothesis
  analyze-table-import
)

if ! command -v supabase >/dev/null 2>&1; then
  cat >&2 <<'MESSAGE'
Supabase CLI не знайдено.
Встановіть CLI локально або запустіть через середовище, де доступна команда `supabase`:
https://supabase.com/docs/guides/local-development/cli/getting-started
MESSAGE
  exit 127
fi

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "SUPABASE_ACCESS_TOKEN не задано. Якщо CLI ще не авторизований, виконайте: supabase login" >&2
fi

supabase link --project-ref "$PROJECT_REF"

for function_name in "${FUNCTIONS[@]}"; do
  echo "Deploying Edge Function: ${function_name}"
  supabase functions deploy "$function_name"
done

echo "Готово. Перевірте Supabase Dashboard → Edge Functions і секрети ENCRYPTION_KEY / APP_URL / ALLOWED_ORIGIN."
