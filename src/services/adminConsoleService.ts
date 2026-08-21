import { getSupabaseClient } from "./supabaseAuth.ts";

export const ADMIN_PERMISSION_CODES = {
  analyticsView: "analytics.view",
  billingManage: "billing.manage",
  featuresManage: "features.manage",
  contentManage: "content.manage",
  supportManage: "support.manage",
  operationsManage: "operations.manage",
  securityView: "security.view",
  zagulyakyModerate: "zagulyaky.moderate",
  zagulyakyImport: "zagulyaky.import",
} as const;

export type AdminPermissionCode = typeof ADMIN_PERMISSION_CODES[keyof typeof ADMIN_PERMISSION_CODES];

export interface AdminCapabilities {
  isAdmin: boolean;
  roles: string[];
  permissions: string[];
}

export function hasAdminPermission(
  capabilities: AdminCapabilities | null,
  permission: AdminPermissionCode,
): boolean {
  return capabilities?.isAdmin === true && capabilities.permissions.includes(permission);
}

export interface AdminSystemHealth {
  checkedAt: string;
  analyticsEvents24h: number;
  gedcomImports: { active: number; stalled: number };
  gedcomExports: { queued: number; processing: number; failed: number };
  projectDeletions: { queued: number; running: number; failed: number };
  storage: {
    objects: number;
    bytes: number;
    buckets: Array<{ bucketId: string; objects: number; bytes: number }>;
  };
}

export interface AdminSecurityAuditRow {
  actionCode: string;
  targetType: string | null;
  outcome: string;
  createdAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function countRecord(value: unknown, keys: string[]): Record<string, number> {
  const source = record(value);
  return Object.fromEntries(keys.map((key) => [key, Number(source[key] ?? 0)]));
}

export async function loadAdminCapabilities(): Promise<AdminCapabilities> {
  const { data, error } = await getSupabaseClient().rpc("get_my_admin_capabilities");
  if (error) throw error;
  const value = record(data);
  return {
    isAdmin: value.isAdmin === true,
    roles: Array.isArray(value.roles) ? value.roles.map(String) : [],
    permissions: Array.isArray(value.permissions) ? value.permissions.map(String) : [],
  };
}

export async function loadAdminSystemHealth(): Promise<AdminSystemHealth> {
  const { data, error } = await getSupabaseClient().rpc("admin_get_system_health");
  if (error) throw error;
  const value = record(data);
  const imports = countRecord(value.gedcomImports, ["active", "stalled"]);
  const exports = countRecord(value.gedcomExports, ["queued", "processing", "failed"]);
  const deletions = countRecord(value.projectDeletions, ["queued", "running", "failed"]);
  const storage = record(value.storage);
  return {
    checkedAt: String(value.checkedAt ?? ""),
    analyticsEvents24h: Number(value.analyticsEvents24h ?? 0),
    gedcomImports: { active: imports.active ?? 0, stalled: imports.stalled ?? 0 },
    gedcomExports: {
      queued: exports.queued ?? 0,
      processing: exports.processing ?? 0,
      failed: exports.failed ?? 0,
    },
    projectDeletions: {
      queued: deletions.queued ?? 0,
      running: deletions.running ?? 0,
      failed: deletions.failed ?? 0,
    },
    storage: {
      objects: Number(storage.objects ?? 0),
      bytes: Number(storage.bytes ?? 0),
      buckets: (Array.isArray(storage.buckets) ? storage.buckets : []).map((entry) => {
        const bucket = record(entry);
        return {
          bucketId: String(bucket.bucketId ?? "unknown"),
          objects: Number(bucket.objects ?? 0),
          bytes: Number(bucket.bytes ?? 0),
        };
      }),
    },
  };
}

export async function loadAdminSecurityAudit(limit = 100): Promise<AdminSecurityAuditRow[]> {
  const { data, error } = await getSupabaseClient().rpc(
    "admin_get_security_audit",
    { p_limit: limit },
  );
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((value) => {
    const row = record(value);
    return {
      actionCode: String(row.action_code ?? ""),
      targetType: row.target_type === null || row.target_type === undefined
        ? null
        : String(row.target_type),
      outcome: String(row.outcome ?? ""),
      createdAt: String(row.created_at ?? ""),
    };
  });
}
