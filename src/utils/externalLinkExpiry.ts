export type ExternalLinkExpiry =
  | {
      kind: "known";
      expiresAt: string;
      expired: boolean;
      remainingDays: number;
    }
  | { kind: "unknown" };

const directExpiryKeys = new Set([
  "e",
  "exp",
  "expire",
  "expires",
  "expiry",
  "expiration",
  "se",
]);
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

/** Reads only a deadline explicitly encoded by the source URL. */
export function externalLinkExpiry(
  value: string,
  nowMs = Date.now(),
): ExternalLinkExpiry {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "unknown" };
  }

  const params = new Map<string, string>();
  url.searchParams.forEach((parameterValue, key) => {
    const normalizedKey = key.trim().toLocaleLowerCase("en-US");
    if (!params.has(normalizedKey)) params.set(normalizedKey, parameterValue.trim());
  });

  const signedAt = parseCompactUtcTimestamp(
    params.get("x-amz-date") || params.get("x-goog-date") || "",
  );
  const signedDuration = parsePositiveSeconds(
    params.get("x-amz-expires") || params.get("x-goog-expires") || "",
  );
  if (signedAt !== null && signedDuration !== null) {
    return knownExpiry(signedAt + signedDuration * 1000, nowMs);
  }

  for (const [key, rawValue] of params) {
    if (!directExpiryKeys.has(key)) continue;
    const expiryMs = parseExpiryTimestamp(rawValue);
    if (expiryMs !== null) return knownExpiry(expiryMs, nowMs);
  }

  return { kind: "unknown" };
}

export function formatExternalLinkExpiry(
  expiry: ExternalLinkExpiry,
  locale = "uk-UA",
): string {
  if (expiry.kind === "unknown") {
    return "Строк дії не вказаний — зовнішнє посилання може перестати працювати будь-коли.";
  }
  const date = new Date(expiry.expiresAt).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  if (expiry.expired) return `Зазначений строк дії завершився ${date}.`;
  if (expiry.remainingDays === 0) return `Посилання діє до ${date} — залишилося менше доби.`;
  return `Посилання діє до ${date} — приблизно ${expiry.remainingDays} ${ukrainianDayUnit(expiry.remainingDays)}.`;
}

function knownExpiry(expiryMs: number, nowMs: number): ExternalLinkExpiry {
  if (
    !Number.isFinite(expiryMs)
    || Math.abs(expiryMs) > MAX_DATE_MILLISECONDS
  ) {
    return { kind: "unknown" };
  }
  const normalizedNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const difference = expiryMs - normalizedNowMs;
  return {
    kind: "known",
    expiresAt: new Date(expiryMs).toISOString(),
    expired: difference <= 0,
    remainingDays: difference <= 0 ? 0 : Math.ceil(difference / 86_400_000),
  };
}

function parseExpiryTimestamp(value: string): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    // Small counters are common in unrelated query parameters such as `e=2`.
    // Treat only plausible dates from 2000 onward as an explicit deadline.
    return Number.isFinite(milliseconds) && milliseconds >= Date.UTC(2000, 0, 1)
      ? milliseconds
      : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveSeconds(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseCompactUtcTimestamp(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(value);
  if (!match) return null;
  const parsed = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function ukrainianDayUnit(value: number): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "днів";
  const last = value % 10;
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дні";
  return "днів";
}
