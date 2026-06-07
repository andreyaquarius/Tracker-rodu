import { useMemo, useState } from "react";
import type { AppDatabase } from "../types";
import type { PageKey } from "../components/Sidebar";
import { formatDateTime } from "../utils/dateHelpers";
import { searchDatabase } from "../utils/globalSearch";

export function DashboardPage({
  db,
  onNavigate,
  onOpenSearchResult,
}: {
  db: AppDatabase;
  onNavigate: (page: PageKey) => void;
  onOpenSearchResult: (page: PageKey, query: string, entityId?: string) => void;
}) {
  const [globalQuery, setGlobalQuery] = useState("");
  const stats = [
    ["Дослідження", db.researches.length, "researches" as PageKey],
    ["Документи", db.documents.length, "documents" as PageKey],
    ["Документи в роботі", db.documents.filter((item) => item.reviewStatus === "в роботі").length, "documents" as PageKey],
    ["Переглянуто", db.documents.filter((item) => item.reviewStatus === "переглянуто").length, "documents" as PageKey],
    ["Відкриті завдання", db.tasks.filter((item) => !["закрито", "перевірено"].includes(item.status)).length, "tasks" as PageKey],
    ["Завершені завдання", db.tasks.filter((item) => ["закрито", "перевірено"].includes(item.status)).length, "tasks" as PageKey],
    ["Знахідки", db.findings.length, "findings" as PageKey],
    ["Запити в архів", db.archiveRequests.length, "archiveRequests" as PageKey],
    ["Особи", db.persons.length, "persons" as PageKey],
    ["Активні гіпотези", db.hypotheses.filter((item) => item.status === "активна").length, "hypotheses" as PageKey],
    ["Прогалини в роках", db.yearMatrix.filter((item) => item.status === "прогалина").length, "yearMatrix" as PageKey],
    ["Не перевірені роки", db.yearMatrix.filter((item) => item.status === "не перевірено").length, "yearMatrix" as PageKey],
  ] as const;

  const priorityWeight: Record<string, number> = { критичний: 4, високий: 3, середній: 2, низький: 1 };
  const nextTasks = db.tasks
    .filter((item) => ["не почато", "в роботі"].includes(item.status))
    .sort((a, b) => (priorityWeight[b.priority] ?? 0) - (priorityWeight[a.priority] ?? 0))
    .slice(0, 6);
  const recentActivity = [...db.activityLog]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);
  const globalResults = useMemo(
    () => searchDatabase(db, globalQuery),
    [db, globalQuery],
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
                        onClick={() => onOpenSearchResult(result.page, globalQuery.trim(), result.id)}
                      >
                        <span className={`activity-icon activity-${result.module}`}>
                          {activityIcon(result.page)}
                        </span>
                        <span>
                          <strong>{result.title}</strong>
                          <small>{result.description || result.moduleLabel}</small>
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
        {stats.map(([label, value, page]) => (
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
          <span className="activity-count">Останні {recentActivity.length} дій</span>
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

function moduleLabel(module: PageKey): string {
  const labels: Record<PageKey, string> = {
    dashboard: "Панель огляду",
    researches: "Дослідження",
    documents: "Документи",
    yearMatrix: "Матриця років",
    tasks: "Завдання",
    findings: "Знахідки",
    hypotheses: "Гіпотези",
    archiveRequests: "Запити в архів",
    persons: "Особи",
    backup: "Резервні копії",
    settings: "Налаштування",
  };
  return labels[module];
}

function activityIcon(module: PageKey): string {
  const icons: Record<PageKey, string> = {
    dashboard: "О",
    researches: "Д",
    documents: "Ф",
    yearMatrix: "Р",
    tasks: "З",
    findings: "✓",
    hypotheses: "?",
    archiveRequests: "А",
    persons: "О",
    backup: "↻",
    settings: "Н",
  };
  return icons[module];
}
