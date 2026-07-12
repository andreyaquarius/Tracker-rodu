import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  adminSetFeatureFlag,
  adminSetSubscription,
  cancelMySubscription,
  loadAdminFeatureFlags,
  loadAdminSubscriptions,
  loadSubscriptionPlans,
  subscriptionErrorMessage,
  type AppFeatureFlag,
  type AdminSubscriptionRow,
} from "../services/subscriptionService";
import {
  adminSetFamilyTreeFeatureAccess,
  loadAdminFamilyTreeFeatureAccess,
  type FamilyTreeFeatureAccessUser,
} from "../services/familyTreeFeatureAccess";
import {
  adminDeleteAnnouncement,
  adminSaveAnnouncement,
  loadAdminAnnouncements,
  sendAnnouncementEmail,
} from "../services/announcementService";
import type {
  AdminAnnouncementInput,
  AnnouncementCategory,
  AnnouncementEmailStatus,
  AnnouncementMediaType,
  AppAnnouncement,
} from "../types/announcements";
import type {
  PlanCode,
  PlanLimit,
  PlanLimitKey,
  SubscriptionContext,
  SubscriptionPlan,
  SubscriptionStatus,
} from "../types/subscription";
import { filterFamilyTreeAccessCandidates } from "../utils/familyTreeFeatureAccess";

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
  records_per_standard_section: "Записи в розділах",
  project_members: "Запрошені учасники",
  custom_sections_per_project: "Власні розділи",
  custom_fields_per_project: "Власні поля",
  table_imports_per_month: "Імпорти за місяць",
  ai_credits_per_month: "ШІ-кредити",
  hypothesis_ai_reviews_per_month: "ШІ-аналізи гіпотез",
};

const hiddenPlanLimitKeys = new Set<PlanLimitKey>(["researches_total", "hypothesis_ai_reviews_per_month"]);
const planCardLimitOrder: PlanLimitKey[] = [
  "projects",
  "researches_per_project",
  "records_per_standard_section",
  "table_imports_per_month",
  "custom_fields_per_project",
  "custom_sections_per_project",
  "project_members",
  "ai_credits_per_month",
];

