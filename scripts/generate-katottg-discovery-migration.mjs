import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const SOURCE_PAGE_URL = "https://mininfra.gov.ua/diialnist/rozvytok-mistsevoho-samovriaduvannia/kodyfikator-administratyvno-terytorialnykh-odynyts-ta-terytorii-terytorialnykh-hromad";
const SOURCE_URL = "https://mininfra.gov.ua/storage/app/sites/1/uploaded-files/kodifikator-07-07.xlsx";
const DATASET_VERSION = "2026-07-07";
const ORDER_NUMBER = "1321";
const EXPECTED_SHA256 = "5C5317759B2B90208E9B00338BC3DB3C5E694272A166ACF73F1543B3E18ECBEA";
const EXPECTED_CONTENT_LENGTH = 1_488_861;
const RETRIEVED_AT = "2026-08-29T00:00:00Z";
const DATASET_KEY = `katottg:${DATASET_VERSION}`;
const GENERATED_BEGIN = "-- BEGIN GENERATED KATOTTG 2026-07-07 SETTLEMENT SEED";
const GENERATED_END = "-- END GENERATED KATOTTG 2026-07-07 SETTLEMENT SEED";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const defaultSchemaMigrationPath = path.join(
  repositoryRoot,
  "supabase",
  "migrations",
  "202608290011_historical_place_discovery.sql",
);
const defaultSeedMigrationPath = path.join(
  repositoryRoot,
  "supabase",
  "migrations",
  "202608290012_katottg_2026_07_07_seed.sql",
);

function cliValue(name) {
  const position = process.argv.indexOf(name);
  if (position < 0) return null;
  const value = process.argv[position + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xmlAttribute(fragment, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = fragment.match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const values = [];
  for (const sharedItem of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const textNode of sharedItem[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      text += decodeXml(textNode[1]);
    }
    values.push(text);
  }
  return values;
}

function columnIndex(cellReference) {
  const letters = String(cellReference ?? "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function parseWorksheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(xmlAttribute(rowMatch[1], "r")) || rows.length + 1;
    const values = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2] ?? "";
      const index = columnIndex(xmlAttribute(attributes, "r"));
      const type = xmlAttribute(attributes, "t");
      const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      let value;
      if (type === "s") {
        value = sharedStrings[Number(rawValue)] ?? "";
      } else if (type === "inlineStr") {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((entry) => decodeXml(entry[1]))
          .join("");
      } else {
        value = decodeXml(rawValue);
      }
      values[index] = value;
    }
    rows.push({ rowNumber, values });
  }
  return rows;
}

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[’`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategory(value) {
  const category = String(value ?? "").normalize("NFKC").trim().toUpperCase();
  return ({ М: "M", Т: "T", С: "C", Х: "X" })[category] ?? category;
}

function sqlText(value) {
  if (value == null || value === "") return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlText(JSON.stringify(value))}::jsonb`;
}

