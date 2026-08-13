import { useState, type FormEvent } from "react";
import type { Person, PersonGender, PersonStatus } from "../../types";
import { PERSON_STATUSES } from "../../utils/personStatus.ts";
import { autoFormatFlexibleDateInput } from "../../utils/dateHelpers.ts";
import {
  buildQuickPersonEdit,
  quickPersonEditDraft,
  type QuickPersonEditDateErrors,
  type QuickPersonEditDraft,
} from "../../utils/quickPersonEdit.ts";
import { Modal } from "../Modal";
import "./familyTreeQuickEditPersonDialog.css";

const GENDERS: PersonGender[] = ["невідомо", "чоловік", "жінка"];

export type FamilyTreeQuickPersonSaveHandler = (
  person: Person,
) => Promise<Person | null | void> | Person | null | void;

export function FamilyTreeQuickEditPersonDialog({
  person,
  onClose,
  onSave,
  onOpenFull,
}: {
  person: Person;
  onClose: () => void;
  onSave: FamilyTreeQuickPersonSaveHandler;
  onOpenFull?: (personId: string) => void;
}) {
  const [draft, setDraft] = useState<QuickPersonEditDraft>(() =>
    quickPersonEditDraft(person),
  );
  const [dateErrors, setDateErrors] =
    useState<QuickPersonEditDateErrors>({});
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  const update = <K extends keyof QuickPersonEditDraft>(
    key: K,
    value: QuickPersonEditDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (key === "birthDate" || key === "marriageDate" || key === "deathDate") {
      setDateErrors((current) => ({ ...current, [key]: undefined }));
    }
    setSaveError("");
  };

  const selectGender = (gender: PersonGender) => {
    setDraft((current) => ({
      ...current,
      gender,
      maidenSurname: gender === "жінка" ? current.maidenSurname : "",
    }));
    setSaveError("");
  };

  const selectLifeStatus = (isLiving: boolean) => {
    setDraft((current) => ({
      ...current,
      isLiving,
      ...(isLiving ? { deathDate: "", deathPlace: "" } : {}),
    }));
    if (isLiving) {
      setDateErrors((current) => ({ ...current, deathDate: undefined }));
    }
    setSaveError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = buildQuickPersonEdit(person, draft);
    setDateErrors(result.errors);
    if (!result.person) {
      setSaveError("Перевірте формат дат у виділених полях.");
      return;
    }

    setSaving(true);
    setSaveError("");
    try {
      const candidate = {
        ...result.person,
        __baseUpdatedAt: person.updatedAt,
      } as Person;
      const saved = await onSave(candidate);
      if (saved === null) {
        setSaveError("Не вдалося зберегти зміни. Перевірте повідомлення застосунку та повторіть спробу.");
        return;
      }
      onClose();
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Не вдалося зберегти основні дані особи.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Швидке редагування: ${person.fullName || "Особа"}`}
      className="family-tree-quick-edit-modal"
      onClose={saving ? () => undefined : onClose}
    >
      <form className="family-tree-quick-edit" onSubmit={submit}>
        <p className="family-tree-quick-edit__intro">
          Змініть основні відомості, не залишаючи родове дерево. Фото, джерела,
          нотатки, власні поля та інші дані особи не змінюються.
        </p>

        {saveError ? <div className="form-error" role="alert">{saveError}</div> : null}

        <section className="family-tree-quick-edit__section" aria-labelledby="quick-edit-main-heading">
          <h3 id="quick-edit-main-heading">Основне</h3>
          <div className="family-tree-quick-edit__grid">
            <label>
              <span>Прізвище</span>
              <input
                autoFocus
                value={draft.surname}
                onChange={(event) => update("surname", event.target.value)}
              />
            </label>
            <label>
              <span>Ім’я</span>
              <input
                value={draft.givenName}
                onChange={(event) => update("givenName", event.target.value)}
              />
            </label>
            <label>
              <span>По батькові</span>
              <input
                value={draft.patronymic}
                onChange={(event) => update("patronymic", event.target.value)}
              />
            </label>
            <label>
              <span>Дівоче прізвище</span>
              <input
                disabled={draft.gender !== "жінка"}
                placeholder={draft.gender === "жінка" ? "Вкажіть за потреби" : "Доступне для жіночої статі"}
                value={draft.maidenSurname}
                onChange={(event) => update("maidenSurname", event.target.value)}
              />
            </label>
            <label>
              <span>Стать</span>
              <select
                value={draft.gender}
                onChange={(event) => selectGender(event.target.value as PersonGender)}
              >
                {GENDERS.map((gender) => <option key={gender}>{gender}</option>)}
              </select>
            </label>
            <label>
              <span>Статус дослідження</span>
              <select
                value={draft.status}
                onChange={(event) => update("status", event.target.value as PersonStatus)}
              >
                {PERSON_STATUSES.map((status) => <option key={status}>{status}</option>)}
              </select>
            </label>
            <fieldset className="family-tree-quick-edit__life-status">
              <legend>Статус життя</legend>
              <label>
                <input
                  type="radio"
                  name={`quick-life-status-${person.id}`}
                  checked={draft.isLiving}
                  onChange={() => selectLifeStatus(true)}
                />
                <span>Жива</span>
              </label>
              <label>
                <input
                  type="radio"
                  name={`quick-life-status-${person.id}`}
                  checked={!draft.isLiving}
                  onChange={() => selectLifeStatus(false)}
                />
                <span>Померла</span>
              </label>
            </fieldset>
          </div>
        </section>

        <section className="family-tree-quick-edit__section" aria-labelledby="quick-edit-events-heading">
          <h3 id="quick-edit-events-heading">Основні факти</h3>
          <div className="family-tree-quick-edit__events">
            <QuickFactFields
              title="Народження"
              date={draft.birthDate}
              place={draft.birthPlace}
              dateError={dateErrors.birthDate}
              onDateChange={(value) => update("birthDate", value)}
              onPlaceChange={(value) => update("birthPlace", value)}
            />
            <QuickFactFields
              title="Шлюб"
              date={draft.marriageDate}
              place={draft.marriagePlace}
              dateError={dateErrors.marriageDate}
              onDateChange={(value) => update("marriageDate", value)}
              onPlaceChange={(value) => update("marriagePlace", value)}
            />
            {!draft.isLiving ? (
              <QuickFactFields
                title="Смерть"
                date={draft.deathDate}
                place={draft.deathPlace}
                dateError={dateErrors.deathDate}
                onDateChange={(value) => update("deathDate", value)}
                onPlaceChange={(value) => update("deathPlace", value)}
              />
            ) : null}
          </div>
        </section>

        <div className="modal-actions family-tree-quick-edit__actions">
          {onOpenFull ? (
            <button
              type="button"
              className="button button-secondary family-tree-quick-edit__full"
              disabled={saving}
              onClick={() => {
                onClose();
                onOpenFull(person.id);
              }}
            >
              Відкрити повну картку
            </button>
          ) : null}
          <button type="button" className="button button-ghost" disabled={saving} onClick={onClose}>
            Скасувати
          </button>
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving ? "Зберігаємо…" : "Зберегти"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function QuickFactFields({
  title,
  date,
  place,
  dateError,
  onDateChange,
  onPlaceChange,
}: {
  title: string;
  date: string;
  place: string;
  dateError?: string;
  onDateChange: (value: string) => void;
  onPlaceChange: (value: string) => void;
}) {
  return (
    <fieldset className="family-tree-quick-edit__fact">
      <legend>{title}</legend>
      <label>
        <span>Дата</span>
        <input
          inputMode="numeric"
          maxLength={10}
          autoComplete="off"
          placeholder="дд.мм.рррр або рррр"
          aria-invalid={dateError ? "true" : undefined}
          value={date}
          onChange={(event) => onDateChange(autoFormatFlexibleDateInput(event.target.value))}
        />
        {dateError ? <small className="form-field-error">{dateError}</small> : null}
      </label>
      <label>
        <span>Місце</span>
        <input
          placeholder="Населений пункт або місце"
          value={place}
          onChange={(event) => onPlaceChange(event.target.value)}
        />
      </label>
    </fieldset>
  );
}
