import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type Subscription,
} from "@supabase/supabase-js";
import {
  assertAllowedRegistrationEmail,
  normalizeEmailForAuth,
  registrationBlockMessage,
} from "../utils/authRestrictions.ts";
import {
  createProjectDeletionOperations,
  parseProjectDeletionStatus,
  resumeProjectDeletion,
  runProjectDeletion,
  type ProjectDeletionOptions,
  type ProjectDeletionStatus,
} from "./projectDeletion.ts";

export interface SupabaseAccount {
  id: string;
  name: string;
  email: string;
  picture?: string;
}

export interface SupabaseWorkspace {
  projectId: string;
  projectName: string;
  projectSlug: string;
  role: "owner" | "editor" | "viewer";
  deletionPending: boolean;
  deletionJobId: string | null;
}

type MembershipRow = {
  role: SupabaseWorkspace["role"];
  projects:
    | {
        id: string;
        name: string;
        slug?: string | null;
        deletion_pending?: boolean | null;
      }
    | Array<{
        id: string;
        name: string;
        slug?: string | null;
        deletion_pending?: boolean | null;
      }>
    | null;
};

type ProjectRow = {
  id: string;
  name: string;
  slug?: string | null;
};

type RegistrationGuardResponse = {
  allowed?: boolean;
  reason?: string;
  message?: string;
  countryCode?: string | null;
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

export const isSupabaseConfigured = Boolean(supabaseUrl && publishableKey);

// Keep route-level reads from exhausting PostgREST when a page needs several
// related tables at once. The realtime websocket does not use this fetch queue.
const MAX_CONCURRENT_REQUESTS = 4;

function createConcurrencyLimitedFetch(maxConcurrent: number): typeof fetch {
  let active = 0;
  const queue: Array<() => void> = [];
  const releaseNext = () => {
    active -= 1;
    queue.shift()?.();
  };
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    new Promise<Response>((resolve, reject) => {
      const run = () => {
        active += 1;
        fetch(input, init).then(resolve, reject).finally(releaseNext);
      };
      if (active < maxConcurrent) run();
      else queue.push(run);
    })) as typeof fetch;
}

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
      global: {
        fetch: createConcurrencyLimitedFetch(MAX_CONCURRENT_REQUESTS),
      },
    })
  : null;

function requireSupabase() {
  if (!supabase) {
    throw new Error("На сайті не налаштовано підключення до сервера.");
  }
  return supabase;
}

export function getSupabaseClient() {
  return requireSupabase();
}

function applicationUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.href).toString();
}

function workspaceNameFor(account: SupabaseAccount): string {
  const trimmed = account.name.trim();
  return trimmed ? `Проєкт ${trimmed}` : "Мій проєкт";
}

function fallbackProjectSlug(name: string, projectId: string): string {
  const transliterated = name
    .trim()
    .toLocaleLowerCase()
    .replaceAll("щ", "shch")
    .replaceAll("ж", "zh")
    .replaceAll("ч", "ch")
    .replaceAll("ш", "sh")
    .replaceAll("ю", "iu")
    .replaceAll("я", "ia")
    .replaceAll("є", "ie")
    .replaceAll("ї", "i")
    .replaceAll("й", "i")
    .replaceAll("х", "kh")
    .replaceAll("ц", "ts")
    .replaceAll("ґ", "g")
    .replace(/[абвгдезиклмнопрстуфь]/g, (letter) => ({
      а: "a", б: "b", в: "v", г: "h", д: "d", е: "e", з: "z", и: "y",
      і: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
      с: "s", т: "t", у: "u", ф: "f", ь: "",
    })[letter] ?? "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${transliterated || "project"}-${projectId.slice(0, 8)}`;
}

function projectSlug(project: ProjectRow): string {
  return project.slug?.trim() || fallbackProjectSlug(project.name, project.id);
}

function mapMembership(row: MembershipRow): SupabaseWorkspace | null {
  const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
  if (!project) return null;
  return {
    projectId: project.id,
    projectName: project.name,
    projectSlug: projectSlug(project),
    role: row.role,
    deletionPending: project.deletion_pending === true,
    deletionJobId: null,
  };
}

function isMissingPendingDeletionRpcError(
  error: { code?: string; message?: string; details?: string; hint?: string } | null,
): boolean {
  const description = [error?.code, error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return description.includes("list_accessible_project_deletions") && (
    description.includes("pgrst202") ||
    description.includes("schema cache") ||
    description.includes("function")
  );
}

async function readAccessibleProjectDeletions(): Promise<ProjectDeletionStatus[]> {
  const { data, error } = await requireSupabase().rpc("list_accessible_project_deletions");
  if (error && isMissingPendingDeletionRpcError(error)) return [];
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    try {
      return [parseProjectDeletionStatus(value)];
    } catch {
      return [];
    }
  });
}

