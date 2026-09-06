import { useEffect, useState } from "react";
import type { ScanAttachment } from "../../types";
import { photoTagError, photoTagsApi, type PhotoPersonTag, type PhotoTagsApi } from "../../services/photoPersonTags.ts";
import { usePersonPhotoPreviewSource } from "./PersonPhotoAlbumV2.tsx";
import "../../components/photoPeople.css";

export function PersonTaggedPhotos({ projectId, personId, onOpenPhoto, api = photoTagsApi }: {
  projectId: string; personId: string;
  onOpenPhoto?: (photo: ScanAttachment, photos: readonly ScanAttachment[], focusTagId?: string) => void;
  api?: PhotoTagsApi;
}) {
  const [tags, setTags] = useState<PhotoPersonTag[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === projectId) setReload((v) => v + 1); };
    const refresh = () => setReload((v) => v + 1);
    window.addEventListener("photo-person-tags-changed", changed);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("photo-person-tags-changed", changed); window.removeEventListener("focus", refresh); };
  }, [projectId]);
  useEffect(() => {
    let active = true;
    setTags([]); setError(""); setLoading(true);
    void api.list(projectId, { personId }).then((result) => { if (active) setTags(result.tags); })
      .catch((error: unknown) => { if (active) setError(photoTagError(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, personId, reload, api]);
  return <section className="person-tagged-photos" aria-label="Фото, на яких позначено особу">
    <h2>Фото, на яких позначено особу{tags.length ? ` (${tags.length})` : ""}</h2>
    {loading ? <p role="status">Завантаження фотографій…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!loading ? <button type="button" className="button button-secondary" onClick={() => setReload((v) => v + 1)}>Оновити фото з позначками</button> : null}
    {!loading && !error && !tags.length ? <p>Ще немає доступних фотографій із позначкою цієї особи.</p> : null}
    <div className="person-tagged-photos__grid">{tags.map((tag) => <TaggedPhoto key={tag.id} tag={tag} onOpen={() => onOpenPhoto?.(tag.photo, [tag.photo], tag.id)} canOpen={Boolean(onOpenPhoto)} />)}</div>
  </section>;
}
function TaggedPhoto({ tag, onOpen, canOpen }: { tag: PhotoPersonTag; onOpen: () => void; canOpen: boolean }) {
  const preview = usePersonPhotoPreviewSource(tag.photo);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [preview.url]);
  return <article className="person-tagged-photos__tile">
    {preview.url && !failed ? <img src={preview.url} alt={tag.photo.name} onError={() => setFailed(true)} /> : null}
    {preview.loading ? <p role="status">Завантаження фото…</p> : null}
    {preview.error || failed ? <p role="status">Фото недоступне. Перевірте доступ до оригіналу в Google Drive.</p> : null}
    <button type="button" className="button button-secondary" disabled={!canOpen} onClick={onOpen}>Відкрити з позначкою: {tag.photo.name}</button>
  </article>;
}
