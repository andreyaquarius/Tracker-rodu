export interface GedcomArchiveReference {
  archive: string;
  fund: string;
  inventory: string;
  file: string;
  page: string;
  actRecord: string;
  originalText: string;
}

type ReferencePart = {
  value: string;
  markerIndex: number;
};

const IDENTIFIER_VALUE = String.raw`(?:[РP]\s*[-–—]?\s*)?\d+(?:\s*\/\s*\d+)*(?:[A-Za-zА-Яа-яІіЇїЄєҐґ])?|б\s*\/\s*н|без\s+номера`;
const PAGE_VALUE = String.raw`\d+(?:\s*(?:зв(?:\.|орот)?|зворот|об(?:\.|орот)?))?(?:\s*[-–—]\s*\d+(?:\s*(?:зв(?:\.|орот)?|зворот|об(?:\.|орот)?))?)?`;

const FUND_MARKERS = String.raw`фонд(?:у)?|ф\.?|fond|f\.?`;
const INVENTORY_MARKERS = String.raw`опис(?:у)?|опись|оп\.?|о\.?|opis|op\.?`;
const FILE_MARKERS = String.raw`справа|справи|спр\.?|с\.?|дело|дела|д\.?|spr\.?|case`;
const PAGE_MARKERS = String.raw`сторінка|сторінки|стор\.?|ст\.?|аркуш|аркуші|акруш|арк\.?|страница|страницы|стр\.?|лист|листе|л\.?|page`;
const ACT_MARKERS = String.raw`актов(?:ий|ого)\s+запис|актовая\s+запись|акт\.?\s*запис|акт|запис|запись|record`;

/**
 * Extracts the first archival cipher found in a Ukrainian, Russian or common
 * transliterated GEDCOM note. The original text is returned unchanged so the
 * caller can preserve it alongside the structured finding fields.
 */
export function parseGedcomArchiveReference(text: string): GedcomArchiveReference | null {
  const originalText = text;
  if (!text.trim()) return null;

  const fund = findReferencePart(text, FUND_MARKERS, IDENTIFIER_VALUE);
  const inventory = findReferencePart(text, INVENTORY_MARKERS, IDENTIFIER_VALUE);
  const file = findReferencePart(text, FILE_MARKERS, IDENTIFIER_VALUE);
  const page = findReferencePart(text, PAGE_MARKERS, PAGE_VALUE);
  const actRecord = findReferencePart(text, ACT_MARKERS, IDENTIFIER_VALUE);
  const parts = [fund, inventory, file, page, actRecord]
    .filter((part): part is ReferencePart => Boolean(part));
  if (!parts.length) return null;

  const firstMarkerIndex = Math.min(...parts.map((part) => part.markerIndex));
  return {
    archive: findArchiveName(text, firstMarkerIndex),
    fund: fund?.value ?? "",
    inventory: inventory?.value ?? "",
    file: file?.value ?? "",
    page: page?.value ?? "",
    actRecord: actRecord?.value ?? "",
    originalText,
  };
}

function findReferencePart(text: string, markers: string, valuePattern: string): ReferencePart | null {
  const pattern = new RegExp(
    String.raw`(^|[\s,;:().])(?:${markers})\s*(?::\s*)?(?:[№#]\s*)?(${valuePattern})`,
    "iu",
  );
  const match = pattern.exec(text);
  if (!match) return null;
  return {
    value: normalizeReferenceValue(match[2]),
    markerIndex: (match.index ?? 0) + match[1].length,
  };
}

function normalizeReferenceValue(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s*([/–—-])\s*/g, "$1")
    .trim();
}

function findArchiveName(text: string, firstMarkerIndex: number): string {
  const prefix = text.slice(0, firstMarkerIndex).replace(/[\s,;:.()\-–—]+$/u, "");
  if (!prefix.trim()) return "";

  const expandedStartPattern = /(?:центральн\p{L}*|державн\p{L}*|обласн\p{L}*|государственн\p{L}*|федеральн\p{L}*)/giu;
  const expandedStarts = [...prefix.matchAll(expandedStartPattern)];
  for (let index = expandedStarts.length - 1; index >= 0; index -= 1) {
    const start = expandedStarts[index].index ?? 0;
    const candidate = trimArchiveName(prefix.slice(start));
    if (/(?:архів\p{L}*|архив\p{L}*)/iu.test(candidate) && candidate.length <= 180) {
      return candidate;
    }
  }

  const explicit = /(?:^|[\s,;])(?:архів|архив|archive)\s*[:\-–—]?\s*([^;\n]{2,100})$/iu.exec(prefix);
  if (explicit) return trimArchiveName(explicit[1]);

  const tokens = [...prefix.matchAll(/[\p{L}]{2,24}/gu)].map((match) => ({
    value: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  let lastIndex = tokens.length - 1;
  while (lastIndex >= 0 && !looksLikeArchiveAcronym(tokens[lastIndex].value)) lastIndex -= 1;
  if (lastIndex < 0) return "";

  let firstIndex = lastIndex;
  while (firstIndex > 0) {
    const previous = tokens[firstIndex - 1];
    const current = tokens[firstIndex];
    const gap = prefix.slice(previous.end, current.start);
    if (!looksLikeArchiveAcronym(previous.value) || !/^[\s,()\-–—]*$/u.test(gap)) break;
    firstIndex -= 1;
  }
  return trimArchiveName(prefix.slice(tokens[firstIndex].start, tokens[lastIndex].end));
}

function looksLikeArchiveAcronym(value: string): boolean {
  const letters = [...value].filter((character) => /\p{L}/u.test(character));
  if (letters.length < 2) return false;
  const uppercaseCount = letters.filter((character) =>
    character === character.toLocaleUpperCase("uk-UA")
      && character !== character.toLocaleLowerCase("uk-UA"),
  ).length;
  return uppercaseCount >= 2 && uppercaseCount / letters.length >= 0.5;
}

function trimArchiveName(value: string): string {
  return value.replace(/^[\s,;:.()\-–—]+|[\s,;:.()\-–—]+$/gu, "").replace(/\s+/g, " ").trim();
}
