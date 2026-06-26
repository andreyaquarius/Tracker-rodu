type GuardRequest = {
  email?: unknown;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const countryHeaderNames = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "x-country-code",
  "x-client-country",
  "cloudfront-viewer-country",
  "x-appengine-country",
  "x-geo-country",
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

function getEmailDomain(email: string): string {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex < 0) return "";
  return normalized.slice(atIndex + 1).replace(/\.+$/g, "");
}

function isBlockedEmailDomain(email: string): boolean {
  const domain = getEmailDomain(email);
  return domain === "ru" || domain.endsWith(".ru");
}

function countryCodeFromHeaders(headers: Headers): string | null {
  for (const name of countryHeaderNames) {
    const value = headers.get(name)?.trim();
    if (value) return value.toLocaleUpperCase();
  }
  return null;
}

function isBlockedCountryCode(countryCode: string | null): boolean {
  return countryCode === "RU" || countryCode === "RUS";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const input = await request.json().catch(() => ({})) as GuardRequest;
  const email = typeof input.email === "string" ? input.email : "";
  if (isBlockedEmailDomain(email)) {
    return json({
      allowed: false,
      reason: "blocked_email_domain",
      message: "Реєстрація з цією email-адресою недоступна.",
    }, 403);
  }

  const countryCode = countryCodeFromHeaders(request.headers);
  if (isBlockedCountryCode(countryCode)) {
    return json({
      allowed: false,
      reason: "blocked_region",
      message: "Доступ до сервісу з вашого регіону недоступний.",
      countryCode,
    }, 403);
  }

  return json({ allowed: true, countryCode });
});
