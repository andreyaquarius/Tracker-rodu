import { useCallback, useEffect, useMemo, useState } from "react";
import {
  loadAdminAnalytics,
  loadAdminAnalyticsActions,
  loadAdminAnalyticsFunnel,
  loadAdminAnalyticsPreferences,
  loadAdminAnalyticsRetention,
  saveAdminAnalyticsPreferences,
  type AdminAnalyticsActionRow,
  type AdminAnalyticsFunnel,
  type AdminAnalyticsFunnelCode,
  type AdminAnalyticsOverview,
  type AdminAnalyticsPageRow,
  type AdminAnalyticsPeriodDays,
  type AdminAnalyticsRetentionRow,
} from "../services/adminAnalyticsService.ts";
import {
  ADMIN_PERMISSION_CODES,
  loadAdminCapabilities,
  loadAdminSecurityAudit,
  loadAdminSystemHealth,
  type AdminCapabilities,
  type AdminPermissionCode,
  type AdminSecurityAuditRow,
  type AdminSystemHealth,
} from "../services/adminConsoleService.ts";
import {
  loadAdminFeatureFlags,
  loadAdminSubscriptions,
  type AdminSubscriptionRow,
  type AppFeatureFlag,
} from "../services/subscriptionService.ts";
import { loadAdminAnnouncements } from "../services/announcementService.ts";
import type { SupabaseAccount } from "../services/supabaseAuth.ts";
import type { AppAnnouncement } from "../types/announcements.ts";
import type { AdminPage } from "../utils/appRoutes.ts";
import {
  PRODUCT_ANALYTICS_ACTION_LABELS,
  PRODUCT_ANALYTICS_PAGE_LABELS,
} from "../utils/productAnalyticsRegistry.ts";
import {
  AdminAnnouncements,
  AdminFeatureFlags,
  AdminSubscriptions,
} from "./SubscriptionPage.tsx";
import { FeedbackPage } from "./FeedbackPage.tsx";
import { ZagulyakyModerationPanel } from "../components/admin/ZagulyakyModerationPanel.tsx";

interface AdminPanelPageProps {
  page: AdminPage;
  allowed: boolean;
  accessLoading: boolean;
  account: SupabaseAccount | null;
  onNavigate: (page: AdminPage) => void;
  onBack: () => void;
  onSignOut: () => void;
  onFeatureFlagsChanged?: () => void;
}

const EMPTY_OVERVIEW: AdminAnalyticsOverview = {
  suppressed: false,
  minimumCohort: 5,
  users: 0,
  sessions: 0,
  pageViews: 0,
  activeSeconds: 0,
};

const ADMIN_PAGE_TITLES: Record<AdminPage, string> = {
  overview: "Огляд",
  analytics: "Аналітика застосунку",
  subscriptions: "Тарифи й підписки",
  features: "Функції",
  announcements: "Оголошення",
  feedback: "Звернення",
  zagulyaky: "Модерація загуляк",
  operations: "Фонові операції",
  security: "Безпека й аудит",
};

const ADMIN_NAVIGATION: Array<{
  page: AdminPage;
  label: string;
  permission?: AdminPermissionCode;
}> = [
  { page: "overview", label: "Огляд" },
  { page: "analytics", label: "Аналітика", permission: ADMIN_PERMISSION_CODES.analyticsView },
  { page: "subscriptions", label: "Тарифи й підписки", permission: ADMIN_PERMISSION_CODES.billingManage },
  { page: "features", label: "Функції", permission: ADMIN_PERMISSION_CODES.featuresManage },
  { page: "announcements", label: "Оголошення", permission: ADMIN_PERMISSION_CODES.contentManage },
  { page: "feedback", label: "Звернення", permission: ADMIN_PERMISSION_CODES.supportManage },
  { page: "zagulyaky", label: "Загуляки", permission: ADMIN_PERMISSION_CODES.zagulyakyModerate },
  { page: "operations", label: "Фонові операції", permission: ADMIN_PERMISSION_CODES.operationsManage },
  { page: "security", label: "Безпека й аудит", permission: ADMIN_PERMISSION_CODES.securityView },
];

