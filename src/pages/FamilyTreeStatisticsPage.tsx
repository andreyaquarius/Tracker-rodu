import L from "leaflet";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Modal } from "../components/Modal.tsx";
import { readFamilyTreeEntryPoints, type FamilyTreeEntryPoint } from "../services/familyTreeNeighborhoodService.ts";
import type { PersonEventType } from "../types/index.ts";
import { PERSON_EVENT_TYPES, personEventLabel } from "../utils/geo.ts";
import { PERSON_STATUSES } from "../utils/personStatus.ts";
import {
  DEFAULT_FAMILY_TREE_STATISTICS_FILTERS,
  clearFamilyTreeStatisticsCache,
  familyTreeStatisticsErrorMessage,
  loadFamilyTreeStatistics,
  loadFamilyTreeStatisticsPeople,
  type FamilyTreeStatisticsChart,
  type FamilyTreeStatisticsFilters,
  type FamilyTreeStatisticsPayload,
  type FamilyTreeStatisticsPeoplePage,
  type FamilyTreeStatisticsTabId,
  type FamilyTreeStatisticsTable,
} from "../services/familyTreeStatisticsService.ts";
import {
  exportStatisticsChartPng,
  exportStatisticsChartCsv,
  exportStatisticsChartSvg,
  exportStatisticsExcel,
  exportStatisticsPdf,
  exportStatisticsTableCsv,
} from "../utils/familyTreeStatisticsExport.ts";
import {
  createFamilyTreeStatisticsLineChartModel,
  familyTreeStatisticsChartForPresentation,
  familyTreeStatisticsRowBreakdown,
  familyTreeStatisticsRowDisplayValue,
} from "../utils/familyTreeStatisticsChart.ts";

const TABS: readonly { id: FamilyTreeStatisticsTabId; label: string; description: string }[] = [
  { id: "overview", label: "Огляд", description: "Ключові показники дерева" },
  { id: "ancestry", label: "Родовід", description: "Покоління, гілки й повтори" },
  { id: "demography", label: "Демографія", description: "Дати, вік і сезонність" },
  { id: "families", label: "Родини та зв’язки", description: "Діти, партнери й типи зв’язків" },
  { id: "names", label: "Імена", description: "Імена, прізвища й варіанти" },
  { id: "geography", label: "Географія", description: "Місця та карта подій" },
  { id: "research", label: "Джерела та дослідження", description: "Документи, знахідки й докази" },
  { id: "quality", label: "Якість даних", description: "Заповненість і проблеми" },
];

const CHART_COLORS = ["#17695f", "#d38a32", "#9a5d83", "#387aa5", "#71895a", "#a54848", "#6f62a4", "#8b7355"];

export interface FamilyTreeStatisticsPageProps {
  projectId?: string;
  initialTreeId?: string;
  onBack: (treeId?: string) => void;
  onOpenPerson?: (personId: string) => void;
}

