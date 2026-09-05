/** Year-resolution evidence, not a guessed lifespan. Approximate dates have no invented bounds. */
export interface ConstellationDate {
  text: string;
  min?: number;
  max?: number;
  reference?: number;
  /** Calendar-order bounds (YYYYMMDD), not timestamps. Missing day/month stays an interval. */
  earliest?: number;
  latest?: number;
  precision: "exact" | "range" | "approximate" | "before" | "after" | "unknown";
  key: string;
}

const unknown = (text: string): ConstellationDate => ({ text, precision: "unknown", key: text.toLowerCase() });
const validYear = (year: number) => Number.isInteger(year) && year >= 1 && year <= 9999;
function exact(text: string): { year: number; key: string; yearOnly: boolean; earliest: number; latest: number } | undefined {
  if (/^\d{4}$/u.test(text) && validYear(Number(text))) return { year: Number(text), key: text, yearOnly: true, earliest: Number(text) * 10000 + 101, latest: Number(text) * 10000 + 1231 };
  let year: number; let month: number; let day = 1; let hasDay = false;
  let match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/u.exec(text);
  if (match) { year = Number(match[1]); month = Number(match[2]); day = Number(match[3] ?? 1); hasDay = !!match[3]; }
  else {
    match = /^(?:(\d{1,2})[./-])?(\d{1,2})[./-](\d{4})$/u.exec(text);
    if (match) { year = Number(match[3]); month = Number(match[2]); day = Number(match[1] ?? 1); hasDay = !!match[1]; }
    else {
      const gedcom = /^(?:(\d{1,2})\s+)?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{4})$/iu.exec(text);
      if (!gedcom) return undefined;
      year = Number(gedcom[3]); month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(gedcom[2]!.toUpperCase()) + 1; day = Number(gedcom[1] ?? 1); hasDay = !!gedcom[1];
    }
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!validYear(year) || month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return undefined;
  return { year, key: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}${hasDay ? `-${String(day).padStart(2, "0")}` : ""}`, yearOnly: false,
    earliest: year * 10000 + month * 100 + day, latest: year * 10000 + month * 100 + (hasDay ? day : days[month - 1]!) };
}

export function parseConstellationDate(value?: string | null): ConstellationDate {
  const text = value?.trim() ?? "";
  if (!text) return unknown("");
  const clean = text.replace(/\s+(?:р\.?|року)$/iu, "").trim();
  const parsed = exact(clean);
  if (parsed) return { text, min: parsed.year, max: parsed.year, reference: parsed.year, earliest: parsed.earliest, latest: parsed.latest, precision: "exact", key: parsed.key };
  const approximate = /^(?:ABT|CAL|EST|ABOUT|CIRCA|близько|приблизно|орієнтовно|бл\.?|~|≈)\s*(.+)$/iu.exec(clean);
  if (approximate) {
    const date = exact(approximate[1]!.trim());
    return date ? { text, reference: date.year, precision: "approximate", key: `~${date.key}` } : unknown(text);
  }
  const qualified = /^(BEF|BEFORE|до|раніше|AFT|AFTER|після|пізніше)\s+(.+)$/iu.exec(clean);
  if (qualified) {
    const date = exact(qualified[2]!.trim());
    if (!date) return unknown(text);
    const before = /^(BEF|BEFORE|до|раніше)$/iu.test(qualified[1]!);
    return { text, ...(before ? { max: date.year - (date.yearOnly ? 1 : 0), latest: date.earliest - 1 } : { min: date.year + (date.yearOnly ? 1 : 0), earliest: date.latest + 1 }),
      reference: date.year, precision: before ? "before" : "after", key: `${before ? "<" : ">"}${date.key}` };
  }
  const range = /^(?:BET\s+(.+)\s+AND\s+(.+)|FROM\s+(.+)\s+TO\s+(.+)|між\s+(.+)\s+(?:і|та)\s+(.+)|(\d{4})\s*[–—-]\s*(\d{4}))$/iu.exec(clean);
  if (range) {
    const parts = range.slice(1).filter(Boolean);
    const from = exact(parts[0]!.trim()); const to = exact(parts[1]!.trim());
    if (from && to && from.earliest <= to.latest) return { text, min: from.year, max: to.year, reference: from.year, earliest: from.earliest, latest: to.latest, precision: "range", key: `${from.key}..${to.key}` };
  }
  return unknown(text);
}

/** Explicit profile bounds are inclusive; a single bound is not an exact birth/death year. */
export function constellationProfileDate(value?: string, from?: string, to?: string, fallback?: string): ConstellationDate {
  if (value?.trim()) return parseConstellationDate(value);
  if (from?.trim() || to?.trim()) {
    const a = from?.trim() ? exact(from.trim()) : undefined;
    const b = to?.trim() ? exact(to.trim()) : undefined;
    const text = from && to ? `${from}–${to}` : from ? `від ${from}` : `до ${to} включно`;
    if ((from?.trim() && !a) || (to?.trim() && !b) || (a && b && a.earliest > b.latest)) return unknown(text);
    return { text, min: a?.year, max: b?.year, earliest: a?.earliest, latest: b?.latest, reference: a?.year ?? b?.year, precision: "range", key: `${a?.key ?? ""}..${b?.key ?? ""}` };
  }
  return parseConstellationDate(fallback);
}

export function constellationDateAtYear(date: ConstellationDate, year: number): "dated" | "possible" | "approximate" | undefined {
  if (date.precision === "unknown") return undefined;
  if (date.precision === "approximate") return date.reference === year ? "approximate" : undefined;
  // An open-ended date cannot locate an event in each of thousands of years.
  if (date.min === undefined || date.max === undefined) return undefined;
  return date.min <= year && year <= date.max ? date.min === date.max ? "dated" : "possible" : undefined;
}
