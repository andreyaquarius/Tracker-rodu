import { getSupabaseClient } from "./supabaseAuth";
import { canonicalPhotoTagRect, validPhotoTagRect, type PhotoTagRect } from "./photoTagGeometry.ts";
import type { ScanAttachment } from "../types";

export interface PhotoPersonTag extends PhotoTagRect {
  id: string; personId: string; personName: string; attachmentId: string; version: number; photo: ScanAttachment;
}
export interface PhotoTagsResult { photo: ScanAttachment | null; canEdit: boolean; tags: PhotoPersonTag[] }
export interface PhotoTagPerson { id: string; name: string; detail: string }
export interface PhotoTagsApi {
  list(projectId: string, filter: { attachmentId: string } | { personId: string }): Promise<PhotoTagsResult>;
  search(projectId: string, query: string): Promise<PhotoTagPerson[]>;
  save(projectId: string, attachmentId: string, personId: string, rect: PhotoTagRect, previous?: PhotoPersonTag): Promise<string>;
  remove(projectId: string, tag: PhotoPersonTag): Promise<void>;
}

export function photoTagError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "PGRST202" || code === "42P01") return "Позначення людей ще не ввімкнено на сервері. Потрібна міграція бази даних.";
  if (code === "23505") return "Цю особу вже позначено на фото. Виберіть її позначку для редагування.";
  if (code === "40001") return "Позначку змінено або видалено в іншому вікні, або доступ втрачено. Оновіть позначки.";
  if (code === "42501" || code === "23503") return "Немає доступу до фото чи особи. Збережіть запис із вкладенням і перевірте права доступу.";
  return error instanceof Error ? error.message : "Не вдалося завантажити або зберегти позначки. Спробуйте ще раз.";
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await getSupabaseClient().rpc(name, args);
  if (result.error) throw result.error;
  return result.data as T;
}
export const photoTagsApi: PhotoTagsApi = {
  list: (projectId, filter) => rpc("list_photo_person_tags_v1", {
    p_project_id: projectId,
    p_attachment_id: "attachmentId" in filter ? filter.attachmentId : null,
    p_person_id: "personId" in filter ? filter.personId : null,
  }),
  search: (projectId, query) => rpc("search_photo_tag_persons_v1", { p_project_id: projectId, p_query: query }),
  save: (projectId, attachmentId, personId, rect, previous) => {
    rect = canonicalPhotoTagRect(rect);
    if (!validPhotoTagRect(rect)) return Promise.reject(new Error("Рамка має бути всередині зображення та мати ненульовий розмір."));
    return rpc("save_photo_person_tag_v1", { p_project_id: projectId, p_attachment_id: attachmentId,
      p_person_id: personId, p_x: rect.x, p_y: rect.y, p_width: rect.width, p_height: rect.height,
      p_id: previous?.id ?? null, p_version: previous?.version ?? null });
  },
  remove: (projectId, tag) => rpc("delete_photo_person_tag_v1", { p_project_id: projectId, p_id: tag.id, p_version: tag.version }),
};

export function notifyPhotoTagsChanged(projectId: string) {
  window.dispatchEvent(new CustomEvent("photo-person-tags-changed", { detail: projectId }));
}
