import type {
  PersonContextCooccurrence,
  PersonContextCooccurrenceFilters,
  PersonContextCooccurrencesPage,
  PersonContextCooccurrenceSource,
} from "../../types/contextGraph.ts";

export interface CooccurrenceFilterDraft {
  yearFrom: string;
  yearTo: string;
  minShared: string;
}

export function defaultCooccurrenceFilterDraft(): CooccurrenceFilterDraft {
  return {
    yearFrom: "",
    yearTo: "",
    minShared: "2",
  };
}

export function parseCooccurrenceFilterDraft(
  value: CooccurrenceFilterDraft,
  limit = 20,
): PersonContextCooccurrenceFilters {
  const yearFrom = parseOptionalBoundedInteger(value.yearFrom, 1, 9999, "початковий рік");
  const yearTo = parseOptionalBoundedInteger(value.yearTo, 1, 9999, "кінцевий рік");
  const minShared = parseRequiredBoundedInteger(
    value.minShared,
    1,
    1000,
    "мінімальну кількість спільних джерел",
  );
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
    throw new Error("Початковий рік не може бути пізнішим за кінцевий.");
  }
  return {
    yearFrom,
    yearTo,
    minShared,
    limit: Math.min(100, Math.max(1, Math.round(limit))),
    offset: 0,
  };
}

export function cooccurrencePeriodLabel(
  item: Pick<PersonContextCooccurrence, "firstYear" | "lastYear">,
): string {
  if (item.firstYear && item.lastYear) {
    return item.firstYear === item.lastYear
      ? String(item.firstYear)
      : `${item.firstYear}–${item.lastYear}`;
  }
  if (item.firstYear) return `від ${item.firstYear}`;
  if (item.lastYear) return `до ${item.lastYear}`;
  return "Роки не визначено";
}

export function cooccurrenceStrengthLabel(score: number): string {
  const normalized = Math.max(0, Math.round(score));
  return `${normalized} ${ukrainianPlural(normalized, "бал", "бали", "балів")}`;
}

export function cooccurrenceSharedSourceLabel(count: number): string {
  const normalized = Math.max(0, Math.round(count));
  return `${normalized} ${ukrainianPlural(normalized, "спільне джерело", "спільні джерела", "спільних джерел")}`;
}

export function cooccurrenceSourceKindLabel(
  kind: PersonContextCooccurrenceSource["kind"],
): string {
  if (kind === "finding") return "Знахідка";
  if (kind === "document") return "Документ";
  return "Подія";
}

export function mergeCooccurrencePages(
  current: PersonContextCooccurrencesPage,
  next: PersonContextCooccurrencesPage,
): PersonContextCooccurrencesPage {
  if (current.centerPersonId !== next.centerPersonId) return next;
  const uniqueItems = new Map(current.items.map((item) => [item.personId, item] as const));
  const previousItemCount = uniqueItems.size;
  next.items.forEach((item) => uniqueItems.set(item.personId, item));
  const madeProgress = uniqueItems.size > previousItemCount;
  return {
    ...next,
    items: [...uniqueItems.values()],
    truncated: next.truncated && madeProgress,
  };
}

function parseOptionalBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return parseRequiredBoundedInteger(normalized, minimum, maximum, label);
}

function parseRequiredBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`Вкажіть ${label} цілим числом.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Значення «${label}» має бути від ${minimum} до ${maximum}.`);
  }
  return parsed;
}

function ukrainianPlural(count: number, one: string, few: string, many: string): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (last === 1 && lastTwo !== 11) return one;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
}
