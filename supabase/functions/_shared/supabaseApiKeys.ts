export type SupabaseApiKeyEnvironment = {
  SUPABASE_SECRET_KEY?: string | null;
  SUPABASE_SECRET_KEYS?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
  SUPABASE_PUBLISHABLE_KEY?: string | null;
  SUPABASE_PUBLISHABLE_KEYS?: string | null;
  SUPABASE_ANON_KEY?: string | null;
};

export function resolveSupabaseSecretKey(environment: SupabaseApiKeyEnvironment): string {
  return firstNonEmpty(
    environment.SUPABASE_SECRET_KEY,
    managedKey(environment.SUPABASE_SECRET_KEYS),
    environment.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export function resolveSupabasePublishableKey(environment: SupabaseApiKeyEnvironment): string {
  return firstNonEmpty(
    environment.SUPABASE_PUBLISHABLE_KEY,
    managedKey(environment.SUPABASE_PUBLISHABLE_KEYS),
    environment.SUPABASE_ANON_KEY,
  );
}

export function supabaseServerKeyHeaders(serverKey: string): Record<string, string> {
  const normalized = serverKey.trim();
  if (!normalized) return {};
  if (isModernSupabaseSecretKey(normalized)) {
    return { apikey: normalized };
  }
  return {
    apikey: normalized,
    Authorization: `Bearer ${normalized}`,
  };
}

export function isModernSupabaseSecretKey(value: string): boolean {
  return value.trim().startsWith("sb_secret_");
}

function managedKey(serialized: string | null | undefined): string {
  const normalized = serialized?.trim() ?? "";
  if (!normalized) return "";
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim()))
      .sort(([left], [right]) => left.localeCompare(right));
    return entries.find(([name]) => name === "default")?.[1].trim()
      ?? entries[0]?.[1].trim()
      ?? "";
  } catch {
    return "";
  }
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = value?.trim() ?? "";
    if (normalized) return normalized;
  }
  return "";
}
