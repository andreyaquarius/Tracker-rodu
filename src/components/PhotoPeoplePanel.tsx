import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ScanAttachment } from "../types";
import { photoTagPoint, photoTagRect, photoTagStyle, validPhotoTagRect, type PhotoTagPoint, type PhotoTagRect } from "../services/photoTagGeometry.ts";
import { notifyPhotoTagsChanged, photoTagError, photoTagsApi, type PhotoPersonTag, type PhotoTagPerson, type PhotoTagsApi } from "../services/photoPersonTags.ts";
import "./photoPeople.css";

const defaultRect: PhotoTagRect = { x: 0.25, y: 0.25, width: 0.25, height: 0.25 };
const coordinateLabels = { x: "Ліворуч (%)", y: "Зверху (%)", width: "Ширина (%)", height: "Висота (%)" };

export function PhotoPeoplePanel({ projectId, photo, imageUrl, canEdit, focusTagId, onOpenPerson, api = photoTagsApi }: {
  projectId: string; photo: ScanAttachment; imageUrl: string; canEdit: boolean; focusTagId?: string;
  onOpenPerson: (id: string) => void; api?: PhotoTagsApi;
}) {
  const [tags, setTags] = useState<PhotoPersonTag[]>([]);
  const [permitted, setPermitted] = useState(false);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  const [imageReady, setImageReady] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState(focusTagId ?? "");
  const [draft, setDraft] = useState<PhotoTagRect | null>(null);
  const [editing, setEditing] = useState<PhotoPersonTag>();
  const [person, setPerson] = useState<PhotoTagPerson | null>(null);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<PhotoTagPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchRetry, setSearchRetry] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const anchor = useRef<{ point: PhotoTagPoint; pointerId: number } | null>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const selected = tags.find((tag) => tag.id === selectedId);
  const editable = canEdit && permitted && ready && imageReady && !imageFailed && !busy;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!draft && !loading) sidebarRef.current?.scrollTo({ top: 0 });
  }, [Boolean(draft), loading]);
  useEffect(() => {
    let active = true;
    setReady(false); setLoading(true); setError(""); setTags([]); setDraft(null); setConfirmDelete(false);
    void api.list(projectId, { attachmentId: photo.id }).then((result) => {
      if (!active) return;
      if (result.photo?.storagePath !== photo.storagePath) throw new Error("Джерело фото змінилося. Закрийте перегляд і відкрийте його повторно.");
      setTags(result.tags); setPermitted(result.canEdit); setReady(true);
    }).catch((error: unknown) => { if (active) setError(photoTagError(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, photo.id, photo.storagePath, reload, api]);

  useEffect(() => {
    let active = true;
    setPeople([]); setSearchError("");
    if (!draft || query.trim().length < 2) { setSearching(false); return; }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api.search(projectId, query).then((results) => { if (active) setPeople(results); })
        .catch((error: unknown) => { if (active) setSearchError(photoTagError(error)); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [projectId, query, Boolean(draft), searchRetry, api]);

  const cancelDraft = () => { setDraft(null); setEditing(undefined); setPerson(null); setQuery(""); anchor.current = null; };
  const beginDraft = (tag?: PhotoPersonTag) => {
    setEditing(tag); setDraft(tag ? { x: tag.x, y: tag.y, width: tag.width, height: tag.height } : { ...defaultRect });
    setPerson(tag ? { id: tag.personId, name: tag.personName, detail: "" } : null);
    setQuery(""); setError(""); setStatus(""); setConfirmDelete(false);
    window.requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>("input")?.focus());
  };
  const point = (event: PointerEvent<HTMLDivElement>) => photoTagPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!draft || !editable || !event.isPrimary || event.button !== 0 || anchor.current) return;
    event.preventDefault(); anchor.current = { point: point(event), pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (anchor.current?.pointerId !== event.pointerId) return;
    setDraft(photoTagRect(anchor.current.point, point(event)));
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (anchor.current?.pointerId !== event.pointerId) return;
    if (event.type !== "pointercancel") setDraft(photoTagRect(anchor.current.point, point(event)));
    anchor.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const mutate = async (action: () => Promise<unknown>, message: string) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setStatus("");
    try {
      const savedId = await action();
      notifyPhotoTagsChanged(projectId);
      if (!alive.current) return;
      if (typeof savedId === "string") setSelectedId(savedId);
      cancelDraft(); setConfirmDelete(false); setStatus(message);
      // A successful write stays successful even if the subsequent refresh fails.
      setReload((value) => value + 1);
    } catch (error) { if (alive.current) setError(photoTagError(error)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  };

  return (
    <section className="photo-people" aria-label="Люди на фото" onKeyDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <div className="photo-people__canvas">
        <div className="photo-people__tools">
          <strong>Люди на фото</strong>
          <button type="button" className="button button-secondary" disabled={zoom === 1} onClick={() => setZoom((v) => Math.max(1, v - 0.5))} aria-label="Зменшити фото">−</button>
          <span>{zoom * 100}%</span>
          <button type="button" className="button button-secondary" disabled={zoom >= 3} onClick={() => setZoom((v) => Math.min(3, v + 0.5))} aria-label="Збільшити фото">+</button>
        </div>
        <div className="photo-people__scroll">
          {ready && !imageFailed ? (
            <div className="photo-people__scale" style={{ width: `${zoom * 100}%` }}>
              <div className={`photo-people__image${draft ? " is-drawing" : ""}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
                <img src={imageUrl} alt={photo.name} draggable={false} onLoad={() => setImageReady(true)} onError={() => { setImageFailed(true); setImageReady(false); }} />
                {imageReady ? tags.filter((tag) => tag.id !== editing?.id || !draft).map((tag) => (
                  <button type="button" key={tag.id} className={`photo-people__rect${tag.id === selectedId ? " is-selected" : ""}`} style={photoTagStyle(tag)}
                    aria-label={`Позначка: ${tag.personName}`} aria-pressed={tag.id === selectedId} disabled={Boolean(draft)}
                    onClick={() => { setSelectedId(tag.id); setConfirmDelete(false); }}><span>{tag.personName}</span></button>
                )) : null}
                {draft && imageReady ? <span className="photo-people__rect is-draft" style={photoTagStyle(draft)} /> : null}
              </div>
            </div>
          ) : null}
          {imageFailed ? <p role="alert">Файл недоступний. Закрийте перегляд і перевірте доступ до оригіналу в Google Drive.</p> : null}
        </div>
      </div>
      <aside ref={sidebarRef} className="photo-people__sidebar">
        {loading ? <p role="status">Завантаження позначок…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <p role="status" aria-live="polite">{busy ? "Збереження…" : status}</p>
        <button type="button" className="button button-secondary" disabled={loading || busy} onClick={() => setReload((v) => v + 1)}>Оновити позначки</button>
        {ready && !draft ? <>
          <p>{tags.length ? `Позначено людей: ${tags.length}` : "На цьому фото ще нікого не позначено."}</p>
          <ul className="photo-people__list">{tags.map((tag) => <li key={tag.id}>
            <button type="button" aria-pressed={tag.id === selectedId} onClick={() => { setSelectedId(tag.id); setConfirmDelete(false); }}>{tag.personName}</button>
          </li>)}</ul>
          {selected ? <div className="photo-people__selected">
            <strong>{selected.personName}</strong>
            <button type="button" className="button button-secondary" disabled={busy || !imageReady || imageFailed} onClick={() => onOpenPerson(selected.personId)}>Відкрити картку особи</button>
            {editable ? <>
              <button type="button" className="button button-secondary" onClick={() => beginDraft(selected)}>Редагувати позначку</button>
              <button type="button" className="text-button" onClick={() => setConfirmDelete(true)}>Видалити позначку</button>
            </> : null}
            {confirmDelete ? <div>
              <p>Прибрати позначку «{selected.personName}»? Фото й особа залишаться.</p>
              <button type="button" disabled={busy} onClick={() => void mutate(() => api.remove(projectId, selected), "Позначку видалено.")}>Так, прибрати</button>
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Скасувати</button>
            </div> : null}
          </div> : null}
          {canEdit && permitted ? <button type="button" className="button button-primary" disabled={!editable} onClick={() => beginDraft()}>Позначити людину</button> : <p>Доступний перегляд позначок.</p>}
        </> : null}
        {draft ? <form ref={formRef} onSubmit={(event) => {
          event.preventDefault();
          if (person && editable && validPhotoTagRect(draft)) void mutate(() => api.save(projectId, photo.id, person.id, draft, editing), "Позначку збережено.");
        }}>
          <p>Протягніть рамку навколо людини мишею або пальцем. Також можна ввести координати нижче.</p>
          <fieldset disabled={busy}><legend>{editing ? "Редагування позначки" : "Нова позначка"}</legend>
            <div className="photo-people__coordinates">{(Object.keys(coordinateLabels) as (keyof PhotoTagRect)[]).map((key) => <label key={key}>
              {coordinateLabels[key]}<input type="number" min="0" max="100" step="any" required value={Number((draft[key] * 100).toFixed(4))}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.valueAsNumber / 100 })} />
            </label>)}</div>
            {!validPhotoTagRect(draft) ? <p role="alert">Рамка має вміщатися у фото та мати ненульовий розмір.</p> : null}
            <label>Пошук особи в проєкті<input type="search" value={query} placeholder="Щонайменше 2 символи" maxLength={160} onChange={(event) => setQuery(event.target.value)} /></label>
            {searching ? <p role="status">Пошук…</p> : null}
            {searchError ? <div role="alert">{searchError} <button type="button" onClick={() => setSearchRetry((v) => v + 1)}>Повторити пошук</button></div> : null}
            {!searching && !searchError && query.trim().length >= 2 && !people.length ? <p>Осіб не знайдено.</p> : null}
            <ul className="photo-people__list">{people.map((candidate) => <li key={candidate.id}><button type="button" aria-pressed={person?.id === candidate.id} onClick={() => setPerson(candidate)}>
              {candidate.name}{candidate.detail ? <small>{candidate.detail}</small> : null}
            </button></li>)}</ul>
            <p>{person ? `Вибрано: ${person.name}` : "Виберіть особу зі списку."}</p>
            <button type="submit" className="button button-primary" disabled={!editable || !person || !validPhotoTagRect(draft)}>Зберегти позначку</button>
            <button type="button" className="button button-secondary" onClick={cancelDraft}>Скасувати</button>
          </fieldset>
        </form> : null}
      </aside>
    </section>
  );
}
