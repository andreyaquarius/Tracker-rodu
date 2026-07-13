import { createClient } from "npm:@supabase/supabase-js@2";

type ClaimedReminder = {
  notification_id: string;
  claim_token: string;
  recipient_user_id: string;
  recipient_email: string | null;
  task_id: string;
  task_title: string;
  task_description: string;
  task_deadline: string;
  project_id: string;
  project_name: string;
  scheduled_for: string;
  email_attempt: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formattedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Europe/Kyiv",
  }).format(date);
}

function formattedCalendarDate(value: string): string {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function appTaskUrl(reminder: ClaimedReminder): string {
  const baseUrl = (Deno.env.get("APP_URL")?.trim() || "https://trekerrodu.com.ua")
    .replace(/\/+$/, "");
  return `${baseUrl}/projects/${encodeURIComponent(reminder.project_id)}/tasks`;
}

function emailContent(reminder: ClaimedReminder): { html: string; text: string } {
  const taskUrl = appTaskUrl(reminder);
  const deadline = reminder.task_deadline
    ? `<p><strong>Строк виконання:</strong> ${escapeHtml(formattedCalendarDate(reminder.task_deadline))}</p>`
    : "";
  const description = reminder.task_description.trim()
    ? `<p>${escapeHtml(reminder.task_description).replaceAll("\n", "<br>")}</p>`
    : "";
  return {
    html: `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#123b35;line-height:1.55">
        <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#9b6b18;margin:0 0 14px">Нагадування Трекера Роду</p>
        <h1 style="font-family:Georgia,serif;font-size:28px;line-height:1.2;margin:0 0 18px">${escapeHtml(reminder.task_title)}</h1>
        <p><strong>Проєкт:</strong> ${escapeHtml(reminder.project_name)}</p>
        <p><strong>Час нагадування:</strong> ${escapeHtml(formattedDate(reminder.scheduled_for))}</p>
        ${deadline}
        ${description}
        <p style="margin:28px 0">
          <a href="${escapeHtml(taskUrl)}" style="background:#174f46;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">
            Відкрити завдання
          </a>
        </p>
        <p style="color:#667a76;font-size:13px">Лист надіслано відповідно до налаштувань нагадування у вашому завданні.</p>
      </div>
    `,
    text: [
      "Нагадування Трекера Роду",
      reminder.task_title,
      `Проєкт: ${reminder.project_name}`,
      `Час нагадування: ${formattedDate(reminder.scheduled_for)}`,
      reminder.task_deadline ? `Строк виконання: ${formattedCalendarDate(reminder.task_deadline)}` : "",
      reminder.task_description,
      `Відкрити завдання: ${taskUrl}`,
    ].filter(Boolean).join("\n\n"),
  };
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { message?: unknown; error?: unknown };
    return String(payload.message ?? payload.error ?? `HTTP ${response.status}`);
  } catch {
    return `HTTP ${response.status}`;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const cronSecret = Deno.env.get("TASK_REMINDER_CRON_SECRET")?.trim() ?? "";
  const authorization = request.headers.get("Authorization") ?? "";
  const providedSecret = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : request.headers.get("x-cron-secret")?.trim() ?? "";
  if (!cronSecret || !providedSecret || !safeEqual(cronSecret, providedSecret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Supabase service configuration is incomplete." }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await adminClient.rpc("claim_due_task_reminders", {
    batch_limit: 100,
  });
  if (error) return json({ error: error.message }, 500);

  const reminders = (data ?? []) as ClaimedReminder[];
  if (!reminders.length) return json({ claimed: 0, sent: 0, failed: 0 });

  const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim() ?? "";
  const emailFrom =
    Deno.env.get("TASK_REMINDER_EMAIL_FROM")?.trim() ||
    Deno.env.get("ANNOUNCEMENT_EMAIL_FROM")?.trim() ||
    Deno.env.get("INVITATION_EMAIL_FROM")?.trim() ||
    Deno.env.get("RESEND_FROM_EMAIL")?.trim() ||
    "";
  let sent = 0;
  let failed = 0;

  for (let offset = 0; offset < reminders.length; offset += 5) {
    const batch = reminders.slice(offset, offset + 5);
    await Promise.all(batch.map(async (reminder) => {
      let delivered = false;
      let deliveryError = "";
      const recipient = reminder.recipient_email?.trim() ?? "";
      if (!resendApiKey || !emailFrom) {
        deliveryError = "RESEND_API_KEY or TASK_REMINDER_EMAIL_FROM is not configured.";
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        deliveryError = "The reminder recipient does not have a valid email address.";
      } else {
        const content = emailContent(reminder);
        try {
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendApiKey}`,
              "Content-Type": "application/json",
              "Idempotency-Key": `task-reminder-${reminder.notification_id}`,
            },
            body: JSON.stringify({
              from: emailFrom,
              to: [recipient],
              subject: `Нагадування: ${reminder.task_title}`,
              html: content.html,
              text: content.text,
            }),
          });
          delivered = response.ok;
          if (!response.ok) deliveryError = await responseError(response);
        } catch (sendError) {
          deliveryError = sendError instanceof Error ? sendError.message : "Email request failed.";
        }
      }

      const { error: completionError } = await adminClient.rpc(
        "complete_task_reminder_delivery",
        {
          target_notification_id: reminder.notification_id,
          target_claim_token: reminder.claim_token,
          delivered,
          delivery_error: deliveryError || null,
        },
      );
      if (completionError || !delivered) failed += 1;
      else sent += 1;
    }));
  }

  return json({ claimed: reminders.length, sent, failed });
});
