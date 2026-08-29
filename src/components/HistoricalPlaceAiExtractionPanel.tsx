import { useEffect, useMemo, useState } from "react";
import {
  extractHistoricalPlaceContextWithAi,
  HISTORICAL_PLACE_AI_MAX_SOURCE_CHARS,
  historicalPlaceAiContextKey,
  selectHistoricalPlaceAiDraft,
} from "../services/historicalPlaceAiExtraction.ts";
import type { HistoricalPlaceDocumentOption, HistoricalPlaceTemporalContext } from "../types/historicalPlaces.ts";
import type {
  HistoricalPlaceAiAcceptedDraft,
  HistoricalPlaceAiExtractionInput,
  HistoricalPlaceAiExtractionResponse,
  HistoricalPlaceAiNameSuggestion,
  HistoricalPlaceAiRelationSuggestion,
} from "../types/historicalPlaceAi.ts";

const consentStorageKey = "tracker-rodu-historical-place-ai-consent";

export interface HistoricalPlaceAiExtractionPanelProps {
  projectId: string;
  target: {
    placeId?: string | null;
    canonicalName: string;
    modernName?: string;
  };
  documents?: HistoricalPlaceDocumentOption[];
  temporalContext?: HistoricalPlaceTemporalContext | null;
  initialSourceText?: string;
  initialDocumentId?: string;
  disabled?: boolean;
  /** Receives reviewed draft values only. Persistence remains the parent form's responsibility. */
  onAccept: (draft: HistoricalPlaceAiAcceptedDraft) => void | Promise<void>;
}