function isMissingSlugError(error: { message?: string; details?: string; hint?: string } | null): boolean {
  const description = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return description.includes("slug") && (
    description.includes("column") ||
    description.includes("schema cache") ||
    description.includes("does not exist")
  );
}

function isMissingDeletionPendingError(
  error: { message?: string; details?: string; hint?: string } | null,
): boolean {
  const description = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return description.includes("deletion_pending") && (
    description.includes("column") ||
    description.includes("schema cache") ||
    description.includes("does not exist")
  );
}

async function readMemberships(knownUserId?: string): Promise<SupabaseWorkspace[]> {
  const client = requireSupabase();
  let userId = knownUserId;
  if (!userId) {
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError) throw userError;
    userId = userData.user?.id;
  }
  if (!userId) return [];

  const loadMemberships = async (selection: string) => client
      .from("project_members")
      .select(selection)
      .eq("user_id", userId)
      .order("joined_at", { ascending: true });

  let memberships = await loadMemberships(
    "role, projects!inner(id, name, slug, deletion_pending)",
  );
  if (memberships.error && isMissingSlugError(memberships.error)) {
    memberships = await loadMemberships(
      "role, projects!inner(id, name, deletion_pending)",
    );
    if (memberships.error && isMissingDeletionPendingError(memberships.error)) {
      memberships = await loadMemberships("role, projects!inner(id, name)");
    }
  } else if (memberships.error && isMissingDeletionPendingError(memberships.error)) {
    memberships = await loadMemberships("role, projects!inner(id, name, slug)");
    if (memberships.error && isMissingSlugError(memberships.error)) {
      memberships = await loadMemberships("role, projects!inner(id, name)");
    }
  }
  const data = memberships.data as MembershipRow[] | null;
  const error = memberships.error;
  if (error) throw error;
  const mapped = (data ?? [])
    .map(mapMembership)
    .filter((workspace): workspace is SupabaseWorkspace => workspace !== null);
  const pendingDeletions = await readAccessibleProjectDeletions();
  const pendingByProject = new Map(
    pendingDeletions.map((status) => [status.projectId, status]),
  );
  const workspaces = mapped.map((workspace) => {
    const deletion = pendingByProject.get(workspace.projectId);
    if (!deletion) return workspace;
    pendingByProject.delete(workspace.projectId);
    return {
      ...workspace,
      deletionPending: true,
      deletionJobId: deletion.jobId,
    };
  });
  return Array.from(
    new Map(workspaces.map((workspace) => [workspace.projectId, workspace])).values(),
  );
}

function asErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = "message" in error ? String(error.message ?? "") : "";
    const details = "details" in error ? String(error.details ?? "") : "";
    const hint = "hint" in error ? String(error.hint ?? "") : "";
    const combined = [message, details, hint].filter(Boolean).join(" ");
    if (combined) return combined;
  }
  return fallback;
}

