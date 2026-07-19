import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { unstable_usePrompt } from "react-router-dom";
import type {
  AppDatabase,
  CustomFieldDefinition,
  GeoPoint,
  Person,
  PersonEvent,
  PersonEventType,
  PersonGender,
  PersonPrivacyStatus,
  PersonStatus,
  Research,
} from "../../types";
import { CustomFieldsEditor } from "../../components/CustomFields";
import { GeoPlaceField } from "../../components/GeoPlaceField";
import { InlineCustomFieldCreator } from "../../components/InlineCustomFieldCreator";
import { PersonEventsEditor } from "../../components/PersonEventsEditor";
import { ScanAttachmentsEditor } from "../../components/ScanAttachments";
import {
  formatFlexibleDateForDisplay,
  normalizeFlexibleDateInput,
  nowIso,
} from "../../utils/dateHelpers";
import { createId } from "../../utils/id";
import { normalizeCustomFieldValues } from "../../utils/customFields";
import { PERSON_EVENT_TYPES, normalizePersonEvents, personEventLabel } from "../../utils/geo";
import { createPersonMapEvent, updatePersonEventById } from "../../utils/personEventGeo.ts";
import { normalizePersonPhotoState } from "../../utils/personPhotos";
import { resolveEditorSectionAtViewport } from "../../utils/personEditorSectionNavigation";
import {
  personEducation,
  personNationality,
  withPersonStandardFields,
} from "../../utils/personStandardFields";
import type { PersonSaveHandler } from "./contracts";

const genders: PersonGender[] = ["невідомо", "чоловік", "жінка"];
const CORE_MAP_EVENT_TYPES = new Set<PersonEventType>(["birth", "marriage", "death", "residence"]);
const statuses: PersonStatus[] = [
  "доведена",
  "частково доведена",
  "гіпотетична",
  "сумнівна",
  "спростована",
];

const privacyStatuses: Array<{ value: PersonPrivacyStatus; label: string }> = [
  { value: "private", label: "Приватна" },
  { value: "project", label: "Учасники проєкту" },
  { value: "public", label: "Публічна" },
  { value: "confidential", label: "Конфіденційна" },
];

type PersonDraft = Omit<Person, "id" | "createdAt" | "updatedAt">;
type PersonDateFieldKey = "birthDate" | "marriageDate" | "deathDate";
type ValidationErrors = Record<string, string>;
type SaveIntent = "stay" | "profile";

const personDateFields: Array<{ key: PersonDateFieldKey; label: string }> = [
  { key: "birthDate", label: "Дата народження" },
  { key: "marriageDate", label: "Дата шлюбу" },
  { key: "deathDate", label: "Дата смерті" },
];

const editorSections = [
  { key: "main", label: "Основне" },
  { key: "names", label: "Імена" },
  { key: "birth", label: "Народження" },
  { key: "marriage", label: "Шлюб" },
  { key: "death", label: "Смерть" },
  { key: "status", label: "Статус" },
  { key: "places", label: "Місця" },
  { key: "notes", label: "Біографія і нотатки" },
  { key: "events", label: "Події" },
  { key: "custom", label: "Власні поля" },
] as const;

type EditorSectionKey = (typeof editorSections)[number]["key"];

const validationLabels: Record<string, string> = {
  researchId: "Дослідження",
  fullName: "Ім’я особи",
  birthDate: "Дата народження",
  marriageDate: "Дата шлюбу",
  deathDate: "Дата смерті",
  birthYearFrom: "Рік народження від",
  birthYearTo: "Рік народження до",
  deathYearFrom: "Рік смерті від",
  deathYearTo: "Рік смерті до",
};

export interface PersonEditorV2Props {
  db: AppDatabase;
  person: Person | null;
  researches: Research[];
  researchRequired?: boolean;
  initialFullName?: string;
  initialResearchId?: string;
  customFieldDefinitions?: CustomFieldDefinition[];
  onAddCustomField?: (definition: CustomFieldDefinition) => void;
  onDeleteCustomField?: (definition: CustomFieldDefinition) => void;
  canAddCustomField?: boolean;
  customFieldLimitMessage?: string;
  onSave: PersonSaveHandler;
  onCancel: () => void;
  onOpenProfile?: (person: Person) => void;
  onPersisted?: (person: Person) => void;
}

function emptyPerson(initialFullName = "", researchId = ""): PersonDraft {
  return {
    researchId,
    surname: "",
    maidenSurname: "",
    givenName: "",
    patronymic: "",
    fullName: initialFullName,
    gender: "невідомо",
    nameVariants: "",
    surnameVariants: "",
    birthDate: "",
    birthYearFrom: "",
    birthYearTo: "",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathYearFrom: "",
    deathYearTo: "",
    deathPlace: "",
    residencePlaces: "",
    socialStatus: "",
    religion: "",
    occupation: "",
    status: "гіпотетична",
    isLiving: false,
    privacyStatus: "private",
    notes: "",
    birthScans: [],
    marriageScans: [],
    deathScans: [],
    mentionScans: [],
    photos: [],
    primaryPhotoId: "",
    events: [],
    customFields: {},
  };
}

