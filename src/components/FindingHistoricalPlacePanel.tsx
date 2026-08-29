import { useEffect, useMemo, useRef, useState } from "react";
import type { PlaceSummary } from "../types/historicalPlaces.ts";
import { historicalPlaceAdministrativeLabel, historicalPlaceTypeLabel } from "../utils/historicalPlaceField.ts";
import {
  confirmFindingHistoricalPlaceDecision,
  currentConfirmedFindingPlace,
  exactFindingEventDate,
  findingHistoricalPlaceContextKey,
  selectFindingHistoricalPlace,
  suggestHistoricalPlacesForFinding,
  type FindingDocumentPlaceState,
  type FindingHistoricalPlaceContext,
  type FindingHistoricalPlaceDecision,
} from "../services/findingHistoricalPlaceWorkflow.ts";

interface FindingHistoricalPlacePanelProps extends FindingHistoricalPlaceContext {
  decision: FindingHistoricalPlaceDecision | null;
  persistedState: FindingDocumentPlaceState | null;
  loadPending: boolean;
  loadError: string;
  onRetryLoad: () => void;
  onDecisionChange: (decision: FindingHistoricalPlaceDecision | null) => void;
}

export function FindingHistoricalPlacePanel({
  projectId,
  documentId,
  originalText,
  eventDate,
  decision,
  persistedState,
  loadPending,
  loadError,
  onRetryLoad,
  onDecisionChange,
}: FindingHistoricalPlacePanelProps) {
  const context = useMemo<FindingHistoricalPlaceContext>(() => ({
    projectId,
    documentId,
    originalText,
    eventDate,
  }), [documentId, eventDate, originalText, projectId]);
  const contextKey = findingHistoricalPlaceContextKey(context);
  const currentDecision = decision?.contextKey === contextKey ? decision : null;
  const confirmedPlace = currentConfirmedFindingPlace(context, decision);
  const [query, setQuery] = useState(originalText);
  const [candidates, setCandidates] = useState<PlaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const previousOriginalText = useRef(originalText);

  useEffect(() => {
    if (decision && decision.contextKey !== contextKey) {
      // A confirmed identification belongs to one exact source-text/date/
      // document snapshot.  Clear it permanently instead of letting it become
      // active again if the user later restores an older field value.
      onDecisionChange(null);
    }
  }, [contextKey, decision, onDecisionChange]);

  useEffect(() => {
    const previous = previousOriginalText.current;
    previousOriginalText.current = originalText;
    setQuery((current) => !current.trim() || current === previous ? originalText : current);
  }, [originalText]);

  useEffect(() => {
    const normalized = query.trim();
    if (!projectId.trim() || normalized.length < 2) {
      setCandidates([]);
      setLoading(false);
      setSearched(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void suggestHistoricalPlacesForFinding({ ...context, query: normalized }, controller.signal)
        .then((places) => {
          if (controller.signal.aborted) return;
          setCandidates(places);
          setSearched(true);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setCandidates([]);
          setSearched(true);
          setError(cause instanceof Error ? cause.message : "Не вдалося знайти історичні місця.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [context, projectId, query]);

  const exactDate = exactFindingEventDate(eventDate);
  const persistedContextMatches = Boolean(
    persistedState?.documentMatchesFinding
    && persistedState.link.documentId === documentId
    && persistedState.link.originalText === originalText,
  );
  const persistedDecisionMatches = Boolean(
    persistedContextMatches
    && currentDecision?.place.id === persistedState?.link.placeId
    && currentDecision?.confirmed === (persistedState?.link.resolutionStatus === "confirmed"),
  );
  const status = loadPending
    ? { label: "Завантаження…", className: "unresolved" }
    : loadError
      ? { label: "Помилка перевірки", className: "error" }
      : confirmedPlace && persistedDecisionMatches
        ? { label: "Збережено", className: "confirmed" }
        : confirmedPlace
          ? { label: "Підтверджено", className: "confirmed" }
          : persistedDecisionMatches
            ? { label: "Потребує перевірки", className: "unresolved" }
            : persistedState
              ? { label: "Буде очищено", className: "unresolved" }
              : { label: "Не визначено", className: "unresolved" };
  const canConfirm = Boolean(
    documentId.trim()
    && originalText.trim()
    && currentDecision?.place.id,
  );

  return (
    <section className="finding-historical-place-panel" aria-labelledby="finding-historical-place-title">
      <div className="finding-historical-place-heading">
        <div>
          <span className="eyebrow">Історичне місце</span>
          <h3 id="finding-historical-place-title">Зіставити місце з каталогом</h3>
          <p>Система лише пропонує варіанти. Прив’язка створюється після вашого окремого підтвердження та збереження знахідки.</p>
        </div>
        <span className={`finding-place-status ${status.className}`}>{status.label}</span>
      </div>

      {loadError ? (
        <div className="finding-place-load-error form-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="button button-secondary" onClick={onRetryLoad}>Повторити</button>
        </div>
      ) : null}
      {!loadError && persistedState && !persistedDecisionMatches ? (
        <div className="finding-place-persisted-warning" role="status">
          {confirmedPlace
            ? "Після збереження попередню прив’язку буде замінено на щойно підтверджене місце."
            : "Після збереження попередню прив’язку буде прибрано. Точний текст у знахідці залишиться без змін."}
        </div>
      ) : null}

      {!originalText.trim() ? (
        <div className="hint-box">Спочатку введіть точне написання у полі «Населений пункт» або застосуйте результат транскрипції.</div>
      ) : (
        <>
          <div className="finding-place-source-text">
            <strong>Точний текст із запису</strong>
            <span>{originalText}</span>
            <small>Цей текст не змінюється під час вибору нормалізованого Place.</small>
          </div>
          <div className="finding-place-search-row">
            <label>
              <span>Пошук у каталозі</span>
              <input
                type="search"
                value={query}
                autoComplete="off"
                placeholder="Введіть сучасну або історичну назву"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div>
              <span>Контекст дати</span>
              <strong>{exactDate || "Точну дату не вказано"}</strong>
              {!exactDate && eventDate.trim() ? <small>Неповну дату не перетворюємо на вигадане число.</small> : null}
            </div>
          </div>

          {loading ? <p className="finding-place-search-state" role="status">Шукаємо можливі місця…</p> : null}
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          {!loading && !error && searched && candidates.length === 0 ? (
            <div className="hint-box">Збігів не знайдено. Залиште місце невизначеним або змініть лише пошуковий запит — точний текст джерела залишиться незмінним.</div>
          ) : null}
          {!loading && candidates.length > 0 ? (
            <div className="finding-place-candidates" role="listbox" aria-label="Ймовірні історичні місця">
              <p>{candidates.length === 1 ? "Знайдено один варіант, але його все одно потрібно підтвердити." : `Знайдено ${candidates.length} варіантів. Оберіть лише після перевірки.`}</p>
              {candidates.map((place) => {
                const selected = currentDecision?.place.id === place.id;
                return (
                  <button
                    key={place.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={selected ? "selected" : ""}
                    onClick={() => onDecisionChange(selectFindingHistoricalPlace(context, place))}
                  >
                    <strong>{place.displayName || place.canonicalName}</strong>
                    <span>{placeDetails(place)}</span>
                    {place.matchedName && place.matchedName !== place.displayName ? <small>Збіг: {place.matchedName}</small> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {currentDecision ? (
            <div className="finding-place-decision">
              <div>
                <strong>{currentDecision.place.displayName || currentDecision.place.canonicalName}</strong>
                <span>{placeDetails(currentDecision.place)}</span>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={currentDecision.confirmed}
                  disabled={!documentId.trim() || loadPending || Boolean(loadError)}
                  onChange={(event) => onDecisionChange(event.target.checked
                    ? confirmFindingHistoricalPlaceDecision(context, currentDecision)
                    : { ...currentDecision, confirmed: false })}
                />
                <span>Підтверджую, що це саме те місце, яке написано в документі.</span>
              </label>
              {!documentId.trim() ? <small>Спочатку оберіть пов’язаний документ — без нього прив’язка не створюється.</small> : null}
            </div>
          ) : null}

          <div className="finding-place-actions">
            <button
              type="button"
              className="button button-ghost"
              disabled={loadPending || Boolean(loadError)}
              onClick={() => onDecisionChange(null)}
            >
              Залишити невизначеним
            </button>
            <span>{canConfirm && currentDecision?.confirmed
              ? "Після збереження буде створено підтверджений зв’язок документа з Place."
              : "Без підтвердження жодного зв’язку з Place не буде створено."}</span>
          </div>
        </>
      )}
    </section>
  );
}

function placeDetails(place: PlaceSummary): string {
  return [
    historicalPlaceTypeLabel(place.placeType),
    historicalPlaceAdministrativeLabel(place),
    place.latitude !== null && place.longitude !== null
      ? `${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}`
      : "",
  ].filter(Boolean).join(" · ") || "Додаткові відомості відсутні";
}
