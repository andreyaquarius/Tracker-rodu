import type { YearMatrixRecord } from "../types";

const problematic = new Set(["не перевірено", "прогалина", "недоступно"]);

export function analyzeYearGaps(
  records: YearMatrixRecord[],
  from: number,
  to: number,
  documentType: string,
): number[] {
  const years = new Map(
    records
      .filter((item) => !documentType || item.documentType === documentType)
      .map((item) => [Number(item.year), item.status]),
  );
  const gaps: number[] = [];
  for (let year = from; year <= to; year += 1) {
    const status = years.get(year);
    if (!status || problematic.has(status)) gaps.push(year);
  }
  return gaps;
}
