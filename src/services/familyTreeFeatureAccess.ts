import { getSupabaseClient } from "./supabaseAuth";

export interface FamilyTreeFeatureAccessUser {
  userId: string;
  email: string;
  displayName: string;
  isEnabled: boolean;
  isAdmin: boolean;
  grantedAt: string | null;
}

/**
 * Reads the server-side entitlement for the signed-in account. The caller must
 * treat errors as denied access; the module is intentionally fail-closed.
 */
export async function loadMyFamilyTreeFeatureAccess(): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc(
    "get_my_family_tree_feature_access",
  );
  if (error) throw error;
  return data === true;
}

/** Server-side guard used before the official GEDCOM import/export flows. */
export async function assertFamilyTreeFeatureAccess(): Promise<void> {
  const { data, error } = await getSupabaseClient().rpc(
    "assert_family_tree_feature_access",
  );
  if (error) throw error;
  if (data !== true) throw new Error("FAMILY_TREE_FEATURE_ACCESS_REQUIRED");
}

export async function loadAdminFamilyTreeFeatureAccess(): Promise<
  FamilyTreeFeatureAccessUser[]
> {
  const { data, error } = await getSupabaseClient().rpc(
    "admin_list_family_tree_feature_access",
  );
  if (error) throw error;

  return (data ?? []).map((row: Record<string, unknown>) => ({
    userId: String(row.user_id),
    email: String(row.email ?? ""),
    displayName: String(row.display_name ?? ""),
    isEnabled: Boolean(row.is_enabled),
    isAdmin: Boolean(row.is_admin),
    grantedAt: nullableString(row.granted_at),
  }));
}

export async function adminSetFamilyTreeFeatureAccess(input: {
  userId: string;
  isEnabled: boolean;
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc(
    "admin_set_family_tree_feature_access",
    {
      target_user_id: input.userId,
      target_is_enabled: input.isEnabled,
    },
  );
  if (error) throw error;
}

export function isFamilyTreeAccessRequiredError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String(error.message)
      : String(error ?? "");
  return message.includes("FAMILY_TREE_FEATURE_ACCESS_REQUIRED");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : String(value);
}
