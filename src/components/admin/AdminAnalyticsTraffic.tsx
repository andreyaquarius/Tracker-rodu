import { useEffect, useId, useRef, useState } from "react";
import { loadAdminAnalyticsOnline, loadAdminAnalyticsTraffic } from "../../services/adminAnalyticsService.ts";
import {
  analyticsCount, analyticsDuration, analyticsLinePath, analyticsLoadError,
  type AnalyticsOnline, type AnalyticsTraffic,
} from "../../utils/adminAnalyticsTraffic.ts";
import { startAnalyticsVisiblePoller } from "../../utils/analyticsVisiblePoller.ts";

export function AdminAnalyticsOnline({ load = loadAdminAnalyticsOnline }: { load?: typeof loadAdminAnalyticsOnline }) {
  const [data, setData] = useState<AnalyticsOnline | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    const poller = startAnalyticsVisiblePoller({
      load, visibility: document,
      onLoading: () => setLoading(true),
      onData: (next) => { setData(next); setError(""); setLoading(false); },
      onError: (err) => { setData(null); setError(analyticsLoadError(err)); setLoading(false); },
    });
    refresh.current = poller.refresh;
    return () => { poller.stop(); refresh.current = null; };
  }, [load]);
  return (
    <section className="admin-panel-card admin-online-card" aria-label="Користувачі онлайн">
      <div className="admin-online-count">
        <span className={`admin-online-dot${data && !error ? " is-connected" : ""}`} aria-hidden="true" />
        <div><span>Користувачі онлайн</span><strong aria-live="polite">{
          data?.suppressed ? `< ${data.minimumCohort}` : analyticsCount(data?.users ?? null)
        }</strong></div>
      </div>
      <div className="admin-online-description">
        <p>Активність за останні 2 хвилини. Одна людина в кількох вкладках рахується один раз.</p>
        <small>Лише авторизовані користувачі зі згодою на аналітику, без адміністраторів. Сигнал надходить приблизно раз на хвилину.</small>
        {error ? <p role="alert">{error}</p> : <small>{data
          ? `Перевірено ${new Date(data.checkedAt).toLocaleTimeString("uk-UA")}. Автооновлення кожні 30 с у видимій вкладці.`
          : "Очікуємо актуальні дані…"}</small>}
      </div>
      <button type="button" className="button button-secondary" disabled={loading} onClick={() => refresh.current?.()}>
        {loading ? "Оновлюємо…" : "Оновити онлайн"}
      </button>
    </section>
  );
}

function DailyChart({ title, labels, values, duration = false }: {
  title: string; labels: string[]; values: Array<number | null>; duration?: boolean;
}) {
  const titleId = useId();
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  const format = duration ? analyticsDuration : analyticsCount;
  const width = 600, height = 150;
  const x = (i: number) => values.length === 1 ? width / 2 : i * width / Math.max(1, values.length - 1);
  const shortDate = (date: string) => `${date.slice(8,10)}.${date.slice(5,7)}`;
  return (
    <div className={`admin-traffic-chart${duration ? " is-duration" : ""}`}>
      <h3>{title}</h3>
      <div className="admin-chart-scale"><span>{format(max)}</span><span>Київський час</span></div>
      <svg viewBox="-8 -8 616 164" role="img" aria-labelledby={titleId}>
        <title id={titleId}>{title}. Точні значення доступні в таблиці під графіками; пропуски — приховані вибірки.</title>
        {[0, 0.5, 1].map((ratio) => <line key={ratio} className="admin-chart-gridline" x1={0} x2={width} y1={height * ratio} y2={height * ratio} />)}
        <path d={analyticsLinePath(values, width, height)} className="admin-chart-line" />
        {values.map((value, i) => value === null ? (
          <path key={labels[i]} className="admin-chart-redacted" d={`M${x(i)-2},${height-3} l4,6 m-4,0 l4,-6`}><title>{labels[i]}: приховано</title></path>
        ) : (
          <circle key={labels[i]} cx={x(i)} cy={height - value / max * height} r={values.length > 40 ? 2 : 3.5} className="admin-chart-point">
            <title>{labels[i]}: {format(value)}</title>
          </circle>
        ))}
      </svg>
      <div className="admin-chart-dates" aria-hidden="true">{[0, Math.floor((labels.length - 1) / 2), labels.length - 1].filter((i, pos, all) => i >= 0 && i < labels.length && all.indexOf(i) === pos).map((i) => <span key={i}>{shortDate(labels[i])}</span>)}</div>
    </div>
  );
}

const DEVICE_LABELS: Record<string, string> = { desktop: "Комп’ютер", tablet: "Планшет", mobile: "Телефон", unknown: "Невідомо" };
const VISIT_LABELS = { users: "Користувачі", sessions: "Сесії з активністю", pageViews: "Перегляди розділів" };