export function HistoricalPlaceAiExtractionPanel(
  props: HistoricalPlaceAiExtractionPanelProps,
) {
  const [sourceText, setSourceText] = useState(props.initialSourceText ?? "");
  const [documentId, setDocumentId] = useState(props.initialDocumentId ?? "");
  const [page, setPage] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [consent, setConsent] = useState(() =>
    typeof window !== "undefined" && window.localStorage.getItem(consentStorageKey) === "yes"
  );
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<HistoricalPlaceAiExtractionResponse | null>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [selectedRelations, setSelectedRelations] = useState<Set<string>>(new Set());
  const [selectedPlaceType, setSelectedPlaceType] = useState(false);

  const input = useMemo<HistoricalPlaceAiExtractionInput>(() => ({
    projectId: props.projectId,
    consent,
    target: props.target,
    source: {
      documentId: documentId || null,
      text: sourceText,
      page,
      sourceReference,
    },
    temporalContext: props.temporalContext,
  }), [
    consent,
    documentId,
    page,
    props.projectId,
    props.target,
    props.temporalContext,
    sourceReference,
    sourceText,
  ]);
  const currentContextKey = historicalPlaceAiContextKey(input);

  useEffect(() => {
    if (!result || result.requestContextKey === currentContextKey) return;
    // A result belongs to one exact target, excerpt and provenance context.
    // Changing any of them requires a fresh analysis before acceptance.
    setResult(null);
    setSelectedNames(new Set());
    setSelectedRelations(new Set());
    setSelectedPlaceType(false);
    setNotice("");
  }, [currentContextKey, result]);

  const analyze = async () => {
    setError("");
    setNotice("");
    if (!consent) {
      setError("Підтвердіть згоду на передачу вибраного уривка до AI-обробки.");
      return;
    }
    if (typeof window !== "undefined") window.localStorage.setItem(consentStorageKey, "yes");
    setLoading(true);
    try {
      const response = await extractHistoricalPlaceContextWithAi(input);
      setResult(response);
      // Nothing is preselected: every accepted fact requires an explicit click.
      setSelectedNames(new Set());
      setSelectedRelations(new Set());
      setSelectedPlaceType(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не вдалося проаналізувати документ.");
    } finally {
      setLoading(false);
    }
  };

  const hasSelection = selectedNames.size > 0
    || selectedRelations.size > 0
    || selectedPlaceType;

  const acceptSelection = async () => {
    if (!result || result.requestContextKey !== currentContextKey || !hasSelection) return;
    setAccepting(true);
    setError("");
    setNotice("");
    try {
      const draft = selectHistoricalPlaceAiDraft(result, {
        nameSuggestionIds: selectedNames,
        relationSuggestionIds: selectedRelations,
        acceptPlaceType: selectedPlaceType,
      });
      await props.onAccept(draft);
      setNotice("Вибрані пропозиції передано у чернетку. Перевірте поля та окремо збережіть форму.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не вдалося передати пропозиції у чернетку.");
    } finally {
      setAccepting(false);
    }
  };

  const documents = props.documents ?? [];
  const hasTarget = Boolean(props.target.placeId?.trim() || props.target.canonicalName.trim());
  const targetLabel = props.target.canonicalName.trim()
    || props.target.modernName?.trim()
    || "нове історичне місце";

  return (
    <section className="panel historical-place-ai-panel" aria-labelledby="historical-place-ai-title">
      <div className="historical-place-ai-heading">
        <div>
          <span className="eyebrow">Необов’язковий AI-аналіз</span>
          <h3 id="historical-place-ai-title">Витягти історичні відомості з документа</h3>
          <p>
            AI знайде можливі назви, тип і згадані зв’язки для «{targetLabel}».
            Результат не зберігається автоматично.
          </p>
        </div>
      </div>

      <div className="form-grid">
        {documents.length ? (
          <label>
            <span>Документ-джерело</span>
            <select value={documentId} onChange={(event) => setDocumentId(event.target.value)} disabled={props.disabled || loading}>
              <option value="">Текст без прив’язки до документа</option>
              {documents.map((document) => (
                <option key={document.id} value={document.id}>{document.title}</option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>Сторінка або аркуш</span>
          <input value={page} maxLength={120} onChange={(event) => setPage(event.target.value)} disabled={props.disabled || loading} />
        </label>
        <label className="field-wide">
          <span>Джерело / шифр / посилання</span>
          <input value={sourceReference} maxLength={500} onChange={(event) => setSourceReference(event.target.value)} disabled={props.disabled || loading} />
        </label>
        <label className="field-wide">
          <span>Уривок або транскрипція документа *</span>
          <textarea
            rows={8}
            value={sourceText}
            maxLength={HISTORICAL_PLACE_AI_MAX_SOURCE_CHARS}
            onChange={(event) => setSourceText(event.target.value)}
            disabled={props.disabled || loading}
            placeholder="Вставте фрагмент, у якому згадано назву, тип або адміністративну належність місця"
          />
          <small className="field-hint">
            {sourceText.length.toLocaleString("uk-UA")} / {HISTORICAL_PLACE_AI_MAX_SOURCE_CHARS.toLocaleString("uk-UA")} символів. Передавайте лише потрібний уривок.
          </small>
        </label>
      </div>

      <label className="checkbox-row historical-place-ai-consent">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          disabled={props.disabled || loading}
        />
        <span>Дозволяю передати цей уривок до Google Gemini для одноразового аналізу.</span>
      </label>

      <div className="hint-box">
        AI не визначає координати, КАТОТТГ, OpenStreetMap/Wikidata ID або готовий зв’язок із каталогом.
        Пов’язані місця потрібно зіставити й підтвердити вручну. Один запуск аналізу використовує
        1 ШІ-кредит із місячного ліміту тарифу; власний API-ключ не збільшує цей ліміт.
      </div>

      <div className="historical-place-ai-actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={props.disabled || loading || sourceText.trim().length < 10 || !hasTarget}
          onClick={() => void analyze()}
        >
          {loading ? "Аналізуємо…" : "Знайти історичні відомості"}
        </button>
      </div>

      {error ? <div className="form-error" role="alert">{error}</div> : null}
      {notice ? <div className="hint-box" role="status">{notice}</div> : null}

      {result ? (
        <div className="historical-place-ai-result">
          <header>
            <h4>Пропозиції для перевірки</h4>
            <p>
              {targetAssessmentLabel(result.result.targetAssessment.match)}
              {result.result.targetAssessment.reason ? ` — ${result.result.targetAssessment.reason}` : ""}
            </p>
          </header>

          {result.result.warnings.length ? (
            <WarningList warnings={result.result.warnings} />
          ) : null}

          {result.result.nameSuggestions.length ? (
            <fieldset>
              <legend>Назви й варіанти написання</legend>
              {result.result.nameSuggestions.map((suggestion) => (
                <NameSuggestionCard
                  key={suggestion.suggestionId}
                  suggestion={suggestion}
                  checked={selectedNames.has(suggestion.suggestionId)}
                  onChange={(checked) => setSelectedNames((current) => toggledSet(current, suggestion.suggestionId, checked))}
                />
              ))}
            </fieldset>
          ) : null}

          {result.result.relationSuggestions.length ? (
            <fieldset>
              <legend>Адміністративні, парафіяльні та інші зв’язки</legend>
              {result.result.relationSuggestions.map((suggestion) => (
                <RelationSuggestionCard
                  key={suggestion.suggestionId}
                  suggestion={suggestion}
                  checked={selectedRelations.has(suggestion.suggestionId)}
                  onChange={(checked) => setSelectedRelations((current) => toggledSet(current, suggestion.suggestionId, checked))}
                />
              ))}
            </fieldset>
          ) : null}

          {result.result.placeTypeSuggestion ? (
            <fieldset>
              <legend>Тип місця</legend>
              <label className="historical-place-ai-suggestion">
                <input type="checkbox" checked={selectedPlaceType} onChange={(event) => setSelectedPlaceType(event.target.checked)} />
                <div>
                  <strong>{placeTypeLabel(result.result.placeTypeSuggestion.placeType)}</strong>
                  <EvidenceDetails suggestion={result.result.placeTypeSuggestion} />
                </div>
              </label>
            </fieldset>
          ) : null}

          {!result.result.nameSuggestions.length
            && !result.result.relationSuggestions.length
            && !result.result.placeTypeSuggestion ? (
              <div className="hint-box">У вибраному уривку не знайдено достатньо надійних відомостей про це місце.</div>
            ) : null}

          <div className="historical-place-ai-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={props.disabled || accepting || !hasSelection}
              onClick={() => void acceptSelection()}
            >
              {accepting ? "Передаємо…" : "Передати вибране у чернетку"}
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                setResult(null);
                setSelectedNames(new Set());
                setSelectedRelations(new Set());
                setSelectedPlaceType(false);
                setNotice("");
              }}
            >
              Відхилити результат
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function NameSuggestionCard({
  suggestion,
  checked,
  onChange,
}: {
  suggestion: HistoricalPlaceAiNameSuggestion;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="historical-place-ai-suggestion">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <div>
        <strong>{suggestion.normalizedName || suggestion.originalText}</strong>
        <span>У джерелі: {suggestion.originalText}</span>
        <small>
          {nameTypeLabel(suggestion.nameType)} · {suggestion.languageCode || "мова не визначена"}
          {suggestion.validFromText || suggestion.validToText
            ? ` · ${[suggestion.validFromText, suggestion.validToText].filter(Boolean).join(" — ")}`
            : ""}
        </small>
        <EvidenceDetails suggestion={suggestion} />
      </div>
    </label>
  );
}

function RelationSuggestionCard({
  suggestion,
  checked,
  onChange,
}: {
  suggestion: HistoricalPlaceAiRelationSuggestion;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="historical-place-ai-suggestion">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <div>
        <strong>{suggestion.relatedPlaceOriginalText}</strong>
        <span>{relationKindLabel(suggestion.kind)} · {relationTypeLabel(suggestion.relationType)}</span>
        {suggestion.religion ? <small>Конфесія: {suggestion.religion}</small> : null}
        <small>Після прийняття потрібно окремо знайти й підтвердити це місце в каталозі.</small>
        <EvidenceDetails suggestion={suggestion} />
      </div>
    </label>
  );
}

function EvidenceDetails({
  suggestion,
}: {
  suggestion: {
    sourceQuote: string;
    verifiedQuote: boolean;
    confidence: number;
    warnings: string[];
  };
}) {
  return (
    <div className="historical-place-ai-evidence">
      <blockquote>«{suggestion.sourceQuote}»</blockquote>
      <small>
        {confidenceLabel(suggestion.confidence)} · {suggestion.verifiedQuote ? "цитату знайдено в уривку" : "цитата потребує звірки"}
      </small>
      {suggestion.warnings.length ? <WarningList warnings={suggestion.warnings} /> : null}
    </div>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  return (
    <ul className="historical-place-ai-warnings">
      {warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
    </ul>
  );
}

function toggledSet(current: Set<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(current);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

function confidenceLabel(value: number): string {
  const percent = Math.round(value * 100);
  if (percent >= 80) return `висока впевненість (${percent}%)`;
  if (percent >= 50) return `середня впевненість (${percent}%)`;
  return `низька впевненість (${percent}%)`;
}

function targetAssessmentLabel(value: HistoricalPlaceAiExtractionResponse["result"]["targetAssessment"]["match"]): string {
  if (value === "likely_same") return "AI вважає, що уривок, імовірно, стосується вибраного місця";
  if (value === "different") return "AI виявив ознаки іншого місця — не приймайте дані без звірки";
  return "Зв’язок уривка з вибраним місцем неоднозначний";
}

function relationKindLabel(value: string): string {
  return ({
    administrative_parent: "Адміністративна належність",
    parish: "Парафіяльний зв’язок",
    related: "Інший зв’язок",
  } as Record<string, string>)[value] ?? "Інший зв’язок";
}

function relationTypeLabel(value: string): string {
  return ({
    administrative_parent: "адміністративна одиниця",
    historical_parent: "історична адміністративна одиниця",
    parish_membership: "належність до парафії",
    nearby: "поруч",
    renamed_from: "перейменовано з",
    renamed_to: "перейменовано на",
    absorbed_by: "приєднано до",
    split_from: "виділено з",
    successor: "наступник",
    predecessor: "попередник",
    mentioned_with: "згадано разом",
    other: "інший зв’язок",
  } as Record<string, string>)[value] ?? value;
}

function nameTypeLabel(value: string): string {
  return ({
    historical: "Історична назва",
    official: "Офіційна назва",
    unofficial: "Неофіційна назва",
    local: "Місцева назва",
    pre_reform: "Дореформене написання",
    soviet: "Радянська назва",
    source_error: "Можлива помилка джерела",
    variant: "Варіант написання",
    other: "Інший тип назви",
  } as Record<string, string>)[value] ?? value;
}

function placeTypeLabel(value: string): string {
  return ({
    settlement: "Населений пункт",
    hamlet: "Хутір",
    small_settlement: "Малий населений пункт",
    village: "Село",
    town: "Містечко",
    city: "Місто",
    sloboda: "Слобода",
    colony: "Колонія",
    folwark: "Фільварок",
    estate: "Маєток",
    manor: "Садиба",
    parish: "Парафія",
    volost: "Волость",
    county: "Повіт",
    governorate: "Губернія",
    district: "Район",
    region: "Область",
    community: "Громада",
    country: "Країна",
    cemetery: "Кладовище",
    church: "Церква",
    monastery: "Монастир",
    military_unit: "Військова одиниця",
    other: "Інший тип",
  } as Record<string, string>)[value] ?? value;
}
