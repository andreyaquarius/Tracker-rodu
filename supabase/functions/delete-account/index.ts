import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorMessage, json } from "../_shared/ai.ts";

const STORAGE_BUCKETS = ["project-backups", "project-attachments", "gedcom-exports"] as const;
const STORAGE_PAGE_SIZE = 1_000;
const STORAGE_REMOVE_BATCH_SIZE = 100;

type StorageListEntry = {
  id?: string | null;
  name: string;
};

type AccountDeletionResult = {
  removedRows?: number;
  projectIds?: unknown[];
};

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function requiredEnvironment() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const publicKey = (
    Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
  )?.trim();
  const serviceRoleKey = (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY")
  )?.trim();
  if (!supabaseUrl || !publicKey || !serviceRoleKey) {
    throw new HttpError(500, "Налаштування серверної функції неповні.");
  }
  return { supabaseUrl, publicKey, serviceRoleKey };
}

async function authenticatedDeletionContext(request: Request) {
  const authorization = request.headers.get("Authorization")?.trim();
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(401, "Потрібна авторизація.");
  }

  const env = requiredEnvironment();
  const userClient = createClient(env.supabaseUrl, env.publicKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) {
    throw new HttpError(401, "Не вдалося підтвердити користувача.");
  }

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { user: data.user, admin };
}

function storagePath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function isMissingBucket(error: unknown): boolean {
  const message = error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error ?? "");
  return /bucket.+not found|not found.+bucket/i.test(message);
}

async function removeProjectObjectsFromBucket(
  admin: SupabaseClient,
  bucket: string,
  projectId: string,
): Promise<void> {
  const directories = [projectId];
  const visited = new Set<string>();

  while (directories.length) {
    const directory = directories.shift()!;
    if (visited.has(directory)) continue;
    visited.add(directory);

    const files: string[] = [];
    const childDirectories: string[] = [];
    let offset = 0;

    // Read a complete directory before removing objects from it. Removing one
    // page while incrementing the offset would skip the following page.
    while (true) {
      const { data, error } = await admin.storage.from(bucket).list(directory, {
        limit: STORAGE_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) {
        if (offset === 0 && directory === projectId && isMissingBucket(error)) return;
        throw error;
      }

      const entries = (data ?? []) as StorageListEntry[];
      for (const entry of entries) {
        const path = storagePath(directory, entry.name);
        if (entry.id == null) childDirectories.push(path);
        else files.push(path);
      }
      if (entries.length < STORAGE_PAGE_SIZE) break;
      offset += entries.length;
    }

    for (let index = 0; index < files.length; index += STORAGE_REMOVE_BATCH_SIZE) {
      const { error } = await admin.storage
        .from(bucket)
        .remove(files.slice(index, index + STORAGE_REMOVE_BATCH_SIZE));
      if (error) throw error;
    }
    directories.push(...childDirectories);
  }
}

async function removeOwnedProjectStorage(
  admin: SupabaseClient,
  projectIds: string[],
): Promise<number> {
  for (const projectId of projectIds) {
    for (const bucket of STORAGE_BUCKETS) {
      await removeProjectObjectsFromBucket(admin, bucket, projectId);
    }
  }
  return projectIds.length;
}

function accountDeletionResult(value: unknown): {
  removedRows?: number;
  projectIds: string[];
} {
  const result = value && typeof value === "object"
    ? value as AccountDeletionResult
    : {};
  const projectIds = Array.isArray(result.projectIds)
    ? result.projectIds
      .map((projectId) => String(projectId ?? "").trim())
      .filter((projectId) => (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(projectId)
      ))
    : [];
  return {
    removedRows: typeof result.removedRows === "number" ? result.removedRows : undefined,
    projectIds: [...new Set(projectIds)],
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { user, admin } = await authenticatedDeletionContext(request);

    // This endpoint is intentionally self-delete only. Administrator accounts
    // are protected from both the UI and a direct Edge Function request.
    const { data: isAdmin, error: adminCheckError } = await admin.rpc("is_app_admin", {
      target_user_id: user.id,
    });
    if (adminCheckError) throw adminCheckError;
    if (isAdmin === true) {
      throw new HttpError(
        403,
        "Акаунт адміністратора не можна видалити через користувацьке меню.",
      );
    }

    // The database transaction records a private durable Storage manifest
    // before deleting owned projects. A retry can therefore continue cleanup
    // even if the previous Edge Function invocation stopped after the commit.
    const { data: deletionData, error: deleteRowsError } = await admin.rpc(
      "delete_account_data_v2",
      { p_user_id: user.id },
    );
    if (deleteRowsError) throw deleteRowsError;
    const deletion = accountDeletionResult(deletionData);

    const removedStorageProjects = await removeOwnedProjectStorage(
      admin,
      deletion.projectIds,
    );

    const { error: completeError } = await admin.rpc("complete_account_deletion", {
      p_user_id: user.id,
    });
    if (completeError) throw completeError;

    const { error: deleteUserError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteUserError) throw deleteUserError;

    return json({
      deleted: true,
      removedRows: deletion.removedRows,
      removedStorageProjects,
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const publicMessage = error instanceof HttpError
      ? error.message
      : "Не вдалося завершити видалення акаунта. Безпечно повторіть спробу: очищення продовжиться з останнього завершеного кроку.";
    console.error("Account self-deletion failed", {
      status,
      message: errorMessage(error),
    });
    return json({ error: publicMessage }, status);
  }
});
