import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ArchiveRequest,
  Finding,
  Hypothesis,
  Person,
  PersonRelation,
  Research,
  TaskRecord,
} from "../../types";
import {
  buildPersonTimeline,
  personDisplayName as previewPersonNameV2,
  personInitials as previewInitialsV2,
  personLifeYears,
  personRelationLabel,
} from "./model";

export interface PersonPreviewDrawerV2Props {
  person: Person | null;
  persons?: readonly Person[];
  relations?: readonly PersonRelation[];
  research?: Research | null;
  findings?: readonly Finding[];
  tasks?: readonly TaskRecord[];
  hypotheses?: readonly Hypothesis[];
  archiveRequests?: readonly ArchiveRequest[];
  photoUrl?: string;
  directAncestor?: boolean;
  onClose: () => void;
  onOpenProfile?: (person: Person) => void;
  onShowInTree?: (person: Person) => void;
  onEdit?: (person: Person) => void;
  onDelete?: (person: Person) => void;
  onAddEvent?: (person: Person) => void;
  onLinkDocument?: (person: Person) => void;
  onMoreActions?: (person: Person) => void;
}

export function PersonPreviewDrawerV2({
  person,
  persons = [],
  relations = [],
  research,
  findings = [],
  tasks = [],
  hypotheses = [],
  archiveRequests = [],
  photoUrl,
  directAncestor = false,
  onClose,
  onOpenProfile,
  onShowInTree,
  onEdit,
  onDelete,
  onAddEvent,
  onLinkDocument,
  onMoreActions,
}: PersonPreviewDrawerV2Props) {
  const [compactOverlay, setCompactOverlay] = useState(() => (
    typeof window !== "undefined"
      && window.matchMedia("(max-width: 780px)").matches
  ));
  const [photoFailed, setPhotoFailed] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 780px)");
    const sync = () => setCompactOverlay(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setPhotoFailed(false);
  }, [person?.id, photoUrl]);

  useEffect(() => {
    if (!person || !compactOverlay || typeof document === "undefined") return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && !drawer.contains(activeElement)) {
      returnFocusRef.current = activeElement;
    }
    const catalogMain = drawer
      .closest(".persons-v2-catalog-shell")
      ?.querySelector<HTMLElement>(".persons-v2-catalog-main") ?? null;
    const catalogWasInert = catalogMain?.hasAttribute("inert") ?? false;
    catalogMain?.setAttribute("inert", "");
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (catalogMain && !catalogWasInert) catalogMain.removeAttribute("inert");
      document.body.style.overflow = previousBodyOverflow;
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [compactOverlay, person?.id]);

  if (!person) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!compactOverlay) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute("hidden"));
    if (!focusable.length) {
      event.preventDefault();
      drawer.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const name = previewPersonNameV2(person);
  const linkedRelations = relations.filter(
    (relation) => relation.personId === person.id || relation.relatedPersonId === person.id,
  );
  const personsById = new Map(persons.map((item) => [item.id, item]));
  const relatives = linkedRelations.flatMap((relation) => {
    const relatedId = relation.personId === person.id
      ? relation.relatedPersonId
      : relation.personId;
    const relatedPerson = personsById.get(relatedId);
    return relatedPerson ? [{ relation, person: relatedPerson }] : [];
  });
  const linkedFindings = findings.filter((finding) => finding.personIds.includes(person.id));
  const linkedTasks = tasks.filter((task) => task.personIds.includes(person.id));
  const linkedHypotheses = hypotheses.filter((hypothesis) => hypothesis.personIds.includes(person.id));
  const linkedArchiveRequests = archiveRequests.filter((request) => request.personIds.includes(person.id));
  const documentIds = new Set([
    ...linkedFindings.map((finding) => finding.documentId),
    ...linkedTasks.map((task) => task.documentId),
    ...linkedHypotheses.flatMap((hypothesis) => hypothesis.documentIds),
  ].filter(Boolean));
  const eventCount = previewEventCountV2(person);
  const notesCount = [
    person.notes,
    ...linkedRelations.map((relation) => relation.notes),
  ].filter((value) => value.trim()).length;
  const keyRelation = relatives.find(({ relation }) => isPrimaryFamilyRelationV2(relation))
    ?? relatives[0];

  return (
    <aside
      ref={drawerRef}
      className="panel persons-v2-preview"
      role={compactOverlay ? "dialog" : undefined}
      aria-modal={compactOverlay || undefined}
      aria-labelledby="persons-v2-preview-title"
      aria-describedby="persons-v2-preview-summary"
      tabIndex={compactOverlay ? -1 : undefined}
      onKeyDown={handleKeyDown}
    >
      <header className="persons-v2-preview__header">
        <button
          type="button"
          ref={closeButtonRef}
          className="button button-ghost persons-v2-preview__close"
          aria-label="Закрити попередній перегляд"
          onClick={onClose}
        >
          ×
        </button>
        <div className="persons-v2-preview__photo">
          {photoUrl && !photoFailed ? (
            <img src={photoUrl} alt={`Фото: ${name}`} onError={() => setPhotoFailed(true)} />
          ) : (
            <span aria-hidden="true">{previewInitialsV2(person)}</span>
          )}
        </div>
        <div>
          <h2 id="persons-v2-preview-title">{name}</h2>
          <div className="persons-v2-preview__badges">
            <span className="status-pill">{person.status}</span>
            {directAncestor ? <span className="status-pill">Прямий предок</span> : null}
          </div>
          <p id="persons-v2-preview-summary">
            {personLifeYears(person) || "Роки життя не вказані"} · {person.gender}
          </p>
          {research ? <small>Проєкт: {research.title}</small> : null}
        </div>
      </header>

      <dl className="persons-v2-preview__facts">
        <PreviewFactV2
          term="Народження"
          value={previewFactV2(
            person.birthDate || previewYearRangeV2(person.birthYearFrom, person.birthYearTo),
            person.birthPlace,
          )}
        />
        <PreviewFactV2
          term="Смерть"
          value={person.isLiving
            ? "Жива особа"
            : previewFactV2(
              person.deathDate || previewYearRangeV2(person.deathYearFrom, person.deathYearTo),
              person.deathPlace,
            )}
        />
        {keyRelation ? (
          <PreviewFactV2
            term="Ключовий зв’язок"
            value={`${personRelationLabel(keyRelation.relation, person.id, keyRelation.person)}: ${previewPersonNameV2(keyRelation.person)}`}
          />
        ) : null}
        {relatives.length ? (
          <PreviewFactV2
            term="Пов’язані особи"
            value={`${relatives.length} ${previewUkrainianCountV2(relatives.length, "особа", "особи", "осіб")}`}
          />
        ) : null}
      </dl>

      {relatives.length ? (
        <section className="persons-v2-preview__relatives" aria-labelledby="persons-v2-preview-relatives">
          <h3 id="persons-v2-preview-relatives">Родина й зв’язки</h3>
          <ul>
            {relatives.slice(0, 4).map(({ relation, person: relative }) => (
              <li key={relation.id}>
                <span className="persons-v2-preview__relative-avatar" aria-hidden="true">
                  {previewInitialsV2(relative)}
                </span>
                <span>
                  <strong>{previewPersonNameV2(relative)}</strong>
                  <small>{personRelationLabel(relation, person.id, relative)} · {relation.status}</small>
                </span>
              </li>
            ))}
          </ul>
          {relatives.length > 4 ? <small>Ще {relatives.length - 4}</small> : null}
        </section>
      ) : null}

      <dl className="persons-v2-preview__counts" aria-label="Пов’язані матеріали">
        <PreviewCountV2 label="Документи" value={documentIds.size} />
        <PreviewCountV2 label="Події" value={eventCount} />
        <PreviewCountV2 label="Знахідки" value={linkedFindings.length} />
        <PreviewCountV2 label="Нотатки" value={notesCount} />
      </dl>

      {(linkedTasks.length || linkedHypotheses.length || linkedArchiveRequests.length) ? (
        <p className="persons-v2-preview__linked-summary">
          Завдання: {linkedTasks.length} · Гіпотези: {linkedHypotheses.length} · Запити: {linkedArchiveRequests.length}
        </p>
      ) : null}

      <footer className="persons-v2-preview__actions">
        {onOpenProfile ? (
          <button type="button" className="button button-primary" onClick={() => onOpenProfile(person)}>
            Відкрити картку
          </button>
        ) : null}
        {onShowInTree ? (
          <button type="button" className="button button-secondary" onClick={() => onShowInTree(person)}>
            Показати в дереві
          </button>
        ) : null}
        {onEdit ? (
          <button type="button" className="button button-secondary" onClick={() => onEdit(person)}>
            Редагувати
          </button>
        ) : null}
        {onDelete ? (
          <button type="button" className="button button-danger" onClick={() => onDelete(person)}>
            Видалити особу
          </button>
        ) : null}
        {onAddEvent ? (
          <button type="button" className="button button-secondary" onClick={() => onAddEvent(person)}>
            Додати подію
          </button>
        ) : null}
        {onLinkDocument ? (
          <button type="button" className="button button-secondary" onClick={() => onLinkDocument(person)}>
            Пов’язати документ
          </button>
        ) : null}
        {onMoreActions ? (
          <button type="button" className="button button-ghost" onClick={() => onMoreActions(person)}>
            Більше дій
          </button>
        ) : null}
      </footer>
    </aside>
  );
}

function PreviewFactV2({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

function PreviewCountV2({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function previewYearRangeV2(from: string, to: string): string {
  if (from && to && from !== to) return `${from}–${to}`;
  return from || to;
}

function previewFactV2(date: string, place: string): string {
  return [date, place].map((value) => value.trim()).filter(Boolean).join(", ");
}

function previewEventCountV2(person: Person): number {
  return buildPersonTimeline(person).length;
}

function isPrimaryFamilyRelationV2(relation: PersonRelation): boolean {
  return [
    "батько",
    "мати",
    "батько або мати",
    "чоловік",
    "дружина",
    "подружжя",
    "дитина",
    "син",
    "донька",
  ].includes(relation.relationType);
}

function previewUkrainianCountV2(
  value: number,
  one: string,
  few: string,
  many: string,
): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