function draftFromPerson(
  person: Person | null,
  initialFullName = "",
  initialResearchId = "",
): PersonDraft {
  if (!person) return emptyPerson(initialFullName, initialResearchId);
  const photoState = normalizePersonPhotoState(person.photos, person.primaryPhotoId);
  return {
    researchId: person.researchId,
    surname: person.surname,
    maidenSurname: person.maidenSurname ?? "",
    givenName: person.givenName,
    patronymic: person.patronymic,
    fullName: person.fullName,
    gender: person.gender,
    nameVariants: person.nameVariants,
    surnameVariants: person.surnameVariants,
    birthDate: person.birthDate,
    birthYearFrom: person.birthYearFrom,
    birthYearTo: person.birthYearTo,
    birthPlace: person.birthPlace,
    marriageDate: person.marriageDate,
    marriagePlace: person.marriagePlace,
    deathDate: person.deathDate,
    deathYearFrom: person.deathYearFrom,
    deathYearTo: person.deathYearTo,
    deathPlace: person.deathPlace,
    residencePlaces: person.residencePlaces,
    socialStatus: person.socialStatus,
    religion: person.religion,
    occupation: person.occupation,
    status: person.status,
    isLiving: person.isLiving ?? false,
    privacyStatus: person.privacyStatus ?? "private",
    notes: person.notes,
    birthScans: person.birthScans ?? [],
    marriageScans: person.marriageScans ?? [],
    deathScans: person.deathScans ?? [],
    mentionScans: person.mentionScans ?? [],
    photos: photoState.photos,
    primaryPhotoId: photoState.primaryPhotoId,
    events: person.events ?? [],
    customFields: normalizeCustomFieldValues(person.customFields),
  };
}

function dateDraftsFromDraft(draft: PersonDraft): Record<PersonDateFieldKey, string> {
  return {
    birthDate: formatFlexibleDateForDisplay(draft.birthDate),
    marriageDate: formatFlexibleDateForDisplay(draft.marriageDate),
    deathDate: formatFlexibleDateForDisplay(draft.deathDate),
  };
}

function draftSnapshot(
  draft: PersonDraft,
  dates: Record<PersonDateFieldKey, string>,
): string {
  return JSON.stringify({ draft, dates });
}

function composedPersonName(draft: PersonDraft): string {
  const composed = [draft.surname, draft.givenName, draft.patronymic]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return composed || draft.fullName.trim();
}

function personInitials(fullName: string): string {
  const initials = fullName
    .split(/\s+/)
    .map((part) => part.trim().charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return initials.toLocaleUpperCase("uk") || "?";
}

function displayLifeYears(draft: PersonDraft): string {
  const birth = draft.birthDate || draft.birthYearFrom || "?";
  const death = draft.isLiving ? "дотепер" : draft.deathDate || draft.deathYearFrom || "?";
  return `${formatFlexibleDateForDisplay(birth)} — ${formatFlexibleDateForDisplay(death)}`;
}

function profileCompleteness(draft: PersonDraft): number {
  const values = [
    composedPersonName(draft),
    draft.gender !== "невідомо" ? draft.gender : "",
    draft.birthDate || draft.birthYearFrom,
    draft.birthPlace,
    draft.isLiving ? "living" : draft.deathDate || draft.deathYearFrom,
    draft.isLiving ? "living" : draft.deathPlace,
    draft.residencePlaces,
    draft.occupation,
    draft.notes,
    draft.photos?.length ? "photo" : "",
  ];
  return Math.round((values.filter(Boolean).length / values.length) * 100);
}

function normalizeDateDrafts(
  values: Record<PersonDateFieldKey, string>,
  isLiving: boolean,
): {
  normalized: Record<PersonDateFieldKey, string>;
  formatted: Record<PersonDateFieldKey, string>;
  errors: ValidationErrors;
} {
  const normalized: Record<PersonDateFieldKey, string> = {
    birthDate: "",
    marriageDate: "",
    deathDate: "",
  };
  const formatted = { ...values };
  const errors: ValidationErrors = {};
  for (const field of personDateFields) {
    if (isLiving && field.key === "deathDate") {
      formatted.deathDate = "";
      continue;
    }
    const parsed = normalizeFlexibleDateInput(values[field.key]);
    if (parsed.error) {
      errors[field.key] = parsed.error;
      continue;
    }
    normalized[field.key] = parsed.value;
    formatted[field.key] = formatFlexibleDateForDisplay(parsed.value);
  }
  return { normalized, formatted, errors };
}

function validateYearRange(
  errors: ValidationErrors,
  fromKey: "birthYearFrom" | "deathYearFrom",
  toKey: "birthYearTo" | "deathYearTo",
  from: string,
  to: string,
) {
  const validateYear = (key: string, value: string) => {
    if (value && !/^\d{4}$/.test(value.trim())) {
      errors[key] = "Введіть чотиризначний рік.";
    }
  };
  validateYear(fromKey, from);
  validateYear(toKey, to);
  if (!errors[fromKey] && !errors[toKey] && from && to && Number(from) > Number(to)) {
    errors[toKey] = "Кінцевий рік не може бути раніше початкового.";
  }
}

function firstYear(...values: string[]): number | null {
  for (const value of values) {
    const year = Number(value.match(/\d{4}/)?.[0]);
    if (Number.isFinite(year)) return year;
  }
  return null;
}

function FieldError({ message }: { message?: string }) {
  return message ? <small className="form-field-error">{message}</small> : null;
}

function PersonDateInput({
  label,
  value,
  error,
  onChange,
  onBlur,
}: {
  label: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="дд.мм.рррр або рррр"
        value={value}
        aria-invalid={error ? "true" : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
      <FieldError message={error} />
    </label>
  );
}

function EditorSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section className="person-editor-v2-section" id={id} aria-labelledby={headingId}>
      <div className="person-editor-v2-section-heading">
        <div>
          <h2 id={headingId}>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      <div className="person-editor-v2-fields">{children}</div>
    </section>
  );
}

