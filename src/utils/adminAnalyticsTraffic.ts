export interface AnalyticsMetrics {
  suppressed: boolean;
  users: number | null;
  sessions: number | null;
  pageViews: number | null;
  activeSeconds: number | null;
  averageSessionSeconds: number | null;
  averageUserSeconds: number | null;
}
export interface AnalyticsTraffic {
  daily: Array<AnalyticsMetrics & { day: string }>;
  hourly: Array<AnalyticsMetrics & { hour: number }>;
  devices: Array<AnalyticsMetrics & { device: string }>;
}
export interface AnalyticsOnline {
  users: number | null;
  suppressed: boolean;
  minimumCohort: number;
  checkedAt: string;
  windowSeconds: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ANALYTICS_RESPONSE");
  return value as Record<string, unknown>;
}
export function analyticsNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function metrics(row: Record<string, unknown>): AnalyticsMetrics {
  const number = (key: string) => row.suppressed === true ? null : analyticsNumber(row[key]);
  return {
    suppressed: row.suppressed === true,
    users: number("users"), sessions: number("sessions"), pageViews: number("pageViews"),
    activeSeconds: number("activeSeconds"), averageSessionSeconds: number("averageSessionSeconds"),
    averageUserSeconds: number("averageUserSeconds"),
  };
}
export function parseAnalyticsTraffic(value: unknown): AnalyticsTraffic {
  const data = record(value);
  if (![data.daily, data.hourly, data.devices].every(Array.isArray)) throw new Error("INVALID_ANALYTICS_RESPONSE");
  return {
    daily: (data.daily as unknown[]).map((value) => {
      const row = record(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.day))) throw new Error("INVALID_ANALYTICS_RESPONSE");
      return { ...metrics(row), day: String(row.day) };
    }),
    hourly: (data.hourly as unknown[]).map((value) => {
      const row = record(value);
      const hour = analyticsNumber(row.hour);
      if (hour === null || !Number.isInteger(hour) || hour > 23) throw new Error("INVALID_ANALYTICS_RESPONSE");
      return { ...metrics(row), hour };
    }),
    devices: (data.devices as unknown[]).map((value) => {
      const row = record(value);
      return { ...metrics(row), device: String(row.device ?? "unknown") };
    }),
  };
}
export function parseAnalyticsOnline(value: unknown): AnalyticsOnline {
  const row = record(value);
  if (!Number.isFinite(Date.parse(String(row.checkedAt)))) throw new Error("INVALID_ANALYTICS_RESPONSE");
  return {
    users: row.suppressed === true ? null : analyticsNumber(row.users),
    suppressed: row.suppressed === true,
    minimumCohort: analyticsNumber(row.minimumCohort) ?? 5,
    checkedAt: String(row.checkedAt), windowSeconds: analyticsNumber(row.windowSeconds) ?? 120,
  };
}
export function analyticsDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const value = Math.max(0, Math.round(seconds));
  if (value >= 3600) return `${Math.floor(value / 3600)} год ${Math.floor(value % 3600 / 60)} хв`;
  if (value >= 60) return `${Math.floor(value / 60)} хв ${value % 60} с`;
  return `${value} с`;
}
export const analyticsCount = (value: number | null) => value === null ? "—" : value.toLocaleString("uk-UA");

/** Separate SVG subpaths for redacted buckets: a missing value is not zero. */
export function analyticsLinePath(values: Array<number | null>, width: number, height: number): string {
  const max = Math.max(1, ...values.filter((value): value is number => value !== null));
  let connected = false;
  return values.map((value, index) => {
    if (value === null) { connected = false; return ""; }
    const x = values.length === 1 ? width / 2 : index * width / (values.length - 1);
    const y = height - value / max * height;
    const point = `${connected ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    connected = true;
    return point;
  }).filter(Boolean).join(" ");
}

export function analyticsLoadError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "PGRST202" || code === "42883") return "Нові звіти ще не підключені до цієї бази. Потрібна міграція 202609070003_admin_analytics_traffic.sql.";
  if (code === "42501") return "Немає дозволу analytics.view для перегляду цих звітів.";
  return "Не вдалося оновити аналітику. Перевірте з’єднання та спробуйте ще раз.";
}
