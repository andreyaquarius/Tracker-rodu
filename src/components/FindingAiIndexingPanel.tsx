import { useMemo, useState } from "react";
import type {
  CustomFieldValues,
  DocumentRecord,
  Finding,
  FindingParticipant,
} from "../types";
import { createId } from "../utils/id";
import {
  AI_FINDING_INDEXING_META_KEY,
  analyzeFindingFragmentWithAi,
  type AiFindingIndexingResponse,
  type AiFindingParticipantCandidate,
} from "../services/findingAiIndexing";
import { sortFindingParticipants } from "../utils/findingParticipants";

const consentStorageKey = "tracker-rodu-ai-finding-indexing-consent";

export function FindingAiIndexingPanel({
  finding,
  documents,
  customValues,
  onApply,
}: {
  finding: Partial<Finding> & { id?: string };
  documents: DocumentRecord[];
  customValues: CustomFieldValues;
  onApply: (patch: {
    form: Partial<Finding>;
    customValues: CustomFieldValues;
  }) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AiFindingIndexingResponse | null>(null);
  const [consent, setConsent] = useState(() =>
    localStorage.getItem(consentStorageKey) === "yes",
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const scans = finding.scans ?? [];
  const canAnalyze = Boolean(scans.length);
  const participants = result?.result.participants ?? [];
  const selectedParticipants = useMemo(
    () => participants.filter((participant) => selected.has(participant.tempId)),
    [participants, selected],
  );

  const analyze = async () => {
    setError("");
    if (!scans.length) {
      setError("Прикріпіть до знахідки фрагмент запису.");
      return;
    }
    if (!consent) {
      setError("Підтвердіть згоду на передачу фрагмента до AI-обробки.");
      return;
    }
    localStorage.setItem(consentStorageKey, "yes");
    setLoading(true);
    try {
      const response = await analyzeFindingFragmentWithAi({
        finding,
        documents,
        consent: true,
      });
      setResult(response);
      setSelected(new Set(response.result.participants.map((participant) => participant.tempId)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не вдалося розпізнати фрагмент.");
    } finally {
      setLoading(false);
    }
  };

  const applyParticipants = (candidates: AiFindingParticipantCandidate[]) => {
    if (!result || !candidates.length) return;
    const currentParticipants = Array.isArray(finding.participants)
      ? finding.participants
      : [];
    const nextParticipants = sortFindingParticipants(
      mergeParticipants(currentParticipants, candidates),
      finding.findingType ?? "",
    );
    const transcription = result.result.transcription.originalText
      || result.result.transcription.normalizedText
      || "";
    const eventDate = result.result.event.eventDateNormalized
      || result.result.event.eventDateOriginal
      || "";
    const place = result.result.event.eventPlaceNormalized
      || result.result.event.eventPlaceOriginal
      || "";
    const summary = result.result.documentUnderstanding.summary
      || result.result.event.recordNumber
      || "";
    const nextCustomValues = appendAudit(customValues, result, candidates);
    onApply({
      form: {
        participants: nextParticipants,
        personsText: String(finding.personsText || candidateNames(candidates)),
        transcription: String(finding.transcription || transcription),
        eventDate: String(finding.eventDate || eventDate),
        place: String(finding.place || place),
        page: String(finding.page || result.result.event.sourcePage || ""),
        summary: String(finding.summary || summary),
        needsReview: Boolean(finding.needsReview || result.result.needsHumanReview),
      },
      customValues: nextCustomValues,
    });
  };

  return (
    <section className="finding-ai-panel">
      <div className="finding-ai-panel-header">
        <div>
          <span className="eyebrow">AI-розпізнавання</span>
          <h3>Розпізнати фрагмент знахідки</h3>
          <p>Gemini прочитає прикріплений фрагмент і запропонує учасників запису для перевірки.</p>
        </div>
        <button
          type="button"
          className="button button-primary"
          disabled={loading || !canAnalyze}
          onClick={analyze}
        >
          {loading ? "Розпізнаємо..." : "Розпізнати та заповнити учасників AI"}
        </button>
      </div>

      {!canAnalyze ? (
        <div className="hint-box">
          Для AI-розпізнавання потрібен прикріплений фрагмент-зображення.
        </div>
      ) : null}

      <label className="checkbox-row finding-ai-consent">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>Дозволяю передати прикріплений фрагмент запису до AI-обробки для розпізнавання цієї знахідки.</span>
      </label>

      {error ? <div className="form-error">{error}</div> : null}

      {result ? (
        <div className="finding-ai-result">
          <div className="finding-ai-summary">
            <div>
              <strong>Модель</strong>
              <span>{result.model}</span>
            </div>
            <div>
              <strong>Тип запису</strong>
              <span>{recordTypeLabel(result.result.documentUnderstanding.detectedRecordType)}</span>
            </div>
            <div>
              <strong>Читабельність</strong>
              <span>{readabilityLabel(result.result.documentUnderstanding.overallReadability)}</span>
            </div>
            <div>
              <strong>Учасників</strong>
              <span>{participants.length}</span>
            </div>
          </div>

          <div className="finding-ai-transcription">
            <h4>Транскрипція</h4>
            <p>{result.result.transcription.originalText || "Текст не вдалося надійно прочитати."}</p>
            {result.result.transcription.translationToUkrainian ? (
              <small>{result.result.transcription.translationToUkrainian}</small>
            ) : null}
          </div>

          {result.result.warnings.length ? (
            <div className="finding-ai-warnings">
              {result.result.warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </div>
          ) : null}

          <div className="finding-ai-candidates">
            {participants.map((participant) => (
              <label key={participant.tempId} className="finding-ai-candidate">
                <input
                  type="checkbox"
                  checked={selected.has(participant.tempId)}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(participant.tempId);
                      else next.delete(participant.tempId);
                      return next;
                    });
                  }}
                />
                <div>
                  <strong>{candidateName(participant) || "Особа без імені"}</strong>
                  <span>{participant.roleLabel} · {confidenceLabel(participant.confidence)}</span>
                  {candidateDetails(participant).length ? (
                    <small>{candidateDetails(participant).join("; ")}</small>
                  ) : null}
                  {participant.warnings.length ? (
                    <em>{participant.warnings.join("; ")}</em>
                  ) : null}
                </div>
              </label>
            ))}
          </div>

          <div className="finding-ai-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={!selectedParticipants.length}
              onClick={() => applyParticipants(selectedParticipants)}
            >
              Прийняти вибраних
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!participants.length}
              onClick={() => applyParticipants(participants)}
            >
              Прийняти всіх
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                setResult(null);
                setSelected(new Set());
              }}
            >
              Відхилити
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function mergeParticipants(
  currentParticipants: FindingParticipant[],
  candidates: AiFindingParticipantCandidate[],
): FindingParticipant[] {
  const existing = new Set(
    currentParticipants.map((participant) =>
      `${participant.role.trim().toLocaleLowerCase("uk")}:${participant.name.trim().toLocaleLowerCase("uk")}`,
    ),
  );
  const additions = candidates
    .map((candidate) => ({
      id: createId(),
      role: candidate.roleLabel || "Інша особа",
      name: candidateName(candidate),
      notes: candidateNotes(candidate),
    }))
    .filter((participant) => participant.name.trim())
    .filter((participant) => {
      const key = `${participant.role.trim().toLocaleLowerCase("uk")}:${participant.name.trim().toLocaleLowerCase("uk")}`;
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
  return [...currentParticipants, ...additions];
}

function appendAudit(
  customValues: CustomFieldValues,
  result: AiFindingIndexingResponse,
  accepted: AiFindingParticipantCandidate[],
): CustomFieldValues {
  const current = parseAudit(customValues[AI_FINDING_INDEXING_META_KEY]);
  const next = [
    {
      jobId: result.jobId,
      createdAt: result.createdAt,
      model: result.model,
      provider: result.provider,
      promptVersion: result.promptVersion,
      schemaVersion: result.schemaVersion,
      acceptedParticipantTempIds: accepted.map((participant) => participant.tempId),
      warningCount: result.result.warnings.length,
      needsHumanReview: result.result.needsHumanReview,
      imageSha256: result.inputSummary.imageSha256,
    },
    ...current,
  ].slice(0, 10);
  return {
    ...customValues,
    [AI_FINDING_INDEXING_META_KEY]: JSON.stringify(next),
  };
}

function parseAudit(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> =>
          Boolean(item && typeof item === "object" && !Array.isArray(item)),
        )
      : [];
  } catch {
    return [];
  }
}

function candidateName(candidate: AiFindingParticipantCandidate): string {
  const person = candidate.person;
  return (
    person.fullNameNormalized
    || person.fullNameOriginal
    || [
      person.surnameNormalized || person.surnameOriginal,
      person.givenNamesNormalized.join(" ") || person.givenNamesOriginal,
      person.patronymicNormalized || person.patronymicOriginal,
    ].filter(Boolean).join(" ")
  ).trim();
}

function candidateNames(candidates: AiFindingParticipantCandidate[]): string {
  return candidates.map(candidateName).filter(Boolean).join("; ");
}

function candidateNotes(candidate: AiFindingParticipantCandidate): string {
  const details = candidateDetails(candidate);
  const original = candidate.person.fullNameOriginal &&
    candidate.person.fullNameOriginal !== candidateName(candidate)
    ? `Оригінальне написання: ${candidate.person.fullNameOriginal}`
    : "";
  const warnings = candidate.warnings.length ? `Попередження AI: ${candidate.warnings.join("; ")}` : "";
  return [
    original,
    ...details,
    `Додано з AI-пропозиції, впевненість: ${Math.round(candidate.confidence * 100)}%`,
    warnings,
  ].filter(Boolean).join("; ");
}

function candidateDetails(candidate: AiFindingParticipantCandidate): string[] {
  const facts = candidate.facts;
  return [
    facts.ageOriginal ? `вік: ${facts.ageOriginal}` : "",
    facts.birthDateOriginal ? `дата народження: ${facts.birthDateOriginal}` : "",
    facts.residenceOriginal ? `місце проживання: ${facts.residenceOriginal}` : "",
    facts.originPlaceOriginal ? `місце походження: ${facts.originPlaceOriginal}` : "",
    facts.occupationOriginal ? `заняття: ${facts.occupationOriginal}` : "",
    facts.socialStatusOriginal ? `стан: ${facts.socialStatusOriginal}` : "",
    facts.religionOriginal ? `конфесія: ${facts.religionOriginal}` : "",
    facts.notes || "",
  ].filter(Boolean);
}

function confidenceLabel(confidence: number): string {
  const percent = Math.round(confidence * 100);
  if (percent >= 80) return `висока впевненість (${percent}%)`;
  if (percent >= 50) return `середня впевненість (${percent}%)`;
  return `низька впевненість (${percent}%)`;
}

function recordTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    birth: "народження",
    baptism: "хрещення",
    marriage: "шлюб",
    death: "смерть",
    burial: "поховання",
    revision_list: "ревізія",
    confession_list: "сповідний розпис",
    census: "перепис",
    military: "військовий документ",
    court: "судова справа",
    land: "земельний документ",
    notarial: "нотаріальний документ",
    migration: "міграційний документ",
    address_book: "адресна книга",
    school: "навчальний документ",
    other: "інше",
    unknown: "невідомо",
  };
  return labels[value] ?? value;
}

function readabilityLabel(value: string): string {
  const labels: Record<string, string> = {
    high: "висока",
    medium: "середня",
    low: "низька",
    very_low: "дуже низька",
  };
  return labels[value] ?? "невідомо";
}
