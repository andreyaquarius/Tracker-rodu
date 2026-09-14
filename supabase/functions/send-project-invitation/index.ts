import { createClient } from "npm:@supabase/supabase-js@2.108.0";

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

type InvitationRow = {
  id: string;
  email: string;
  role: "editor" | "viewer";
  status: string;
  expires_at: string;
  invited_by: string;
  projects: { name: string } | Array<{ name: string }> | null;
};

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

function projectName(value: InvitationRow["projects"]): string {
  const project = Array.isArray(value) ? value[0] : value;
  return project?.name?.trim() || "Спільний проєкт";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return json(request, { error: "Method not allowed" }, 405);
  }

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json(request, { error: "Authentication required" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const emailFrom = Deno.env.get("INVITATION_EMAIL_FROM");
    const appUrl = Deno.env.get("APP_URL");
    if (!supabaseUrl || !supabaseAnonKey || !serviceKey) {
      return json(request, { error: "Supabase function environment is incomplete" }, 500);
    }
    if (!resendApiKey || !emailFrom || !appUrl) {
      return json(
        request,
        {
          error:
            "Email delivery is not configured. Set RESEND_API_KEY, INVITATION_EMAIL_FROM and APP_URL.",
        },
        503,
      );
    }

    const { invitationId } = await request.json() as { invitationId?: string };
    if (typeof invitationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invitationId)) return json(request, { error: "Valid invitation ID is required" }, 400);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: userResult, error: userError } = await supabase.auth.getUser();
    if (userError || !userResult.user) {
      return json(request, { error: "Authentication required" }, 401);
    }

    const { data, error } = await supabase
      .from("project_invitations")
      .select(
        "id, email, role, status, expires_at, invited_by, projects(name)",
      )
      .eq("id", invitationId)
      .single();
    if (error || !data) return json(request, { error: "Invitation not found" }, 404);

    const invitation = data as InvitationRow;
    if (
      invitation.invited_by !== userResult.user.id ||
      invitation.status !== "pending" ||
      new Date(invitation.expires_at).getTime() <= Date.now()
    ) {
      return json(request, { error: "Invitation cannot be sent" }, 403);
    }

    // Only the server can claim delivery. Authorization/status are checked
    // again under a DB lock immediately before the external provider call.
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: claim, error: claimError } = await admin.rpc("claim_invitation_email_v1", {
      target_invitation_id: invitationId, target_actor_id: userResult.user.id,
    });
    if (claimError) return json(request, { error: "Invitation cannot be sent" }, claimError.code === "42501" ? 403 : 503);
    if (!claim || claim.status !== "claimed") {
      return json(request, { error: "Зачекайте перед повторним надсиланням запрошення.", retryAfter: claim?.retry_after ?? 60 }, 429);
    }
    // A failed/uncertain attempt retains both the idempotency key and payload.
    const snapshot = claim.snapshot;
    const inviterName = String(snapshot.inviter_name || "Користувач");
    const name = String(snapshot.project_name || "Спільний проєкт");
    const roleLabel =
      snapshot.role === "editor" ? "може редагувати" : "лише перегляд";
    const invitationUrl = new URL(appUrl);
    invitationUrl.searchParams.set("openTeam", "1");

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `project-invitation/${claim.id}`,
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [snapshot.email],
        subject: `Запрошення до проєкту «${name}»`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#153d37">
            <h1 style="font-family:Georgia,serif">Запрошення до Трекера Роду</h1>
            <p><strong>${escapeHtml(inviterName)}</strong> запрошує вас до проєкту
              <strong>«${escapeHtml(name)}»</strong>.</p>
            <p>Рівень доступу: <strong>${roleLabel}</strong>.</p>
            <p style="margin:28px 0">
              <a href="${escapeHtml(invitationUrl.toString())}"
                style="background:#174f46;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">
                Відкрити запрошення
              </a>
            </p>
            <p>Увійдіть або зареєструйтеся з адресою
              <strong>${escapeHtml(snapshot.email)}</strong>, щоб прийняти запрошення.</p>
            <p style="color:#667a76;font-size:13px">Запрошення діє до
              ${new Date(snapshot.expires_at).toLocaleDateString("uk-UA")}.</p>
          </div>
        `,
      }),
    });
    const emailResult = await emailResponse.json();
    const { error: finishError } = await admin.rpc("finish_invitation_email_v1", {
      delivery_id: claim.id, claim_token: claim.lease_token, delivered: emailResponse.ok,
    });
    if (finishError) return json(request, { error: "Не вдалося підтвердити стан доставки. Не надсилайте запрошення повторно одразу." }, 503);
    if (!emailResponse.ok) {
      return json(
        request,
        {
          error:
            typeof emailResult?.message === "string"
              ? emailResult.message
              : "Email provider rejected the message",
        },
        502,
      );
    }

    return json(request, { sent: true, id: emailResult.id });
  } catch (error) {
    return json(
      request,
      { error: error instanceof Error ? error.message : "Unexpected error" },
      500,
    );
  }
});
