import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { AnnouncementBell } from "../../../src/components/AnnouncementBell.tsx";
import { NotificationInboxProvider, useNotificationInbox } from "../../../src/components/NotificationInboxProvider.tsx";
import { NotificationsPage } from "../../../src/pages/NotificationsPage.tsx";
import { parseAppRoute } from "../../../src/utils/appRoutes.ts";
import { announcementInboxItem, taskInboxItem, geneHelpInboxItem, notificationKey, type InboxNotification } from "../../../src/utils/notificationInbox.ts";
import type { NotificationInboxService } from "../../../src/services/notificationInboxService.ts";
import type { SupabaseAccount } from "../../../src/services/supabaseAuth.ts";
import "../../../src/styles.css";
import "../../../src/components/appearance/appAppearance.css";

const id = (number: number) => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const date = "2026-09-12T12:00:00Z";
const longBody = "Вітаємо! Тепер повідомлення можна зручно читати на окремій сторінці.\n\n" +
  Array.from({ length: 14 }, (_, i) => `Розділ ${i + 1}. Зберігайте родинні історії, додавайте джерела та перевіряйте факти. Повідомлення не обрізається: кожен абзац залишається доступним і на телефоні, і на комп’ютері.`).join("\n\n") +
  "\n\nКІНЕЦЬ ПОВНОГО ПОВІДОМЛЕННЯ. <script>Це звичайний текст, не HTML.</script>";
const announcement = (number: number) => announcementInboxItem({
  id: id(number), title: number === 1 ? "Велике оновлення: повідомлення на окремій сторінці" : `Оголошення ${number}`,
  body: number === 1 ? longBody : "Короткий текст повідомлення для перевірки сторінок списку.",
  category: "update", mediaType: "video", mediaUrl: "https://example.org/video", ctaLabel: "Дізнатися більше", ctaUrl: "https://example.org/news",
  isPublished: true, publishedAt: date, createdAt: date, updatedAt: date, isRead: number > 1, readAt: number > 1 ? date : null, emailStatus: "not_planned", emailRequestedAt: null,
});
const seed = [
  geneHelpInboxItem({ id: id(30), requestId: "request-123", eventType: "reply_created", title: "Нова відповідь на генеалогічний запит", body: "Дослідник додав відповідь. Перегляньте її в GeneHelp.", occurredAt: date, createdAt: date, readAt: null, isRead: false }),
  taskInboxItem({ id: id(31), taskId: id(91), projectId: id(92), projectName: "Тестова родина", taskTitle: "Перевірити запис про народження", taskDescription: "Зіставте імена батьків у метричній книзі.\n\nДодайте посилання на справу та номер аркуша.", taskDeadline: "2026-09-15", scheduledFor: date, createdAt: date, readAt: null, isRead: false }),
  ...Array.from({ length: 23 }, (_, i) => announcement(i + 1)),
];
const rows = new Map<string, InboxNotification[]>([["fixture-a", seed], ["fixture-b", [{ ...announcement(90), title: "Повідомлення іншого тестового акаунту", isRead: false }]]]);
const flags = { failRead: false, failLoad: false, slowRead: false, stale: false };
const counts = { loads: 0, details: 0, reads: 0 };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const service: NotificationInboxService = {
  async load(userId) {
    counts.loads += 1; await delay(150);
    if (flags.failLoad) throw new Error("Тестова помилка мережі");
    return { items: (flags.stale && userId === "fixture-a" ? seed : rows.get(userId) ?? []).map((item) => ({ ...item })), warning: "" };
  },
  async loadOne(kind, targetId, userId) {
    counts.details += 1; await delay(80);
    if (flags.failLoad) throw new Error("Тестова помилка мережі");
    return rows.get(userId)?.find((item) => item.kind === kind && item.id === targetId) ?? null;
  },
  async markRead(item, userId) {
    counts.reads += 1; await delay(flags.slowRead ? 1500 : 100);
    if (flags.failRead) throw new Error("Тестова помилка збереження");
    rows.set(userId, (rows.get(userId) ?? []).map((row) => notificationKey(row) === notificationKey(item) ? { ...row, isRead: true } : row));
  },
  async markAll(items, userId) { await Promise.all(items.filter((item) => !item.isRead).map((item) => service.markRead(item, userId))); },
};

function Contents({ accountId }: { accountId: string }) {
  const routeLocation = useLocation();
  const route = parseAppRoute(routeLocation.pathname);
  const inbox = useNotificationInbox();
  const navigate = useNavigate();
  return <>
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", position: "sticky", top: 0, zIndex: 10, background: "var(--paper)", borderBottom: "1px solid var(--line)" }}>
      <strong>Локальна перевірка · {accountId}</strong>
      <AnnouncementBell account={{ id: accountId, name: "Тестовий акаунт" } as SupabaseAccount} />
    </header>
    <main style={{ maxWidth: 1200, padding: 16, margin: "0 auto" }}>
      <details><summary>Діагностика тесту</summary><p>Вигадані дані. Зовнішні запити заблоковані.</p>
        <p data-testid="fixture-counters">Запити списку: {counts.loads}; деталі: {counts.details}; позначення: {counts.reads}; непрочитані: {inbox.unreadCount}</p>
        <p data-testid="fixture-route">Маршрут: {routeLocation.pathname}{routeLocation.search}</p>
        <label><input type="checkbox" onChange={(event) => { flags.failRead = event.target.checked; }} /> Помилка позначення</label>
        <label><input type="checkbox" onChange={(event) => { flags.failLoad = event.target.checked; }} /> Помилка завантаження</label>
        <label><input type="checkbox" onChange={(event) => { flags.slowRead = event.target.checked; }} /> Повільне позначення</label>
        <label><input type="checkbox" onChange={(event) => { flags.stale = event.target.checked; }} /> Застаріла відповідь списку</label>
        <button onClick={() => navigate("/notifications/announcement/10000000-0000-4000-8000-999999999999")}>Відсутнє повідомлення</button>
        <button onClick={() => navigate("/notifications")}>Список</button>
        <button onClick={() => navigate(-1)}>Назад у браузері</button>
      </details>
      {route.kind === "notifications" ? <NotificationsPage notificationKind={route.notificationKind} notificationId={route.notificationId} /> : <section className="panel"><h1>Робоча сторінка</h1><p>Відкрийте дзвіночок, щоб прочитати повідомлення.</p></section>}
    </main>
  </>;
}
function Fixture() {
  const [accountId, setAccountId] = useState("fixture-a");
  return <>
    <nav aria-label="Тестові налаштування" style={{ display: "flex", gap: 8, padding: 8, flexWrap: "wrap" }}>
      <button onClick={() => setAccountId((value) => value === "fixture-a" ? "fixture-b" : "fixture-a")}>Змінити тестовий акаунт</button>
      <button onClick={() => { document.documentElement.dataset.appTheme = document.documentElement.dataset.appTheme === "starry-dark" ? "standard" : "starry-dark"; }}>Змінити тему</button>
    </nav>
    <NotificationInboxProvider accountId={accountId} service={service}><Contents accountId={accountId} /></NotificationInboxProvider>
  </>;
}
const initial = new URLSearchParams(window.location.search).get("route") || "/projects";
createRoot(document.getElementById("root")!).render(<StrictMode><RouterProvider router={createMemoryRouter([{ path: "*", element: <Fixture /> }], { initialEntries: [initial] })} /></StrictMode>);
