import { useEffect, useMemo, useRef, useState } from "react";
import {
  discoverHistoricalPlaces,
  toConfirmedHistoricalPlaceDraft,
} from "../services/historicalPlaceDiscovery.ts";
import type {
  ConfirmedHistoricalPlaceDraft,
  HistoricalPlaceDiscoveryCandidate,
  HistoricalPlaceDiscoveryProvider,
} from "../types/historicalPlaceDiscovery.ts";
import { historicalPlaceTypeLabel } from "../utils/historicalPlaceField.ts";
import "./HistoricalPlaceDiscoveryPanel.css";

interface HistoricalPlaceDiscoveryPanelProps {
  query: string;
  projectId: string;
  disabled?: boolean;
  onConfirmedSuggestion: (draft: ConfirmedHistoricalPlaceDraft) => void;
}

const PROVIDER_LABELS: Record<HistoricalPlaceDiscoveryProvider, string> = {
  katottg: "КАТОТТГ",
  openstreetmap: "OpenStreetMap",
  wikidata: "Wikidata",
  other: "Інше джерело",
};

/**
 * Explicit, review-first external catalogue lookup for the new Place form.
 * Selecting a card changes no parent form field; only the confirmation button
 * emits a clean draft.
 */
export function HistoricalPlaceDiscoveryPanel({
  query,
  projectId,
  disabled = false,
  onConfirmedSuggestion,
}: HistoricalPlaceDiscoveryPanelProps) {
  const [candidates, setCandidates] = useState<HistoricalPlaceDiscoveryCandidate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [searchedQuery, setSearchedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const requestIdRef = useRef(0);
  const currentQueryRef = useRef(query.trim());
  const normalizedQuery = query.trim();
  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? null,
    [candidates, selectedId],
  );

  useEffect(() => {
    currentQueryRef.current = normalizedQuery;
    if (searchedQuery && normalizedQuery !== searchedQuery) {
      requestIdRef.current += 1;
      setCandidates([]);
      setSelectedId("");
      setSearchedQuery("");
      setLoading(false);
      setError("");
      setWarnings([]);
      setMessage("");
    }
  }, [normalizedQuery, searchedQuery]);

  const search = async () => {
    if (disabled || loading) return;
    if (normalizedQuery.length < 2) {
      setError("Спочатку введіть щонайменше два символи основної назви.");
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const requestedQuery = normalizedQuery;
    setLoading(true);
    setError("");
    setWarnings([]);
    setMessage("");
    setCandidates([]);
    setSelectedId("");
    try {
      const result = await discoverHistoricalPlaces({
        query: requestedQuery,
        projectId,
        limit: 8,
      });
      if (requestIdRef.current !== requestId || currentQueryRef.current !== requestedQuery) return;
      const items = result.candidates;
      setCandidates(items);
      setWarnings(result.warnings);
      setSearchedQuery(requestedQuery);
      if (items.length === 1) setSelectedId(items[0]!.id);
    } catch (cause) {
      if (requestIdRef.current !== requestId || currentQueryRef.current !== requestedQuery) return;
      setCandidates([]);
      setWarnings([]);
      setSearchedQuery(requestedQuery);
      setError(cause instanceof Error ? cause.message : "Не вдалося перевірити зовнішні каталоги.");
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  };

  const confirm = () => {
    if (!selected || disabled) return;
    onConfirmedSuggestion(toConfirmedHistoricalPlaceDraft(selected));
    setMessage("Дані кандидата передано до форми. Перевірте поля перед створенням місця.");
  };

  return (
    <section className="historical-place-discovery" aria-labelledby="historical-place-discovery-title">
      <div className="historical-place-discovery__heading">
        <div>
          <span className="eyebrow">Автоматичне наповнення</span>
          <h2 id="historical-place-discovery-title">Знайти населений пункт у каталогах</h2>
          <p>
            Пошук запускається лише кнопкою. Каталоги пропонують готові поля,
            але нічого не змінюють без вашого підтвердження.
          </p>
        </div>
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled || loading || normalizedQuery.length < 2}
          onClick={() => void search()}
        >
          {loading ? "Шукаємо…" : "Знайти у КАТОТТГ, OSM і Wikidata"}
        </button>
      </div>

      <div className="historical-place-discovery__query" aria-live="polite">
        <span>Назва для пошуку</span>
        <strong>{normalizedQuery || "Спочатку введіть основну назву місця"}</strong>
      </div>

      {error ? <div className="historical-place-error" role="alert">{error}</div> : null}
      {warnings.length ? (
        <div className="historical-place-discovery__warnings" role="status">
          {warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      ) : null}
      {message ? <div className="historical-place-success" role="status">{message}</div> : null}
      {!loading && searchedQuery && !error && candidates.length === 0 ? (
        <div className="hint-box" role="status">
          Каталоги не повернули надійних кандидатів. Заповніть місце вручну;
          введені вами дані не буде втрачено.
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <fieldset className="historical-place-discovery__results">
          <legend>Оберіть відповідний населений пункт</legend>
          <p>Звірте сучасну адміністративну належність і координати, особливо для однойменних сіл.</p>
          <div className="historical-place-discovery__cards">
            {candidates.map((candidate) => (
              <label
                key={candidate.id}
                className={candidate.id === selectedId ? "selected" : ""}
              >
                <input
                  type="radio"
                  name="historical-place-discovery-candidate"
                  value={candidate.id}
                  checked={candidate.id === selectedId}
                  onChange={() => {
                    setSelectedId(candidate.id);
                    setMessage("");
                  }}
                />
                <span className="historical-place-discovery__card-body">
                  <span className="historical-place-discovery__card-heading">
                    <strong>{candidate.canonicalName}</strong>
                    <small>{candidate.confidence}% збігу</small>
                  </span>
                  <span>{candidateSummary(candidate)}</span>
                  <span className="historical-place-discovery__providers">
                    {candidate.sources.map((source, index) => (
                      <span className={`provider provider--${source.provider}`} key={`${source.provider}-${source.externalId ?? index}`}>
                        {PROVIDER_LABELS[source.provider]}
                      </span>
                    ))}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {selected ? (
        <section className="historical-place-discovery__preview" aria-label="Поля вибраного кандидата">
          <div>
            <h3>Буде запропоновано для форми</h3>
            <p>Це сучасні каталогові відомості, а не історичні твердження з документа.</p>
          </div>
          <dl>
            <PreviewValue label="Назва" value={selected.canonicalName} />
            <PreviewValue label="Тип" value={historicalPlaceTypeLabel(selected.placeType)} />
            <PreviewValue label="Сучасна належність" value={selected.currentAdmin || "Не визначено"} />
            <PreviewValue label="Країна" value={selected.currentCountry || "Не визначено"} />
            <PreviewValue label="Координати" value={coordinatesLabel(selected)} />
            <PreviewValue label="КАТОТТГ" value={selected.externalIds.katottg || "Не знайдено"} />
            <PreviewValue label="OpenStreetMap" value={selected.externalIds.osm || "Не знайдено"} />
            <PreviewValue label="Wikidata" value={selected.wikidataId || "Не знайдено"} />
            <PreviewValue label="GeoNames" value={selected.geonamesId || "Не знайдено"} />
          </dl>
          {selected.matchReasons.length ? (
            <p className="historical-place-discovery__reasons">
              <strong>Чому запропоновано:</strong> {selected.matchReasons.join("; ")}
            </p>
          ) : null}
          <div className="historical-place-discovery__sources">
            <strong>Джерела й атрибуція</strong>
            {selected.sources.map((source, index) => (
              <div key={`${source.provider}-${source.externalId ?? index}-details`}>
                <span>
                  {source.url ? (
                    <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
                  ) : source.label}
                  {source.externalId ? ` · ${source.externalId}` : ""}
                  {source.datasetVersion ? ` · версія ${source.datasetVersion}` : ""}
                </span>
                {source.attributionUrl ? (
                  <a href={source.attributionUrl} target="_blank" rel="noreferrer">{source.attribution}</a>
                ) : <small>{source.attribution}</small>}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="button button-primary"
            disabled={disabled}
            onClick={confirm}
          >
            Підтвердити й заповнити форму
          </button>
        </section>
      ) : null}
    </section>
  );
}

function PreviewValue({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function candidateSummary(candidate: HistoricalPlaceDiscoveryCandidate): string {
  return [
    historicalPlaceTypeLabel(candidate.placeType),
    candidate.currentAdmin,
    candidate.currentCountry,
    coordinatesLabel(candidate),
  ].filter(Boolean).join(" · ");
}

function coordinatesLabel(candidate: HistoricalPlaceDiscoveryCandidate): string {
  return candidate.latitude !== null && candidate.longitude !== null
    ? `${candidate.latitude.toFixed(6)}, ${candidate.longitude.toFixed(6)}`
    : "Координати не знайдено";
}
