import { useEffect, useMemo, useState } from "react";
import type { AppDatabase } from "../types";
import type { PageKey } from "../components/Sidebar";
import type {
  ProjectDashboardStats,
  ProjectDashboardTask,
} from "../services/projectDashboard";
import { formatDateTime } from "../utils/dateHelpers";
import {
  createGlobalSearchIndex,
  type HighlightRange,
} from "../utils/globalSearch";

export function DashboardPage({
  db,
  stats,
  dashboardTasks,
  onNavigate,
  onOpenSearchResult,
  onRequestSearchData,
}: {
  db: AppDatabase;
  stats: ProjectDashboardStats;
  dashboardTasks: ProjectDashboardTask[];
  onNavigate: (page: PageKey) => void;
  onOpenSearchResult: (page: PageKey, query: string, entityId?: string) => void;
  onRequestSearchData: () => void;
}) {
  const [globalQuery, setGlobalQuery] = useState("");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const statCards = [
    ["Дослідження", stats.researches, "researches" as PageKey],
    ["Документи", stats.documents, "documents" as PageKey],
    ["Документи в роботі", stats.documentsInProgress, "documents" as PageKey],
    ["Переглянуто", stats.documentsReviewed, "documents" as PageKey],
    ["Відкриті завдання", stats.openTasks, "tasks" as PageKey],
    ["Завершені завдання", stats.completedTasks, "tasks" as PageKey],
    ["Знахідки", stats.findings, "findings" as PageKey],
    ["Запити в архів", stats.archiveRequests, "archiveRequests" as PageKey],
    ["Особи", stats.persons, "persons" as PageKey],
    ["Активні гіпотези", stats.activeHypotheses, "hypotheses" as PageKey],
    ["Прогалини в роках", stats.yearGaps, "yearMatrix" as PageKey],
    ["Не перевірені роки", stats.uncheckedYears, "yearMatrix" as PageKey],
  ] as const;

  const priorityWeight: Record<string, number> = { критичний: 4, високий: 3, середній: 2, низький: 1 };
  const nextTasks = [...dashboardTasks]
    .sort((a, b) => (priorityWeight[b.priority] ?? 0) - (priorityWeight[a.priority] ?? 0))
    .slice(0, 6);
  const sortedActivity = [...db.activityLog]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const recentActivity = showAllActivity
    ? sortedActivity
    : sortedActivity.slice(0, 10);
  const globalSearchIndex = useMemo(() => createGlobalSearchIndex(db), [db]);
  const globalResults = useMemo(
    () => globalSearchIndex.search(globalQuery),
    [globalQuery, globalSearchIndex],
  );
  const groupedResults = useMemo(
    () => Object.entries(
      globalResults.reduce<Record<string, typeof globalResults>>((groups, result) => {
        (groups[result.moduleLabel] ??= []).push(result);
        return groups;
      }, {}),
    ),
    [globalResults],
  );

  useEffect(() => {
    if (globalQuery.trim().length >= 2) {
      onRequestSearchData();
    }
  }, [globalQuery, onRequestSearchData]);

  return (
    <>
      <div className="hero">
        <div>
          <span className="eyebrow">Не губи сліди свого роду</span>
          <h1>Добрий день{db.settings.researcherName ? `, ${db.settings.researcherName}` : ""}</h1>
          <p>Ведіть документи, завдання, знахідки, гіпотези та прогалини по роках в одному місці.</p>
        </div>
        <button className="button button-primary" onClick={() => onNavigate("tasks")}>Перейти до завдань</button>
      </div>

      <section className="panel global-search-panel">
        <div className="global-search-heading">
          <div>
            <span className="eyebrow">Пошук по всьому застосунку</span>
            <h2>Знайдіть будь-який запис</h2>
          </div>
          {globalQuery.trim().length >= 2 ? (
            <span className="global-result-count">{globalResults.length} результатів</span>
          ) : null}
        </div>
        <label className="global-search-input">
          <span>Глобальний пошук</span>
          <div>
            <span className="search-symbol">⌕</span>
            <input
              value={globalQuery}
              onChange={(event) => setGlobalQuery(event.target.value)}
              placeholder="Прізвище, населений пункт, документ, рік, архів, завдання…"
            />
            {globalQuery ? (
              <button type="button" onClick={() => setGlobalQuery("")} aria-label="Очистити пошук">
                ×
              </button>
            ) : null}
          </div>
        </label>
        {globalQuery.trim().length >= 2 ? (
          globalResults.length ? (
            <div className="global-search-results">
              {groupedResults.map(([label, results]) => (
                <section key={label}>
                  <h3>{label}<span>{results.length}</span></h3>
                  <div>
                    {results.map((result) => (
                      <button
                        type="button"
                        key={`${result.module}-${result.id}`}
                        onClick={() => onOpenSearchResult(
                          result.page,
                          globalQuery.trim(),
                          result.entityId,
                        )}
                      >
                        <span className={`activity-icon activity-${result.module}`}>
                          {activityIcon(result.page)}
                        </span>
                        <span>
                          <strong>
                            <HighlightedText text={result.title} ranges={result.titleMatches} />
                          </strong>
                          <small>
                            <HighlightedText
                              text={result.description || result.moduleLabel}
                              ranges={result.descriptionMatches}
                            />
                          </small>
                        </span>
                        <span className="activity-arrow">→</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="global-search-empty">За запитом «{globalQuery.trim()}» нічого не знайдено.</div>
          )
        ) : (
          <p className="global-search-hint">Введіть щонайменше 2 символи. Пошук охоплює всі робочі розділи.</p>
        )}
      </section>

      <section className="stat-grid">
        {statCards.map(([label, value, page]) => (
          <button className="stat-card" key={label} onClick={() => onNavigate(page)}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>Переглянути →</small>
          </button>
        ))}
      </section>

      <section className="panel dashboard-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">У фокусі</span>
            <h2>Наступні дії</h2>
          </div>
          <button className="text-button" onClick={() => onNavigate("tasks")}>Усі завдання</button>
        </div>
        {nextTasks.length ? (
          <div className="task-list">
            {nextTasks.map((task) => (
              <button key={task.id} onClick={() => onNavigate("tasks")}>
                <span className={`priority priority-${task.priority}`}>{task.priority}</span>
                <div><strong>{task.title}</strong><small>{task.personName || task.place || "Без уточнення"}</small></div>
                <span className="status-pill">{task.status}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-inline">Немає відкритих завдань. Час зафіксувати наступний крок.</div>
        )}
      </section>

      <section className="panel dashboard-panel activity-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Історія роботи</span>
            <h2>Журнал активності</h2>
          </div>
          <div className="activity-heading-actions">
            <span className="activity-count">
              {showAllActivity ? `Усі ${recentActivity.length} дій` : `Останні ${recentActivity.length} дій`}
            </span>
            {sortedActivity.length > 10 ? (
              <button
                type="button"
                className="text-button"
                onClick={() => setShowAllActivity((current) => !current)}
              >
                {showAllActivity ? "Показати останні 10" : `Показати всі (${sortedActivity.length})`}
              </button>
            ) : null}
          </div>
        </div>
        {recentActivity.length ? (
          <div className="activity-list">
            {recentActivity.map((activity) => (
              <button
                type="button"
                key={activity.id}
                onClick={() => onNavigate(activity.module)}
              >
                <span className={`activity-icon activity-${activity.module}`}>
                  {activityIcon(activity.module)}
                </span>
                <div>
                  <strong>{activity.text}</strong>
                  <small>
                    {moduleLabel(activity.module)} · {formatDateTime(activity.createdAt)}
                  </small>
                </div>
                <span className="activity-arrow">→</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-inline">
            Журнал поки порожній. Нові дії з’являтимуться тут автоматично.
          </div>
        )}
      </section>
    </>
  );
}

function HighlightedText({
  text,
  ranges,
}: {
  text: string;
  ranges: HighlightRange[];
}) {
  if (!ranges.length) return text;
  const merged = [...ranges]
    .sort((a, b) => a[0] - b[0])
    .reduce<Array<[number, number]>>((result, [from, to]) => {
      const last = result[result.length - 1];
      if (last && from <= last[1] + 1) {
        last[1] = Math.max(last[1], to);
      } else {
        result.push([from, to]);
      }
      return result;
    }, []);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [from, to] of merged) {
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(<mark key={`${from}-${to}`}>{text.slice(from, to + 1)}</mark>);
    cursor = to + 1;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function moduleLabel(module: PageKey): string {
  if (module.startsWith("custom:")) return "Власний розділ";
  const labels: Record<Exclude<PageKey, `custom:${string}`>, string> = {
    dashboard: "Панель огляду",
    map: "Карта",
    researches: "Дослідження",
    documents: "Документи",
    yearMatrix: "Матриця років",
    tasks: "Завдання",
    findings: "Знахідки",
    hypotheses: "Гіпотези",
    archiveRequests: "Запити в архів",
    persons: "Особи",
    backup: "Резервні копії",
    subscription: "Тариф і підписка",
    settings: "Налаштування",
  };
  return labels[module as Exclude<PageKey, `custom:${string}`>];
}

function activityIcon(module: PageKey): string {
  if (module.startsWith("custom:")) return "Р";
  const icons: Record<Exclude<PageKey, `custom:${string}`>, string> = {
    dashboard: "О",
    map: "К",
    researches: "Д",
    documents: "Ф",
    yearMatrix: "Р",
    tasks: "З",
    findings: "✓",
    hypotheses: "?",
    archiveRequests: "А",
    persons: "О",
    backup: "↻",
    subscription: "₴",
    settings: "Н",
  };
  return icons[module as Exclude<PageKey, `custom:${string}`>];
}
