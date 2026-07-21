import { useState, type FormEvent } from "react";
import type {
  AppDatabase,
  CustomFieldDefinition,
  GeoPoint,
  Person,
  PersonEventType,
  PersonGender,
  PersonStatus,
  Research,
} from "../types";
import { createId } from "../utils/id";
import {
  formatFlexibleDateForDisplay,
  normalizeFlexibleDateInput,
  nowIso,
} from "../utils/dateHelpers";
import { Modal } from "./Modal";
import { CustomFieldsEditor } from "./CustomFields";
import { normalizeCustomFieldValues } from "../utils/customFields";
import { InlineCustomFieldCreator } from "./InlineCustomFieldCreator";
import { GeoPlaceField } from "./GeoPlaceField";
import { normalizePersonEvents, personEventLabel } from "../utils/geo";
import { ScanAttachmentsEditor } from "./ScanAttachments";
import { normalizePersonPhotoState } from "../utils/personPhotos.ts";
import { PersonEventsEditor } from "./PersonEventsEditor.tsx";
import {
  personEducation,
  personNationality,
  withPersonStandardFields,
} from "../utils/personStandardFields.ts";
import { PERSON_STATUSES } from "../utils/personStatus.ts";

const genders: PersonGender[] = ["невідомо", "чоловік", "жінка"];
type PersonDraft = Omit<Person, "id" | "createdAt" | "updatedAt">;
export type PersonInitialDraft = Partial<PersonDraft>;
type PersonDateFieldKey = "birthDate" | "marriageDate" | "deathDate";

const personDateFields: Array<{ key: PersonDateFieldKey; label: string }> = [
  { key: "birthDate", label: "Дата народження" },
  { key: "marriageDate", label: "Дата шлюбу" },
  { key: "deathDate", label: "Дата смерті" },
];

