import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  EvidenceStatus,
  ParentChildRelationshipType,
  PartnerRelationshipType,
} from "../../types/familyTree";
import {
  type FamilyTreeBuilderAction,
  type FamilyTreePersonMutationDraft,
} from "../../services/familyTreeMutationService";
import { normalizeFlexibleDateInput } from "../../utils/dateHelpers";
import { Modal } from "../Modal";

export interface FamilyTreePartnerOption {
  personId: string;
  familyGroupId: string | null;
  label: string;
}

export interface FamilyTreePersonDialogSubmit {
  action: FamilyTreeBuilderAction;
  person: FamilyTreePersonMutationDraft;
  parentRelationshipType: ParentChildRelationshipType;
  partnerRelationshipType: PartnerRelationshipType;
  evidenceStatus: EvidenceStatus;
  secondParentId?: string;
  familyGroupId?: string | null;
}

const evidenceOptions: Array<{ value: EvidenceStatus; label: string }> = [
  { value: "proven", label: "Доведено" },
  { value: "likely", label: "Ймовірно" },
  { value: "disputed", label: "Сумнівно" },
  { value: "unknown", label: "Невідомо" },
];

const parentTypeOptions: Array<{ value: ParentChildRelationshipType; label: string }> = [
  { value: "biological", label: "Біологічний зв’язок" },
  { value: "genetic_father", label: "Генетичний батько" },
  { value: "genetic_mother", label: "Генетична мати" },
  { value: "gestational_parent", label: "Гестаційна мати / особа, яка виносила дитину" },
  { value: "birth_parent", label: "Батько / мати при народженні" },
  { value: "adoptive", label: "Усиновлення" },
  { value: "foster", label: "Виховання" },
  { value: "step", label: "Нерідний батько/мати" },
  { value: "guardian", label: "Опіка" },
  { value: "social_parent", label: "Соціальний батько/мати" },
  { value: "legal_parent", label: "Юридичний батько / мати" },
  { value: "donor", label: "Донор генетичного матеріалу" },
  { value: "surrogate", label: "Сурогатна мати" },
  { value: "presumed", label: "Батько / мати за презумпцією" },
  { value: "unknown", label: "Невідомий тип" },
  { value: "other", label: "Інший батьківський зв’язок" },
];

const partnerTypeOptions: Array<{ value: PartnerRelationshipType; label: string }> = [
  { value: "marriage", label: "Шлюб" },
  { value: "civil_partnership", label: "Цивільний союз" },
  { value: "cohabitation", label: "Спільне проживання" },
  { value: "engagement", label: "Заручини" },
  { value: "other", label: "Партнерство / інше" },
  { value: "divorced", label: "Розлучені" },
  { value: "separated", label: "Окремо" },
  { value: "unknown", label: "Невідомий тип" },
];

