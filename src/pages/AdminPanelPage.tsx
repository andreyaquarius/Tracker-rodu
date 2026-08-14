import { useEffect, useMemo, useState } from "react";
import {
  loadAdminAnalytics,
  type AdminAnalyticsOverview,
  type AdminAnalyticsPageRow,
} from "../services/adminAnalyticsService.ts";
import { PRODUCT_ANALYTICS_PAGE_LABELS } from "../utils/productAnalyticsRegistry.ts";

interface AdminPanelPageProps {
  page: "overview" | "analytics";
  allowed: boolean;
  accessLoading: boolean;
  accountName: string;
  onNavigate: (page: "overview" | "analytics") => void;
  onBack: () => void;
  onSignOut: () => void;
}

const EMPTY_OVERVIEW: AdminAnalyticsOverview = {
  suppressed: false,
  minimumCohort: 5,
  users: 0,
  sessions: 0,
  pageViews: 0,
  activeSeconds: 0,
};

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  if (hours > 0) return `${hours} год ${minutes} хв`;
  if (minutes > 0) return `${minutes} хв`;
  return `${rounded} с`;
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : new Intl.NumberFormat("uk-UA").format(value);
}

export function AdminPanelPage(props: AdminPanelPageProps) {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [pages, setPages] = useState<AdminAnalyticsPageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1_000);
    return { from, to };
  }, [days]);

  useEffect(() => {
    if (!props.allowed) return;
    let active = true;
    setLoading(true);
    setError("");
    void loadAdminAnalytics(range.from, range.to)
      .then((result) => {
        if (!active) return;
        setOverview(result.overview);
        setPages(result.pages);
      })
      .catch(() => {
        if (active) setError("Не вдалося завантажити статистику. Перевірте, чи застосована міграція аналітики.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.allowed, range]);

  if (props.accessLoading) {
    return <main className="admin-access-state"><strong>Перевіряємо права адміністратора…</strong></main>;
  }
  if (!props.allowed) {
    return (
      <main className="admin-access-state">
        <h1>Доступ заборонено</h1>
        <p>Адмін-панель доступна лише адміністраторам Трекера Роду.</p>
        <button type="button" className="button button-primary" onClick={props.onBack}>Повернутися до застосунку</button>
      </main>
    );
  }

  const metricCards = (
    <div className="admin-metric-grid">
      <article><span>Користувачі</span><strong>{formatNumber(overview.users)}</strong></article>
      <article><span>Сесії</span><strong>{formatNumber(overview.sessions)}</strong></article>
      <article><span>Перегляди сторінок</span><strong>{formatNumber(overview.pageViews)}</strong></article>
      <article><span>Активний час</span><strong>{formatDuration(overview.activeSeconds)}</strong></article>
    </div>
  );

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><span>Трекер Роду</span><strong>Адмін-панель</strong></div>
        <nav aria-label="Розділи адмін-панелі">
          <button className={props.page === "overview" ? "active" : ""} onClick={() => props.onNavigate("overview")}>Огляд</button>
          <button className={props.page === "analytics" ? "active" : ""} onClick={() => props.onNavigate("analytics")}>Аналітика застосунку</button>
        </nav>
        <div className="admin-sidebar-footer">
          <button type="button" onClick={props.onBack}>← До застосунку</button>
          <button type="button" onClick={props.onSignOut}>Вийти</button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-header">
          <div>
            <span className="eyebrow">Приватна зона адміністратора</span>
            <h1>{props.page === "overview" ? "Огляд" : "Аналітика застосунку"}</h1>
            <p>{props.accountName}</p>
          </div>
          <label>
            Період
            <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
              <option value={7}>7 днів</option>
              <option value={30}>30 днів</option>
              <option value={90}>90 днів</option>
            </select>
          </label>
        </header>
        {error ? <div className="admin-alert error">{error}</div> : null}
        {overview.suppressed ? (
          <div className="admin-alert">
            Дані приховано: за вибраний період менше {overview.minimumCohort} користувачів.
          </div>
        ) : metricCards}
        {loading ? <div className="admin-loading">Завантажуємо агреговані дані…</div> : null}
        {props.page === "overview" ? (
          <section className="admin-panel-card">
            <h2>Що вже доступно</h2>
            <p>
              Перший безпечний зріз показує кількість користувачів, сесій, переглядів і
              активний час. Власні дії адміністраторів не входять у статистику.
            </p>
            <button type="button" className="button button-primary" onClick={() => props.onNavigate("analytics")}>Відкрити звіт за сторінками</button>
          </section>
        ) : (
          <section className="admin-panel-card">
            <div className="admin-card-heading">
              <div><h2>Використання розділів</h2><p>Показуються лише групи щонайменше з 5 користувачів.</p></div>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-analytics-table">
                <thead><tr><th>Розділ</th><th>Користувачі</th><th>Перегляди</th><th>Активний час</th><th>Середнє на користувача</th></tr></thead>
                <tbody>
                  {pages.map((row) => (
                    <tr key={row.pageCode}>
                      <td>{PRODUCT_ANALYTICS_PAGE_LABELS[row.pageCode] ?? row.pageCode}</td>
                      <td>{formatNumber(row.users)}</td>
                      <td>{formatNumber(row.pageViews)}</td>
                      <td>{formatDuration(row.activeSeconds)}</td>
                      <td>{formatDuration(row.averageActiveSeconds)}</td>
                    </tr>
                  ))}
                  {!loading && pages.length === 0 ? <tr><td colSpan={5}>За вибраний період ще немає достатньої вибірки.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
        )}
        <footer className="admin-privacy-note">
          Без персональних і родинних даних. Малі вибірки приховуються для захисту приватності.
        </footer>
      </main>
    </div>
  );
}
