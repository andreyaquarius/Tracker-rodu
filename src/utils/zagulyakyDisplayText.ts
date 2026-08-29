/**
 * Removes internal import instructions before values reach public/private UI.
 *
 * These markers were never historical data. They instructed an old table
 * importer where to derive a place, and a few legacy rows persisted them as
 * ordinary strings.
 */
export function zagulyakyDisplayText(input: unknown): string {
  const result = typeof input === "string" ? input.trim() : String(input ?? "").trim();
  if (!result) return "";

  // Normalising separators also catches old camel/snake/kebab variants while
  // remaining deliberately narrow enough not to hide genuine source wording.
  const technicalKey = result.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
  return technicalKey === "foundplacefromtabletitle" ? "" : result;
}
