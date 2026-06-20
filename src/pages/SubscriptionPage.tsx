import { useEffect, useMemo, useState } from "react";
import {
  adminSetSubscription,
  loadAdminSubscriptions,
  loadSubscriptionPlans,
  type AdminSubscriptionRow,
} from "../services/subscriptionService";
import type {
  PlanCode,
  PlanLimit,
  PlanLimitKey,
  SubscriptionContext,
  SubscriptionPlan,
  SubscriptionStatus,
} from "../types/subscription";

interface SubscriptionPageProps {
  context: SubscriptionContext | null;
  trialDaysRemaining: number;
  loading: boolean;
  error: string;
  onRefresh: () => Promise<unknown>;
}

const limitLabels: Record<PlanLimitKey, string> = {
  projects: "Проєкти",
  researches_total: "Дослідження загалом",
  researches_per_project: "Дослідження у проєкті",
  project_members: "Запрошені учасники",
  custom_sections_per_project: "Власні розділи",
  custom_fields_per_project: "Власні поля у стандартних розділах",
  table_imports_per_month: "Імпорти цього місяця",
  hypothesis_ai_reviews_per_month: "AI-аналіз гіпотез",
};

const hiddenPlanLimitKeys = new Set<PlanLimitKey>(["researches_total"]);

export function SubscriptionPage({
  context,
  trialDaysRemaining,
  loading,
  error,
  onRefresh,
}: SubscriptionPageProps) {
  const [plans, setPlans] = useState<Array<{ plan: SubscriptionPlan; limits: PlanLimit[] }>>([]);
  const [adminRows, setAdminRows] = useState<AdminSubscriptionRow[]>([]);
  const [pageError, setPageError] = useState("");

  const refreshPage = async () => {
    setPageError("");
    try {
      const nextPlans = await loadSubscriptionPlans();
      setPlans(nextPlans);
      if (context?.isAdmin) setAdminRows(await loadAdminSubscriptions());
      await onRefresh();
    } catch (loadError) {
      setPageError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити тарифи.");
    }
  };

  useEffect(() => {
    void refreshPage();
  }, [context?.isAdmin]);

  const trialExpired = context?.subscription.status === "expired";
  const isPermanentAdmin = Boolean(context?.isAdmin);
  const statusText = context?.subscription.status === "trialing"
    ? "Пробний доступ"
    : context?.subscription.status === "active"
      ? "Активна"
      : context?.subscription.status === "past_due"
        ? "Очікує оплати"
        : context?.subscription.status === "cancelled"
          ? "Скасована"
          : "Пробний період завершено";
  const usageRows = useMemo(() => {
    if (!context) return [];
    return Object.values(context.limits)
      .filter((limit) => isVisibleLimit(context.effectivePlanCode, limit))
      .map((limit) => ({
        ...limit,
        used: context.usage[limit.key],
      }));
  }, [context]);

  if (loading && !context) return <section className="panel"><p>Завантажуємо тариф…</p></section>;

  return (
    <>
      <div className="page-heading subscription-heading">
        <div>
          <span className="eyebrow">Обліковий запис</span>
          <h1>Тариф і підписка</h1>
          <p>Поточні можливості, використання лімітів і керування доступом.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={() => void refreshPage()}>
          Оновити
        </button>
      </div>

      {error || pageError ? <div className="alert alert-error">{pageError || error}</div> : null}
      {isPermanentAdmin ? (
        <section className="subscription-status-band">
          <div>
            <span className="eyebrow">Адміністратор</span>
            <h2>Безстроковий доступ адміністратора</h2>
          </div>
          <div className="subscription-status-value compact">
            <strong>Назавжди</strong>
          </div>
          <p>Цей акаунт має повний доступ без вибору тарифу, trial-періоду або дати завершення.</p>
        </section>
      ) : context?.subscription.status === "trialing" ? (
        <section className="subscription-status-band">
          <div>
            <span className="eyebrow">Пробний період: повний доступ</span>
            <h2>Пробний доступ до тарифу «Професійний»</h2>
          </div>
          <div className="subscription-status-value">
            <strong>{trialDaysRemaining}</strong>
            <span>днів залишилося</span>
          </div>
          <p>Діє до {formatDate(context.subscription.trialEndsAt)}. Платіжна картка не потрібна.</p>
        </section>
      ) : (
        <section className="subscription-status-band">
          <div>
            <span className="eyebrow">Поточна підписка</span>
            <h2>{context?.plan.name ?? "Безкоштовний"}</h2>
          </div>
          <div className="subscription-status-value compact">
            <strong>{statusText}</strong>
          </div>
          {trialExpired ? <p>Пробний період завершився. Дані збережено, нові дії перевіряються за free-лімітами.</p> : null}
        </section>
      )}

      <section className="subscription-usage-section">
        <div className="section-heading"><h2>Використання</h2></div>
        <div className="usage-grid">
          {usageRows.map((item) => (
            <div className="usage-item" key={item.key}>
              <span>{limitLabels[item.key]}</span>
              <strong>{usageValue(context?.effectivePlanCode ?? "free", item)}</strong>
            </div>
          ))}
        </div>
      </section>

      {!isPermanentAdmin ? (
        <section className="subscription-plans-section">
          <div className="section-heading"><h2>Тарифні плани</h2></div>
          <div className="plan-grid">
            {plans.map(({ plan, limits }) => (
              <article className={`plan-card ${plan.code === context?.effectivePlanCode ? "active" : ""}`} key={plan.id}>
                <div className="plan-card-heading">
                  <h3>{plan.name}</h3>
                  {plan.code === context?.effectivePlanCode ? <span className="status-pill">Поточний</span> : null}
                </div>
                <p>{plan.description}</p>
                <div className="plan-price">{priceLabel(plan)}</div>
                <ul>
                  {limits.filter((limit) => isVisibleLimit(plan.code, limit)).map((limit) => (
                    <li key={limit.key}>
                      <span>{limitLabels[limit.key]}</span>
                      <strong>{planLimitValue(plan.code, limit)}</strong>
                    </li>
                  ))}
                </ul>
                <button type="button" className="button button-secondary" disabled>
                  {plan.code === context?.effectivePlanCode ? "Активний тариф" : "Оплата готується"}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {context?.isAdmin ? (
        <AdminSubscriptions rows={adminRows} onChanged={refreshPage} />
      ) : null}
    </>
  );
}

function AdminSubscriptions({ rows, onChanged }: {
  rows: AdminSubscriptionRow[];
  onChanged: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState("");
  const [adminError, setAdminError] = useState("");
  const [query, setQuery] = useState("");
  const [planFilter, setPlanFilter] = useState<PlanCode | "admin" | "all">("all");
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | "all">("all");
  const [drafts, setDrafts] = useState<Record<string, {
    planCode: PlanCode;
    status: SubscriptionStatus;
    periodEnd: string;
  }>>({});
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("uk");
    return rows.filter((row) => {
      const matchesQuery = !normalizedQuery || [
        row.displayName,
        row.email,
        row.planCode,
        row.status,
        row.isAdmin ? "адміністратор admin" : "",
      ].join(" ").toLocaleLowerCase("uk").includes(normalizedQuery);
      const matchesPlan = planFilter === "all" ||
        (planFilter === "admin" ? row.isAdmin : !row.isAdmin && row.planCode === planFilter);
      const matchesStatus = statusFilter === "all" || row.status === statusFilter;
      return matchesQuery && matchesPlan && matchesStatus;
    });
  }, [rows, query, planFilter, statusFilter]);
  const draftFor = (row: AdminSubscriptionRow) => drafts[row.userId] ?? {
    planCode: row.planCode,
    status: row.status,
    periodEnd: dateInputValue(row.currentPeriodEnd),
  };
  const updateDraft = (row: AdminSubscriptionRow, patch: Partial<ReturnType<typeof draftFor>>) => {
    setDrafts((current) => ({ ...current, [row.userId]: { ...draftFor(row), ...patch } }));
  };
  const change = async (row: AdminSubscriptionRow, grantTrial = false) => {
    const draft = draftFor(row);
    setBusyId(row.userId);
    setAdminError("");
    try {
      await adminSetSubscription({
        userId: row.userId,
        planCode: grantTrial ? "professional" : draft.planCode,
        status: draft.status,
        periodEnd: draft.periodEnd ? new Date(`${draft.periodEnd}T23:59:59`).toISOString() : null,
        grantTrial,
      });
      setDrafts((current) => {
        const next = { ...current };
        delete next[row.userId];
        return next;
      });
      await onChanged();
    } catch (changeError) {
      setAdminError(changeError instanceof Error ? changeError.message : "Не вдалося змінити підписку.");
    } finally {
      setBusyId("");
    }
  };
  return (
    <section className="subscription-admin-section">
      <div className="section-heading"><h2>Адміністрування підписок</h2></div>
      {adminError ? <div className="alert alert-error">{adminError}</div> : null}
      <div className="subscription-admin-filters">
        <label className="search-field">
          <span>Пошук</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ім'я або email користувача"
          />
        </label>
        <label>
          <span>Тариф</span>
          <select value={planFilter} onChange={(event) => setPlanFilter(event.target.value as PlanCode | "admin" | "all")}>
            <option value="all">Усі тарифи</option>
            <option value="admin">Адміністратори</option>
            <option value="free">Безкоштовний</option>
            <option value="researcher">Дослідник</option>
            <option value="professional">Професійний</option>
          </select>
        </label>
        <label>
          <span>Статус</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SubscriptionStatus | "all")}>
            <option value="all">Усі статуси</option>
            <option value="active">Активна</option>
            <option value="trialing">Пробний період</option>
            <option value="past_due">Очікує оплати</option>
            <option value="cancelled">Скасована</option>
            <option value="expired">Завершена</option>
          </select>
        </label>
        <div className="result-count">{filteredRows.length} з {rows.length}</div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Користувач</th><th>Тариф</th><th>Статус</th><th>Завершення</th><th>Дії</th></tr></thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.userId}>
                <td><strong>{row.displayName || row.email}</strong><small>{row.email}</small></td>
                <td>{row.isAdmin ? <span className="status-pill">Адміністратор</span> : row.planCode}</td>
                <td>{row.isAdmin ? "Безстроковий доступ" : row.status}</td>
                <td>{row.isAdmin ? "Назавжди" : formatDate(row.trialEndsAt || row.currentPeriodEnd)}</td>
                <td className="row-actions">
                  {row.isAdmin ? (
                    <span className="subscription-admin-note">Керується через список адміністраторів</span>
                  ) : (
                    <>
                      <select
                        aria-label="Призначити тариф"
                        disabled={busyId === row.userId}
                        value={draftFor(row).planCode}
                        onChange={(event) => updateDraft(row, { planCode: event.target.value as PlanCode })}
                      >
                        <option value="free">Безкоштовний</option>
                        <option value="researcher">Дослідник</option>
                        <option value="professional">Професійний</option>
                      </select>
                      <select
                        aria-label="Статус підписки"
                        disabled={busyId === row.userId}
                        value={draftFor(row).status}
                        onChange={(event) => updateDraft(row, { status: event.target.value as SubscriptionStatus })}
                      >
                        <option value="active">Активна</option>
                        <option value="past_due">Очікує оплати</option>
                        <option value="cancelled">Скасована</option>
                        <option value="expired">Завершена</option>
                      </select>
                      <input
                        type="date"
                        aria-label="Дата завершення підписки"
                        disabled={busyId === row.userId}
                        value={draftFor(row).periodEnd}
                        onChange={(event) => updateDraft(row, { periodEnd: event.target.value })}
                      />
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={busyId === row.userId}
                        onClick={() => void change(row)}
                      >
                        Зберегти
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busyId === row.userId}
                        onClick={() => void change(row, true)}
                      >
                        +30 днів trial
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!filteredRows.length ? (
              <tr>
                <td colSpan={5}>
                  <div className="empty-inline">Немає підписок за вибраними фільтрами.</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function dateInputValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function priceLabel(plan: SubscriptionPlan): string {
  if (plan.code === "free") return "0 грн";
  if (plan.priceMonthly === null) return "Ціну буде оголошено";
  return `${plan.priceMonthly.toLocaleString("uk-UA")} ${plan.currency} / місяць`;
}

function planLimitValue(planCode: PlanCode, limit: PlanLimit): string | number | null {
  if (limit.key === "hypothesis_ai_reviews_per_month" && planCode === "free") {
    return "Власний API-ключ";
  }
  if (limit.isUnlimited) return "Без обмежень";
  return limit.value;
}

function usageValue(
  planCode: PlanCode,
  item: PlanLimit & { used: number },
): string {
  if (item.key === "hypothesis_ai_reviews_per_month" && planCode === "free") {
    return "Власний API-ключ";
  }
  if (item.isUnlimited) return "Без обмежень";
  return `${item.used} із ${item.value ?? 0}`;
}

function isVisibleLimit(planCode: PlanCode, limit: PlanLimit): boolean {
  if (hiddenPlanLimitKeys.has(limit.key)) return false;
  if (limit.key === "hypothesis_ai_reviews_per_month" && planCode === "free") return true;
  return limit.isUnlimited || limit.value !== 0;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("uk-UA", { dateStyle: "long" }).format(new Date(value));
}