function PersonDateInput({
  label,
  value,
  error,
  onChange,
  onBlur,
}: {
  label: string;
  value: string;
  error: string;
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
      {error ? <small className="form-field-error">{error}</small> : null}
    </label>
  );
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

function buildInitialPerson(
  initialFullName: string,
  researchId: string,
  initialPersonDraft?: PersonInitialDraft,
): PersonDraft {
  const empty = emptyPerson(initialFullName, researchId);
  if (!initialPersonDraft) return empty;
  return {
    ...empty,
    ...initialPersonDraft,
    researchId: initialPersonDraft.researchId ?? empty.researchId,
    fullName: initialPersonDraft.fullName ?? empty.fullName,
    birthScans: initialPersonDraft.birthScans ?? empty.birthScans,
    marriageScans: initialPersonDraft.marriageScans ?? empty.marriageScans,
    deathScans: initialPersonDraft.deathScans ?? empty.deathScans,
    mentionScans: initialPersonDraft.mentionScans ?? empty.mentionScans,
    photos: initialPersonDraft.photos ?? empty.photos,
    primaryPhotoId: normalizePersonPhotoState(
      initialPersonDraft.photos,
      initialPersonDraft.primaryPhotoId,
    ).primaryPhotoId,
    events: initialPersonDraft.events ?? empty.events,
    customFields: normalizeCustomFieldValues(initialPersonDraft.customFields),
  };
}

export function PersonFormModal({
  person,
  db,
  researches,
  initialFullName = "",
  initialResearchId = "",
  initialPersonDraft,
  customFieldDefinitions = [],
  researchRequired = false,
  onAddCustomField,
  onDeleteCustomField,
  canAddCustomField = true,
  customFieldLimitMessage,
  onClose,
  onSave,
  modalMode = "dialog",
  stackIndex = 0,
  dockIndex = 0,
  onFocus,
}: {
  person?: Person | null;
  db: AppDatabase;
  researches: Research[];
  initialFullName?: string;
  initialResearchId?: string;
  initialPersonDraft?: PersonInitialDraft;
  customFieldDefinitions?: CustomFieldDefinition[];
  researchRequired?: boolean;
  onAddCustomField?: (definition: CustomFieldDefinition) => void;
  onDeleteCustomField?: (definition: CustomFieldDefinition) => void;
  canAddCustomField?: boolean;
  customFieldLimitMessage?: string;
  onClose: () => void;
  onSave: (person: Person) => void | Promise<unknown>;
  modalMode?: "dialog" | "window";
  stackIndex?: number;
  dockIndex?: number;
  onFocus?: () => void;
}) {
  const [form, setForm] = useState<PersonDraft>(() =>
    person
      ? {
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
          photos: person.photos ?? [],
          primaryPhotoId: normalizePersonPhotoState(
            person.photos,
            person.primaryPhotoId,
          ).primaryPhotoId,
          events: person.events ?? [],
          customFields: normalizeCustomFieldValues(person.customFields),
        }
      : buildInitialPerson(initialFullName, initialResearchId, initialPersonDraft),
  );
  const [dateDrafts, setDateDrafts] = useState<Record<PersonDateFieldKey, string>>(() => ({
    birthDate: formatFlexibleDateForDisplay(person?.birthDate ?? initialPersonDraft?.birthDate ?? ""),
    marriageDate: formatFlexibleDateForDisplay(person?.marriageDate ?? initialPersonDraft?.marriageDate ?? ""),
    deathDate: formatFlexibleDateForDisplay(person?.deathDate ?? initialPersonDraft?.deathDate ?? ""),
  }));
  const [dateErrors, setDateErrors] = useState<Record<PersonDateFieldKey, string>>({
    birthDate: "",
    marriageDate: "",
    deathDate: "",
  });
  const [educationDraft, setEducationDraft] = useState(() => personEducation(form).join("\n"));

  const update = <K extends keyof PersonDraft>(key: K, value: PersonDraft[K]) => {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "gender" && value !== "жінка") {
        next.maidenSurname = "";
      }
      return next;
    });
  };

  const updateStandardFields = (patch: { nationality?: string; education?: string }) => {
    setForm((current) => ({
      ...current,
      customFields: withPersonStandardFields(current.customFields, {
        nationality: patch.nationality ?? personNationality(current),
        education: patch.education ?? personEducation(current),
      }),
    }));
  };

  const updateLifeStatus = (isLiving: boolean) => {
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
    if (isLiving) {
      setDateDrafts((current) => ({ ...current, deathDate: "" }));
      setDateErrors((current) => ({ ...current, deathDate: "" }));
    }
  };

  const updateDateDraft = (key: PersonDateFieldKey, value: string) => {
    setDateDrafts((current) => ({ ...current, [key]: value }));
    setDateErrors((current) => ({ ...current, [key]: "" }));
    const parsed = normalizeFlexibleDateInput(value);
    if (!parsed.error) update(key, parsed.value);
  };

  const commitDateDraft = (key: PersonDateFieldKey) => {
    const parsed = normalizeFlexibleDateInput(dateDrafts[key]);
    if (parsed.error) {
      setDateErrors((current) => ({ ...current, [key]: parsed.error ?? "" }));
      return false;
    }
    update(key, parsed.value);
    setDateDrafts((current) => ({ ...current, [key]: formatFlexibleDateForDisplay(parsed.value) }));
    setDateErrors((current) => ({ ...current, [key]: "" }));
    return true;
  };

  const normalizeDateDrafts = () => {
    const nextDates = { deathDate: "" } as Record<PersonDateFieldKey, string>;
    const nextDrafts = { ...dateDrafts };
    const nextErrors: Record<PersonDateFieldKey, string> = {
      birthDate: "",
      marriageDate: "",
      deathDate: "",
    };
    const fieldsToNormalize = form.isLiving
      ? personDateFields.filter((field) => field.key !== "deathDate")
      : personDateFields;
    for (const field of fieldsToNormalize) {
      const parsed = normalizeFlexibleDateInput(dateDrafts[field.key]);
      if (parsed.error) {
        nextErrors[field.key] = parsed.error;
      } else {
        nextDates[field.key] = parsed.value;
        nextDrafts[field.key] = formatFlexibleDateForDisplay(parsed.value);
      }
    }
    setDateErrors(nextErrors);
    setDateDrafts(nextDrafts);
    return Object.values(nextErrors).some(Boolean) ? null : nextDates;
  };

  const composedFullName = [form.surname, form.givenName, form.patronymic]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  const displayedFullName = composedFullName || form.fullName.trim();
  const photoState = normalizePersonPhotoState(form.photos, form.primaryPhotoId);
  const updatePhotos = (photos: Person["photos"]) => {
    const next = normalizePersonPhotoState(photos, form.primaryPhotoId);
    setForm((current) => ({
      ...current,
      photos: next.photos,
      primaryPhotoId: next.primaryPhotoId,
    }));
  };
  const eventPerson = {
    id: person?.id ?? "draft",
    birthDate: form.birthDate,
    birthPlace: form.birthPlace,
    marriageDate: form.marriageDate,
    marriagePlace: form.marriagePlace,
    deathDate: form.isLiving ? "" : form.deathDate,
    deathPlace: form.isLiving ? "" : form.deathPlace,
    residencePlaces: form.residencePlaces,
  };
  const personEvents = normalizePersonEvents(form.events, eventPerson);

  const updateEventGeo = (type: PersonEventType, geo: GeoPoint | null) => {
    update("events", personEvents.map((item) =>
      item.type === type ? { ...item, geo } : item,
    ));
  };

  const updateEventPlace = (type: PersonEventType, place: string) => {
    if (type === "birth") update("birthPlace", place);
    if (type === "marriage") update("marriagePlace", place);
    if (type === "death") update("deathPlace", place);
    if (type === "residence") update("residencePlaces", place);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (researchRequired && !form.researchId.trim()) {
      window.alert("Оберіть дослідження для цієї особи.");
      return;
    }
    const normalizedDates = normalizeDateDrafts();
    if (!normalizedDates) {
      window.alert("Перевірте формат дат. Можна вводити лише рік, дату через крапку, косу лінію або як рррр-мм-дд.");
      return;
    }
    const timestamp = nowIso();
    const personId = person?.id ?? createId();
    const normalizedForm = {
      ...form,
      ...normalizedDates,
      ...(form.isLiving
        ? {
            deathDate: "",
            deathYearFrom: "",
            deathYearTo: "",
            deathPlace: "",
          }
        : {}),
    };
    const eventsForSave = form.isLiving ? form.events.filter((item) => item.type !== "death") : form.events;
    const finalPerson = {
      ...normalizedForm,
      fullName: displayedFullName,
      id: personId,
      createdAt: person?.createdAt ?? timestamp,
      __baseUpdatedAt: person?.updatedAt,
      updatedAt: timestamp,
    } as Person;
    await onSave({
      ...finalPerson,
      events: normalizePersonEvents(eventsForSave, finalPerson),
    });
  };

  return (
    <Modal
      title={person ? "Редагувати особу" : "Додати особу"}
      onClose={onClose}
      mode={modalMode}
      stackIndex={stackIndex}
      dockIndex={dockIndex}
      onFocus={onFocus}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>
            <span>Дослідження{researchRequired ? " *" : ""}</span>
            <select
              required={researchRequired}
              value={form.researchId}
              onChange={(event) => update("researchId", event.target.value)}
            >
              <option value="">{researchRequired ? "Оберіть дослідження" : "Без прив’язки"}</option>
              {researches.map((research) => (
                <option key={research.id} value={research.id}>{research.title}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Статус *</span>
            <select value={form.status} onChange={(event) => update("status", event.target.value as PersonStatus)}>
              {PERSON_STATUSES.map((status) => <option key={status}>{status}</option>)}
            </select>
          </label>
          <label>
            <span>Прізвище</span>
            <input value={form.surname} onChange={(event) => update("surname", event.target.value)} />
          </label>
          <label>
            <span>Дівоче прізвище</span>
            <input
              value={form.maidenSurname}
              disabled={form.gender !== "жінка"}
              placeholder={form.gender === "жінка" ? "Вкажіть дівоче прізвище" : "Доступне після вибору жіночої статі"}
              onChange={(event) => update("maidenSurname", event.target.value)}
            />
          </label>
          <label>
            <span>Ім’я</span>
            <input value={form.givenName} onChange={(event) => update("givenName", event.target.value)} />
          </label>
          <label>
            <span>По батькові</span>
            <input value={form.patronymic} onChange={(event) => update("patronymic", event.target.value)} />
          </label>
          <label>
            <span>Стать</span>
            <select value={form.gender} onChange={(event) => update("gender", event.target.value as PersonGender)}>
              {genders.map((gender) => <option key={gender}>{gender}</option>)}
            </select>
          </label>
          <fieldset className="life-status-toggle">
            <legend>Статус життя</legend>
            <label>
              <input
                type="checkbox"
                checked={form.isLiving}
                onChange={() => updateLifeStatus(true)}
              />
              <span>Жива</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={!form.isLiving}
                onChange={() => updateLifeStatus(false)}
              />
              <span>Померла</span>
            </label>
          </fieldset>
          <label className="field-wide">
            <span>Повне ім’я (автоматично)</span>
            <input
              value={displayedFullName}
              placeholder="Заповніть прізвище, ім’я та по батькові"
              readOnly
            />
          </label>
          <ScanAttachmentsEditor
            title="Фотографії особи"
            description="Головне фото та галерея зображень. Нові файли зберігаються у Google Drive активного проєкту; в картці зберігаються лише посилання й метадані."
            accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/svg+xml,image/tiff,.jpg,.jpeg,.png,.webp,.gif,.bmp,.svg,.tif,.tiff"
            maxFiles={20}
            policy="person-photo"
            driveFolderPath={["Особи", displayedFullName || "Без імені", "Фото"]}
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
          <label>
            <span>Варіанти імені</span>
            <input value={form.nameVariants} onChange={(event) => update("nameVariants", event.target.value)} />
          </label>
          <label>
            <span>Варіанти прізвища</span>
            <input value={form.surnameVariants} onChange={(event) => update("surnameVariants", event.target.value)} />
          </label>
          <PersonDateInput
            label="Дата народження"
            value={dateDrafts.birthDate}
            error={dateErrors.birthDate}
            onChange={(value) => updateDateDraft("birthDate", value)}
            onBlur={() => commitDateDraft("birthDate")}
          />
          <label>
            <span>Місце народження</span>
            <input value={form.birthPlace} onChange={(event) => update("birthPlace", event.target.value)} />
          </label>
          <label>
            <span>Рік народження від</span>
            <input type="number" value={form.birthYearFrom} onChange={(event) => update("birthYearFrom", event.target.value)} />
          </label>
          <label>
            <span>Рік народження до</span>
            <input type="number" value={form.birthYearTo} onChange={(event) => update("birthYearTo", event.target.value)} />
          </label>
          <PersonDateInput
            label="Дата шлюбу"
            value={dateDrafts.marriageDate}
            error={dateErrors.marriageDate}
            onChange={(value) => updateDateDraft("marriageDate", value)}
            onBlur={() => commitDateDraft("marriageDate")}
          />
          <label>
            <span>Місце шлюбу</span>
            <input value={form.marriagePlace} onChange={(event) => update("marriagePlace", event.target.value)} />
          </label>
          {!form.isLiving ? (
            <>
              <PersonDateInput
                label="Дата смерті"
                value={dateDrafts.deathDate}
                error={dateErrors.deathDate}
                onChange={(value) => updateDateDraft("deathDate", value)}
                onBlur={() => commitDateDraft("deathDate")}
              />
              <label>
                <span>Місце смерті</span>
                <input value={form.deathPlace} onChange={(event) => update("deathPlace", event.target.value)} />
              </label>
              <label>
                <span>Рік смерті від</span>
                <input type="number" value={form.deathYearFrom} onChange={(event) => update("deathYearFrom", event.target.value)} />
              </label>
              <label>
                <span>Рік смерті до</span>
                <input type="number" value={form.deathYearTo} onChange={(event) => update("deathYearTo", event.target.value)} />
              </label>
            </>
          ) : null}
          <label className="field-wide">
            <span>Місця проживання</span>
            <textarea rows={3} value={form.residencePlaces} onChange={(event) => update("residencePlaces", event.target.value)} />
          </label>
          <fieldset className="geo-events field-wide">
            <legend>Місця подій на карті</legend>
            <p>Додайте позначки для тих подій, які потрібно показувати на географічній карті.</p>
            {(["birth", "marriage", ...(form.isLiving ? [] : ["death"]), "residence"] as PersonEventType[]).map((type) => {
              const personEvent = personEvents.find((item) => item.type === type);
              return (
                <GeoPlaceField
                  key={type}
                  label={personEventLabel(type)}
                  eventType={type}
                  value={personEvent?.geo ?? null}
                  placeName={personEvent?.placeName ?? ""}
                  onChange={(geo) => updateEventGeo(type, geo)}
                  onPlaceNameChange={(place) => updateEventPlace(type, place)}
                />
              );
            })}
          </fieldset>
          <label>
            <span>Соціальний статус</span>
            <input value={form.socialStatus} onChange={(event) => update("socialStatus", event.target.value)} />
          </label>
          <label>
            <span>Віросповідання</span>
            <input value={form.religion} onChange={(event) => update("religion", event.target.value)} />
          </label>
          <label className="field-wide">
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
              value={educationDraft}
              onChange={(event) => {
                setEducationDraft(event.target.value);
                updateStandardFields({ education: event.target.value });
              }}
            />
          </label>
          <PersonEventsEditor
            personId={person?.id ?? "draft"}
            events={personEvents}
            onChange={(events) => update("events", events)}
          />
          <label className="field-wide">
            <span>Нотатки</span>
            <textarea rows={5} value={form.notes} onChange={(event) => update("notes", event.target.value)} />
          </label>
          <CustomFieldsEditor
            db={db}
            definitions={customFieldDefinitions}
            values={form.customFields}
            onChange={(values) => update("customFields", values)}
            onDeleteDefinition={onDeleteCustomField ? (definition) => {
              if (!window.confirm(
                `Видалити поле «${definition.label}»? Значення цього поля більше не відображатимуться в картках осіб.`,
              )) return;
              const next = { ...form.customFields };
              delete next[definition.id];
              update("customFields", next);
              onDeleteCustomField(definition);
            } : undefined}
          />
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
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button type="submit" className="button button-primary">Зберегти</button>
        </div>
      </form>
    </Modal>
  );
}