export function AdminAnalyticsTrafficView({ data }: { data: AnalyticsTraffic }) {
  const [metric, setMetric] = useState<keyof typeof VISIT_LABELS>("users");
  const maxHourly = Math.max(1, ...data.hourly.map((row) => row.users ?? 0));
  const maxDevices = Math.max(1, ...data.devices.map((row) => row.sessions ?? 0));
  return (
    <>
      <section className="admin-panel-card">
        <div className="admin-card-heading">
          <div><h2>Відвідування та час на сайті</h2><p>За днями, у київському часі. Перший і останній день можуть бути неповними.</p></div>
          <label>На графіку<select value={metric} onChange={(e) => setMetric(e.target.value as keyof typeof VISIT_LABELS)}>
            {Object.entries(VISIT_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </div>
        <div className="admin-chart-grid">
          <DailyChart title={VISIT_LABELS[metric]} labels={data.daily.map((row) => row.day)} values={data.daily.map((row) => row[metric])} />
          <DailyChart title="Сумарний активний час" labels={data.daily.map((row) => row.day)} values={data.daily.map((row) => row.activeSeconds)} duration />
        </div>
        <p className="admin-privacy-note">Рахується час у видимій вкладці з фокусом; після 5 хв без взаємодії відлік зупиняється. Це не час просто відкритої вкладки. «—» / розрив лінії означає приховану вибірку (1–4 користувачі), а 0 — відсутність активності.</p>
        <details className="admin-chart-details">
          <summary>Точні дані за днями та середній час</summary>
          <div className="admin-table-wrap"><table className="admin-analytics-table">
            <caption className="sr-only">Денні відвідування й активний час</caption>
            <thead><tr><th>Дата</th><th>Користувачі</th><th>Сесії</th><th>Перегляди</th><th>Час</th><th>На сесію</th><th>На користувача</th></tr></thead>
            <tbody>{data.daily.map((row) => <tr key={row.day}>
              <th scope="row">{row.day}</th><td>{row.suppressed ? "< 5" : analyticsCount(row.users)}</td>
              <td>{analyticsCount(row.sessions)}</td><td>{analyticsCount(row.pageViews)}</td><td>{analyticsDuration(row.activeSeconds)}</td>
              <td>{analyticsDuration(row.averageSessionSeconds)}</td><td>{analyticsDuration(row.averageUserSeconds)}</td>
            </tr>)}</tbody>
          </table></div>
        </details>
      </section>
      <div className="admin-chart-grid">
        <section className="admin-panel-card">
          <h2>Коли користуються застосунком</h2>
          <p>Унікальні користувачі в кожну годину за весь період · Київ.</p>
          <div className="admin-hourly-chart" role="list" aria-label="Активність за годинами">
            {data.hourly.map((row) => <div key={row.hour} role="listitem" className="admin-hourly-slot"
              title={`${row.hour}:00 — ${row.suppressed ? "менше 5" : analyticsCount(row.users)} користувачів`}>
              <span className="sr-only">{row.hour}:00 — {row.suppressed ? "менше 5" : analyticsCount(row.users)} користувачів</span>
              <div className="admin-hourly-track" aria-hidden="true"><span className={row.users === null ? "is-redacted" : ""} style={{ height: row.users === null ? "8px" : `${row.users / maxHourly * 100}%` }} /></div>
              <small aria-hidden="true">{row.hour % 3 === 0 ? row.hour : ""}</small>
            </div>)}
          </div>
          <p className="admin-privacy-note">Одна людина може бути врахована в кількох годинах. Штрихування — приховані дані, не нуль.</p>
        </section>
        <section className="admin-panel-card">
          <h2>Пристрої</h2><p>Сесії за розміром екрана на початку сесії.</p>
          <div className="admin-device-list">{data.devices.map((row) => <div key={row.device}>
            <div><strong>{DEVICE_LABELS[row.device] ?? row.device}</strong><span>{row.suppressed ? "Приховано (< 5 користувачів)" : `${analyticsCount(row.sessions)} сесій · ${analyticsDuration(row.activeSeconds)}`}</span></div>
            <div className="admin-device-track"><span style={{ width: `${(row.sessions ?? 0) / maxDevices * 100}%` }} /></div>
          </div>)}</div>
        </section>
      </div>
    </>
  );
}

export function AdminAnalyticsTraffic({ from, to, load = loadAdminAnalyticsTraffic }: {
  from: Date; to: Date; load?: typeof loadAdminAnalyticsTraffic;
}) {
  const [result, setResult] = useState<{ key: string; data?: AnalyticsTraffic; error?: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const key = `${from.toISOString()}-${to.toISOString()}-${revision}`;
  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    void load(from, to, controller.signal).then((data) => {
      if (mounted) setResult({ key, data });
    }).catch((err) => {
      if (mounted) setResult({ key, error: analyticsLoadError(err) });
    });
    return () => { mounted = false; controller.abort(); };
  }, [from, to, load, key]);
  if (result?.key !== key) return <section className="admin-panel-card" role="status">Завантажуємо графіки відвідувань…</section>;
  if (!result.data) return <section className="admin-panel-card"><p role="alert">{result.error}</p><button type="button" className="button button-secondary" onClick={() => setRevision((n) => n + 1)}>Повторити завантаження графіків</button></section>;
  return <AdminAnalyticsTrafficView data={result.data} />;
}
