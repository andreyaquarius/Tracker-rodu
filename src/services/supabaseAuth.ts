import { createClient, type Session, type Subscription } from "@supabase/supabase-js";

export interface SupabaseAccount {
  id: string;
  name: string;
  email: string;
  picture?: string;
}

export interface SupabaseWorkspace {
  projectId: string;
  projectName: string;
  role: "owner" | "editor" | "viewer";
}

type MembershipRow = {
  role: SupabaseWorkspace["role"];
  projects:
    | {
        id: string;
        name: string;
      }
    | Array<{
        id: string;
        name: string;
      }>
    | null;
};

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? "";
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

export const isSupabaseConfigured = Boolean(supabaseUrl && publishableKey);

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

function requireSupabase() {
  if (!supabase) {
    throw new Error("На сайті не налаштовано підключення до Supabase.");
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

function mapMembership(row: MembershipRow): SupabaseWorkspace | null {
  const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
  if (!project) return null;
  return {
    projectId: project.id,
    projectName: project.name,
    role: row.role,
  };
}

async function readMemberships(): Promise<SupabaseWorkspace[]> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("project_members")
    .select("role, projects!inner(id, name)")
    .order("joined_at", { ascending: true });
  if (error) throw error;
  return (data as MembershipRow[])
    .map(mapMembership)
    .filter((workspace): workspace is SupabaseWorkspace => workspace !== null);
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
  const { data, error } = await requireSupabase().auth.signUp({
    email: email.trim().toLocaleLowerCase(),
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

export async function getSupabaseSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function listSupabaseWorkspaces(): Promise<SupabaseWorkspace[]> {
  return readMemberships();
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

  const { data: fallbackProject, error: fallbackProjectError } = await client
    .from("projects")
    .select("id, name")
    .eq("owner_id", session.user.id)
    .eq("name", projectName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
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
    role: "owner",
  };
}

export async function deleteSupabaseWorkspace(projectId: string): Promise<SupabaseWorkspace[]> {
  const client = requireSupabase();
  const { error } = await client.from("projects").delete().eq("id", projectId);
  if (error) throw new Error(asErrorMessage(error, "Не вдалося видалити проєкт."));
  return waitForWorkspaceRemoval(projectId);
}

export async function ensureSupabaseWorkspace(
  session: Session,
  account: SupabaseAccount,
): Promise<SupabaseWorkspace> {
  const client = requireSupabase();

  const memberships = await readMemberships();
  if (memberships.length) return memberships[0];

  const { data: existingProject, error: existingProjectError } = await client
    .from("projects")
    .select("id, name")
    .eq("owner_id", session.user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existingProjectError) throw existingProjectError;

  if (existingProject) {
    return {
      projectId: existingProject.id,
      projectName: existingProject.name,
      role: "owner",
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
  callback: (session: Session | null) => void,
): Subscription | null {
  if (!supabase) return null;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return data.subscription;
}

export async function signOutFromSupabase(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
