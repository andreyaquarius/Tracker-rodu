const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * MyHeritage exports some notes with HTML entities encoded twice and uses
 * LinkURL/LinkName pseudo-elements. The raw GEDCOM record is preserved
 * separately; this function prepares a readable, safe plain-text projection.
 */
export function normalizeGedcomDisplayText(value: string): string {
  let text = value.replace(/@@/g, "@");
  for (let pass = 0; pass < 4; pass += 1) {
    const decoded = decodeHtmlEntitiesOnce(text);
    if (decoded === text) break;
    text = decoded;
  }

  text = text
    .replace(/<\s*br\s*\/?\s*>/giu, "\n")
    .replace(/<\s*\/\s*(?:p|div|li)\s*>/giu, "\n")
    .replace(/<\s*li(?:\s[^>]*)?>/giu, "• ")
    .replace(/<\s*(?:p|div)(?:\s[^>]*)?>/giu, "")
    .replace(/<\s*LinkURL\s*>([\s\S]*?)<\s*\/\s*LinkURL\s*>/giu, "$1")
    .replace(/<\s*LinkName\s*>([\s\S]*?)<\s*\/\s*LinkName\s*>/giu, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/gu, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+\n/g, "\n")
    .replace(/\n[\t\f\v ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

function decodeHtmlEntitiesOnce(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => safeCodePoint(code, 16))
    .replace(/&#(\d+);/gu, (_match, code: string) => safeCodePoint(code, 10))
    .replace(/&([a-z]+);/giu, (match, name: string) => NAMED_ENTITIES[name.toLocaleLowerCase()] ?? match);
}

function safeCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}