async function loadWorkbookBytes() {
  const localXlsx = cliValue("--xlsx");
  if (localXlsx) return readFile(path.resolve(localXlsx));
  const response = await fetch(SOURCE_URL, {
    headers: {
      Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "User-Agent": "TrackerRodu-KATOTTG-Importer/1.0 (https://trekerrodu.com.ua)",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`KATOTTG download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function parseOfficialSettlements(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relationsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relationsXml) throw new Error("XLSX workbook metadata is missing");

  const firstSheet = workbookXml.match(/<sheet\b([^>]*)\/?\s*>/);
  if (!firstSheet) throw new Error("XLSX contains no worksheet");
  const relationshipId = xmlAttribute(firstSheet[1], "r:id");
  const sheetName = xmlAttribute(firstSheet[1], "name") ?? "Sheet1";
  const relation = [...relationsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)]
    .find((entry) => xmlAttribute(entry[1], "Id") === relationshipId);
  const target = relation ? xmlAttribute(relation[1], "Target") : null;
  if (!target) throw new Error(`Worksheet relationship ${relationshipId} is missing`);
  const worksheetPath = target.startsWith("/")
    ? target.slice(1)
    : path.posix.normalize(path.posix.join("xl", target));
  const worksheetXml = await zip.file(worksheetPath)?.async("string");
  if (!worksheetXml) throw new Error(`Worksheet ${worksheetPath} is missing`);

  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings = parseSharedStrings(sharedStringsXml ?? "");
  const rows = parseWorksheetRows(worksheetXml, sharedStrings);
  const headerRow = rows.find((row) => {
    const cells = row.values.map(normalizeHeader);
    return cells.includes("перший рівень")
      && cells.includes("четвертий рівень")
      && cells.some((cell) => cell.includes("назва об'єкта"));
  });
  if (!headerRow) throw new Error("KATOTTG header row was not recognized");

  const normalizedHeaders = headerRow.values.map(normalizeHeader);
  const findColumn = (label) => {
    const index = normalizedHeaders.findIndex((header) => header === label);
    if (index < 0) throw new Error(`KATOTTG column '${label}' is missing`);
    return index;
  };
  const columns = {
    level1: findColumn("перший рівень"),
    level2: findColumn("другий рівень"),
    level3: findColumn("третій рівень"),
    level4: findColumn("четвертий рівень"),
    category: normalizedHeaders.findIndex((header) => header.includes("категорія об'єкта")),
    name: normalizedHeaders.findIndex((header) => header.includes("назва об'єкта")),
  };
  if (columns.category < 0 || columns.name < 0) {
    throw new Error("KATOTTG category or name column is missing");
  }

  const rawRows = rows
    .filter((row) => row.rowNumber > headerRow.rowNumber)
    .map((row) => ({
      rowNumber: row.rowNumber,
      level1Code: String(row.values[columns.level1] ?? "").trim(),
      level2Code: String(row.values[columns.level2] ?? "").trim(),
      level3Code: String(row.values[columns.level3] ?? "").trim(),
      level4Code: String(row.values[columns.level4] ?? "").trim(),
      category: normalizeCategory(row.values[columns.category]),
      name: String(row.values[columns.name] ?? "").trim(),
    }))
    .filter((row) => row.name);

  const namesByCode = new Map();
  for (const row of rawRows) {
    const ownCode = row.level4Code || row.level3Code || row.level2Code || row.level1Code;
    if (ownCode) namesByCode.set(ownCode, row.name);
  }

  const uniqueSettlements = new Map();
  for (const row of rawRows) {
    if (!row.level4Code || !["M", "T", "C", "X"].includes(row.category)) continue;
    if (!/^UA\d{17}$/.test(row.level4Code)) {
      throw new Error(`Unexpected KATOTTG code '${row.level4Code}' at row ${row.rowNumber}`);
    }
    uniqueSettlements.set(row.level4Code, {
      katottgCode: row.level4Code,
      name: row.name,
      category: row.category,
      level1Code: row.level1Code || null,
      level2Code: row.level2Code || null,
      level3Code: row.level3Code || null,
      level4Code: row.level4Code,
      regionName: namesByCode.get(row.level1Code) ?? null,
      districtName: namesByCode.get(row.level2Code) ?? null,
      communityName: namesByCode.get(row.level3Code) ?? null,
      sourceRowNumber: row.rowNumber,
    });
  }

  const settlements = [...uniqueSettlements.values()]
    .sort((left, right) => left.katottgCode.localeCompare(right.katottgCode, "en"));
  if (settlements.length < 25_000) {
    const categoryCounts = Object.fromEntries(
      [...rawRows.reduce((counts, row) => {
        counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
        return counts;
      }, new Map()).entries()].sort(),
    );
    throw new Error(
      `Only ${settlements.length} settlements were parsed; expected at least 25,000. `
      + `Rows=${rawRows.length}; categories=${JSON.stringify(categoryCounts)}; `
      + `samples=${JSON.stringify(rawRows.slice(0, 8))}`,
    );
  }
  return { sheetName, headerRowNumber: headerRow.rowNumber, settlements };
}

function generatedSql(settlements, workbookMetadata) {
  const lines = [GENERATED_BEGIN];
  lines.push("update security_private.historical_place_reference_datasets");
  lines.push("set is_active = false, updated_at = clock_timestamp()");
  lines.push("where provider = 'katottg' and dataset_key <> 'katottg:2026-07-07';");
  lines.push("");
  lines.push("insert into security_private.historical_place_reference_datasets (");
  lines.push("  dataset_key, provider, version, published_on, order_number,");
  lines.push("  source_page_url, source_url, source_sha256, retrieved_at,");
  lines.push("  row_count, is_active, metadata");
  lines.push(") values (");
  lines.push(`  ${sqlText(DATASET_KEY)}, 'katottg', ${sqlText(DATASET_VERSION)}, ${sqlText(DATASET_VERSION)}::date, ${sqlText(ORDER_NUMBER)},`);
  lines.push(`  ${sqlText(SOURCE_PAGE_URL)}, ${sqlText(SOURCE_URL)}, ${sqlText(EXPECTED_SHA256.toLowerCase())},`);
  lines.push(`  ${sqlText(RETRIEVED_AT)}::timestamptz, ${settlements.length}, true,`);
  lines.push(`  ${sqlJson({
    workbookSheet: workbookMetadata.sheetName,
    headerRowNumber: workbookMetadata.headerRowNumber,
    contentLength: EXPECTED_CONTENT_LENGTH,
    generator: "scripts/generate-katottg-discovery-migration.mjs",
  })}`);
  lines.push(") on conflict (dataset_key) do update set");
  lines.push("  source_page_url = excluded.source_page_url,");
  lines.push("  source_url = excluded.source_url,");
  lines.push("  source_sha256 = excluded.source_sha256,");
  lines.push("  retrieved_at = excluded.retrieved_at,");
  lines.push("  row_count = excluded.row_count,");
  lines.push("  is_active = true,");
  lines.push("  metadata = excluded.metadata,");
  lines.push("  updated_at = clock_timestamp();");
  lines.push("");

  const batchSize = 500;
  for (let offset = 0; offset < settlements.length; offset += batchSize) {
    const batch = settlements.slice(offset, offset + batchSize);
    lines.push("insert into security_private.katottg_settlements (");
    lines.push("  dataset_key, katottg_code, name, category,");
    lines.push("  level1_code, level2_code, level3_code, level4_code,");
    lines.push("  region_name, district_name, community_name, source_row_number");
    lines.push(") values");
    batch.forEach((settlement, index) => {
      const suffix = index === batch.length - 1 ? "" : ",";
      lines.push(
        `(${sqlText(DATASET_KEY)},${sqlText(settlement.katottgCode)},${sqlText(settlement.name)},${sqlText(settlement.category)},`
        + `${sqlText(settlement.level1Code)},${sqlText(settlement.level2Code)},${sqlText(settlement.level3Code)},${sqlText(settlement.level4Code)},`
        + `${sqlText(settlement.regionName)},${sqlText(settlement.districtName)},${sqlText(settlement.communityName)},${settlement.sourceRowNumber})${suffix}`,
      );
    });
    lines.push("on conflict (dataset_key, katottg_code) do update set");
    lines.push("  name = excluded.name,");
    lines.push("  category = excluded.category,");
    lines.push("  level1_code = excluded.level1_code,");
    lines.push("  level2_code = excluded.level2_code,");
    lines.push("  level3_code = excluded.level3_code,");
    lines.push("  level4_code = excluded.level4_code,");
    lines.push("  region_name = excluded.region_name,");
    lines.push("  district_name = excluded.district_name,");
    lines.push("  community_name = excluded.community_name,");
    lines.push("  source_row_number = excluded.source_row_number;");
    lines.push("");
  }

  lines.push(GENERATED_END);
  return lines.join("\n");
}

async function main() {
  const bytes = await loadWorkbookBytes();
  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (sha256 !== EXPECTED_SHA256) {
    throw new Error(`Unexpected XLSX SHA-256 ${sha256}; expected ${EXPECTED_SHA256}`);
  }
  if (bytes.length !== EXPECTED_CONTENT_LENGTH) {
    throw new Error(`Unexpected XLSX length ${bytes.length}; expected ${EXPECTED_CONTENT_LENGTH}`);
  }

  const parsed = await parseOfficialSettlements(bytes);
  const schemaMigrationPath = path.resolve(
    cliValue("--schema-output") ?? defaultSchemaMigrationPath,
  );
  const seedMigrationPath = path.resolve(
    cliValue("--output") ?? defaultSeedMigrationPath,
  );
  const schemaMigration = await readFile(schemaMigrationPath, "utf8");
  const start = schemaMigration.indexOf(GENERATED_BEGIN);
  const end = schemaMigration.indexOf(GENERATED_END);
  if (start < 0 || end < start) {
    throw new Error(`Generated seed markers are missing in ${schemaMigrationPath}`);
  }
  const generated = generatedSql(parsed.settlements, parsed);
  const schemaPlaceholder = [
    GENERATED_BEGIN,
    "-- Seeded by the next migration; regenerate both files with the script above.",
    GENERATED_END,
  ].join("\n");
  const updatedSchema = schemaMigration.slice(0, start)
    + schemaPlaceholder
    + schemaMigration.slice(end + GENERATED_END.length);
  const seedMigration = [
    "-- Generated offline KATOTTG settlement snapshot.",
    `-- Official source: ${SOURCE_URL}`,
    `-- Version ${DATASET_VERSION}; order ${ORDER_NUMBER}; SHA-256 ${EXPECTED_SHA256}.`,
    "-- Reproduce with: node scripts/generate-katottg-discovery-migration.mjs",
    "",
    generated,
    "",
    "analyze security_private.historical_place_reference_datasets;",
    "analyze security_private.katottg_settlements;",
    "",
  ].join("\n");
  await writeFile(schemaMigrationPath, updatedSchema, "utf8");
  await writeFile(seedMigrationPath, seedMigration, "utf8");
  console.log(JSON.stringify({
    sourceUrl: SOURCE_URL,
    version: DATASET_VERSION,
    orderNumber: ORDER_NUMBER,
    sha256,
    contentLength: bytes.length,
    sheetName: parsed.sheetName,
    headerRowNumber: parsed.headerRowNumber,
    settlementCount: parsed.settlements.length,
    schemaOutput: schemaMigrationPath,
    seedOutput: seedMigrationPath,
  }, null, 2));
}

await main();
