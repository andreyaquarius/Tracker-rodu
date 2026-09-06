import { getSupabaseClient } from "../../../src/services/supabaseAuth.ts";
import { putCachedDocumentBlob, setDocumentBlobCacheScope } from "../../../src/services/documentBlobCache.ts";
import { scanBlobCacheKey } from "../../../src/services/scanStorage.ts";
import type { ScanAttachment } from "../../../src/types";
const projectId = "0600bb00-0000-4000-8000-000000000010";
const personId = "0600bb00-0000-4000-8000-000000000101";
const button = document.getElementById("start") as HTMLButtonElement;
const status = document.getElementById("status")!;
button.onclick = async () => {
  button.disabled = true;
  try {
    if (import.meta.env.MODE !== "photo-tags" || import.meta.env.VITE_SUPABASE_URL !== "http://127.0.0.1:54321"
      || !["127.0.0.1", "localhost"].includes(location.hostname)) throw new Error("Доступно лише в локальному тестовому режимі photo-tags.");
    status.textContent = "Вхід до локального Supabase…";
    const { data, error } = await getSupabaseClient().auth.signInWithPassword({ email: "photo-tags-local@example.test", password: "PhotoTags-Docker-2026!" });
    if (error || !data.user) throw error ?? new Error("Не вдалося увійти.");
    const result = await getSupabaseClient().from("attachments").select("id,file_name,mime_type,size_bytes,created_at,storage_path").eq("project_id", projectId).eq("id", "0600bb00-0000-4000-8000-000000000301").single();
    if (result.error) throw result.error;
    const row = result.data;
    const photo: ScanAttachment = { id: row.id, name: row.file_name, mimeType: row.mime_type, size: row.size_bytes,
      createdAt: row.created_at, storage: "google-drive", storagePath: row.storage_path };
    const response = await fetch(new URL("./group.svg", import.meta.url));
    if (!response.ok) throw new Error("Не вдалося підготувати синтетичне фото.");
    setDocumentBlobCacheScope(data.user.id, projectId, { allowLegacyMigration: false });
    await putCachedDocumentBlob(scanBlobCacheKey(photo), await response.blob(), "image/svg+xml", scanBlobCacheKey(photo));
    location.assign(`/projects/${projectId}/persons/${personId}`);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
    button.disabled = false;
  }
};