export function FamilyTreePersonDialog({
  action,
  targetName,
  partnerOptions,
  isSaving,
  error,
  onClose,
  onSubmit,
}: {
  action: FamilyTreeBuilderAction;
  targetName: string;
  partnerOptions: FamilyTreePartnerOption[];
  isSaving: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (data: FamilyTreePersonDialogSubmit) => void | Promise<void>;
}) {
  const [person, setPerson] = useState<FamilyTreePersonMutationDraft>(() => defaultPersonDraft(action));
  const [parentRelationshipType, setParentRelationshipType] = useState<ParentChildRelationshipType>("biological");
  const [partnerRelationshipType, setPartnerRelationshipType] = useState<PartnerRelationshipType>("marriage");
  const [evidenceStatus, setEvidenceStatus] = useState<EvidenceStatus>("proven");
  const [secondParentId, setSecondParentId] = useState("");
  const [dateError, setDateError] = useState("");

  const title = useMemo(() => titleForAction(action, targetName), [action, targetName]);
  const isRootAction = action === "create_root";
  const isPartnerAction = action === "add_partner";
  const needsParentType = !isRootAction && action !== "add_partner";
  const requiresSecondParent = action === "add_child";
  const mustChooseSecondParent = requiresSecondParent && partnerOptions.length > 1;
  const canChooseSecondParent = requiresSecondParent && partnerOptions.length > 0;
  useEffect(() => {
    if (!secondParentId) return;
    if (partnerOptions.some((option) => option.personId === secondParentId)) return;
    setSecondParentId("");
  }, [partnerOptions, secondParentId]);
  const isFemalePerson = person.gender === "жінка";

  const updatePerson = (patch: Partial<FamilyTreePersonMutationDraft>) => {
    setPerson((current) => {
      const next = { ...current, ...patch };
      if ("gender" in patch && patch.gender !== "жінка") {
        next.maidenSurname = "";
      }
      return next;
    });
  };

  const normalizeDate = (field: "birthDate" | "deathDate") => {
    const result = normalizeFlexibleDateInput(person[field]);
    if (result.error) {
      setDateError(result.error);
      return;
    }
    setDateError("");
    updatePerson({ [field]: result.value } as Partial<FamilyTreePersonMutationDraft>);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const hasAnyName = [person.surname, person.givenName, person.patronymic].some((part) => part.trim());
    if (!hasAnyName) {
      setDateError("Заповніть хоча б ім’я, прізвище або по батькові.");
      return;
    }
    if (mustChooseSecondParent && !secondParentId) {
      setDateError(canChooseSecondParent
        ? "Оберіть другого з батьків для дитини."
        : "Спочатку додайте другого з батьків, а потім додавайте дитину до батьківської пари.");
      return;
    }
    const normalizedBirthDate = normalizeFlexibleDateInput(person.birthDate);
    const normalizedDeathDate = normalizeFlexibleDateInput(person.deathDate);
    if (normalizedBirthDate.error || normalizedDeathDate.error) {
      setDateError(normalizedBirthDate.error ?? normalizedDeathDate.error ?? "Перевірте формат дат.");
      return;
    }
    setDateError("");
    void onSubmit({
      action,
      person: {
        ...person,
        birthDate: normalizedBirthDate.value,
        deathDate: normalizedDeathDate.value,
        maidenSurname: person.gender === "жінка" ? person.maidenSurname : "",
        privacyStatus: "private",
      },
      parentRelationshipType,
      partnerRelationshipType,
      evidenceStatus,
      secondParentId: secondParentId || undefined,
      familyGroupId: partnerOptions.find((option) => option.personId === secondParentId)?.familyGroupId ?? null,
    });
  };

  return (
    <Modal title={title} className="family-tree-relation-editor-modal" onClose={onClose} mode="dialog">
      <form className="family-tree-builder-form" onSubmit={submit}>
        {error ? <div className="form-error">{error}</div> : null}
        {dateError ? <div className="form-error">{dateError}</div> : null}

        <div className="form-grid two">
          <label>
            <span>Прізвище</span>
            <input value={person.surname} onChange={(event) => updatePerson({ surname: event.target.value })} />
          </label>
          {isFemalePerson ? (
            <label>
              <span>Дівоче прізвище</span>
              <input value={person.maidenSurname ?? ""} onChange={(event) => updatePerson({ maidenSurname: event.target.value })} />
            </label>
          ) : null}
          <label>
            <span>Ім’я</span>
            <input value={person.givenName} onChange={(event) => updatePerson({ givenName: event.target.value })} />
          </label>
          <label>
            <span>По батькові</span>
            <input value={person.patronymic} onChange={(event) => updatePerson({ patronymic: event.target.value })} />
          </label>
          <label>
            <span>Стать</span>
            <select value={person.gender} onChange={(event) => updatePerson({ gender: event.target.value })}>
              <option value="невідомо">Невідомо</option>
              <option value="чоловік">Чоловік</option>
              <option value="жінка">Жінка</option>
            </select>
          </label>
          <label>
            <span>Дата народження</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="дд.мм.рррр або рррр"
              value={person.birthDate}
              onChange={(event) => updatePerson({ birthDate: event.target.value })}
              onBlur={() => normalizeDate("birthDate")}
            />
          </label>
          <label>
            <span>Дата смерті</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="дд.мм.рррр або рррр"
              value={person.deathDate}
              onChange={(event) => updatePerson({ deathDate: event.target.value })}
              onBlur={() => normalizeDate("deathDate")}
            />
          </label>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={person.isLiving}
              onChange={(event) => updatePerson({ isLiving: event.target.checked })}
            />
            <span>Жива особа</span>
          </label>
        </div>

        <div className="form-grid two">
          {needsParentType ? (
            <label>
              <span>Тип родинного зв’язку</span>
              <select
                value={parentRelationshipType}
                onChange={(event) => setParentRelationshipType(event.target.value as ParentChildRelationshipType)}
              >
                {parentTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          ) : null}

          {isPartnerAction ? (
            <label>
              <span>Тип партнерського зв’язку</span>
              <select
                value={partnerRelationshipType}
                onChange={(event) => setPartnerRelationshipType(event.target.value as PartnerRelationshipType)}
              >
                {partnerTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          ) : null}

          <label>
            <span>Доказовість</span>
            <select value={evidenceStatus} onChange={(event) => setEvidenceStatus(event.target.value as EvidenceStatus)}>
              {evidenceOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          {requiresSecondParent ? (
            <label>
              <span>Другий з батьків</span>
              <select
                value={secondParentId}
                onChange={(event) => setSecondParentId(event.target.value)}
                required={mustChooseSecondParent}
                disabled={!canChooseSecondParent}
              >
                <option value="">
                  {canChooseSecondParent ? "Оберіть другого з батьків" : "Спочатку додайте другого з батьків"}
                </option>
                {partnerOptions.map((option) => (
                  <option key={option.personId} value={option.personId}>{option.label}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={isSaving}>
            Скасувати
          </button>
          <button type="submit" className="button" disabled={isSaving}>
            {isSaving ? "Збереження..." : "Створити і прив’язати"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function defaultPersonDraft(action: FamilyTreeBuilderAction): FamilyTreePersonMutationDraft {
  return {
    surname: "",
    maidenSurname: "",
    givenName: "",
    patronymic: "",
    gender: action === "add_father" ? "чоловік" : action === "add_mother" ? "жінка" : "невідомо",
    birthDate: "",
    deathDate: "",
    isLiving: false,
    privacyStatus: "private",
  };
}

function titleForAction(action: FamilyTreeBuilderAction, targetName: string): string {
  const target = targetName ? ` для ${targetName}` : "";
  if (action === "create_root") return "Створити першу особу";
  if (action === "add_father") return `Додати батька${target}`;
  if (action === "add_mother") return `Додати матір${target}`;
  if (action === "add_parent") return `Додати одного з батьків${target}`;
  if (action === "add_partner") return `Додати партнера${target}`;
  if (action === "add_child") return `Додати дитину${target}`;
  return `Додати брата або сестру${target}`;
}