export function SubscriptionPage({
  context,
  trialDaysRemaining,
  loading,
  error,
  onRefresh,
}: SubscriptionPageProps) {
  const [plans, setPlans] = useState<Array<{ plan: SubscriptionPlan; limits: PlanLimit[] }>>([]);
  const [adminRows, setAdminRows] = useState<AdminSubscriptionRow[]>([]);
  const [featureFlags, setFeatureFlags] = useState<AppFeatureFlag[]>([]);
  const [familyTreeAccessUsers, setFamilyTreeAccessUsers] = useState<
    FamilyTreeFeatureAccessUser[]
  >([]);
  const [adminAnnouncements, setAdminAnnouncements] = useState<AppAnnouncement[]>([]);
  const [announcementsError, setAnnouncementsError] = useState("");
  const [featureFlagsError, setFeatureFlagsError] = useState("");
  const [familyTreeAccessError, setFamilyTreeAccessError] = useState("");
  const [pageError, setPageError] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelMessage, setCancelMessage] = useState("");

  const refreshPage = async () => {
    setPageError("");
    setFeatureFlagsError("");
    setFamilyTreeAccessError("");
    setAnnouncementsError("");
    try {
      const nextPlans = await loadSubscriptionPlans();
      setPlans(nextPlans);
      if (context?.isAdmin) {
        const nextAdminRows = await loadAdminSubscriptions();
        setAdminRows(nextAdminRows);
        try {
          const nextAccessUsers = await loadAdminFamilyTreeFeatureAccess();
          setFamilyTreeAccessUsers(nextAccessUsers);
          setFamilyTreeAccessError("");
        } catch {
          setFamilyTreeAccessUsers([]);
          setFamilyTreeAccessError(
            "Контроль доступу до родового дерева ще не налаштований у базі. Застосуйте міграцію 202607120002_family_tree_feature_access.sql.",
          );
        }
        try {
          const nextAnnouncements = await loadAdminAnnouncements();
          setAdminAnnouncements(nextAnnouncements);
          setAnnouncementsError("");
        } catch {
          setAdminAnnouncements([]);
          setAnnouncementsError(
            "Центр оновлень ще не налаштований у базі. Застосуйте SQL-міграцію 202606280001_app_announcements.sql.",
          );
        }
        try {
          const nextFeatureFlags = await loadAdminFeatureFlags();
          setFeatureFlags(nextFeatureFlags);
          setFeatureFlagsError("");
        } catch {
          setFeatureFlags([]);
          setFeatureFlagsError(
            "Перемикачі функцій ще не налаштовані в базі. Список підписок працює окремо; для перемикачів потрібно застосувати SQL-міграцію 202606260002_app_feature_flags.sql.",
          );
        }
      }
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
  const canCancelSubscription = Boolean(context && !isPermanentAdmin && context.effectivePlanCode !== "free");
  const isPaidPlan = Boolean(context && context.effectivePlanCode !== "free");
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
    return planCardLimitOrder
      .map((key) => context.limits[key])
      .filter((limit) => isVisibleLimit(context.effectivePlanCode, limit))
      .map((limit) => ({
        ...limit,
        used: context.usage[limit.key],
      }));
  }, [context]);

  const cancelSubscription = async () => {
    if (!window.confirm("Скасувати поточну підписку і перейти на тариф «Старт»? Дані залишаться у вашому акаунті.")) {
      return;
    }
    setCancelBusy(true);
    setCancelMessage("");
    setPageError("");
    try {
      await cancelMySubscription();
      setCancelMessage("Підписку скасовано. Акаунт переведено на тариф «Старт».");
      await refreshPage();
    } catch (cancelError) {
      setPageError(subscriptionErrorMessage(cancelError));
    } finally {
      setCancelBusy(false);
    }
  };

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
      {cancelMessage ? <div className="alert alert-notice">{cancelMessage}</div> : null}
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
            <h2>{context?.plan.name ?? "Старт"}</h2>
          </div>
          <div className="subscription-status-value compact">
            <strong>{statusText}</strong>
          </div>
          {isPaidPlan ? (
            <p>{paidSubscriptionEndText(context?.subscription.currentPeriodEnd ?? null, context?.subscription.status)}</p>
          ) : trialExpired ? (
            <p>Пробний період завершився. Дані збережено, нові дії перевіряються за лімітами тарифу «Старт».</p>
          ) : null}
        </section>
      )}

      {canCancelSubscription ? (
        <section className="subscription-cancel-panel">
          <div>
            <h2>Керування підпискою</h2>
            <p>Скасування переведе акаунт на тариф «Старт». Дані залишаться доступними за умовами тарифу «Старт».</p>
          </div>
          <button
            type="button"
            className="button button-secondary"
            disabled={cancelBusy}
            onClick={() => void cancelSubscription()}
          >
            {cancelBusy ? "Скасовуємо…" : "Скасувати підписку"}
          </button>
        </section>
      ) : null}

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
                  {orderedVisibleLimits(plan.code, limits).map((limit) => (
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
        <>
          <AdminAnnouncements
            announcements={adminAnnouncements}
            loadError={announcementsError}
            onChanged={refreshPage}
          />
          <AdminFeatureFlags
            flags={featureFlags}
            loadError={featureFlagsError}
            onChanged={refreshPage}
          />
          <AdminFamilyTreeAccess
            users={familyTreeAccessUsers}
            loadError={familyTreeAccessError}
            onChanged={refreshPage}
          />
          <AdminSubscriptions rows={adminRows} onChanged={refreshPage} />
        </>
      ) : null}
    </>
  );
}

const announcementCategoryLabels: Record<AnnouncementCategory, string> = {
  update: "Оновлення",
  feature: "Нова функція",
  maintenance: "Технічне",
  tip: "Порада",
};

const announcementMediaLabels: Record<AnnouncementMediaType, string> = {
  none: "Без медіа",
  image: "Скриншот",
  video: "Відео",
  link: "Посилання",
};

const announcementEmailLabels: Record<AnnouncementEmailStatus, string> = {
  not_planned: "Без email-розсилки",
  planned: "Підготувати для ручної розсилки",
  sent: "Email уже надіслано",
};

