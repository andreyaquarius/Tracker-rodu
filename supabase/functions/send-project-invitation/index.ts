import { createClient } from "npm:@supabase/supabase-js@2";

// Bind CORS to the deployed app origin instead of "*" (see _shared/ai.ts).
function normalizedOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") return trimmed || "*";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

const allowedOrigin = normalizedOrigin(
  Deno.env.get("ALLOWED_ORIGIN")?.trim() ||
  Deno.env.get("APP_URL")?.trim() ||
  "*",
);

const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

type InvitationRow = {
  id: string;
  email: string;
  role: "editor" | "viewer";
  status: string;
  expires_at: string;
  invited_by: string;
  projects: { name: string } | Array<{ name: string }> | null;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "Authentication required" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const emailFrom = Deno.env.get("INVITATION_EMAIL_FROM");
    const appUrl = Deno.env.get("APP_URL");
    if (!supabaseUrl || !supabaseAnonKey) {
      return json({ error: "Supabase function environment is incomplete" }, 500);
    }
    if (!resendApiKey || !emailFrom || !appUrl) {
      return json(
        {
          error:
            "Email delivery is not configured. Set RESEND_API_KEY, INVITATION_EMAIL_FROM and APP_URL.",
        },
        503,
      );
    }

    const { invitationId } = await request.json() as { invitationId?: string };
    if (!invitationId) return json({ error: "Invitation ID is required" }, 400);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: userResult, error: userError } = await supabase.auth.getUser();
    if (userError || !userResult.user) {
      return json({ error: "Authentication required" }, 401);
    }

    const { data, error } = await supabase
      .from("project_invitations")
      .select(
        "id, email, role, status, expires_at, invited_by, projects(name)",
      )
      .eq("id", invitationId)
      .single();
    if (error || !data) return json({ error: "Invitation not found" }, 404);

    const invitation = data as InvitationRow;
    if (
      invitation.invited_by !== userResult.user.id ||
      invitation.status !== "pending" ||
      new Date(invitation.expires_at).getTime() <= Date.now()
    ) {
      return json({ error: "Invitation cannot be sent" }, 403);
    }

    const inviterName = String(
      userResult.user.user_metadata?.full_name ||
        userResult.user.user_metadata?.name ||
        userResult.user.email ||
        "Користувач",
    );
    const name = projectName(invitation.projects);
    const roleLabel =
      invitation.role === "editor" ? "може редагувати" : "лише перегляд";
    const invitationUrl = new URL(appUrl);
    invitationUrl.searchParams.set("openTeam", "1");

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [invitation.email],
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
              <strong>${escapeHtml(invitation.email)}</strong>, щоб прийняти запрошення.</p>
            <p style="color:#667a76;font-size:13px">Запрошення діє до
              ${new Date(invitation.expires_at).toLocaleDateString("uk-UA")}.</p>
          </div>
        `,
      }),
    });
    const emailResult = await emailResponse.json();
    if (!emailResponse.ok) {
      return json(
        {
          error:
            typeof emailResult?.message === "string"
              ? emailResult.message
              : "Email provider rejected the message",
        },
        502,
      );
    }

    return json({ sent: true, id: emailResult.id });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      500,
    );
  }
});
