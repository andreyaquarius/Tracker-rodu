import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../src/pages/FamilyTreeStatisticsPage.tsx", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/services/familyTreeStatisticsService.ts", import.meta.url), "utf8");
const exporter = readFileSync(new URL("../src/utils/familyTreeStatisticsExport.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/202608120004_family_tree_statistics.sql", import.meta.url), "utf8");
const myHeritageReconciliationMigration = readFileSync(
  new URL("../supabase/migrations/202608130001_reconcile_myheritage_vital_status.sql", import.meta.url),
  "utf8",
);
const fullTimelineMigration = readFileSync(
  new URL("../supabase/migrations/202608130002_family_tree_statistics_full_timeline.sql", import.meta.url),
  "utf8",
);
const firstMarriageMigration = readFileSync(
  new URL("../supabase/migrations/202608130003_family_tree_statistics_first_marriage.sql", import.meta.url),
  "utf8",
);
const layout = readFileSync(new URL("../src/components/Layout.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("statistics UI exposes every report, global filters, lazy detail and accessible charts", () => {
  for (const tab of ["overview", "ancestry", "demography", "families", "names", "geography", "research", "quality"]) {
    assert.match(page, new RegExp(`id: "${tab}"`));
  }
  assert.match(page, /loadFamilyTreeStatistics\(activeTab/);
  assert.match(page, /loadFamilyTreeStatisticsPeople/);
  assert.match(page, /StatisticsFiltersPanel/);
  assert.match(page, /ChartAccessibleTable/);
  assert.match(page, /familyTreeStatisticsRowDisplayValue/);
  assert.match(page, /familyTreeStatisticsRowBreakdown/);
  assert.match(page, /hasTotal \? <th>Усього<\/th>/);
  assert.match(page, /StatisticsMap/);
  assert.match(page, /Теплова карта/);
  assert.match(page, /Переміщення/);
  assert.match(page, /PERSON_EVENT_TYPES/);
  assert.match(page, /surnameMode/);
  assert.match(page, /forceRefreshRef/);
  assert.doesNotMatch(page, /bindPopup\(`.*\$\{marker\.label\}/s);
});

test("statistics uses a dedicated vertically scrollable tree workspace", () => {
  assert.match(layout, /familyTreeView\?: "tree" \| "statistics"/);
  assert.match(layout, /family-tree-statistics-host/);
  assert.match(layout, /main-shell-family-tree-statistics/);
  assert.match(app, /familyTreeView=\{/);
  assert.match(
    styles,
    /\.main-shell-family-tree-statistics > \.family-tree-statistics-host\s*\{[^}]*flex:\s*1 1 0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s,
  );
});

test("statistics keeps the report header in one compact desktop toolbar", () => {
  assert.match(
    page,
    /family-tree-statistics-actions[\s\S]*family-tree-statistics-filter-bar[\s\S]*Оновити статистику/,
  );
  assert.match(page, /<h1 title=\{selectedTree\.title\}>/);
  assert.match(
    styles,
    /\.family-tree-statistics-title-row\s*\{[^}]*align-items:\s*center;[^}]*padding:\s*8px 10px;/s,
  );
  assert.match(
    styles,
    /\.family-tree-statistics-heading h1\s*\{[^}]*font-size:\s*clamp\(18px, 1\.45vw, 24px\);[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    styles,
    /\.family-tree-statistics-filter-bar\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;/s,
  );
});

test("statistics bar totals stay readable beside the internal scrollbar", () => {
  assert.match(
    styles,
    /\.family-tree-statistics-bars\s*\{[^}]*scrollbar-gutter:\s*stable;/s,
  );
  assert.match(
    styles,
    /\.family-tree-statistics-bars strong\s*\{[^}]*min-width:\s*7ch;[^}]*font-variant-numeric:\s*tabular-nums;/s,
  );
});

test("statistics timelines expose exact axes without rendering every dense marker", () => {
  assert.match(page, /createFamilyTreeStatisticsLineChartModel/);
  assert.match(page, /family-tree-statistics-line-grid/);
  assert.match(page, /family-tree-statistics-line-summary/);
  assert.match(page, /showAllMarkers = rows\.length <= 48/);
  assert.match(page, /Наведіть курсор на лінію/);
  assert.match(styles, /\.family-tree-statistics-line-axis text/);
  assert.match(styles, /\.family-tree-statistics-line-hit/);
  assert.match(exporter, /statisticsLineChartSvg/);
  assert.match(migration, /'name-decades','title','Популярність імен за десятиліттями','type','horizontal-bar'/);
  assert.doesNotMatch(migration, /event_year desc limit 160/);
  assert.match(fullTimelineMigration, /get_family_tree_statistics_tab_v1\(jsonb,text\)/);
  assert.match(fullTimelineMigration, /new_names_fragment/);
  assert.match(fullTimelineMigration, /delete from security_private\.family_tree_statistics_cache/);
});

test("statistics client keeps each tab server-side and paginates drill-down results", () => {
  for (const rpc of [
    "get_family_tree_statistics_overview_v1",
    "get_family_tree_statistics_ancestry_v1",
    "get_family_tree_statistics_demography_v1",
    "get_family_tree_statistics_families_v1",
    "get_family_tree_statistics_names_v1",
    "get_family_tree_statistics_geography_v1",
    "get_family_tree_statistics_research_v1",
    "get_family_tree_statistics_quality_v1",
    "list_family_tree_statistics_people_v1",
  ]) assert.match(service, new RegExp(rpc));
  assert.match(service, /offset: input\.offset \?\? 0/);
  assert.match(service, /limit: input\.limit \?\? 50/);
  assert.match(service, /relationshipType/);
  assert.match(service, /eventTypes/);
  assert.match(service, /surnameMode/);
});

test("statistics SQL is tree-scoped, permission checked, cached and privacy-aware", () => {
  assert.match(migration, /assert_family_tree_feature_access/);
  assert.match(migration, /is_project_member/);
  assert.match(migration, /persisted_root_id/);
  assert.match(migration, /relation\.evidence_status <> 'disproven'/);
  assert.match(migration, /requested_relationship_type/);
  assert.match(migration, /requested_event_types/);
  assert.match(migration, /requested_surname_mode/);
  assert.match(migration, /movement_paths/);
  assert.match(migration, /family_tree_statistics_coordinate_v1/);
  assert.match(migration, /family_tree_research_issues/);
  assert.match(migration, /family_tree_statistics_cache/);
  assert.match(migration, /'statisticsVersion',2/);
  assert.match(migration, /family_tree_statistics_prune_cache_trigger/);
  assert.match(migration, /private_living/);
  assert.match(migration, /family_tree_statistics_life_status_v1/);
  assert.match(migration, /custom_fields_value ->> '__gedcomVitalStatus'/);
  assert.match(migration, /DEAT Y означає «померла» навіть без відомої дати смерті/);
  assert.match(migration, /11\.0 \+ case when security_private\.family_tree_statistics_life_status_v1/);
  assert.match(migration, /__trackerRoduPersonScans/);
  assert.match(migration, /__trackerRoduPersonEvents/);
  assert.match(migration, /coalesce\(photo\.value ->> 'availability', 'available'\) <> 'missing-local'/);
  assert.doesNotMatch(
    migration.match(/create or replace function security_private\.family_tree_statistics_profile_scores_v1\(\)[\s\S]*?\$function\$;/)?.[0] ?? "",
    /population\.has_sources/,
  );
  assert.match(migration, /when detail_key='repeated-ancestors'/);
  assert.match(migration, /when detail_key='all-quality-issues'/);
  assert.match(migration, /when detail_key='without-coordinates'/);
  assert.match(migration, /when detail_key='without-photo' then not exists/);
  assert.match(migration, /else false/);
});

test("statistics and Persons catalogue share one canonical direct-ancestor set", () => {
  assert.match(migration, /create temporary table _ft_stats_direct_ancestors/);
  assert.match(migration, /security_private\.list_family_tree_direct_ancestor_order_v1/);
  assert.match(migration, /when direct_ancestor\.generation > 0 then 'ancestor'/);
  assert.match(migration, /Унікальних прямих предків/);
  assert.match(migration, /Позицій предків \(1–16 покоління\)/);
  assert.match(migration, /from _ft_stats_population where kinship_kind='ancestor'/);
  assert.match(migration, /preferred_relation\.is_primary_for_display/);
  assert.match(migration, /relation_kind\.relationship_type/);
});

test("statistics keeps GEDCOM death assertions separate from known death dates", () => {
  const lifeStatusFunction = migration.match(
    /create or replace function security_private\.family_tree_statistics_life_status_v1[\s\S]*?\$function\$;/,
  )?.[0] ?? "";
  assert.match(lifeStatusFunction, /'deceased' then 'deceased'/);
  assert.match(lifeStatusFunction, /'unknown' then 'unknown'/);

  const peopleDetails = migration.match(
    /create or replace function public\.list_family_tree_statistics_people_v1[\s\S]*?\$function\$;/,
  )?.[0] ?? "";
  assert.match(peopleDetails, /when detail_key='deceased' then security_private\.family_tree_statistics_life_status_v1/);
  assert.match(peopleDetails, /when detail_key='known-death' then security_private\.family_tree_statistics_year_v1/);
  assert.match(peopleDetails, /when detail_key='unknown-life' then security_private\.family_tree_statistics_life_status_v1/);
  assert.doesNotMatch(peopleDetails, /detail_key in \('deceased','known-death'\)/);
});

test("statistics repairs legacy MyHeritage binary vital statuses without touching other vendors", () => {
  assert.match(myHeritageReconciliationMigration, /head_line\.value ->> 'value'.*MYHERITAGE/s);
  assert.match(myHeritageReconciliationMigration, /__gedcomVitalStatus.*unknown/s);
  assert.match(myHeritageReconciliationMigration, /reference_year - 110/);
  assert.match(myHeritageReconciliationMigration, /person_timeline_events/);
  assert.match(myHeritageReconciliationMigration, /parent_child_relationships/);
  assert.match(myHeritageReconciliationMigration, /partner_relationships/);
  assert.match(myHeritageReconciliationMigration, /when evidence\.presumed_deceased then 'deceased'[\s\S]*?else 'living'/);
  assert.match(myHeritageReconciliationMigration, /graph_version = tree\.graph_version \+ 1/);
  assert.match(myHeritageReconciliationMigration, /family_tree_statistics_cache/);
});

test("statistics SQL implements the complete families, names, demography and research specification", () => {
  for (const report of [
    "first-marriage-age",
    "without-partners",
    "without-children",
    "siblings-distribution",
    "association-types",
    "name-variants",
    "surname-branches",
    "confirmed-findings",
    "unreviewed-findings",
    "document-generations",
    "evidence-statuses",
    "finding-review",
    "findings-years",
    "materials-per-person",
    "frequent-documents",
  ]) assert.match(migration, new RegExp(report));
  assert.match(migration, /seriesLabels/);
  assert.match(migration, /can_view_private or not population\.private_living/);
});

test("first-marriage age uses GEDCOM family dates and keeps chart drill-down consistent", () => {
  assert.match(migration, /family_tree_statistics_first_marriage_year_v1/);
  assert.match(migration, /public\.partner_relationships relation/);
  assert.match(migration, /relation\.start_date/);
  assert.match(migration, /public\.person_timeline_events event/);
  assert.match(migration, /event\.event_type = 'marriage'/);
  assert.match(
    migration,
    /family_tree_statistics_first_marriage_year_v1\(person\.id,current_tree_id,person\.marriage_date\) marriage_year/,
  );
  assert.match(
    migration,
    /family_tree_statistics_first_marriage_year_v1\(person\.id,\(meta->>'treeId'\)::uuid,person\.marriage_date\)/,
  );

  assert.match(firstMarriageMigration, /get_family_tree_statistics_tab_v1\(jsonb,text\)/);
  assert.match(firstMarriageMigration, /list_family_tree_statistics_people_v1\(jsonb\)/);
  assert.match(firstMarriageMigration, /partner_relationships_first_marriage_person_a_idx/);
  assert.match(firstMarriageMigration, /partner_relationships_first_marriage_person_b_idx/);
  assert.match(firstMarriageMigration, /where tab = 'demography'/);
});

test("statistics exports cover print, PDF, CSV, SVG, PNG and a real XLSX workbook", () => {
  assert.match(page, /window\.print\(\)/);
  assert.match(exporter, /exportStatisticsPdf/);
  assert.match(exporter, /exportStatisticsTableCsv/);
  assert.match(exporter, /exportStatisticsChartCsv/);
  assert.match(exporter, /exportStatisticsChartSvg/);
  assert.match(exporter, /exportStatisticsChartPng/);
  assert.match(exporter, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(exporter, /new JSZip\(\)/);
  assert.match(exporter, /payload\.charts\.forEach/);
  assert.match(exporter, /hasTotal/);
  assert.match(exporter, /familyTreeStatisticsRowDisplayValue/);
});