async function waitForMemberships(projectId?: string): Promise<SupabaseWorkspace[]> {
  let lastResult: SupabaseWorkspace[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    lastResult = await readMemberships();
    if (!projectId || lastResult.some((item) => item.projectId === projectId)) {
      return lastResult;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return lastResult;
}

async function waitForWorkspaceRemoval(projectId: string): Promise<SupabaseWorkspace[]> {
  let lastResult: SupabaseWorkspace[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    lastResult = await readMemberships();
    if (!lastResult.some((item) => item.projectId === projectId)) {
      return lastResult;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return lastResult;
}

async function checkRegistrationGuard(email: string): Promise<void> {
  assertAllowedRegistrationEmail(email);

  const client = requireSupabase();
  try {
    const { data, error } = await client.functions.invoke<RegistrationGuardResponse>(
      "registration-guard",
      { body: { email } },
    );
    if (error) return;
    if (data?.allowed === false) {
      throw new Error(data.message || registrationBlockMessage(data.reason));
    }
  } catch (error) {
    if (error instanceof Error) {
      const message = error.message;
      if (
        message === registrationBlockMessage("blocked_email_domain") ||
        message === registrationBlockMessage("blocked_region")
      ) {
        throw error;
      }
    }
  }
}

export async function signInWithSupabaseGoogle(): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: applicationUrl(),
    },
  });
  if (error) throw error;
}

export async function signInWithSupabaseEmail(
  email: string,
  password: string,
): Promise<void> {
  const { error } = await requireSupabase().auth.signInWithPassword({
    email: email.trim().toLocaleLowerCase(),
    password,
  });
  if (error) throw error;
}

export async function signUpWithSupabaseEmail(
  name: string,
  email: string,
  password: string,
): Promise<{ confirmationRequired: boolean }> {
  const normalizedEmail = normalizeEmailForAuth(email);
  await checkRegistrationGuard(normalizedEmail);

  const { data, error } = await requireSupabase().auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      emailRedirectTo: applicationUrl(),
      data: {
        full_name: name.trim(),
        name: name.trim(),
      },
    },
  });
  if (error) throw error;
  return { confirmationRequired: !data.session };
}

export async function requestSupabasePasswordReset(email: string): Promise<void> {
  const { error } = await requireSupabase().auth.resetPasswordForEmail(
    email.trim().toLocaleLowerCase(),
    {
      redirectTo: applicationUrl(),
    },
  );
  if (error) throw error;
}

export async function updateSupabasePassword(password: string): Promise<void> {
  const { error } = await requireSupabase().auth.updateUser({ password });
  if (error) throw error;
}

export async function getSupabaseSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function listSupabaseWorkspaces(
  expectedProjectId?: string,
  knownUserId?: string,
): Promise<SupabaseWorkspace[]> {
  return expectedProjectId
    ? waitForMemberships(expectedProjectId)
    : readMemberships(knownUserId);
}

