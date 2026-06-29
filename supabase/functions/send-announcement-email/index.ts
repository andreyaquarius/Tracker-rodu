import { createClient } from "npm:@supabase/supabase-js@2";

const localDevOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

const configuredOrigins = [
  Deno.env.get("ALLOWED_ORIGIN")?.trim(),
  Deno.env.get("APP_URL")?.trim(),
]
  .flatMap((value) => (value ?? "").split(","))
  .map(normalizeOrigin)
  .filter(Boolean);

function corsHeaders(request: Request): HeadersInit {
  const origin = normalizeOrigin(request.headers.get("Origin") ?? "");
  const allowedOrigins = new Set(configuredOrigins);
  for (const localOrigin of localDevOrigins) allowedOrigins.add(localOrigin);
  const allowedOrigin =
    allowedOrigins.has("*")
      ? "*"
      : origin && allowedOrigins.has(origin)
      ? origin
      : configuredOrigins[0] ?? "*";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function textToHtml(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

function emailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function appLink(): string {
  return Deno.env.get("APP_URL")?.trim() || "https://trekerrodu.com.ua";
}

type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  media_url: string | null;
  cta_label: string | null;
  cta_url: string | null;
  email_status: string;
};

type ProfileRow = {
  email: string | null;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json(request, { error: "Потрібна авторизація." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const emailFrom =
      Deno.env.get("ANNOUNCEMENT_EMAIL_FROM") ||
      Deno.env.get("INVITATION_EMAIL_FROM") ||
      Deno.env.get("RESEND_FROM_EMAIL");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return json(request, { error: "Серверна функція налаштована не повністю." }, 500);
    }
    if (!resendApiKey || !emailFrom) {
      return json(
        request,
        { error: "Email-розсилка не налаштована. Додайте RESEND_API_KEY та ANNOUNCEMENT_EMAIL_FROM." },
        503,
      );
    }

    const { announcementId } = await request.json() as { announcementId?: string };
    if (!announcementId) return json(request, { error: "Не вказано оголошення для розсилки." }, 400);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: userResult, error: userError } = await userClient.auth.getUser();
    if (userError || !userResult.user) {
      return json(request, { error: "Потрібна авторизація." }, 401);
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const { data: isAdmin, error: adminError } = await adminClient.rpc("is_app_admin", {
      target_user_id: userResult.user.id,
    });
    if (adminError || !isAdmin) {
      return json(request, { error: "Ця дія доступна лише адміністратору." }, 403);
    }

    const { data: announcement, error: announcementError } = await adminClient
      .from("app_announcements")
      .select("id, title, body, media_url, cta_label, cta_url, email_status")
      .eq("id", announcementId)
      .single();
    if (announcementError || !announcement) {
      return json(request, { error: "Оголошення не знайдено." }, 404);
    }

    const selectedAnnouncement = announcement as AnnouncementRow;
    if (selectedAnnouncement.email_status !== "planned") {
      return json(
        request,
        { error: "Для розсилки спочатку встановіть для оголошення статус email: підготовлено." },
        409,
      );
    }

    const { data: profiles, error: profilesError } = await adminClient
      .from("profiles")
      .select("email")
      .neq("email", "")
      .order("created_at", { ascending: true });
    if (profilesError) {
      return json(request, { error: "Не вдалося отримати список користувачів." }, 500);
    }

    const recipients = Array.from(
      new Set(
        ((profiles ?? []) as ProfileRow[])
          .map((profile) => profile.email?.trim().toLowerCase() ?? "")
          .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
      ),
    );
    if (!recipients.length) {
      return json(request, { error: "Немає користувачів з email для розсилки." }, 400);
    }

    const safeTitle = escapeHtml(selectedAnnouncement.title);
    const safeAppUrl = escapeHtml(appLink());
    const primaryUrl = selectedAnnouncement.cta_url?.trim() || appLink();
    const primaryLabel = selectedAnnouncement.cta_label?.trim() || "Відкрити Трекер Роду";
    const mediaLink = selectedAnnouncement.media_url?.trim();
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#123b35;line-height:1.55">
        <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#9b6b18;margin:0 0 14px">Оновлення Трекера Роду</p>
        <h1 style="font-family:Georgia,serif;font-size:28px;line-height:1.2;margin:0 0 18px">${safeTitle}</h1>
        ${textToHtml(selectedAnnouncement.body)}
        ${
          mediaLink
            ? `<p><a href="${escapeHtml(mediaLink)}" style="color:#174f46">Переглянути додатковий матеріал</a></p>`
            : ""
        }
        <p style="margin:28px 0">
          <a href="${escapeHtml(primaryUrl)}"
            style="background:#174f46;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">
            ${escapeHtml(primaryLabel)}
          </a>
        </p>
        <p style="color:#667a76;font-size:13px">
          Ви отримали цей лист, бо зареєстровані у Трекері Роду.
          <br><a href="${safeAppUrl}" style="color:#174f46">${safeAppUrl}</a>
        </p>
      </div>
    `;
    const text = [
      selectedAnnouncement.title,
      "",
      selectedAnnouncement.body,
      "",
      mediaLink ? `Додатковий матеріал: ${mediaLink}` : "",
      `${primaryLabel}: ${primaryUrl}`,
      "",
      "Ви отримали цей лист, бо зареєстровані у Трекері Роду.",
    ].filter(Boolean).join("\n");

    let sent = 0;
    let failed = 0;
    const senderMailbox = emailAddress(emailFrom);
    for (const batch of chunk(recipients, 45)) {
      const emailResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: emailFrom,
          to: [senderMailbox],
          bcc: batch,
          subject: selectedAnnouncement.title,
          html,
          text,
        }),
      });

      if (emailResponse.ok) {
        sent += batch.length;
      } else {
        failed += batch.length;
      }
    }

    if (sent > 0 && failed === 0) {
      await adminClient
        .from("app_announcements")
        .update({
          email_status: "sent",
          email_requested_at: new Date().toISOString(),
          email_requested_by: userResult.user.id,
        })
        .eq("id", selectedAnnouncement.id);
    }

    return json(request, { sent, failed });
  } catch (error) {
    return json(
      request,
      { error: error instanceof Error ? error.message : "Не вдалося надіслати email-оновлення." },
      500,
    );
  }
});