function numberInput(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function parseOptionalNumber(value: string): number | undefined {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
}

function dateTimeLabel(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("uk-UA", { dateStyle: "medium", timeStyle: "short" });
}

function filtersEqual(left: FamilyTreeStatisticsFilters, right: FamilyTreeStatisticsFilters): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appliedFilterChips(filters: FamilyTreeStatisticsFilters): string[] {
  return [
    filters.scope === "direct-ancestors" ? "Прямі предки" : filters.scope === "descendants" ? "Нащадки кореневої особи" : "Усе дерево",
    filters.branch === "paternal" ? "Батьківська гілка" : filters.branch === "maternal" ? "Материнська гілка" : "",
    filters.generationFrom !== undefined || filters.generationTo !== undefined ? `Покоління ${filters.generationFrom ?? "…"}–${filters.generationTo ?? "…"}` : "",
    filters.yearFrom !== undefined || filters.yearTo !== undefined ? `Роки ${filters.yearFrom ?? "…"}–${filters.yearTo ?? "…"}` : "",
    filters.sex !== "all" ? `Стать: ${filters.sex === "male" ? "чоловіча" : filters.sex === "female" ? "жіноча" : "невідома"}` : "",
    filters.lifeStatus !== "all" ? `Статус: ${filters.lifeStatus === "living" ? "живі" : filters.lifeStatus === "deceased" ? "померлі" : "невідомо"}` : "",
    filters.evidenceStatuses.length ? `Доказовість: ${filters.evidenceStatuses.join(", ")}` : "",
    filters.eventTypes.length ? `Події: ${filters.eventTypes.map((type) => personEventLabel(type as PersonEventType)).join(", ")}` : "",
    filters.surnameMode !== "displayed" ? `Жіночі прізвища: ${filters.surnameMode === "birth" ? "при народженні" : "у шлюбі"}` : "",
    filters.place ? `Місце: ${filters.place}` : "",
    filters.importSourceKey ? `Імпорт: ${filters.importSourceKey}` : "",
    filters.sourceFilter === "with-sources" ? "Лише з джерелами" : filters.sourceFilter === "without-sources" ? "Без джерел" : "",
  ].filter(Boolean);
}

export function FamilyTreeStatisticsPage({
  projectId,
  initialTreeId,
  onBack,
  onOpenPerson,
}: FamilyTreeStatisticsPageProps) {
  const [trees, setTrees] = useState<FamilyTreeEntryPoint[]>([]);
  const [treeId, setTreeId] = useState(initialTreeId?.trim() ?? "");
  const [activeTab, setActiveTab] = useState<FamilyTreeStatisticsTabId>("overview");
  const [draftFilters, setDraftFilters] = useState<FamilyTreeStatisticsFilters>(DEFAULT_FAMILY_TREE_STATISTICS_FILTERS);
  const [filters, setFilters] = useState<FamilyTreeStatisticsFilters>(DEFAULT_FAMILY_TREE_STATISTICS_FILTERS);
  const [payloads, setPayloads] = useState<Partial<Record<FamilyTreeStatisticsTabId, FamilyTreeStatisticsPayload>>>({});
  const [loadingTrees, setLoadingTrees] = useState(Boolean(projectId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const forceRefreshRef = useRef(false);
  const [detail, setDetail] = useState<{ key: string; title: string; offset: number } | null>(null);
  const [detailPage, setDetailPage] = useState<FamilyTreeStatisticsPeoplePage | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  useEffect(() => {
    let active = true;
    if (!projectId) {
      setLoadingTrees(false);
      return () => { active = false; };
    }
    setLoadingTrees(true);
    void readFamilyTreeEntryPoints(projectId)
      .then((entries) => {
        if (!active) return;
        setTrees(entries);
        const selected = entries.find((entry) => entry.id === initialTreeId?.trim()) ?? entries.find((entry) => entry.isDefault) ?? entries[0];
        setTreeId(selected?.id ?? "");
      })
      .catch((loadError) => active && setError(familyTreeStatisticsErrorMessage(loadError)))
      .finally(() => active && setLoadingTrees(false));
    return () => { active = false; };
  }, [initialTreeId, projectId]);

  const selectedTree = useMemo(
    () => trees.find((tree) => tree.id === treeId) ?? trees.find((tree) => tree.isDefault) ?? trees[0] ?? null,
    [treeId, trees],
  );
  const payload = payloads[activeTab];

  useEffect(() => {
    let active = true;
    if (!selectedTree?.id || !selectedTree.rootPersonId) return () => { active = false; };
    setLoading(true);
    setError("");
    void loadFamilyTreeStatistics(activeTab, {
      treeId: selectedTree.id,
      rootPersonId: selectedTree.rootPersonId,
      graphVersion: selectedTree.graphVersion,
      filters,
      force: forceRefreshRef.current,
    })
      .then((response) => {
        if (!active) return;
        setPayloads((current) => ({ ...current, [activeTab]: response }));
      })
      .catch((loadError) => active && setError(familyTreeStatisticsErrorMessage(loadError)))
      .finally(() => {
        if (!active) return;
        forceRefreshRef.current = false;
        setLoading(false);
      });
    return () => { active = false; };
  }, [activeTab, filters, refreshRevision, selectedTree?.graphVersion, selectedTree?.id, selectedTree?.rootPersonId]);

  useEffect(() => {
    let active = true;
    if (!detail || !selectedTree?.id || !selectedTree.rootPersonId) return () => { active = false; };
    setDetailLoading(true);
    setDetailError("");
    void loadFamilyTreeStatisticsPeople({
      treeId: selectedTree.id,
      rootPersonId: selectedTree.rootPersonId,
      filters,
      detailKey: detail.key,
      offset: detail.offset,
      limit: 50,
    })
      .then((response) => active && setDetailPage(response))
      .catch((loadError) => active && setDetailError(familyTreeStatisticsErrorMessage(loadError)))
      .finally(() => active && setDetailLoading(false));
    return () => { active = false; };
  }, [detail, filters, selectedTree?.id, selectedTree?.rootPersonId]);

  const openDetail = useCallback((key: string | undefined, title: string) => {
    if (!key) return;
    setDetailPage(null);
    setDetail({ key, title, offset: 0 });
  }, []);

  const refresh = () => {
    if (selectedTree?.id) clearFamilyTreeStatisticsCache(selectedTree.id);
    forceRefreshRef.current = true;
    setPayloads({});
    setRefreshRevision((value) => value + 1);
  };

  const exportAllExcel = async () => {
    if (!selectedTree?.id || !selectedTree.rootPersonId) return;
    setExporting(true);
    setExportOpen(false);
    try {
      const entries = await Promise.all(TABS.map(async ({ id }) => [id, await loadFamilyTreeStatistics(id, {
        treeId: selectedTree.id,
        rootPersonId: selectedTree.rootPersonId!,
        graphVersion: selectedTree.graphVersion,
        filters,
      })] as const));
      const allPayloads = Object.fromEntries(entries) as Record<FamilyTreeStatisticsTabId, FamilyTreeStatisticsPayload>;
      setPayloads(allPayloads);
      await exportStatisticsExcel(allPayloads);
    } catch (exportError) {
      setError(familyTreeStatisticsErrorMessage(exportError));
    } finally {
      setExporting(false);
    }
  };

  if (loadingTrees) {
    return <section className="family-tree-statistics-page family-tree-statistics-empty"><div className="panel"><strong>Завантажуємо дерева…</strong></div></section>;
  }
  if (!selectedTree) {
    return (
      <section className="family-tree-statistics-page family-tree-statistics-empty">
        <div className="panel empty-state">
          <h2>Статистика стане доступною після створення дерева</h2>
          <p>Цей розділ рахує лише осіб активного дерева.</p>
          <button type="button" className="button" onClick={() => onBack()}>Назад до дерева</button>
        </div>
      </section>
    );
  }
  if (!selectedTree.rootPersonId) {
    return (
      <section className="family-tree-statistics-page family-tree-statistics-empty">
        <div className="panel empty-state">
          <h2>Спочатку виберіть кореневу особу</h2>
          <p>Коренева особа є постійною точкою відліку для гілок, поколінь і родоводу.</p>
          <button type="button" className="button" onClick={() => onBack(selectedTree.id)}>Назад до дерева</button>
        </div>
      </section>
    );
  }

  return (
    <section className="family-tree-statistics-page">
      <header className="family-tree-statistics-header">
        <div className="family-tree-statistics-title-row">
          <button type="button" className="button button-secondary" onClick={() => onBack(selectedTree.id)}>← Назад до дерева</button>
          <div className="family-tree-statistics-heading">
            <span className="eyebrow">Родове дерево · Статистика</span>
            <h1 title={selectedTree.title}>{selectedTree.title}</h1>
            <div className="family-tree-statistics-meta">
              <span><strong>Коренева особа:</strong> {payload?.meta.rootPersonName ?? "Завантажуємо…"}</span>
              <span><strong>Останній розрахунок:</strong> {dateTimeLabel(payload?.meta.calculatedAt)}</span>
              <span><strong>У вибірці:</strong> {(payload?.meta.filteredPeople ?? 0).toLocaleString("uk-UA")}</span>
            </div>
          </div>
          <div className="family-tree-statistics-actions">
            {trees.length > 1 ? (
              <label><span>Дерево</span><select value={selectedTree.id} onChange={(event) => { setTreeId(event.target.value); setPayloads({}); }}>
                {trees.map((tree) => <option key={tree.id} value={tree.id}>{tree.title}</option>)}
              </select></label>
            ) : null}
            <div className="family-tree-statistics-filter-bar">
              <button type="button" className="button button-secondary" onClick={() => setFilterOpen((value) => !value)}>☷ Фільтри{appliedFilterChips(filters).length > 1 ? ` (${appliedFilterChips(filters).length})` : ""}</button>
              <div className="family-tree-statistics-filter-chips">
                {appliedFilterChips(filters).map((chip) => <span key={chip}>{chip}</span>)}
              </div>
            </div>
            <button type="button" className="button button-secondary" disabled={loading} onClick={refresh}>{loading ? "Рахуємо…" : "Оновити статистику"}</button>
            <div className="family-tree-statistics-export-wrap">
              <button type="button" className="button" disabled={!payload || exporting} onClick={() => setExportOpen((value) => !value)}>{exporting ? "Формуємо…" : "Експорт звіту"}</button>
              {exportOpen && payload ? (
                <div className="family-tree-statistics-export-menu">
                  <button type="button" onClick={() => { setExportOpen(false); void exportStatisticsPdf(payload, filters); }}>PDF-звіт</button>
                  <button type="button" onClick={() => void exportAllExcel()}>Excel · усі вкладки</button>
                  <button type="button" onClick={() => { setExportOpen(false); window.print(); }}>Друк</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {filterOpen ? (
          <StatisticsFiltersPanel
            value={draftFilters}
            changed={!filtersEqual(filters, draftFilters)}
            onChange={setDraftFilters}
            onApply={() => { setFilters(draftFilters); setPayloads({}); setFilterOpen(false); }}
            onReset={() => { setDraftFilters(DEFAULT_FAMILY_TREE_STATISTICS_FILTERS); setFilters(DEFAULT_FAMILY_TREE_STATISTICS_FILTERS); setPayloads({}); }}
          />
        ) : null}
      </header>

      <nav className="family-tree-statistics-tabs" aria-label="Вкладки статистики">
        {TABS.map((tab) => (
          <button key={tab.id} type="button" className={activeTab === tab.id ? "active" : ""} aria-current={activeTab === tab.id ? "page" : undefined} onClick={() => setActiveTab(tab.id)}>
            <strong>{tab.label}</strong><small>{tab.description}</small>
          </button>
        ))}
      </nav>

      {error ? <div className="alert alert-error family-tree-statistics-alert">{error}<button type="button" className="button button-secondary" onClick={refresh}>Спробувати ще раз</button></div> : null}
      {loading && !payload ? <StatisticsLoading /> : null}
      {!loading && payload ? <StatisticsDashboard payload={payload} onOpenDetail={openDetail} /> : null}

      {detail ? (
        <StatisticsPeopleModal
          title={detail.title}
          page={detailPage}
          loading={detailLoading}
          error={detailError}
          onOpenPerson={onOpenPerson}
          onPage={(offset) => setDetail((current) => current ? { ...current, offset } : current)}
          onClose={() => { setDetail(null); setDetailPage(null); }}
        />
      ) : null}
    </section>
  );
}

function StatisticsFiltersPanel({ value, changed, onChange, onApply, onReset }: {
  value: FamilyTreeStatisticsFilters;
  changed: boolean;
  onChange: (value: FamilyTreeStatisticsFilters) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const update = <K extends keyof FamilyTreeStatisticsFilters>(key: K, next: FamilyTreeStatisticsFilters[K]) => onChange({ ...value, [key]: next });
  const toggleEvidence = (status: string) => update("evidenceStatuses", value.evidenceStatuses.includes(status)
    ? value.evidenceStatuses.filter((item) => item !== status)
    : [...value.evidenceStatuses, status]);
  const toggleEventType = (eventType: string) => update("eventTypes", value.eventTypes.includes(eventType)
    ? value.eventTypes.filter((item) => item !== eventType)
    : [...value.eventTypes, eventType]);
  return (
    <div className="family-tree-statistics-filters panel">
      <div className="family-tree-statistics-filter-grid">
        <label><span>Обсяг дерева</span><select value={value.scope} onChange={(event) => update("scope", event.target.value as FamilyTreeStatisticsFilters["scope"])}><option value="all">Усе дерево</option><option value="direct-ancestors">Прямі предки</option><option value="descendants">Нащадки кореневої особи</option></select></label>
        <label><span>Гілка</span><select value={value.branch} onChange={(event) => update("branch", event.target.value as FamilyTreeStatisticsFilters["branch"])}><option value="all">Усі гілки</option><option value="paternal">Батьківська</option><option value="maternal">Материнська</option></select></label>
        <label><span>Покоління від</span><input type="number" min="0" max="99" value={numberInput(value.generationFrom)} onChange={(event) => update("generationFrom", parseOptionalNumber(event.target.value))} /></label>
        <label><span>Покоління до</span><input type="number" min="0" max="99" value={numberInput(value.generationTo)} onChange={(event) => update("generationTo", parseOptionalNumber(event.target.value))} /></label>
        <label><span>Рік від</span><input type="number" min="1" max="2200" value={numberInput(value.yearFrom)} onChange={(event) => update("yearFrom", parseOptionalNumber(event.target.value))} /></label>
        <label><span>Рік до</span><input type="number" min="1" max="2200" value={numberInput(value.yearTo)} onChange={(event) => update("yearTo", parseOptionalNumber(event.target.value))} /></label>
        <label><span>Стать</span><select value={value.sex} onChange={(event) => update("sex", event.target.value as FamilyTreeStatisticsFilters["sex"])}><option value="all">Усі</option><option value="male">Чоловіки</option><option value="female">Жінки</option><option value="unknown">Невідомо</option></select></label>
        <label><span>Життєвий статус</span><select value={value.lifeStatus} onChange={(event) => update("lifeStatus", event.target.value as FamilyTreeStatisticsFilters["lifeStatus"])}><option value="all">Усі</option><option value="living">Живі</option><option value="deceased">Померлі</option><option value="unknown">Невідомо</option></select></label>
        <label><span>Тип зв’язку</span><input value={value.relationshipType ?? ""} placeholder="Наприклад, biological" onChange={(event) => update("relationshipType", event.target.value || undefined)} /></label>
        <label><span>Жіночі прізвища у звіті «Імена»</span><select value={value.surnameMode} onChange={(event) => update("surnameMode", event.target.value as FamilyTreeStatisticsFilters["surnameMode"])}><option value="displayed">Поточне відображуване</option><option value="birth">При народженні</option><option value="married">У шлюбі</option></select></label>
        <label><span>Місце</span><input value={value.place ?? ""} placeholder="Назва населеного пункту" onChange={(event) => update("place", event.target.value || undefined)} /></label>
        <label><span>Ключ імпорту GEDCOM</span><input value={value.importSourceKey ?? ""} placeholder="Необов’язково" onChange={(event) => update("importSourceKey", event.target.value || undefined)} /></label>
        <label><span>Джерела</span><select value={value.sourceFilter} onChange={(event) => update("sourceFilter", event.target.value as FamilyTreeStatisticsFilters["sourceFilter"])}><option value="all">Усі особи</option><option value="with-sources">З джерелами</option><option value="without-sources">Без джерел</option></select></label>
      </div>
      <fieldset className="family-tree-statistics-evidence-filter"><legend>Статус доказовості</legend>{PERSON_STATUSES.map((status) => <label key={status}><input type="checkbox" checked={value.evidenceStatuses.includes(status)} onChange={() => toggleEvidence(status)} />{status}</label>)}</fieldset>
      <fieldset className="family-tree-statistics-evidence-filter family-tree-statistics-event-filter"><legend>Типи подій для географії</legend>{PERSON_EVENT_TYPES.map((eventType) => <label key={eventType}><input type="checkbox" checked={value.eventTypes.includes(eventType)} onChange={() => toggleEventType(eventType)} />{personEventLabel(eventType)}</label>)}</fieldset>
      <div className="family-tree-statistics-filter-actions"><button type="button" className="button button-secondary" onClick={onReset}>Скинути</button><button type="button" className="button" disabled={!changed} onClick={onApply}>Застосувати до всіх звітів</button></div>
    </div>
  );
}

function StatisticsLoading() {
  return <div className="family-tree-statistics-loading" aria-live="polite"><div className="family-tree-statistics-skeleton" /><div className="family-tree-statistics-skeleton" /><div className="family-tree-statistics-skeleton" /><strong>Розраховуємо статистику на сервері…</strong></div>;
}

function StatisticsDashboard({ payload, onOpenDetail }: { payload: FamilyTreeStatisticsPayload; onOpenDetail: (key: string | undefined, title: string) => void }) {
  return (
    <div className="family-tree-statistics-content">
      <section className="family-tree-statistics-metrics" aria-label="Основні показники">
        {payload.metrics.map((metric) => (
          <button key={metric.id} type="button" className={metric.detailKey ? "is-actionable" : ""} disabled={!metric.detailKey} onClick={() => onOpenDetail(metric.detailKey, metric.label)}>
            <span>{metric.label}</span><strong>{typeof metric.value === "number" ? metric.value.toLocaleString("uk-UA") : metric.value}{metric.suffix ?? ""}</strong>{metric.sampleSize !== undefined ? <small>Вибірка: {metric.sampleSize.toLocaleString("uk-UA")}</small> : null}
          </button>
        ))}
      </section>

      {payload.map?.markers?.length ? <StatisticsMap markers={payload.map.markers} paths={payload.map.paths ?? []} onOpenDetail={onOpenDetail} /> : null}

      <section className="family-tree-statistics-chart-grid">
        {payload.charts.map((chart) => <StatisticsChartCard key={chart.id} chart={chart} onOpenDetail={onOpenDetail} />)}
      </section>

      <section className="family-tree-statistics-tables">
        {payload.tables.map((table) => <StatisticsTableCard key={table.id} table={table} />)}
      </section>

      <footer className="family-tree-statistics-methodology"><strong>Методика</strong><p>{payload.meta.methodology}</p>{!payload.meta.canViewPrivate ? <p>Приватні дані живих осіб згруповано та приховано відповідно до вашої ролі.</p> : null}</footer>
    </div>
  );
}

function StatisticsChartCard({ chart, onOpenDetail }: { chart: FamilyTreeStatisticsChart; onOpenDetail: (key: string | undefined, title: string) => void }) {
  const [tableOpen, setTableOpen] = useState(false);
  const displayChart = familyTreeStatisticsChartForPresentation(chart);
  return (
    <article className="family-tree-statistics-chart-card panel">
      <header><h2>{displayChart.title}</h2><div><button type="button" title="Зберегти CSV" onClick={() => exportStatisticsChartCsv(displayChart)}>CSV</button><button type="button" title="Зберегти SVG" onClick={() => exportStatisticsChartSvg(displayChart)}>SVG</button><button type="button" title="Зберегти PNG" onClick={() => void exportStatisticsChartPng(displayChart)}>PNG</button><button type="button" onClick={() => setTableOpen((value) => !value)}>{tableOpen ? "Сховати таблицю" : "Таблиця"}</button></div></header>
      <StatisticsChartView chart={displayChart} onOpenDetail={onOpenDetail} />
      {displayChart.seriesLabels?.length ? <div className="family-tree-statistics-series-legend" aria-label="Позначення рядів">{displayChart.seriesLabels.map((label, index) => <span key={label}><i className={`series-${index}`} />{label}</span>)}</div> : null}
      {tableOpen ? <ChartAccessibleTable chart={displayChart} onOpenDetail={onOpenDetail} /> : null}
    </article>
  );
}

function StatisticsChartView({ chart, onOpenDetail }: { chart: FamilyTreeStatisticsChart; onOpenDetail: (key: string | undefined, title: string) => void }) {
  if (!chart.rows.length) return <div className="family-tree-statistics-no-data">Недостатньо даних для діаграми.</div>;
  if (chart.type === "donut") return <DonutChart chart={chart} onOpenDetail={onOpenDetail} />;
  if (chart.type === "line") return <LineChart chart={chart} onOpenDetail={onOpenDetail} />;
  const max = Math.max(1, ...chart.rows.map((row) => Number(row.total ?? row.value + (row.secondary ?? 0) + (row.tertiary ?? 0))));
  return (
    <div className={`family-tree-statistics-bars ${chart.type}`} role="img" aria-label={chart.title}>
      {chart.rows.map((row, index) => (
        <button
          key={`${row.label}-${index}`}
          type="button"
          disabled={!row.detailKey}
          onClick={() => onOpenDetail(row.detailKey, `${chart.title}: ${row.label}`)}
          title={familyTreeStatisticsRowBreakdown(chart, row)}
        >
          <span className="label">{row.label}</span>
          <span className="track">
            <span className="primary" style={{ width: `${Math.max(row.value ? 1 : 0, row.value / max * 100)}%` }} />
            {row.secondary !== undefined ? <span className="secondary" style={{ width: `${Math.max(row.secondary ? 1 : 0, row.secondary / max * 100)}%` }} /> : null}
            {row.tertiary !== undefined ? <span className="tertiary" style={{ width: `${Math.max(row.tertiary ? 1 : 0, row.tertiary / max * 100)}%` }} /> : null}
          </span>
          <strong>{familyTreeStatisticsRowDisplayValue(chart, row)}</strong>
        </button>
      ))}
    </div>
  );
}

function DonutChart({ chart, onOpenDetail }: { chart: FamilyTreeStatisticsChart; onOpenDetail: (key: string | undefined, title: string) => void }) {
  const total = Math.max(1, chart.rows.reduce((sum, row) => sum + row.value, 0));
  let offset = 0;
  const segments = chart.rows.map((row, index) => {
    const length = row.value / total * 100;
    const segment = { row, color: CHART_COLORS[index % CHART_COLORS.length], offset, length };
    offset += length;
    return segment;
  });
  return (
    <div className="family-tree-statistics-donut-wrap">
      <svg viewBox="0 0 180 180" role="img" aria-label={chart.title}>
        <circle cx="90" cy="90" r="62" fill="none" stroke="#e3e7e2" strokeWidth="28" />
        {segments.map(({ row, color, offset: segmentOffset, length }) => <circle key={row.label} cx="90" cy="90" r="62" fill="none" stroke={color} strokeWidth="28" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-segmentOffset} transform="rotate(-90 90 90)" />)}
        <text x="90" y="85" textAnchor="middle">Усього</text><text x="90" y="108" textAnchor="middle" className="total">{total.toLocaleString("uk-UA")}</text>
      </svg>
      <div className="family-tree-statistics-legend">{segments.map(({ row, color }) => <button type="button" key={row.label} disabled={!row.detailKey} onClick={() => onOpenDetail(row.detailKey, `${chart.title}: ${row.label}`)}><i style={{ background: color }} /><span>{row.label}</span><strong>{row.value.toLocaleString("uk-UA")}</strong></button>)}</div>
    </div>
  );
}

function LineChart({ chart, onOpenDetail }: { chart: FamilyTreeStatisticsChart; onOpenDetail: (key: string | undefined, title: string) => void }) {
  const rows = chart.rows;
  const model = useMemo(() => createFamilyTreeStatisticsLineChartModel(rows), [rows]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  useEffect(() => setActiveIndex(null), [chart.id, rows]);
  const activePoint = activeIndex === null ? undefined : model.points[activeIndex];
  const linePath = model.points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${model.points.at(-1)?.x ?? model.plotRight} ${model.plotBottom} L ${model.points[0]?.x ?? model.plotLeft} ${model.plotBottom} Z`;
  const showAllMarkers = rows.length <= 48;
  const hitRadius = Math.max(4, Math.min(9, model.plotWidth / Math.max(1, rows.length - 1) / 2));
  const tooltipWidth = 190;
  const tooltipHeight = 58;
  const tooltipX = activePoint
    ? Math.max(model.plotLeft, Math.min(model.plotRight - tooltipWidth, activePoint.x - tooltipWidth / 2))
    : 0;
  const tooltipY = activePoint
    ? activePoint.y < model.plotTop + tooltipHeight + 18 ? activePoint.y + 15 : activePoint.y - tooltipHeight - 15
    : 0;
  const tooltipLabel = activePoint && activePoint.row.label.length > 25
    ? `${activePoint.row.label.slice(0, 24)}…`
    : activePoint?.row.label;

  return (
    <div className={`family-tree-statistics-line${rows.length > 48 ? " is-dense" : ""}`}>
      <div className="family-tree-statistics-line-summary" aria-label="Короткий підсумок графіка">
        <span><small>Період</small><strong>{rows[0]?.label} — {rows.at(-1)?.label}</strong></span>
        <span><small>Усього</small><strong>{model.total.toLocaleString("uk-UA")}</strong></span>
        <span><small>Максимум</small><strong>{model.peak.row.value.toLocaleString("uk-UA")} · {model.peak.row.label}</strong></span>
      </div>
      <svg viewBox={`0 0 ${model.width} ${model.height}`} role="img" aria-labelledby={`${chart.id}-line-title ${chart.id}-line-description`}>
        <title id={`${chart.id}-line-title`}>{chart.title}</title>
        <desc id={`${chart.id}-line-description`}>Значення за період від {rows[0]?.label} до {rows.at(-1)?.label}. Максимум — {model.peak.row.value} у категорії {model.peak.row.label}.</desc>
        <g className="family-tree-statistics-line-grid" aria-hidden="true">
          {model.yTicks.map((tick) => <line key={tick.value} x1={model.plotLeft} y1={tick.y} x2={model.plotRight} y2={tick.y} />)}
          {model.xTicks.map((tick) => <line key={`${tick.label}-${tick.index}`} className="vertical" x1={tick.x} y1={model.plotTop} x2={tick.x} y2={model.plotBottom} />)}
        </g>
        <g className="family-tree-statistics-line-axis" aria-hidden="true">
          <line className="axis" x1={model.plotLeft} y1={model.plotTop} x2={model.plotLeft} y2={model.plotBottom} />
          <line className="axis" x1={model.plotLeft} y1={model.plotBottom} x2={model.plotRight} y2={model.plotBottom} />
          {model.yTicks.map((tick) => <text key={tick.value} x={model.plotLeft - 11} y={tick.y + 4} textAnchor="end">{tick.label}</text>)}
          {model.xTicks.map((tick, index) => <text key={`${tick.label}-${tick.index}`} x={tick.x} y={model.height - 18} textAnchor={index === 0 ? "start" : index === model.xTicks.length - 1 ? "end" : "middle"}>{tick.label}</text>)}
        </g>
        <path className="family-tree-statistics-line-area" d={areaPath} />
        <path className="family-tree-statistics-line-series" d={linePath} />
        {showAllMarkers ? model.points.map((point) => <circle key={`marker-${point.index}`} className="family-tree-statistics-line-marker" cx={point.x} cy={point.y} r="3.5" />) : null}
        {model.points.map((point) => (
          <circle
            key={`${point.row.label}-${point.index}`}
            className={`family-tree-statistics-line-hit${point.row.detailKey ? " actionable" : ""}`}
            tabIndex={point.row.detailKey ? 0 : undefined}
            role={point.row.detailKey ? "button" : undefined}
            aria-label={`${point.row.label}: ${point.row.value.toLocaleString("uk-UA")}`}
            cx={point.x}
            cy={point.y}
            r={hitRadius}
            onPointerEnter={() => setActiveIndex(point.index)}
            onPointerLeave={() => setActiveIndex((current) => current === point.index ? null : current)}
            onFocus={() => setActiveIndex(point.index)}
            onBlur={() => setActiveIndex((current) => current === point.index ? null : current)}
            onClick={() => onOpenDetail(point.row.detailKey, `${chart.title}: ${point.row.label}`)}
            onKeyDown={(event) => {
              if (point.row.detailKey && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                onOpenDetail(point.row.detailKey, `${chart.title}: ${point.row.label}`);
              }
            }}
          />
        ))}
        {activePoint ? (
          <g className="family-tree-statistics-line-active" pointerEvents="none" aria-hidden="true">
            <line x1={activePoint.x} y1={model.plotTop} x2={activePoint.x} y2={model.plotBottom} />
            <circle cx={activePoint.x} cy={activePoint.y} r="5" />
            <g className="tooltip" transform={`translate(${tooltipX} ${tooltipY})`}>
              <rect width={tooltipWidth} height={tooltipHeight} rx="8" />
              <text x="12" y="22">{tooltipLabel}</text>
              <text className="value" x="12" y="44">{activePoint.row.value.toLocaleString("uk-UA")}</text>
            </g>
          </g>
        ) : null}
      </svg>
      {rows.length > 48 ? <p className="family-tree-statistics-line-hint">Наведіть курсор на лінію, щоб побачити точне значення за конкретний рік.</p> : null}
    </div>
  );
}

function ChartAccessibleTable({ chart, onOpenDetail }: { chart: FamilyTreeStatisticsChart; onOpenDetail: (key: string | undefined, title: string) => void }) {
  const labels = chart.seriesLabels ?? ["Значення", "Додатково", "Третій ряд"];
  const hasSecondary = chart.rows.some((row) => row.secondary !== undefined);
  const hasTertiary = chart.rows.some((row) => row.tertiary !== undefined);
  const hasTotal = chart.rows.some((row) => row.total !== undefined);
  const hasPercent = chart.rows.some((row) => row.percent !== undefined);
  return <div className="table-wrap"><table><thead><tr><th>Категорія</th><th>{labels[0] ?? "Значення"}</th>{hasSecondary ? <th>{labels[1] ?? "Додатково"}</th> : null}{hasTertiary ? <th>{labels[2] ?? "Третій ряд"}</th> : null}{hasTotal ? <th>Усього</th> : null}{hasPercent ? <th>Частка</th> : null}</tr></thead><tbody>{chart.rows.map((row, index) => <tr key={`${row.label}-${index}`}><td>{row.detailKey ? <button type="button" className="link-button" onClick={() => onOpenDetail(row.detailKey, `${chart.title}: ${row.label}`)}>{row.label}</button> : row.label}</td><td>{row.value}</td>{hasSecondary ? <td>{row.secondary ?? "—"}</td> : null}{hasTertiary ? <td>{row.tertiary ?? "—"}</td> : null}{hasTotal ? <td>{row.total ?? "—"}</td> : null}{hasPercent ? <td>{row.percent !== undefined ? `${row.percent}%` : "—"}</td> : null}</tr>)}</tbody></table></div>;
}

function StatisticsTableCard({ table }: { table: FamilyTreeStatisticsTable }) {
  return <article className="family-tree-statistics-table-card panel"><header><h2>{table.title}</h2><button type="button" className="button button-secondary" onClick={() => exportStatisticsTableCsv(table)}>CSV</button></header>{table.rows.length ? <div className="table-wrap"><table><thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell ?? "—"}</td>)}</tr>)}</tbody></table></div> : <div className="family-tree-statistics-no-data">Для цієї таблиці немає записів.</div>}</article>;
}

function StatisticsMap({ markers, paths, onOpenDetail }: {
  markers: NonNullable<FamilyTreeStatisticsPayload["map"]>["markers"];
  paths: NonNullable<NonNullable<FamilyTreeStatisticsPayload["map"]>["paths"]>;
  onOpenDetail: (key: string | undefined, title: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [mode, setMode] = useState<"markers" | "heat" | "paths">("markers");
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current).setView([49, 31], 5);
    mapRef.current = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 18 }).addTo(map);
    window.setTimeout(() => map.invalidateSize(), 50);
    return () => { map.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layer = L.layerGroup().addTo(map);
    const bounds: L.LatLngExpression[] = [];
    if (mode === "paths") {
      paths.forEach((path) => {
        const from: L.LatLngExpression = [path.fromLatitude, path.fromLongitude];
        const to: L.LatLngExpression = [path.toLatitude, path.toLongitude];
        bounds.push(from, to);
        L.polyline([from, to], { color: "#b46928", opacity: 0.58, weight: 2 })
          .bindTooltip(`${path.fromLabel} → ${path.toLabel}`)
          .addTo(layer);
      });
    }
    markers.forEach((marker) => {
      const position: L.LatLngExpression = [marker.latitude, marker.longitude];
      bounds.push(position);
      const radius = Math.min(28, 8 + Math.sqrt(Math.max(1, marker.value)) * 2);
      const popup = document.createElement("div");
      const title = document.createElement("strong");
      const summary = document.createElement("span");
      title.textContent = marker.label;
      summary.textContent = `${marker.value.toLocaleString("uk-UA")} подій · ${marker.people.toLocaleString("uk-UA")} осіб`;
      popup.append(title, document.createElement("br"), summary);
      if (marker.detailKey) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "family-tree-statistics-map-detail";
        open.textContent = "Показати осіб";
        open.addEventListener("click", () => onOpenDetail(marker.detailKey, `Місце: ${marker.label}`));
        popup.append(document.createElement("br"), open);
      }
      L.circleMarker(position, mode === "heat"
        ? { radius: Math.min(54, 18 + Math.sqrt(Math.max(1, marker.value)) * 4), stroke: false, fillColor: "#c65d28", fillOpacity: 0.25 }
        : { radius, color: "#0d574f", weight: 2, fillColor: "#2c8d7f", fillOpacity: 0.62 })
        .bindPopup(popup)
        .addTo(layer);
    });
    if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 11 });
    else if (bounds.length === 1) map.setView(bounds[0], 10);
    return () => { layer.remove(); };
  }, [markers, mode, onOpenDetail, paths]);
  return <article className="family-tree-statistics-map-card panel"><header><div><span className="eyebrow">Інтерактивна карта</span><h2>Місця подій дерева</h2></div><div className="family-tree-statistics-map-modes" role="group" aria-label="Режим карти"><button type="button" className={mode === "markers" ? "active" : ""} onClick={() => setMode("markers")}>Маркери</button><button type="button" className={mode === "heat" ? "active" : ""} onClick={() => setMode("heat")}>Теплова карта</button><button type="button" className={mode === "paths" ? "active" : ""} disabled={!paths?.length} onClick={() => setMode("paths")}>Переміщення</button><span>{markers.length.toLocaleString("uk-UA")} місць</span></div></header><div ref={containerRef} className="family-tree-statistics-map" /></article>;
}

function StatisticsPeopleModal({ title, page, loading, error, onOpenPerson, onPage, onClose }: {
  title: string;
  page: FamilyTreeStatisticsPeoplePage | null;
  loading: boolean;
  error: string;
  onOpenPerson?: (personId: string) => void;
  onPage: (offset: number) => void;
  onClose: () => void;
}) {
  const offset = page?.offset ?? 0;
  const limit = page?.limit ?? 50;
  return (
    <Modal title={title} onClose={onClose} className="family-tree-statistics-detail-modal">
      <div className="family-tree-statistics-detail">
        {loading ? <strong>Завантажуємо записи…</strong> : null}
        {error ? <div className="alert alert-error">{error}</div> : null}
        {page ? <><p>Знайдено: <strong>{page.total.toLocaleString("uk-UA")}</strong></p><div className="table-wrap"><table><thead><tr><th>Особа</th><th>Роки життя</th><th>Покоління</th><th>Гілка</th><th>Заповненість</th><th>Джерела</th></tr></thead><tbody>{page.rows.map((person) => <tr key={person.id}><td>{onOpenPerson && person.displayName !== "Приховано" ? <button type="button" className="link-button" onClick={() => onOpenPerson(person.id)}>{person.displayName}</button> : person.displayName}</td><td>{person.birthDate ?? "?"} — {person.deathDate ?? "?"}</td><td>{person.generation}</td><td>{person.branch}</td><td>{person.completeness}%</td><td>{person.hasSources ? "Є" : "Немає"}</td></tr>)}</tbody></table></div><div className="family-tree-statistics-pagination"><button type="button" className="button button-secondary" disabled={offset <= 0} onClick={() => onPage(Math.max(0, offset - limit))}>← Назад</button><span>{offset + 1}–{Math.min(offset + limit, page.total)} з {page.total}</span><button type="button" className="button button-secondary" disabled={offset + limit >= page.total} onClick={() => onPage(offset + limit)}>Далі →</button></div></> : null}
      </div>
    </Modal>
  );
}