const FUNNEL_LABELS: Record<AdminAnalyticsFunnelCode, string> = {
  onboarding: "Перший шлях користувача",
  gedcom_import: "Імпорт GEDCOM → дерево",
  document_research: "Документ → знахідка",
  ai_hypothesis: "Перевірка гіпотези ШІ",
};

const FUNNEL_STEP_LABELS: Record<string, string> = {
  session_start: "Авторизована сесія",
  project_open: "Відкрито проєкт",
  person_create: "Створено особу",
  tree_open: "Відкрито дерево",
  import_start: "Розпочато імпорт",
  import_complete: "Імпорт завершено",
  document_create: "Створено документ",
  viewer_open: "Відкрито переглядач",
  finding_create: "Створено знахідку",
  ai_start: "Запущено перевірку",
  ai_success: "Перевірку завершено",
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

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** exponent);
  return `${new Intl.NumberFormat("uk-UA", { maximumFractionDigits: exponent === 0 ? 0 : 1 }).format(amount)} ${units[exponent]}`;
}

function metricDelta(current: number | null, previous: number | null): string {
  if (current === null || previous === null || previous === 0) return "";
  const percent = Math.round(((current - previous) / previous) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}% до попереднього періоду`;
}

function downloadAggregateCsv(
  fileName: string,
  headers: string[],
  rows: Array<Array<string | number | null>>,
): void {
  const escape = (value: string | number | null) => {
    const text = value === null ? "" : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(escape).join(";")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AdminPanelPage(props: AdminPanelPageProps) {
  const currentPage = props.page;
  const navigateAdmin = props.onNavigate;
  const [days, setDays] = useState<AdminAnalyticsPeriodDays>(30);
  const [funnelCode, setFunnelCode] = useState<AdminAnalyticsFunnelCode>("onboarding");
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [previousOverview, setPreviousOverview] = useState(EMPTY_OVERVIEW);
  const [pages, setPages] = useState<AdminAnalyticsPageRow[]>([]);
  const [actions, setActions] = useState<AdminAnalyticsActionRow[]>([]);
  const [retention, setRetention] = useState<AdminAnalyticsRetentionRow[]>([]);
  const [funnel, setFunnel] = useState<AdminAnalyticsFunnel | null>(null);
  const [capabilities, setCapabilities] = useState<AdminCapabilities | null>(null);
  const [capabilitiesResolved, setCapabilitiesResolved] = useState(false);
  const [analyticsPreferencesResolved, setAnalyticsPreferencesResolved] = useState(false);
  const [subscriptions, setSubscriptions] = useState<AdminSubscriptionRow[]>([]);
  const [featureFlags, setFeatureFlags] = useState<AppFeatureFlag[]>([]);
  const [announcements, setAnnouncements] = useState<AppAnnouncement[]>([]);
  const [systemHealth, setSystemHealth] = useState<AdminSystemHealth | null>(null);
  const [securityAudit, setSecurityAudit] = useState<AdminSecurityAuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1_000);
    const previousFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1_000);
    return { from, to, previousFrom };
  }, [days]);
  const requiredPermission = ADMIN_NAVIGATION.find((item) => item.page === currentPage)?.permission;
  const canSee = (permission?: AdminPermissionCode) => !permission
    || capabilities?.permissions.includes(permission) === true;
  const hasPagePermission = canSee(requiredPermission);
  const hasAnalyticsPermission = canSee(ADMIN_PERMISSION_CODES.analyticsView);

  const refreshSubscriptions = useCallback(async () => {
    setSubscriptions(await loadAdminSubscriptions());
  }, []);
  const refreshFeatures = useCallback(async () => {
    setFeatureFlags(await loadAdminFeatureFlags());
  }, []);
  const refreshAnnouncements = useCallback(async () => {
    setAnnouncements(await loadAdminAnnouncements());
  }, []);
  const refreshSystemHealth = useCallback(async () => {
    setSystemHealth(await loadAdminSystemHealth());
  }, []);

  useEffect(() => {
    if (!props.allowed) {
      setCapabilities(null);
      setCapabilitiesResolved(true);
      return;
    }
    let active = true;
    setCapabilitiesResolved(false);
    void loadAdminCapabilities()
      .then((nextCapabilities) => {
        if (active) setCapabilities(nextCapabilities);
      })
      .catch(() => {
        if (active) setCapabilities(null);
      })
      .finally(() => {
        if (active) setCapabilitiesResolved(true);
      });
    return () => { active = false; };
  }, [props.allowed]);

  useEffect(() => {
    if (!props.allowed || !hasAnalyticsPermission) {
      setAnalyticsPreferencesResolved(false);
      return;
    }
    let active = true;
    setAnalyticsPreferencesResolved(false);
    void loadAdminAnalyticsPreferences()
      .then((preferences) => {
        if (!active) return;
        setDays(preferences.periodDays);
        setFunnelCode(preferences.funnelCode);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setAnalyticsPreferencesResolved(true);
      });
    return () => { active = false; };
  }, [hasAnalyticsPermission, props.allowed]);

  useEffect(() => {
    if (!analyticsPreferencesResolved || !hasAnalyticsPermission) return;
    const timer = window.setTimeout(() => {
      void saveAdminAnalyticsPreferences({ periodDays: days, funnelCode }).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [analyticsPreferencesResolved, days, funnelCode, hasAnalyticsPermission]);

  useEffect(() => {
    if (!props.allowed || !hasAnalyticsPermission || !analyticsPreferencesResolved || (props.page !== "overview" && props.page !== "analytics")) return;
    let active = true;
    setLoading(true);
    setError("");
    void Promise.all([
      loadAdminAnalytics(range.from, range.to),
      loadAdminAnalytics(range.previousFrom, range.from),
      loadAdminAnalyticsActions(range.from, range.to),
      loadAdminAnalyticsRetention(range.from, range.to),
      loadAdminAnalyticsFunnel(range.from, range.to, funnelCode),
    ]).then(([current, previous, nextActions, nextRetention, nextFunnel]) => {
      if (!active) return;
      setOverview(current.overview);
      setPages(current.pages);
      setPreviousOverview(previous.overview);
      setActions(nextActions);
      setRetention(nextRetention);
      setFunnel(nextFunnel);
    }).catch(() => {
      if (active) setError("Не вдалося завантажити повний звіт. Застосуйте нову міграцію аналітики.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [analyticsPreferencesResolved, funnelCode, hasAnalyticsPermission, props.allowed, props.page, range]);

  useEffect(() => {
    if (!props.allowed || !hasPagePermission || ["overview", "analytics", "zagulyaky"].includes(currentPage)) return;
    let active = true;
    setLoading(true);
    setError("");
    const request = props.page === "subscriptions" ? refreshSubscriptions()
      : props.page === "features" ? refreshFeatures()
      : props.page === "announcements" ? refreshAnnouncements()
      : props.page === "operations" ? refreshSystemHealth()
      : props.page === "security"
        ? loadAdminSecurityAudit().then((rows) => { if (active) setSecurityAudit(rows); })
        : Promise.resolve();
    void request.catch(() => {
      if (active) setError("Не вдалося завантажити цей розділ адмін-панелі.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [currentPage, hasPagePermission, props.allowed, props.page, refreshAnnouncements, refreshFeatures, refreshSubscriptions, refreshSystemHealth]);

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
  if (!capabilitiesResolved) {
    return <main className="admin-access-state"><strong>Завантажуємо адміністративні дозволи…</strong></main>;
  }
  if (!capabilities) {
    return (
      <main className="admin-access-state">
        <h1>Не вдалося перевірити дозволи</h1>
        <p>Адміністративні дані не завантажувалися. Перевірте застосування міграцій адмін-панелі.</p>
        <button type="button" className="button button-primary" onClick={props.onBack}>Повернутися до застосунку</button>
      </main>
    );
  }
  if (!hasPagePermission) {
    return (
      <main className="admin-access-state">
        <h1>Недостатньо дозволів</h1>
        <p>Ваша адміністративна роль не має доступу до цього розділу.</p>
        <button type="button" className="button button-primary" onClick={() => navigateAdmin("overview")}>До огляду адмін-панелі</button>
      </main>
    );
  }
  const metricCards = (
    <div className="admin-metric-grid">
      {([
        ["Користувачі", overview.users, previousOverview.users, false],
        ["Сесії", overview.sessions, previousOverview.sessions, false],
        ["Перегляди сторінок", overview.pageViews, previousOverview.pageViews, false],
        ["Активний час", overview.activeSeconds, previousOverview.activeSeconds, true],
      ] as const).map(([label, value, previous, duration]) => (
        <article key={label}>
          <span>{label}</span>
          <strong>{duration ? formatDuration(value) : formatNumber(value)}</strong>
          <small>{metricDelta(value, previous)}</small>
        </article>
      ))}
    </div>
  );

  const analyticsReport = (
    <div className="admin-report-stack">
      <section className="admin-panel-card">
        <div className="admin-card-heading">
          <div><h2>Використання розділів</h2><p>Лише агреговані групи щонайменше з 5 користувачів.</p></div>
          <button type="button" className="button button-secondary" onClick={() => downloadAggregateCsv(
            "tracker-pages.csv",
            ["Розділ", "Користувачі", "Перегляди", "Активний час, с"],
            pages.map((row) => [PRODUCT_ANALYTICS_PAGE_LABELS[row.pageCode] ?? row.pageCode, row.users, row.pageViews, row.activeSeconds]),
          )}>CSV</button>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-analytics-table">
            <thead><tr><th>Розділ</th><th>Користувачі</th><th>Перегляди</th><th>Активний час</th><th>Середнє</th></tr></thead>
            <tbody>
              {pages.map((row) => (
                <tr key={row.pageCode}>
                  <td>{PRODUCT_ANALYTICS_PAGE_LABELS[row.pageCode] ?? row.pageCode}</td>
                  <td>{formatNumber(row.users)}</td><td>{formatNumber(row.pageViews)}</td>
                  <td>{formatDuration(row.activeSeconds)}</td><td>{formatDuration(row.averageActiveSeconds)}</td>
                </tr>
              ))}
              {!loading && pages.length === 0 ? <tr><td colSpan={5}>Ще немає достатньої вибірки.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel-card">
        <div className="admin-card-heading">
          <div><h2>Дії та надійність</h2><p>Результати й тривалість зберігаються лише грубими категоріями.</p></div>
          <button type="button" className="button button-secondary" onClick={() => downloadAggregateCsv(
            "tracker-actions.csv",
            ["Дія", "Користувачі", "Виклики", "Успішні", "Помилки", "Успішність"],
            actions.map((row) => [PRODUCT_ANALYTICS_ACTION_LABELS[row.actionCode] ?? row.actionCode, row.users, row.invocations, row.successes, row.failures, row.successRate]),
          )}>CSV</button>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-analytics-table">
            <thead><tr><th>Дія</th><th>Користувачі</th><th>Виклики</th><th>Завершено</th><th>Помилки</th><th>Успішність</th></tr></thead>
            <tbody>
              {actions.map((row) => (
                <tr key={row.actionCode}>
                  <td>{PRODUCT_ANALYTICS_ACTION_LABELS[row.actionCode] ?? row.actionCode}</td>
                  <td>{formatNumber(row.users)}</td><td>{formatNumber(row.invocations)}</td>
                  <td>{formatNumber(row.completions)}</td><td>{formatNumber(row.failures)}</td>
                  <td>{formatPercent(row.successRate)}</td>
                </tr>
              ))}
              {!loading && actions.length === 0 ? <tr><td colSpan={6}>Ще немає достатньої вибірки.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel-card">
        <div className="admin-card-heading">
          <div><h2>Воронка</h2><p>Кількість користувачів, які досягли кожного етапу за період.</p></div>
          <select value={funnelCode} onChange={(event) => setFunnelCode(event.target.value as AdminAnalyticsFunnelCode)}>
            {Object.entries(FUNNEL_LABELS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </div>
        {funnel?.suppressed ? <div className="admin-alert">Воронку приховано: менше 5 користувачів.</div> : (
          <div className="admin-funnel">
            {(funnel?.steps ?? []).map((step) => (
              <article key={step.stepCode}>
                <div><strong>{FUNNEL_STEP_LABELS[step.stepCode] ?? step.stepCode}</strong><span>{formatNumber(step.actors)} · {formatPercent(step.conversionPercent)}</span></div>
                <div className="admin-funnel-track"><span style={{ width: `${Math.max(2, step.conversionPercent)}%` }} /></div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="admin-panel-card">
        <div className="admin-card-heading">
          <div><h2>Утримання D1 / D7 / D30</h2><p>Тижневі когорти менш ніж із 5 користувачів не показуються.</p></div>
          <button type="button" className="button button-secondary" onClick={() => downloadAggregateCsv(
            "tracker-retention.csv",
            ["Тиждень", "Тариф", "Когорта", "D1 %", "D7 %", "D30 %"],
            retention.map((row) => [row.cohortWeek, row.planCode, row.cohortSize, row.d1Percent, row.d7Percent, row.d30Percent]),
          )}>CSV</button>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-analytics-table">
            <thead><tr><th>Тиждень</th><th>Тариф</th><th>Когорта</th><th>D1</th><th>D7</th><th>D30</th></tr></thead>
            <tbody>
              {retention.map((row) => (
                <tr key={`${row.cohortWeek}-${row.planCode}`}>
                  <td>{row.cohortWeek}</td><td>{row.planCode}</td><td>{row.cohortSize}</td>
                  <td>{formatPercent(row.d1Percent)}</td><td>{formatPercent(row.d7Percent)}</td><td>{formatPercent(row.d30Percent)}</td>
                </tr>
              ))}
              {!loading && retention.length === 0 ? <tr><td colSpan={6}>Ще немає достатньої вибірки.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );

  let pageContent: React.ReactNode;
  if (currentPage === "overview") {
    pageContent = (
      <section className="admin-panel-card">
        <h2>Центр керування</h2>
        <p>Аналітика, підтримка, підписки, оголошення, безпека та стан фонових процесів зібрані в одному місці.</p>
        <div className="admin-shortcut-grid">
          {ADMIN_NAVIGATION.filter((item) => item.page !== "overview" && canSee(item.permission)).map((item) => (
            <button type="button" key={item.page} onClick={() => navigateAdmin(item.page)}>
              <strong>{item.label}</strong><span>Відкрити розділ →</span>
            </button>
          ))}
        </div>
      </section>
    );
  } else if (currentPage === "analytics") pageContent = analyticsReport;
  else if (currentPage === "subscriptions") pageContent = <AdminSubscriptions rows={subscriptions} onChanged={refreshSubscriptions} />;
  else if (currentPage === "features") pageContent = (
    <AdminFeatureFlags
      flags={featureFlags}
      loadError=""
      onChanged={async () => {
        try {
          await refreshFeatures();
        } finally {
          // The mutation may have succeeded even if refreshing this list
          // failed. Re-resolve the signed-in account's effective access in
          // either case so the application cannot keep a stale permission.
          props.onFeatureFlagsChanged?.();
        }
      }}
    />
  );
  else if (currentPage === "announcements") pageContent = <AdminAnnouncements announcements={announcements} loadError="" onChanged={refreshAnnouncements} />;
  else if (currentPage === "feedback") pageContent = props.account ? <FeedbackPage account={props.account} isAdmin /> : <div className="admin-alert">Обліковий запис недоступний.</div>;
  else if (currentPage === "zagulyaky") pageContent = <ZagulyakyModerationPanel />;
  else if (currentPage === "operations") {
    pageContent = (
      <section className="admin-panel-card">
        <div className="admin-card-heading"><div><h2>Стан фонових операцій</h2><p>Без вмісту файлів, імен користувачів або проєктних даних.</p></div><button type="button" className="button button-secondary" onClick={() => void refreshSystemHealth()}>Оновити</button></div>
        {systemHealth ? (
          <div className="admin-health-grid">
            <article><span>Події аналітики за 24 год</span><strong>{formatNumber(systemHealth.analyticsEvents24h)}</strong></article>
            <article><span>Імпорти GEDCOM</span><strong>{systemHealth.gedcomImports.active}</strong><small>зависли: {systemHealth.gedcomImports.stalled}</small></article>
            <article><span>Експорти GEDCOM</span><strong>{systemHealth.gedcomExports.queued + systemHealth.gedcomExports.processing}</strong><small>помилки: {systemHealth.gedcomExports.failed}</small></article>
            <article><span>Видалення проєктів</span><strong>{systemHealth.projectDeletions.queued + systemHealth.projectDeletions.running}</strong><small>помилки: {systemHealth.projectDeletions.failed}</small></article>
            <article><span>Supabase Storage</span><strong>{formatBytes(systemHealth.storage.bytes)}</strong><small>{formatNumber(systemHealth.storage.objects)} об’єктів</small></article>
          </div>
        ) : <div className="admin-loading">Дані ще не завантажені.</div>}
        {systemHealth?.storage.buckets.length ? (
          <div className="admin-table-wrap">
            <table className="admin-analytics-table">
              <thead><tr><th>Bucket</th><th>Об’єкти</th><th>Обсяг</th></tr></thead>
              <tbody>{systemHealth.storage.buckets.map((bucket) => (
                <tr key={bucket.bucketId}><td>{bucket.bucketId}</td><td>{formatNumber(bucket.objects)}</td><td>{formatBytes(bucket.bytes)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
      </section>
    );
  } else {
    pageContent = (
      <div className="admin-report-stack">
        <section className="admin-panel-card">
          <h2>Ваші адміністративні дозволи</h2>
          <p>Ролі: {capabilities?.roles.join(", ") || "не завантажено"}</p>
          <p>Дозволи: {capabilities?.permissions.join(", ") || "не завантажено"}</p>
        </section>
        <section className="admin-panel-card">
          <h2>Журнал адміністративних дій</h2>
          <div className="admin-table-wrap">
            <table className="admin-analytics-table">
              <thead><tr><th>Час</th><th>Дія</th><th>Тип об’єкта</th><th>Результат</th></tr></thead>
              <tbody>
                {securityAudit.map((row, index) => <tr key={`${row.createdAt}-${index}`}><td>{new Date(row.createdAt).toLocaleString("uk-UA")}</td><td>{row.actionCode}</td><td>{row.targetType ?? "—"}</td><td>{row.outcome}</td></tr>)}
                {!securityAudit.length ? <tr><td colSpan={4}>Записів ще немає.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    );
  }

  const showMetrics = hasAnalyticsPermission
    && (currentPage === "overview" || currentPage === "analytics");
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><span>Трекер Роду</span><strong>Адмін-панель</strong></div>
        <nav aria-label="Розділи адмін-панелі">
          {ADMIN_NAVIGATION.filter((item) => canSee(item.permission)).map((item) => (
            <button key={item.page} className={currentPage === item.page ? "active" : ""} onClick={() => navigateAdmin(item.page)}>{item.label}</button>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <button type="button" onClick={props.onBack}>← До застосунку</button>
          <button type="button" onClick={props.onSignOut}>Вийти</button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-header">
          <div><span className="eyebrow">Приватна зона адміністратора</span><h1>{ADMIN_PAGE_TITLES[currentPage]}</h1><p>{props.account?.name ?? "Адміністратор"}</p></div>
          {showMetrics ? (
            <label>Період<select value={days} onChange={(event) => setDays(Number(event.target.value) as AdminAnalyticsPeriodDays)}><option value={7}>7 днів</option><option value={30}>30 днів</option><option value={90}>90 днів</option></select></label>
          ) : null}
        </header>
        {error ? <div className="admin-alert error">{error}</div> : null}
        {showMetrics && overview.suppressed ? <div className="admin-alert">Дані приховано: за період менше {overview.minimumCohort} користувачів.</div> : null}
        {showMetrics && !overview.suppressed ? metricCards : null}
        {loading ? <div className="admin-loading">Завантажуємо дані…</div> : null}
        {pageContent}
        <footer className="admin-privacy-note">{currentPage === "zagulyaky"
          ? "Модерація охоплює лише записи публічного каталогу. Приватні родові дерева користувачів не відкриваються."
          : "Аналітика не містить персональних, родинних чи документних даних. Малі вибірки приховуються."}</footer>
      </main>
    </div>
  );
}