export function PersonEditorV2({
  db,
  person,
  researches,
  researchRequired = false,
  initialFullName = "",
  initialResearchId = "",
  customFieldDefinitions = [],
  onAddCustomField,
  onDeleteCustomField,
  canAddCustomField = true,
  customFieldLimitMessage,
  onSave,
  onCancel,
  onOpenProfile,
  onPersisted,
}: PersonEditorV2Props) {
  const firstDraft = useMemo(
    () => draftFromPerson(person, initialFullName, initialResearchId),
    // The editor deliberately resets on a different person identity below, not
    // whenever a parent recreates the same person object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const firstDates = useMemo(() => dateDraftsFromDraft(firstDraft), [firstDraft]);
  const [form, setForm] = useState<PersonDraft>(firstDraft);
  const [persistedPerson, setPersistedPerson] = useState<Person | null>(person);
  const [dateDrafts, setDateDrafts] = useState(firstDates);
  const [baseline, setBaseline] = useState(() => draftSnapshot(firstDraft, firstDates));
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const [saveError, setSaveError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<EditorSectionKey>("main");
  const editorIdentityRef = useRef(person?.id ?? "new");
  const allowNavigationRef = useRef(false);
  const requestedSectionRef = useRef<EditorSectionKey | null>(null);
  const navigationReleaseFrameRef = useRef<number | null>(null);
  const editorPrefix = `person-editor-${useId().replace(/:/g, "")}`;

  const displayedFullName = composedPersonName(form);
  const currentSnapshot = useMemo(
    () => draftSnapshot(form, dateDrafts),
    [dateDrafts, form],
  );
  const dirty = currentSnapshot !== baseline;

  unstable_usePrompt({
    message: "Вийти з редактора? Незбережені зміни буде втрачено.",
    when: ({ currentLocation, nextLocation }) =>
      dirty &&
      !saving &&
      !allowNavigationRef.current &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  });

  useEffect(() => {
    const nextIdentity = person?.id ?? "new";
    if (editorIdentityRef.current === nextIdentity) return;
    editorIdentityRef.current = nextIdentity;
    const nextDraft = draftFromPerson(person, initialFullName, initialResearchId);
    const nextDates = dateDraftsFromDraft(nextDraft);
    setForm(nextDraft);
    setPersistedPerson(person);
    setDateDrafts(nextDates);
    setBaseline(draftSnapshot(nextDraft, nextDates));
    setValidationErrors({});
    setSaveError("");
    setSaveMessage("");
    setActiveSection("main");
  }, [initialFullName, initialResearchId, person]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  useEffect(() => {
    const targets = editorSections
      .map((section) => document.getElementById(`${editorPrefix}-${section.key}`))
      .filter((target): target is HTMLElement => Boolean(target));
    if (!targets.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      () => {
        const key = resolveEditorSectionAtViewport(
          requestedSectionRef.current,
          targets.map((target, index) => {
            const rect = target.getBoundingClientRect();
            return {
              key: editorSections[index].key,
              top: rect.top,
              bottom: rect.bottom,
            };
          }),
          window.innerHeight,
        );
        if (key) setActiveSection(key);
      },
      { rootMargin: "-15% 0px -65% 0px", threshold: [0, 0.1, 0.25, 0.5] },
    );
    targets.forEach((target, index) => {
      target.dataset.sectionKey = editorSections[index].key;
      observer.observe(target);
    });
    return () => observer.disconnect();
  }, [editorPrefix]);

  useEffect(() => () => {
    if (navigationReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(navigationReleaseFrameRef.current);
    }
  }, []);

  const markEdited = () => {
    setSaveError("");
    setSaveMessage("");
  };

  const clearValidationErrors = (...keys: string[]) => {
    setValidationErrors((current) => {
      if (!keys.some((key) => current[key])) return current;
      const next = { ...current };
      keys.forEach((key) => delete next[key]);
      return next;
    });
  };

  const update = <K extends keyof PersonDraft>(
    key: K,
    value: PersonDraft[K],
    ...errorKeys: string[]
  ) => {
    markEdited();
    clearValidationErrors(...errorKeys);
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "gender" && value !== "жінка") next.maidenSurname = "";
      return next;
    });
  };

  const updateLifeStatus = (isLiving: boolean) => {
    markEdited();
    clearValidationErrors("deathDate", "deathYearFrom", "deathYearTo");
    setForm((current) => ({
      ...current,
      isLiving,
      ...(isLiving
        ? {
            deathDate: "",
            deathYearFrom: "",
            deathYearTo: "",
            deathPlace: "",
            events: (current.events ?? []).filter((item) => item.type !== "death"),
          }
        : {}),
    }));
    if (isLiving) setDateDrafts((current) => ({ ...current, deathDate: "" }));
  };

  const updateStandardFields = (patch: { nationality?: string; education?: string }) => {
    markEdited();
    setForm((current) => ({
      ...current,
      customFields: withPersonStandardFields(current.customFields, {
        nationality: patch.nationality ?? personNationality(current),
        education: patch.education ?? personEducation(current),
      }),
    }));
  };

  const updateDateDraft = (key: PersonDateFieldKey, value: string) => {
    markEdited();
    clearValidationErrors(key);
    setDateDrafts((current) => ({ ...current, [key]: value }));
    const parsed = normalizeFlexibleDateInput(value);
    if (!parsed.error) setForm((current) => ({ ...current, [key]: parsed.value }));
  };

  const commitDateDraft = (key: PersonDateFieldKey) => {
    const parsed = normalizeFlexibleDateInput(dateDrafts[key]);
    if (parsed.error) {
      setValidationErrors((current) => ({ ...current, [key]: parsed.error ?? "" }));
      return;
    }
    setForm((current) => ({ ...current, [key]: parsed.value }));
    setDateDrafts((current) => ({
      ...current,
      [key]: formatFlexibleDateForDisplay(parsed.value),
    }));
    clearValidationErrors(key);
  };

  const photoState = normalizePersonPhotoState(form.photos, form.primaryPhotoId);
  const updatePhotos = (photos: Person["photos"]) => {
    markEdited();
    setForm((current) => {
      const next = normalizePersonPhotoState(photos, current.primaryPhotoId);
      return { ...current, photos: next.photos, primaryPhotoId: next.primaryPhotoId };
    });
  };

  const eventPerson = {
    id: persistedPerson?.id ?? "draft",
    birthDate: form.birthDate,
    birthPlace: form.birthPlace,
    marriageDate: form.marriageDate,
    marriagePlace: form.marriagePlace,
    deathDate: form.isLiving ? "" : form.deathDate,
    deathPlace: form.isLiving ? "" : form.deathPlace,
    residencePlaces: form.residencePlaces,
  };
  const personEvents = normalizePersonEvents(form.events, eventPerson);

  const normalizedEventsForDraft = (draft: PersonDraft) => normalizePersonEvents(
    draft.events,
    {
      id: persistedPerson?.id ?? "draft",
      birthDate: draft.birthDate,
      birthPlace: draft.birthPlace,
      marriageDate: draft.marriageDate,
      marriagePlace: draft.marriagePlace,
      deathDate: draft.isLiving ? "" : draft.deathDate,
      deathPlace: draft.isLiving ? "" : draft.deathPlace,
      residencePlaces: draft.residencePlaces,
    },
  );

  const patchEvent = (
    eventId: string,
    patch: Partial<PersonEvent>,
    fallbackType?: PersonEventType,
  ) => {
    markEdited();
    setForm((current) => {
      const events = normalizedEventsForDraft(current);
      if (events.some((event) => event.id === eventId)) {
        return { ...current, events: updatePersonEventById(events, eventId, patch) };
      }
      if (!fallbackType) return current;
      const fallback: PersonEvent = {
        id: eventId,
        personId: persistedPerson?.id ?? "draft",
        type: fallbackType,
        title: personEventLabel(fallbackType),
        date: null,
        placeName: null,
        geo: null,
        notes: null,
        ...patch,
      };
      return { ...current, events: [...events, fallback] };
    });
  };

  const updateEventGeo = (
    eventId: string,
    geo: GeoPoint | null,
    fallbackType?: PersonEventType,
  ) => patchEvent(eventId, { geo }, fallbackType);

  const updateCoreEventPlace = (type: PersonEventType, place: string) => {
    if (type === "birth") update("birthPlace", place);
    if (type === "marriage") update("marriagePlace", place);
    if (type === "death") update("deathPlace", place);
    if (type === "residence") update("residencePlaces", place);
  };

  const addMapEvent = () => {
    markEdited();
    setForm((current) => ({
      ...current,
      events: [
        ...normalizedEventsForDraft(current),
        createPersonMapEvent(persistedPerson?.id ?? "draft"),
      ],
    }));
  };

  const removeMapEvent = (eventId: string) => {
    markEdited();
    setForm((current) => ({
      ...current,
      events: normalizedEventsForDraft(current).filter((event) => event.id !== eventId),
    }));
  };

  const additionalMapEvents = personEvents.filter((event) => !(
    CORE_MAP_EVENT_TYPES.has(event.type) && event.id === event.type
  ));

  const cancel = () => {
    if (saving) return;
    if (dirty && !window.confirm("Вийти з редактора? Незбережені зміни буде втрачено.")) return;
    allowNavigationRef.current = true;
    onCancel();
    window.setTimeout(() => {
      allowNavigationRef.current = false;
    }, 0);
  };

  const scrollToSection = (key: EditorSectionKey) => {
    const target = document.getElementById(`${editorPrefix}-${key}`);
    if (!target) return;
    if (navigationReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(navigationReleaseFrameRef.current);
    }
    requestedSectionRef.current = key;
    setActiveSection(key);
    target.scrollIntoView({
      behavior: "auto",
      block: "start",
    });
    navigationReleaseFrameRef.current = window.requestAnimationFrame(() => {
      navigationReleaseFrameRef.current = window.requestAnimationFrame(() => {
        requestedSectionRef.current = null;
        navigationReleaseFrameRef.current = null;
      });
    });
  };

  const persist = async (intent: SaveIntent) => {
    if (saving) return;
    setSaveError("");
    setSaveMessage("");

    const dates = normalizeDateDrafts(dateDrafts, form.isLiving);
    const errors: ValidationErrors = { ...dates.errors };
    if (researchRequired && !form.researchId.trim()) {
      errors.researchId = "Оберіть дослідження для цієї особи.";
    }
    if (!displayedFullName) {
      errors.fullName = "Вкажіть хоча б ім’я, прізвище або повне ім’я.";
    }
    validateYearRange(
      errors,
      "birthYearFrom",
      "birthYearTo",
      form.birthYearFrom,
      form.birthYearTo,
    );
    if (!form.isLiving) {
      validateYearRange(
        errors,
        "deathYearFrom",
        "deathYearTo",
        form.deathYearFrom,
        form.deathYearTo,
      );
    }
    const birthYear = firstYear(
      dates.normalized.birthDate,
      form.birthYearFrom,
      form.birthYearTo,
    );
    const marriageYear = firstYear(dates.normalized.marriageDate);
    const deathYear = firstYear(
      dates.normalized.deathDate,
      form.deathYearTo,
      form.deathYearFrom,
    );
    if (birthYear !== null && marriageYear !== null && marriageYear < birthYear) {
      errors.marriageDate = "Дата шлюбу не може бути раніше народження.";
    }
    if (!form.isLiving && birthYear !== null && deathYear !== null && deathYear < birthYear) {
      errors.deathDate = "Дата смерті не може бути раніше народження.";
    }
    setDateDrafts(dates.formatted);
    setValidationErrors(errors);
    if (Object.keys(errors).length) {
      setSaveError("Перевірте позначені поля перед збереженням.");
      window.requestAnimationFrame(() => {
        document.getElementById(`${editorPrefix}-errors`)?.focus();
      });
      return;
    }

    const timestamp = nowIso();
    const personId = persistedPerson?.id ?? createId();
    const normalizedForm: PersonDraft = {
      ...form,
      ...dates.normalized,
      fullName: displayedFullName,
      ...(form.isLiving
        ? {
            deathDate: "",
            deathYearFrom: "",
            deathYearTo: "",
            deathPlace: "",
          }
        : {}),
    };
    const eventsForSave = form.isLiving
      ? form.events.filter((item) => item.type !== "death")
      : form.events;
    const finalPerson = {
      ...normalizedForm,
      id: personId,
      createdAt: persistedPerson?.createdAt ?? timestamp,
      updatedAt: timestamp,
      __baseUpdatedAt: persistedPerson?.updatedAt,
    } as Person;
    finalPerson.events = normalizePersonEvents(eventsForSave, finalPerson);

    setSaving(true);
    try {
      const result = await onSave(finalPerson);
      if (result === null) {
        setSaveError("Збереження не підтверджено. Дані залишилися в редакторі.");
        return;
      }
      // `void` is supported by the shared legacy contract and means that the
      // handler completed without returning a server-normalized record.
      const savedPerson = result ?? finalPerson;
      const wasNewPerson = persistedPerson === null;
      setPersistedPerson(savedPerson);
      const savedDraft = draftFromPerson(savedPerson);
      const savedDates = dateDraftsFromDraft(savedDraft);
      setForm(savedDraft);
      setDateDrafts(savedDates);
      setBaseline(draftSnapshot(savedDraft, savedDates));
      setValidationErrors({});
      setSaveMessage("Зміни збережено.");
      if (intent === "profile" && onOpenProfile) {
        allowNavigationRef.current = true;
        onOpenProfile(savedPerson);
        window.setTimeout(() => {
          allowNavigationRef.current = false;
        }, 0);
      } else if (wasNewPerson && onPersisted) {
        // Let React commit the clean baseline before replacing /persons/new;
        // otherwise the route blocker would correctly treat this as a dirty
        // navigation even though the record has just been persisted.
        window.setTimeout(() => {
          allowNavigationRef.current = true;
          onPersisted(savedPerson);
          window.setTimeout(() => {
            allowNavigationRef.current = false;
          }, 0);
        }, 0);
      }
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Не вдалося зберегти особу. Спробуйте ще раз.",
      );
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void persist("stay");
  };

  const drivePersonName = displayedFullName || "Без імені";
  const completeness = profileCompleteness(form);
  const validationEntries = Object.entries(validationErrors);

  return (
    <div className="person-editor-v2">
      <header className="person-editor-v2-header">
        <div>
          <span className="eyebrow">Особи</span>
          <h1>{persistedPerson ? "Редагування особи" : "Нова особа"}</h1>
        </div>
        <div className="person-editor-v2-header-state" role="status" aria-live="polite">
          {saving ? "Зберігаємо…" : dirty ? "Є незбережені зміни" : saveMessage || "Усі зміни збережено"}
        </div>
      </header>

      <form className="person-editor-v2-form" onSubmit={submit} aria-busy={saving} noValidate>
        <div className="person-editor-v2-layout" inert={saving ? true : undefined}>
          <aside className="person-editor-v2-sidebar">
            <div className="person-editor-v2-summary">
              <span className="person-editor-v2-avatar" aria-hidden="true">
                {personInitials(displayedFullName)}
              </span>
              <strong>{displayedFullName || "Особа без імені"}</strong>
              <span>{displayLifeYears(form)}</span>
              <span className="person-editor-v2-status-badge">{form.status}</span>
              <div className="person-editor-v2-completeness">
                <div>
                  <span>Заповненість профілю</span>
                  <strong>{completeness}%</strong>
                </div>
                <progress max="100" value={completeness} aria-label="Заповненість профілю" />
              </div>
            </div>
            <nav className="person-editor-v2-section-nav" aria-label="Навігація розділами редактора особи">
              {editorSections.map((section) => (
                <button
                  type="button"
                  key={section.key}
                  className={activeSection === section.key ? "active" : ""}
                  aria-current={activeSection === section.key ? "location" : undefined}
                  aria-controls={`${editorPrefix}-${section.key}`}
                  onClick={() => scrollToSection(section.key)}
                >
                  {section.label}
                </button>
              ))}
            </nav>
          </aside>

          <main className="person-editor-v2-content">
            {saveError || validationEntries.length ? (
              <div
                className="person-editor-v2-error-summary"
                id={`${editorPrefix}-errors`}
                role="alert"
                tabIndex={-1}
              >
                <strong>{saveError || "Перевірте дані форми."}</strong>
                {validationEntries.length ? (
                  <ul>
                    {validationEntries.map(([key, message]) => (
                      <li key={key}>
                        <strong>{validationLabels[key] ?? "Поле"}:</strong> {message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {saveMessage ? (
              <p className="person-editor-v2-save-message" role="status" aria-live="polite">
                {saveMessage}
              </p>
            ) : null}

            <EditorSection
              id={`${editorPrefix}-main`}
              title="Основне"
              description="Дослідження, статус картки та фотографії особи."
            >
              <label>
                <span>Дослідження{researchRequired ? " *" : ""}</span>
                <select
                  required={researchRequired}
                  value={form.researchId}
                  aria-invalid={validationErrors.researchId ? "true" : undefined}
                  onChange={(event) => update("researchId", event.target.value, "researchId")}
                >
                  <option value="">{researchRequired ? "Оберіть дослідження" : "Без прив’язки"}</option>
                  {researches.map((research) => (
                    <option key={research.id} value={research.id}>{research.title}</option>
                  ))}
                </select>
                <FieldError message={validationErrors.researchId} />
              </label>
              <label>
                <span>Статус дослідження *</span>
                <select
                  value={form.status}
                  onChange={(event) => update("status", event.target.value as PersonStatus)}
                >
                  {statuses.map((status) => <option key={status}>{status}</option>)}
                </select>
              </label>
              <ScanAttachmentsEditor
                title="Фотографії особи"
                description="Зображення зберігаються у Google Drive; у картці залишаються посилання та метадані."
                accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/svg+xml,image/tiff,.jpg,.jpeg,.png,.webp,.gif,.bmp,.svg,.tif,.tiff"
                maxFiles={20}
                policy="person-photo"
                driveFolderPath={["Особи", drivePersonName, "Фото"]}
                scans={photoState.photos}
                onChange={updatePhotos}
              />
              {photoState.photos.length ? (
                <label className="field-wide">
                  <span>Головне фото</span>
                  <select
                    value={photoState.primaryPhotoId}
                    onChange={(event) => update("primaryPhotoId", event.target.value)}
                  >
                    {photoState.photos.map((photo) => (
                      <option key={photo.id} value={photo.id}>{photo.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </EditorSection>

            <EditorSection
              id={`${editorPrefix}-names`}
              title="Імена та варіанти"
              description="Канонічне ім’я картки та написання, знайдені в інших джерелах."
            >
              <label>
                <span>Прізвище</span>
                <input
                  value={form.surname}
                  aria-invalid={validationErrors.fullName ? "true" : undefined}
                  onChange={(event) => update("surname", event.target.value, "fullName")}
                />
              </label>
              {form.gender === "жінка" ? (
                <label>
                  <span>Дівоче прізвище</span>
                  <input
                    value={form.maidenSurname}
                    onChange={(event) => update("maidenSurname", event.target.value)}
                  />
                </label>
              ) : null}
              <label>
                <span>Ім’я</span>
                <input
                  value={form.givenName}
                  aria-invalid={validationErrors.fullName ? "true" : undefined}
                  onChange={(event) => update("givenName", event.target.value, "fullName")}
                />
              </label>
              <label>
                <span>По батькові</span>
                <input
                  value={form.patronymic}
                  onChange={(event) => update("patronymic", event.target.value, "fullName")}
                />
              </label>
              <label className="field-wide">
                <span>Повне ім’я</span>
                <input
                  value={displayedFullName}
                  placeholder="Заповніть прізвище, ім’я та по батькові"
                  readOnly
                  aria-invalid={validationErrors.fullName ? "true" : undefined}
                />
                <FieldError message={validationErrors.fullName} />
              </label>
              <label>
                <span>Варіанти імені</span>
                <input
                  value={form.nameVariants}
                  onChange={(event) => update("nameVariants", event.target.value)}
                />
              </label>
              <label>
                <span>Варіанти прізвища</span>
                <input
                  value={form.surnameVariants}
                  onChange={(event) => update("surnameVariants", event.target.value)}
                />
              </label>
            </EditorSection>

            <EditorSection id={`${editorPrefix}-birth`} title="Народження">
              <PersonDateInput
                label="Дата народження"
                value={dateDrafts.birthDate}
                error={validationErrors.birthDate}
                onChange={(value) => updateDateDraft("birthDate", value)}
                onBlur={() => commitDateDraft("birthDate")}
              />
              <label>
                <span>Місце народження</span>
                <input value={form.birthPlace} onChange={(event) => update("birthPlace", event.target.value)} />
              </label>
              <label>
                <span>Рік від</span>
                <input
                  type="number"
                  min="1"
                  max="9999"
                  value={form.birthYearFrom}
                  aria-invalid={validationErrors.birthYearFrom ? "true" : undefined}
                  onChange={(event) => update("birthYearFrom", event.target.value, "birthYearFrom")}
                />
                <FieldError message={validationErrors.birthYearFrom} />
              </label>
              <label>
                <span>Рік до</span>
                <input
                  type="number"
                  min="1"
                  max="9999"
                  value={form.birthYearTo}
                  aria-invalid={validationErrors.birthYearTo ? "true" : undefined}
                  onChange={(event) => update("birthYearTo", event.target.value, "birthYearTo")}
                />
                <FieldError message={validationErrors.birthYearTo} />
              </label>
              <ScanAttachmentsEditor
                title="Документи про народження"
                driveFolderPath={["Особи", drivePersonName, "Народження"]}
                scans={form.birthScans}
                onChange={(scans) => update("birthScans", scans)}
              />
            </EditorSection>

            <EditorSection id={`${editorPrefix}-marriage`} title="Шлюб">
              <PersonDateInput
                label="Дата шлюбу"
                value={dateDrafts.marriageDate}
                error={validationErrors.marriageDate}
                onChange={(value) => updateDateDraft("marriageDate", value)}
                onBlur={() => commitDateDraft("marriageDate")}
              />
              <label>
                <span>Місце шлюбу</span>
                <input
                  value={form.marriagePlace}
                  onChange={(event) => update("marriagePlace", event.target.value)}
                />
              </label>
              <ScanAttachmentsEditor
                title="Документи про шлюб"
                driveFolderPath={["Особи", drivePersonName, "Шлюб"]}
                scans={form.marriageScans}
                onChange={(scans) => update("marriageScans", scans)}
              />
            </EditorSection>

            <EditorSection id={`${editorPrefix}-death`} title="Смерть">
              {form.isLiving ? (
                <p className="person-editor-v2-section-notice field-wide">
                  Особу позначено живою. Поля смерті приховані й не будуть збережені.
                </p>
              ) : (
                <>
                  <PersonDateInput
                    label="Дата смерті"
                    value={dateDrafts.deathDate}
                    error={validationErrors.deathDate}
                    onChange={(value) => updateDateDraft("deathDate", value)}
                    onBlur={() => commitDateDraft("deathDate")}
                  />
                  <label>
                    <span>Місце смерті</span>
                    <input value={form.deathPlace} onChange={(event) => update("deathPlace", event.target.value)} />
                  </label>
                  <label>
                    <span>Рік від</span>
                    <input
                      type="number"
                      min="1"
                      max="9999"
                      value={form.deathYearFrom}
                      aria-invalid={validationErrors.deathYearFrom ? "true" : undefined}
                      onChange={(event) => update("deathYearFrom", event.target.value, "deathYearFrom")}
                    />
                    <FieldError message={validationErrors.deathYearFrom} />
                  </label>
                  <label>
                    <span>Рік до</span>
                    <input
                      type="number"
                      min="1"
                      max="9999"
                      value={form.deathYearTo}
                      aria-invalid={validationErrors.deathYearTo ? "true" : undefined}
                      onChange={(event) => update("deathYearTo", event.target.value, "deathYearTo")}
                    />
                    <FieldError message={validationErrors.deathYearTo} />
                  </label>
                  <ScanAttachmentsEditor
                    title="Документи про смерть"
                    driveFolderPath={["Особи", drivePersonName, "Смерть"]}
                    scans={form.deathScans}
                    onChange={(scans) => update("deathScans", scans)}
                  />
                </>
              )}
            </EditorSection>

            <EditorSection
              id={`${editorPrefix}-status`}
              title="Стать, статус і приватність"
              description="Приватність живих людей потрібно перевіряти особливо уважно."
            >
              <label>
                <span>Стать</span>
                <select
                  value={form.gender}
                  onChange={(event) => update("gender", event.target.value as PersonGender)}
                >
                  {genders.map((gender) => <option key={gender}>{gender}</option>)}
                </select>
              </label>
              <fieldset className="life-status-toggle">
                <legend>Статус життя</legend>
                <label>
                  <input
                    type="radio"
                    name={`${editorPrefix}-life-status`}
                    checked={form.isLiving}
                    onChange={() => updateLifeStatus(true)}
                  />
                  <span>Жива</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name={`${editorPrefix}-life-status`}
                    checked={!form.isLiving}
                    onChange={() => updateLifeStatus(false)}
                  />
                  <span>Померла або статус невідомий</span>
                </label>
              </fieldset>
              <label>
                <span>Приватність</span>
                <select
                  value={form.privacyStatus}
                  onChange={(event) => update("privacyStatus", event.target.value as PersonPrivacyStatus)}
                >
                  {privacyStatuses.map((status) => (
                    <option key={status.value} value={status.value}>{status.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Соціальний статус</span>
                <input value={form.socialStatus} onChange={(event) => update("socialStatus", event.target.value)} />
              </label>
              <label>
                <span>Віросповідання</span>
                <input value={form.religion} onChange={(event) => update("religion", event.target.value)} />
              </label>
              <label>
                <span>Професія або заняття</span>
                <input value={form.occupation} onChange={(event) => update("occupation", event.target.value)} />
              </label>
              <label>
                <span>Національність</span>
                <input
                  value={personNationality(form)}
                  onChange={(event) => updateStandardFields({ nationality: event.target.value })}
                />
              </label>
              <label>
                <span>Освіта</span>
                <textarea
                  rows={3}
                  placeholder="Кожен заклад або запис — з нового рядка"
                  value={personEducation(form).join("\n")}
                  onChange={(event) => updateStandardFields({ education: event.target.value })}
                />
              </label>
            </EditorSection>

            <EditorSection
              id={`${editorPrefix}-places`}
              title="Місця"
              description="Текстові назви зберігаються разом із позначками для карти."
            >
              <label className="field-wide">
                <span>Місця проживання</span>
                <textarea
                  rows={3}
                  value={form.residencePlaces}
                  onChange={(event) => update("residencePlaces", event.target.value)}
                />
              </label>
              <fieldset className="geo-events field-wide">
                <legend>Місця подій на карті</legend>
                <p>Додайте позначки лише для подій, які потрібно показувати на карті.</p>
                {(["birth", "marriage", ...(form.isLiving ? [] : ["death"]), "residence"] as PersonEventType[])
                  .map((type) => {
                    const currentEvent = personEvents.find((item) => item.id === type);
                    return (
                      <GeoPlaceField
                        key={type}
                        label={personEventLabel(type)}
                        eventType={type}
                        value={currentEvent?.geo ?? null}
                        placeName={type === "birth"
                          ? form.birthPlace
                          : type === "marriage"
                            ? form.marriagePlace
                            : type === "death"
                              ? form.deathPlace
                              : form.residencePlaces}
                        onChange={(geo) => updateEventGeo(type, geo, type)}
                        onPlaceNameChange={(place) => updateCoreEventPlace(type, place)}
                      />
                    );
                  })}
                <div className="person-map-events-heading">
                  <div>
                    <strong>Інші життєві події</strong>
                    <p>Додайте на карту хрещення, переписи, переїзди, службу, освіту, поховання чи власну подію.</p>
                  </div>
                  <button type="button" className="button button-secondary" onClick={addMapEvent}>
                    + Додати подію на карту
                  </button>
                </div>
                {additionalMapEvents.length ? (
                  <div className="person-map-event-list">
                    {additionalMapEvents.map((mapEvent, index) => (
                      <section className="person-map-event-card" key={mapEvent.id}>
                        <header>
                          <strong>Подія {index + 1}</strong>
                          <button
                            type="button"
                            className="text-button danger"
                            onClick={() => removeMapEvent(mapEvent.id)}
                          >
                            Видалити
                          </button>
                        </header>
                        <div className="person-map-event-fields">
                          <label>
                            <span>Тип події</span>
                            <select
                              value={mapEvent.type}
                              onChange={(changeEvent) => {
                                const type = changeEvent.target.value as PersonEventType;
                                patchEvent(mapEvent.id, {
                                  type,
                                  title: !mapEvent.title || mapEvent.title === personEventLabel(mapEvent.type)
                                    ? personEventLabel(type)
                                    : mapEvent.title,
                                });
                              }}
                            >
                              {PERSON_EVENT_TYPES.map((type) => (
                                <option key={type} value={type}>{personEventLabel(type)}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>Назва або уточнення</span>
                            <input
                              value={mapEvent.title ?? ""}
                              onChange={(changeEvent) => patchEvent(mapEvent.id, { title: changeEvent.target.value })}
                            />
                          </label>
                          <label>
                            <span>Дата або період</span>
                            <input
                              value={mapEvent.date ?? ""}
                              placeholder="Наприклад: 1914–1917"
                              onChange={(changeEvent) => patchEvent(mapEvent.id, { date: changeEvent.target.value || null })}
                            />
                          </label>
                        </div>
                        <GeoPlaceField
                          label="Місце події на карті"
                          eventType={mapEvent.type}
                          value={mapEvent.geo ?? null}
                          placeName={mapEvent.placeName ?? ""}
                          onChange={(geo) => updateEventGeo(mapEvent.id, geo)}
                          onPlaceNameChange={(place) => patchEvent(mapEvent.id, { placeName: place || null })}
                        />
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="person-map-events-empty">Додаткових подій із місцем ще немає.</p>
                )}
              </fieldset>
            </EditorSection>

            <EditorSection
              id={`${editorPrefix}-notes`}
              title="Біографія і нотатки"
              description="Поточна модель зберігає біографічний опис у спільному полі нотаток."
            >
              <label className="field-wide">
                <span>Біографія та нотатки</span>
                <textarea rows={8} value={form.notes} onChange={(event) => update("notes", event.target.value)} />
              </label>
              <ScanAttachmentsEditor
                title="Інші згадки та матеріали"
                driveFolderPath={["Особи", drivePersonName, "Згадки"]}
                scans={form.mentionScans}
                onChange={(scans) => update("mentionScans", scans)}
              />
            </EditorSection>

            <EditorSection
              id={`${editorPrefix}-events`}
              title="Події"
              description="Додаткові життєві події та факти, крім основних дат вище."
            >
              <PersonEventsEditor
                personId={persistedPerson?.id ?? "draft"}
                events={personEvents}
                onChange={(events) => update("events", events)}
              />
            </EditorSection>

            <EditorSection
              id={`${editorPrefix}-custom`}
              title="Власні поля"
              description="Додаткові поля, налаштовані для модуля осіб цього проєкту."
            >
              {customFieldDefinitions.length ? (
                <CustomFieldsEditor
                  db={db}
                  definitions={customFieldDefinitions}
                  values={form.customFields}
                  onChange={(values) => update("customFields", values)}
                  onDeleteDefinition={onDeleteCustomField
                    ? (definition) => {
                        if (!window.confirm(
                          `Видалити поле «${definition.label}»? Значення цього поля більше не відображатимуться в картках осіб.`,
                        )) return;
                        const next = { ...form.customFields };
                        delete next[definition.id];
                        update("customFields", next);
                        onDeleteCustomField(definition);
                      }
                    : undefined}
                />
              ) : (
                <p className="person-editor-v2-empty-state field-wide">Власних полів ще немає.</p>
              )}
              {onAddCustomField ? (
                <InlineCustomFieldCreator
                  module="persons"
                  db={db}
                  definitions={customFieldDefinitions}
                  onAdd={onAddCustomField}
                  canAdd={canAddCustomField}
                  blockedMessage={customFieldLimitMessage}
                />
              ) : null}
            </EditorSection>
          </main>
        </div>

        <div className="person-editor-v2-actions">
          <button type="button" className="button button-ghost" onClick={cancel} disabled={saving}>
            Скасувати
          </button>
          <div>
            <button type="submit" className="button button-secondary" disabled={saving || !dirty}>
              {saving ? "Зберігаємо…" : "Зберегти"}
            </button>
            {onOpenProfile ? (
              <button
                type="button"
                className="button button-primary"
                disabled={saving}
                onClick={() => void persist("profile")}
              >
                {saving ? "Зберігаємо…" : "Зберегти й відкрити профіль"}
              </button>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}