const emptyAnnouncementDraft: AdminAnnouncementInput = {
  id: null,
  title: "",
  body: "",
  category: "update",
  mediaType: "none",
  mediaUrl: "",
  ctaLabel: "",
  ctaUrl: "",
  isPublished: false,
  emailStatus: "not_planned",
};

function AdminAnnouncements({ announcements, loadError, onChanged }: {
  announcements: AppAnnouncement[];
  loadError: string;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AdminAnnouncementInput>(emptyAnnouncementDraft);
  const [busy, setBusy] = useState(false);
  const [sendingAnnouncementId, setSendingAnnouncementId] = useState("");
  const [error, setError] = useState("");

  const updateDraft = (patch: Partial<AdminAnnouncementInput>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const resetDraft = () => setDraft(emptyAnnouncementDraft);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await adminSaveAnnouncement(draft);
      resetDraft();
      await onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Не вдалося зберегти оголошення.");
    } finally {
      setBusy(false);
    }
  };

  const edit = (announcement: AppAnnouncement) => {
    setDraft({
      id: announcement.id,
      title: announcement.title,
      body: announcement.body,
      category: announcement.category,
      mediaType: announcement.mediaType,
      mediaUrl: announcement.mediaUrl ?? "",
      ctaLabel: announcement.ctaLabel ?? "",
      ctaUrl: announcement.ctaUrl ?? "",
      isPublished: announcement.isPublished,
      emailStatus: announcement.emailStatus,
    });
  };

  const remove = async (announcement: AppAnnouncement) => {
    if (!window.confirm(`Видалити оголошення "${announcement.title}"?`)) return;
    setBusy(true);
    setError("");
    try {
      await adminDeleteAnnouncement(announcement.id);
      if (draft.id === announcement.id) resetDraft();
      await onChanged();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не вдалося видалити оголошення.");
    } finally {
      setBusy(false);
    }
  };

  const sendEmail = async (announcement: AppAnnouncement) => {
    if (!window.confirm(`Надіслати email-оновлення "${announcement.title}" усім користувачам?`)) return;
    setSendingAnnouncementId(announcement.id);
    setError("");
    try {
      const result = await sendAnnouncementEmail(announcement.id);
      await onChanged();
      if (result.failed > 0) {
        setError(`Email-розсилку виконано частково: надіслано ${result.sent}, помилок ${result.failed}.`);
      }
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Не вдалося надіслати email-оновлення.");
    } finally {
      setSendingAnnouncementId("");
    }
  };

  return (
    <section className="subscription-admin-section announcement-admin-section">
      <div className="section-heading">
        <div>
          <h2>Центр оновлень</h2>
          <p>Оголошення з'являються у дзвіночку в кабінеті користувача. Email-розсилка тут тільки готується і не запускається автоматично.</p>
        </div>
      </div>
      {loadError ? <div className="alert alert-notice">{loadError}</div> : null}
      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="announcement-admin-grid">
        <div className="announcement-editor">
          <label>
            <span>Заголовок</span>
            <input
              value={draft.title}
              onChange={(event) => updateDraft({ title: event.target.value })}
              placeholder="Наприклад: Новий переглядач документів"
            />
          </label>
          <label>
            <span>Текст повідомлення</span>
            <textarea
              value={draft.body}
              onChange={(event) => updateDraft({ body: event.target.value })}
              rows={5}
              placeholder="Коротко поясніть, що змінилося і навіщо це користувачу."
            />
          </label>
          <div className="announcement-editor-row">
            <label>
              <span>Тип</span>
              <select
                value={draft.category}
                onChange={(event) => updateDraft({ category: event.target.value as AnnouncementCategory })}
              >
                {Object.entries(announcementCategoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Медіа</span>
              <select
                value={draft.mediaType}
                onChange={(event) => updateDraft({ mediaType: event.target.value as AnnouncementMediaType })}
              >
                {Object.entries(announcementMediaLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>Посилання на скриншот або відео</span>
            <input
              value={draft.mediaUrl ?? ""}
              onChange={(event) => updateDraft({ mediaUrl: event.target.value })}
              placeholder="https://..."
            />
          </label>
          <div className="announcement-editor-row">
            <label>
              <span>Текст кнопки</span>
              <input
                value={draft.ctaLabel ?? ""}
                onChange={(event) => updateDraft({ ctaLabel: event.target.value })}
                placeholder="Детальніше"
              />
            </label>
            <label>
              <span>Посилання кнопки</span>
              <input
                value={draft.ctaUrl ?? ""}
                onChange={(event) => updateDraft({ ctaUrl: event.target.value })}
                placeholder="https://..."
              />
            </label>
          </div>
          <div className="announcement-editor-row">
            <label>
              <span>Email</span>
              <select
                value={draft.emailStatus}
                onChange={(event) => updateDraft({ emailStatus: event.target.value as AnnouncementEmailStatus })}
              >
                {Object.entries(announcementEmailLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label className="checkbox-line announcement-publish-toggle">
              <input
                type="checkbox"
                checked={draft.isPublished}
                onChange={(event) => updateDraft({ isPublished: event.target.checked })}
              />
              Опублікувати у дзвіночку
            </label>
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {draft.id ? "Зберегти зміни" : "Створити оголошення"}
            </button>
            {draft.id ? (
              <button type="button" className="button button-secondary" disabled={busy} onClick={resetDraft}>
                Нове оголошення
              </button>
            ) : null}
          </div>
        </div>

        <div className="announcement-admin-list">
          {announcements.map((announcement) => (
            <article className={announcement.isPublished ? "published" : ""} key={announcement.id}>
              <div>
                <span>{announcementCategoryLabels[announcement.category]}</span>
                <h3>{announcement.title}</h3>
                <p>{announcement.body}</p>
                <small>
                  {announcement.isPublished ? "Опубліковано" : "Чернетка"} · {formatDate(announcement.publishedAt ?? announcement.createdAt)}
                  {announcement.emailStatus === "planned" ? " · email підготовлено" : ""}
                  {announcement.emailStatus === "sent" ? " · email надіслано" : ""}
                </small>
              </div>
              <div className="row-actions">
                {announcement.emailStatus === "planned" ? (
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={busy || sendingAnnouncementId === announcement.id}
                    onClick={() => void sendEmail(announcement)}
                  >
                    {sendingAnnouncementId === announcement.id ? "Надсилання..." : "Надіслати email"}
                  </button>
                ) : null}
                <button type="button" className="button button-secondary" disabled={busy} onClick={() => edit(announcement)}>
                  Редагувати
                </button>
                <button type="button" className="button button-secondary danger" disabled={busy} onClick={() => void remove(announcement)}>
                  Видалити
                </button>
              </div>
            </article>
          ))}
          {!announcements.length && !loadError ? (
            <div className="empty-inline">Оголошень ще немає.</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AdminFeatureFlags({ flags, loadError, onChanged }: {
  flags: AppFeatureFlag[];
  loadError: string;
  onChanged: () => Promise<void>;
}) {
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");

  const toggle = async (flag: AppFeatureFlag) => {
    setBusyKey(flag.key);
    setError("");
    try {
      await adminSetFeatureFlag({ key: flag.key, isEnabled: !flag.isEnabled });
      await onChanged();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Не вдалося змінити налаштування функції.");
    } finally {
      setBusyKey("");
    }
  };

  return (
    <section className="subscription-admin-section feature-flags-section">
      <div className="section-heading">
        <h2>Керування функціями</h2>
      </div>
      {loadError ? <div className="alert alert-notice">{loadError}</div> : null}
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="feature-flag-list">
        {flags.map((flag) => (
          <article className="feature-flag-item" key={flag.key}>
            <div>
              <h3>{flag.title}</h3>
              {flag.description ? <p>{flag.description}</p> : null}
              <small>Ключ: {flag.key}</small>
            </div>
            <button
              type="button"
              className={`feature-flag-toggle ${flag.isEnabled ? "enabled" : ""}`}
              disabled={busyKey === flag.key}
              onClick={() => void toggle(flag)}
              aria-pressed={flag.isEnabled}
            >
              <span>{flag.isEnabled ? "Увімкнено" : "Вимкнено"}</span>
            </button>
          </article>
        ))}
        {!flags.length && !loadError ? (
          <div className="empty-inline">Немає доступних перемикачів функцій.</div>
        ) : null}
      </div>
    </section>
  );
}

function AdminFamilyTreeAccess({ users, loadError, onChanged }: {
  users: FamilyTreeFeatureAccessUser[];
  loadError: string;
  onChanged: () => Promise<void>;
}) {
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [busyUserId, setBusyUserId] = useState("");
  const [error, setError] = useState("");
  const availableUsers = users.filter((user) => !user.isAdmin && !user.isEnabled);
  const enabledUsers = users.filter((user) => user.isEnabled);
  const matchingUsers = useMemo(
    () => filterFamilyTreeAccessCandidates(users, userQuery),
    [users, userQuery],
  );
  const visibleMatchingUsers = matchingUsers.slice(0, 12);
  const selectedUser = availableUsers.find((user) => user.userId === selectedUserId) ?? null;

  useEffect(() => {
    if (selectedUserId && !availableUsers.some((user) => user.userId === selectedUserId)) {
      setSelectedUserId("");
    }
  }, [selectedUserId, availableUsers.map((user) => user.userId).join("|")]);

  const updateAccess = async (userId: string, isEnabled: boolean) => {
    setBusyUserId(userId);
    setError("");
    try {
      await adminSetFamilyTreeFeatureAccess({ userId, isEnabled });
      setSelectedUserId("");
      setUserQuery("");
      await onChanged();
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "Не вдалося змінити доступ до родового дерева.",
      );
    } finally {
      setBusyUserId("");
    }
  };

  return (
    <section className="subscription-admin-section feature-flags-section">
      <div className="section-heading">
        <div>
          <h2>Тестувальники родового дерева</h2>
          <p>
            Доступ охоплює модуль «Родове дерево», імпорт і експорт GEDCOM.
            Участь у конкретному проєкті перевіряється окремо.
          </p>
        </div>
      </div>
      {loadError ? <div className="alert alert-notice">{loadError}</div> : null}
      {error ? <div className="alert alert-error">{error}</div> : null}
      {!loadError ? (
        <div className="subscription-admin-filters family-tree-access-form">
          <label className="family-tree-access-search-field">
            <span>Знайти користувача</span>
            <input
              type="search"
              value={userQuery}
              placeholder="Ім’я або email"
              autoComplete="off"
              aria-describedby="family-tree-access-search-status"
              disabled={Boolean(busyUserId) || !availableUsers.length}
              onChange={(event) => {
                setUserQuery(event.target.value);
                setSelectedUserId("");
              }}
            />
          </label>
          <div className="family-tree-access-selected-user">
            <span>Обраний користувач</span>
            <div className="family-tree-access-selected-value">
              {selectedUser ? (
                <>
                  <strong>{selectedUser.displayName || selectedUser.email}</strong>
                  {selectedUser.displayName ? <small>{selectedUser.email}</small> : null}
                </>
              ) : (
                <strong className="muted-text">Не обрано</strong>
              )}
            </div>
          </div>
          <button
            type="button"
            className="button button-primary"
            disabled={!selectedUserId || Boolean(busyUserId)}
            onClick={() => void updateAccess(selectedUserId, true)}
          >
            {busyUserId ? "Зберігаємо…" : "Надати доступ"}
          </button>
          <div className="family-tree-access-search-panel">
            <div
              id="family-tree-access-search-status"
              className="family-tree-access-search-status"
              role="status"
              aria-live="polite"
            >
              {!availableUsers.length
                ? "Усі зареєстровані користувачі вже мають доступ."
                : !userQuery.trim()
                  ? "Введіть ім’я або email користувача."
                  : !matchingUsers.length
                    ? "Користувачів не знайдено."
                    : matchingUsers.length > visibleMatchingUsers.length
                      ? `Знайдено ${matchingUsers.length}. Показано перші ${visibleMatchingUsers.length}.`
                      : `Знайдено: ${matchingUsers.length}.`}
            </div>
            {userQuery.trim() && visibleMatchingUsers.length ? (
              <div className="family-tree-access-search-results">
                {visibleMatchingUsers.map((user) => (
                  <button
                    type="button"
                    key={user.userId}
                    className={`family-tree-access-search-result${selectedUserId === user.userId ? " selected" : ""}`}
                    aria-pressed={selectedUserId === user.userId}
                    disabled={Boolean(busyUserId)}
                    onClick={() => setSelectedUserId(user.userId)}
                  >
                    <strong>{user.displayName || user.email}</strong>
                    {user.displayName ? <small>{user.email}</small> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="feature-flag-list">
        {enabledUsers.map((user) => (
          <article className="feature-flag-item" key={user.userId}>
            <div>
              <h3>{user.displayName || user.email}</h3>
              <p>{user.email}</p>
              <small>
                {user.isAdmin
                  ? "Адміністратор — постійний доступ"
                  : user.grantedAt
                    ? `Доступ надано ${formatDate(user.grantedAt)}`
                    : "Запрошений тестувальник"}
              </small>
            </div>
            {user.isAdmin ? (
              <span className="status-pill">Власник</span>
            ) : (
              <button
                type="button"
                className="button button-secondary danger"
                disabled={busyUserId === user.userId}
                onClick={() => void updateAccess(user.userId, false)}
              >
                {busyUserId === user.userId ? "Вимикаємо…" : "Забрати доступ"}
              </button>
            )}
          </article>
        ))}
        {!enabledUsers.length && !loadError ? (
          <div className="empty-inline">Тестувальників ще не додано.</div>
        ) : null}
      </div>
    </section>
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
            <option value="free">Старт</option>
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
                <td>{row.isAdmin ? <span className="status-pill">Адміністратор</span> : planDisplayName(row.planCode)}</td>
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
                        <option value="free">Старт</option>
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

function paidSubscriptionEndText(
  currentPeriodEnd: string | null,
  status: SubscriptionStatus | undefined,
): string {
  if (!currentPeriodEnd) {
    return "Дата завершення платної підписки ще не встановлена.";
  }
  const date = formatDate(currentPeriodEnd);
  if (status === "cancelled") {
    return `Підписку скасовано. Доступ до платного тарифу діє до ${date}.`;
  }
  if (status === "expired") {
    return `Платна підписка завершилася ${date}.`;
  }
  return `Платна підписка діє до ${date}.`;
}

function priceLabel(plan: SubscriptionPlan): ReactNode {
  if (plan.code === "free") return "0 грн";
  const currency = plan.currency === "UAH" ? "грн" : plan.currency;
  const monthly = plan.priceMonthly === null ? "" : `${plan.priceMonthly.toLocaleString("uk-UA")} ${currency} / місяць`;
  const yearly = plan.priceYearly === null ? "" : `${plan.priceYearly.toLocaleString("uk-UA")} ${currency} / рік`;
  if (!monthly && !yearly) return "Ціну буде оголошено";
  return (
    <>
      {monthly ? <span>{monthly}</span> : null}
      {yearly ? <span className="price-yearly">{yearly}</span> : null}
    </>
  );
}

function planLimitValue(planCode: PlanCode, limit: PlanLimit): string | number | null {
  if (limit.key === "records_per_standard_section" && !limit.isUnlimited && limit.value !== null) {
    return `До ${limit.value}`;
  }
  if (limit.key === "ai_credits_per_month" && !limit.isUnlimited && limit.value !== null) {
    return `${limit.value} на місяць`;
  }
  if (limit.isUnlimited) return "Без обмежень";
  return limit.value;
}

function usageValue(
  _planCode: PlanCode,
  item: PlanLimit & { used: number },
): string {
  if (item.isUnlimited) return "Без обмежень";
  return `${item.used} із ${item.value ?? 0}`;
}

function isVisibleLimit(planCode: PlanCode, limit: PlanLimit): boolean {
  if (hiddenPlanLimitKeys.has(limit.key)) return false;
  if (limit.key === "ai_credits_per_month" && planCode === "free") return true;
  return limit.isUnlimited || limit.value !== 0;
}

function orderedVisibleLimits(planCode: PlanCode, limits: PlanLimit[]): PlanLimit[] {
  const byKey = new Map(limits.map((limit) => [limit.key, limit]));
  return planCardLimitOrder
    .map((key) => byKey.get(key))
    .filter((limit): limit is PlanLimit => Boolean(limit))
    .filter((limit) => isVisibleLimit(planCode, limit));
}

function planDisplayName(planCode: PlanCode): string {
  const names: Record<PlanCode, string> = {
    free: "Старт",
    researcher: "Дослідник",
    professional: "Професійний",
  };
  return names[planCode];
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("uk-UA", { dateStyle: "long" }).format(new Date(value));
}
