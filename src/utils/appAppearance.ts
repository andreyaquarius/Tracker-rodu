export type AppTheme = "standard" | "starry-dark";
export interface AppAppearance { theme: AppTheme; skyMotion: boolean }
export const DEFAULT_APP_APPEARANCE: Readonly<AppAppearance> = { theme: "standard", skyMotion: true };
export const APP_APPEARANCE_KEY = "tracker-rodu:appearance:v1:";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** Personal, not project-wide. Never read credentials or put settings in shared project JSON. */
export function appAppearanceKey(accountId: string | null): string {
  return APP_APPEARANCE_KEY + (accountId ? `account:${encodeURIComponent(accountId)}` : "guest");
}
export function normalizeAppAppearance(value: unknown): AppAppearance {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { theme: source.theme === "starry-dark" ? "starry-dark" : "standard",
    skyMotion: typeof source.skyMotion === "boolean" ? source.skyMotion : true };
}
export function parseAppAppearance(value: string | null): AppAppearance {
  try { return normalizeAppAppearance(value ? JSON.parse(value) : null); }
  catch { return { ...DEFAULT_APP_APPEARANCE }; }
}
export function appearanceStorage(): PreferenceStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}
export function readAppAppearance(accountId: string | null, storage = appearanceStorage()): AppAppearance {
  try { return parseAppAppearance(storage?.getItem(appAppearanceKey(accountId)) ?? null); }
  catch { return { ...DEFAULT_APP_APPEARANCE }; }
}
export function writeAppAppearance(accountId: string | null, value: AppAppearance, storage = appearanceStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(appAppearanceKey(accountId), JSON.stringify(normalizeAppAppearance(value)));
    return true;
  } catch { return false; }
}