export async function createSupabaseWorkspace(
  session: Session,
  name: string,
): Promise<SupabaseWorkspace> {
  const projectName = name.trim();
  if (!projectName) {
    throw new Error("Вкажіть назву нового проєкту.");
  }

  const client = requireSupabase();
  const { error } = await client
    .from("projects")
    .insert({
      owner_id: session.user.id,
      name: projectName,
    });
  if (error) throw new Error(asErrorMessage(error, "Не вдалося створити новий проєкт."));

  const primaryFallbackProject = await client
    .from("projects")
    .select("id, name, slug")
    .eq("owner_id", session.user.id)
    .eq("name", projectName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  let fallbackProject = primaryFallbackProject.data as ProjectRow | null;
  let fallbackProjectError = primaryFallbackProject.error;
  if (fallbackProjectError && isMissingSlugError(fallbackProjectError)) {
    const fallback = await client
      .from("projects")
      .select("id, name")
      .eq("owner_id", session.user.id)
      .eq("name", projectName)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    fallbackProject = fallback.data;
    fallbackProjectError = fallback.error;
  }
  if (fallbackProjectError) {
    throw new Error(asErrorMessage(fallbackProjectError, "Не вдалося знайти новий проєкт після створення."));
  }
  if (!fallbackProject) {
    throw new Error("Проєкт створено, але членство ще не з’явилося. Спробуйте оновити сторінку через кілька секунд.");
  }

  const refreshed = await waitForMemberships(fallbackProject.id);
  const created = refreshed.find((item) => item.projectId === fallbackProject.id);
  if (created) return created;

  return {
    projectId: fallbackProject.id,
    projectName: fallbackProject.name,
    projectSlug: projectSlug(fallbackProject),
    role: "owner",
    deletionPending: false,
    deletionJobId: null,
  };
}

export async function deleteSupabaseWorkspace(
  projectId: string,
  options: ProjectDeletionOptions = {},
): Promise<SupabaseWorkspace[]> {
  const client = requireSupabase();
  const operations = createProjectDeletionOperations(
    (functionName, args) => client.rpc(functionName, args),
    async (jobId) => {
      const { error } = await client.functions.invoke("process-project-deletions", {
        body: { jobId },
      });
      if (error) throw error;
    },
  );
  await runProjectDeletion(operations, projectId, options);
  return waitForWorkspaceRemoval(projectId);
}

export async function resumeSupabaseWorkspaceDeletion(
  workspace: SupabaseWorkspace,
  options: ProjectDeletionOptions = {},
): Promise<SupabaseWorkspace[]> {
  if (!workspace.deletionPending || !workspace.deletionJobId) {
    throw new Error("Не знайдено активне завдання видалення цього проєкту.");
  }
  const client = requireSupabase();
  const operations = createProjectDeletionOperations(
    (functionName, args) => client.rpc(functionName, args),
    async (jobId) => {
      const { error } = await client.functions.invoke("process-project-deletions", {
        body: { jobId },
      });
      if (error) throw error;
    },
  );
  await resumeProjectDeletion(
    operations,
    workspace.projectId,
    workspace.deletionJobId,
    options,
  );
  return waitForWorkspaceRemoval(workspace.projectId);
}

export async function renameSupabaseWorkspace(
  projectId: string,
  name: string,
): Promise<SupabaseWorkspace[]> {
  const projectName = name.trim();
  if (!projectName) {
    throw new Error("Назва проєкту не може бути порожньою.");
  }

  const client = requireSupabase();
  const { error } = await client
    .from("projects")
    .update({ name: projectName })
    .eq("id", projectId);
  if (error) throw new Error(asErrorMessage(error, "Не вдалося перейменувати проєкт."));
  return readMemberships();
}

export async function ensureSupabaseWorkspace(
  session: Session,
  account: SupabaseAccount,
  knownMemberships?: SupabaseWorkspace[],
): Promise<SupabaseWorkspace | null> {
  const client = requireSupabase();

  const memberships = knownMemberships ?? await readMemberships();
  const availableMembership = memberships.find((workspace) => !workspace.deletionPending);
  if (availableMembership) return availableMembership;
  if (memberships.length) return null;

  const normalizedEmail = session.user.email?.trim().toLocaleLowerCase() ?? "";
  if (normalizedEmail) {
    const { data: pendingInvitation, error: invitationError } = await client
      .from("project_invitations")
      .select("id")
      .ilike("email", normalizedEmail)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();
    if (invitationError) throw invitationError;
    if (pendingInvitation) return null;
  }

  const primaryExistingProject = await client
    .from("projects")
    .select("id, name, slug")
    .eq("owner_id", session.user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  let existingProject = primaryExistingProject.data as ProjectRow | null;
  let existingProjectError = primaryExistingProject.error;
  if (existingProjectError && isMissingSlugError(existingProjectError)) {
    const fallback = await client
      .from("projects")
      .select("id, name")
      .eq("owner_id", session.user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    existingProject = fallback.data;
    existingProjectError = fallback.error;
  }
  if (existingProjectError) throw existingProjectError;

  if (existingProject) {
    return {
      projectId: existingProject.id,
      projectName: existingProject.name,
      projectSlug: projectSlug(existingProject),
      role: "owner",
      deletionPending: false,
      deletionJobId: null,
    };
  }

  return createSupabaseWorkspace(session, workspaceNameFor(account));
}

export function getAccountFromSession(session: Session | null): SupabaseAccount | null {
  if (!session?.user) return null;
  const metadata = session.user.user_metadata;
  return {
    id: session.user.id,
    name: metadata.full_name || metadata.name || session.user.email || "Користувач",
    email: session.user.email || "",
    picture: metadata.avatar_url || metadata.picture || undefined,
  };
}

export function onSupabaseAuthChange(
  callback: (session: Session | null, event: AuthChangeEvent) => void,
): Subscription | null {
  if (!supabase) return null;
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(session, event));
  return data.subscription;
}

export async function signOutFromSupabase(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
