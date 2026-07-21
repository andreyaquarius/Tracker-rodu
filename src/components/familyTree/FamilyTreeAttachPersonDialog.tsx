import { useMemo, useRef, useState, type FormEvent } from "react";
import type {
  EvidenceStatus,
  ParentChildRelationshipType,
  PartnerRelationshipType,
} from "../../types/familyTree";
import { Modal } from "../Modal";
import type { FamilyTreePartnerOption } from "./FamilyTreePersonDialog";

export type FamilyTreeAttachAction = "attach_parent" | "attach_partner" | "attach_child";

export interface FamilyTreeAttachCandidate {
  personId: string;
  label: string;
  detail?: string;
}

export interface FamilyTreeAttachSubmit {
  action: FamilyTreeAttachAction;
  existingPersonId: string;
  parentIntent: "father" | "mother" | "parent";
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

const parentIntentOptions: Array<{ value: "father" | "mother" | "parent"; label: string }> = [
  { value: "father", label: "Батько" },
  { value: "mother", label: "Мати" },
  { value: "parent", label: "Батько або мати" },
];

const parentTypeOptions: Array<{ value: ParentChildRelationshipType; label: string }> = [
  { value: "biological", label: "Біологічний зв’язок" },
  { value: "genetic_father", label: "Генетичний батько" },
  { value: "genetic_mother", label: "Генетична мати" },
  { value: "gestational_parent", label: "Гестаційна мати / особа, яка виносила дитину" },
  { value: "birth_parent", label: "Батько / мати при народженні" },
  { value: "adoptive", label: "Усиновлення" },
  { value: "foster", label: "Виховання" },
  { value: "step", label: "Зведений / нерідний зв’язок" },
  { value: "guardian", label: "Опіка" },
  { value: "social_parent", label: "Соціальний зв’язок" },
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

export function FamilyTreeAttachPersonDialog({
  action,
  targetName,
  candidates,
  partnerOptions,
  isSaving,
  error,
  onClose,
  onSubmit,
}: {
  action: FamilyTreeAttachAction;
  targetName: string;
  candidates: FamilyTreeAttachCandidate[];
  partnerOptions: FamilyTreePartnerOption[];
  isSaving: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (data: FamilyTreeAttachSubmit) => void | Promise<void>;
}) {
  const [existingPersonId, setExistingPersonId] = useState("");
  const [query, setQuery] = useState("");
  const [parentIntent, setParentIntent] = useState<"father" | "mother" | "parent">("parent");
  const [parentRelationshipType, setParentRelationshipType] = useState<ParentChildRelationshipType>("biological");
  const [partnerRelationshipType, setPartnerRelationshipType] = useState<PartnerRelationshipType>("marriage");
  const [evidenceStatus, setEvidenceStatus] = useState<EvidenceStatus>("proven");
  const [secondParentId, setSecondParentId] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitPending, setSubmitPending] = useState(false);
  const submitInFlightRef = useRef(false);

  const filteredCandidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("uk");
    const source = normalized
      ? candidates.filter((candidate) =>
          [candidate.label, candidate.detail ?? ""].join(" ").toLocaleLowerCase("uk").includes(normalized),
        )
      : candidates;
    return source.slice(0, 80);
  }, [candidates, query]);

  const needsParentType = action === "attach_parent" || action === "attach_child";
  const isPartnerAction = action === "attach_partner";
  const canChooseSecondParent = action === "attach_child" && partnerOptions.length > 0;
  const submitDisabled = isSaving || submitPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (submitInFlightRef.current || isSaving) return;
    if (!existingPersonId) {
      setLocalError("Оберіть існуючу особу для прив’язки.");
      return;
    }
    setLocalError("");
    submitInFlightRef.current = true;
    setSubmitPending(true);
    const payload: FamilyTreeAttachSubmit = {
      action,
      existingPersonId,
      parentIntent,
      parentRelationshipType,
      partnerRelationshipType,
      evidenceStatus,
      secondParentId: secondParentId || undefined,
      familyGroupId: partnerOptions.find((option) => option.personId === secondParentId)?.familyGroupId ?? null,
    };
    void (async () => {
      try {
        await onSubmit(payload);
      } catch (submitError) {
        setLocalError(
          submitError instanceof Error
            ? submitError.message
            : "Не вдалося прив’язати вибрану особу.",
        );
      } finally {
        submitInFlightRef.current = false;
        setSubmitPending(false);
      }
    })();
  };

  return (
    <Modal
      title={titleForAction(action, targetName)}
      className="family-tree-relation-editor-modal"
      onClose={onClose}
      mode="dialog"
    >
      <form className="family-tree-builder-form" onSubmit={submit}>
        {error ? <div className="form-error">{error}</div> : null}
        {localError ? <div className="form-error">{localError}</div> : null}

        <label>
          <span>Пошук існуючої особи</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ім’я, прізвище, рік або місце"
          />
        </label>

        <label>
          <span>Особа</span>
          <select value={existingPersonId} onChange={(event) => setExistingPersonId(event.target.value)}>
            <option value="">
              {filteredCandidates.length ? "Оберіть особу" : "Немає доступних осіб для прив’язки"}
            </option>
            {filteredCandidates.map((candidate) => (
              <option key={candidate.personId} value={candidate.personId}>
                {[candidate.label, candidate.detail].filter(Boolean).join(" · ")}
              </option>
            ))}
          </select>
        </label>

        <div className="form-grid two">
          {action === "attach_parent" ? (
            <label>
              <span>Роль</span>
              <select value={parentIntent} onChange={(event) => setParentIntent(event.target.value as typeof parentIntent)}>
                {parentIntentOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          ) : null}

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

          {canChooseSecondParent ? (
            <label>
              <span>Другий з батьків</span>
              <select value={secondParentId} onChange={(event) => setSecondParentId(event.target.value)}>
                <option value="">Без другого з батьків</option>
                {partnerOptions.map((option) => (
                  <option key={option.personId} value={option.personId}>{option.label}</option>
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
        </div>

        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose} disabled={submitDisabled}>
            Скасувати
          </button>
          <button type="submit" className="button" disabled={submitDisabled || !filteredCandidates.length}>
            {submitDisabled ? "Прив’язування..." : "Прив’язати без дублювання"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function titleForAction(action: FamilyTreeAttachAction, targetName: string): string {
  const target = targetName ? ` для ${targetName}` : "";
  if (action === "attach_parent") return `Прив’язати існуючого батька/матір${target}`;
  if (action === "attach_partner") return `Прив’язати існуючого партнера${target}`;
  return `Прив’язати існуючу дитину${target}`;
}
