import { useState } from "react";
import { isBrowserMonitoringEnabled, reportBrowserError } from "../../services/browserMonitoring.ts";

export function BrowserMonitoringPanel() {
  const [eventId, setEventId] = useState<string>();
  const enabled = isBrowserMonitoringEnabled();
  return (
    <section className="admin-panel-card" aria-labelledby="browser-monitoring-title">
      <h2 id="browser-monitoring-title">Помилки у браузерах — Sentry</h2>
      <p>{enabled
        ? "Моніторинг увімкнено. Звіти містять технічний код помилки, розділ, версію сайту та браузер без вмісту приватних записів."
        : "Моніторинг вимкнено у цій збірці. Для підключення потрібні VITE_SENTRY_DSN та нова production-збірка сайту."}</p>
      <button type="button" className="button button-secondary" disabled={!enabled || Boolean(eventId)}
        onClick={() => setEventId(reportBrowserError(new Error("Tracker Rodu monitoring test"), "monitoring-test"))}>
        Надіслати тестову помилку
      </button>
      {eventId && <p role="status">Тестовий звіт передано модулю моніторингу. Перевірте його появу в Sentry Issues. ID: <code>{eventId}</code>. Блокувальник реклами або ліміт сервісу можуть завадити доставленню.</p>}
    </section>
  );
}
