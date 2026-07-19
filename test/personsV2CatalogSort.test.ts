import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const catalog = readFileSync(
  new URL("../src/features/persons-v2/PersonsCatalogV2.tsx", import.meta.url),
  "utf8",
);

test("persons V2 catalogue defaults to central-person family order", () => {
  assert.match(
    catalog,
    /useState<PersonsCatalogSortV2>\("family"\)/,
  );
  assert.match(
    catalog,
    /familyOrderStatus === "ready"[\s\S]*?"Від центральної особи"/,
  );
  assert.match(
    catalog,
    /case "family": return \{ sortBy: "family", sortDirection: "asc" \}/,
  );
});

test("persons V2 catalogue names the real fallback when pedigree data is unavailable", () => {
  assert.match(catalog, /familyOrderStatus\?: PersonsCatalogFamilyOrderStatusV2/);
  assert.match(catalog, /"Від центральної особи \(завантаження…\)"/);
  assert.match(catalog, /"Ім’я: А–Я \(дерево недоступне\)"/);
});

test("persons V2 catalogue forwards family rank data and reacts when it changes", () => {
  assert.match(catalog, /familyOrder\?: ReadonlyMap<string, number>/);
  assert.match(catalog, /familyOrder,\s*\.\.\.catalogSortOptionsV2\(sort\)/s);
  assert.match(catalog, /\[directIds, familyOrder, filters, persons, segment, sort\]/);
  assert.match(catalog, /\[familyOrder, filters, pageSize, segment, sort\]/);
});
