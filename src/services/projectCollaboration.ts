import { getSupabaseClient, getSupabaseSession } from "./supabaseAuth";

export type ProjectMemberRole = "owner" | "editor" | "viewer";
export type ProjectInvitationRole = Exclude<ProjectMemberRole, "owner">;

export interface ProjectMember {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  role: ProjectMemberRole;
  joinedAt: string;
}

export interface ProjectInvitation {
  id: string;
  projectId: string;
  projectName: string;
  email: string;
  role: ProjectInvitationRole;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
}

export interface ProjectInvitationCreationResult {
  invitation: ProjectInvitation;
  emailSent: boolean;
  warning?: string;
}

type ProjectRelation =
  | { name: string }
  | Array<{ name: string }>
  | null;

type MemberRow = {
  user_id: string;
  role: ProjectMemberRole;
  joined_at: string;
};

type ProfileRow = {
  user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
};

type InvitationRow = {
  id: string;
  project_id: string;
  email: string;
  role: ProjectInvitationRole;
  status: ProjectInvitation["status"];
  expires_at: string;
  created_at: string;
  projects?: ProjectRelation;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function functionErrorMessage(
  error: unknown,
  fallback: string,
): Promise<string> {
  if (typeof error === "object" && error !== null && "context" in error) {
    const context = error.context;
    if (context instanceof Response) {
      try {
        const body = await context.clone().json() as { error?: unknown; message?: unknown };
        const message = String(body.error ?? body.message ?? "").trim();
        if (message) return message;
      } catch {
        // Fall back to the SDK error below when the response is not JSON.
      }
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function memberFromRow(
  row: MemberRow,
  profiles: Map<string, ProfileRow>,
): ProjectMember {
  const profile = profiles.get(row.user_id);
  return {
    userId: row.user_id,
    email: profile?.email ?? "",
    displayName: profile?.display_name?.trim() || profile?.email || "Користувач",
    avatarUrl: profile?.avatar_url || undefined,
    role: row.role,
    joinedAt: row.joined_at,
  };
}

function invitationFromRow(row: InvitationRow): ProjectInvitation {
  const project = one(row.projects);
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: project?.name ?? "Запрошений проєкт",
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("project_members")
    .select("user_id, role, joined_at")
    .eq("project_id", projectId)
    .order("joined_at", { ascending: true });
  if (error) throw error;
  const members = data as MemberRow[];
  if (!members.length) return [];

  const profilesResult = await client
    .from("profiles")
    .select("user_id, email, display_name, avatar_url")
    .in("user_id", members.map((member) => member.user_id));
  if (profilesResult.error) throw profilesResult.error;
  const profiles = new Map(
    (profilesResult.data as ProfileRow[]).map((profile) => [profile.user_id, profile]),
  );
  return members.map((member) => memberFromRow(member, profiles));
}

export async function listProjectInvitations(
  projectId: string,
): Promise<ProjectInvitation[]> {
  const { data, error } = await getSupabaseClient()
    .from("project_invitations")
    .select("id, project_id, email, role, status, expires_at, created_at")
    .eq("project_id", projectId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as InvitationRow[]).map(invitationFromRow);
}

export async function listIncomingProjectInvitations(): Promise<ProjectInvitation[]> {
  const session = await getSupabaseSession();
  const email = session?.user.email?.trim().toLocaleLowerCase();
  if (!email) return [];

  const { data, error } = await getSupabaseClient()
    .from("project_invitations")
    .select(
      "id, project_id, email, role, status, expires_at, created_at, projects(name)",
    )
    .ilike("email", email)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as InvitationRow[]).map(invitationFromRow);
}

export async function createProjectInvitation(
  projectId: string,
  email: string,
  role: ProjectInvitationRole,
): Promise<ProjectInvitationCreationResult> {
  const session = await getSupabaseSession();
  if (!session) throw new Error("Увійдіть до облікового запису.");

  const normalizedEmail = email.trim().toLocaleLowerCase();
  if (!normalizedEmail) throw new Error("Вкажіть електронну адресу користувача.");
  if (normalizedEmail === session.user.email?.toLocaleLowerCase()) {
    throw new Error("Не можна запросити самого себе.");
  }

  const { data, error } = await getSupabaseClient()
    .from("project_invitations")
    .insert({
      project_id: projectId,
      email: normalizedEmail,
      role,
      invited_by: session.user.id,
    })
    .select("id, project_id, email, role, status, expires_at, created_at")
    .single();
  if (error) throw error;
  const invitation = invitationFromRow(data as InvitationRow);
  const emailResult = await getSupabaseClient().functions.invoke(
    "send-project-invitation",
    { body: { invitationId: invitation.id } },
  );
  if (emailResult.error) {
    return {
      invitation,
      emailSent: false,
      warning: `Запрошення створено, але лист не надіслано: ${await functionErrorMessage(
        emailResult.error,
        "перевірте налаштування поштової відправки",
      )}.`,
    };
  }
  return { invitation, emailSent: true };
}

export async function sendProjectInvitationEmail(
  invitationId: string,
): Promise<void> {
  const { error } = await getSupabaseClient().functions.invoke(
    "send-project-invitation",
    { body: { invitationId } },
  );
  if (error) {
    throw new Error(await functionErrorMessage(
      error,
      "Не вдалося надіслати лист. Перевірте налаштування поштової відправки.",
    ));
  }
}

export async function updateProjectInvitationRole(
  invitationId: string,
  role: ProjectInvitationRole,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("project_invitations")
    .update({ role })
    .eq("id", invitationId)
    .eq("status", "pending");
  if (error) throw error;
}

export async function revokeProjectInvitation(invitationId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("project_invitations")
    .update({ status: "revoked" })
    .eq("id", invitationId)
    .eq("status", "pending");
  if (error) throw error;
}

export async function updateProjectMemberRole(
  projectId: string,
  userId: string,
  role: ProjectInvitationRole,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("project_members")
    .update({ role })
    .eq("project_id", projectId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function removeProjectMember(
  projectId: string,
  userId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("project_members")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function acceptProjectInvitation(invitationId: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc(
    "accept_project_invitation",
    { invitation_id: invitationId },
  );
  if (error) throw error;
  return String(data);
}
