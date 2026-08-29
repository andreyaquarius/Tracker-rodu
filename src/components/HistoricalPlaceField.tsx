import { useEffect, useId, useRef, useState } from "react";
import {
  createProjectPlace,
  searchHistoricalPlaces,
} from "../services/historicalPlacesService";
import type {
  HistoricalPlaceFieldValue,
  HistoricalPlaceTemporalContext,
  PlaceSummary,
} from "../types/historicalPlaces";
import {
  changeHistoricalPlaceOriginalText,
  historicalPlaceAdministrativeLabel,
  historicalPlaceOptionLabel,
  historicalPlaceTypeLabel,
  selectHistoricalPlace,
} from "../utils/historicalPlaceField";

interface HistoricalPlaceFieldProps {
  value: HistoricalPlaceFieldValue;
  onChange: (value: HistoricalPlaceFieldValue) => void;
  projectId: string;
  atDate?: string | null;
  temporalContext?: HistoricalPlaceTemporalContext | null;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  allowInlineCreate?: boolean;
  helpText?: string;
  onCreateRequested?: (originalText: string) => void;
}

/**
 * Date-aware catalogue selector. It never mutates the exact source wording:
 * choosing a canonical place only fills placeId/place beside originalText.
 */
export function HistoricalPlaceField({
  value,
  onChange,
  projectId,
  atDate,
  temporalContext,
  label = "Місце в джерелі",
  placeholder = "Почніть вводити історичну або сучасну назву",
  disabled = false,
  allowInlineCreate = true,
  helpText = "Написання з джерела зберігається окремо від вибраного місця й не нормалізується.",
  onCreateRequested,
}: HistoricalPlaceFieldProps) {
  const listId = useId();
  const safeListId = listId.replace(/[^a-zA-Z0-9_-]/g, "");
  const requestRef = useRef(0);
  const [items, setItems] = useState<PlaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState("settlement");
  const [creating, setCreating] = useState(false);
  const [dismissedQuery, setDismissedQuery] = useState("");
  const query = value.originalText.trim();

  useEffect(() => {
    if (disabled || query.length < 2) {
      setItems([]);
      setLoading(false);
      setError("");
      setActiveIndex(-1);
      return;
    }
    const requestId = ++requestRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void searchHistoricalPlaces(
        { query, projectId, atDate: atDate ?? null, temporalContext, limit: 8 },
        controller.signal,
      ).then((results) => {
        if (requestRef.current === requestId) {
          setItems(results);
          setActiveIndex(results.length ? 0 : -1);
        }
      }).catch((cause: unknown) => {
        if (controller.signal.aborted || requestRef.current !== requestId) return;
        setItems([]);
        setError(cause instanceof Error ? cause.message : "Не вдалося знайти місце.");
      }).finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [atDate, disabled, projectId, query, temporalContext]);

  useEffect(() => {
    if (!createOpen) setCreateName(value.originalText.trim());
  }, [createOpen, value.originalText]);

  const choose = (place: PlaceSummary) => {
    setItems([]);
    setActiveIndex(-1);
    setCreateOpen(false);
    setDismissedQuery("");
    onChange(selectHistoricalPlace(value, place));
  };

  const openCreate = () => {
    if (onCreateRequested) {
      onCreateRequested(value.originalText);
      return;
    }
    setCreateName(value.originalText.trim());
    setCreateOpen(true);
  };

  const createUnresolved = async () => {
    if (disabled || creating || !createName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const place = await createProjectPlace({
        projectId,
        canonicalName: createName.trim(),
        placeType: createType,
        needsIdentification: true,
        languageCode: "uk",
        names: [{
          name: createName.trim(),
          originalText: value.originalText,
          languageCode: "uk",
          nameType: "historical",
          confidence: 25,
        }],
      });
      choose(place);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не вдалося створити місце.");
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showResults) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
      event.preventDefault();
      setActiveIndex((current) => {
        if (event.key === "Home") return 0;
        if (event.key === "End") return items.length - 1;
        if (event.key === "ArrowDown") return (Math.max(current, -1) + 1) % items.length;
        return current <= 0 ? items.length - 1 : current - 1;
      });
      return;
    }
    if (event.key === "Enter" && activeIndex >= 0 && items[activeIndex]) {
      event.preventDefault();
      choose(items[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setItems([]);
      setActiveIndex(-1);
      setCreateOpen(false);
      setDismissedQuery(query);
    }
  };

  const showResults = !disabled
    && query.length >= 2
    && !value.placeId
    && !createOpen
    && dismissedQuery !== query;
  const canCreate = allowInlineCreate || Boolean(onCreateRequested);
  return (
    <div className="historical-place-field">
      <label>
        <span>{label}</span>
        <input
          value={value.originalText}
          placeholder={placeholder}
          disabled={disabled}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={safeListId}
          aria-expanded={showResults}
          aria-activedescendant={activeIndex >= 0 ? `${safeListId}-option-${activeIndex}` : undefined}
          onKeyDown={handleKeyDown}
          onChange={(event) => {
            setDismissedQuery("");
            onChange(changeHistoricalPlaceOriginalText(value, event.target.value));
          }}
        />
      </label>
      {value.place || value.placeId ? (
        <div className="historical-place-selection">
          <div>
            <strong>{value.place?.displayName || value.placeDisplayName || "Прив’язано до каталогу місць"}</strong>
            <small>{value.place
              ? historicalPlaceOptionLabel(value.place)
              : "Канонічне місце збережене; повні відомості доступні у профілі місця."}</small>
          </div>
          {!disabled ? (
            <button
              type="button"
              onClick={() => onChange({
                ...value,
                placeId: null,
                place: null,
                placeDisplayName: "",
              })}
            >
              Змінити прив’язку
            </button>
          ) : null}
        </div>
      ) : null}
      {showResults ? (
        <div id={safeListId} className="historical-place-options" role="listbox">
          {loading ? <div className="historical-place-option-state">Шукаємо місця…</div> : null}
          {!loading && items.map((place) => (
            <button
              type="button"
              role="option"
              id={`${safeListId}-option-${items.indexOf(place)}`}
              aria-selected={activeIndex === items.indexOf(place)}
              className={activeIndex === items.indexOf(place) ? "active" : ""}
              key={place.id}
              onMouseEnter={() => setActiveIndex(items.indexOf(place))}
              onClick={() => choose(place)}
            >
              <strong>{place.displayName}</strong>
              <span>{[historicalPlaceTypeLabel(place.placeType), historicalPlaceAdministrativeLabel(place)].filter(Boolean).join(" · ")}</span>
              {place.names.length > 0 ? (
                <small>
                  Варіанти: {place.names.slice(0, 3).map((name) => name.originalText).join(", ")}
                </small>
              ) : null}
            </button>
          ))}
          {!loading && !error && items.length === 0 ? (
            <div className="historical-place-option-state">
              <span>Збігів не знайдено. Текст можна залишити без прив’язки.</span>
              {canCreate ? <button type="button" onClick={openCreate}>Створити невизначене місце</button> : null}
            </div>
          ) : null}
          {error ? <div className="historical-place-option-state error">{error}</div> : null}
        </div>
      ) : null}
      {createOpen && !value.placeId ? (
        <section className="historical-place-inline-create" aria-label="Створення невизначеного історичного місця">
          <strong>Нове місце, яке потребує перевірки</strong>
          <p>Точне написання «{value.originalText}» залишиться окремо від назви каталогу.</p>
          <label>
            <span>Робоча назва</span>
            <input value={createName} maxLength={500} onChange={(event) => setCreateName(event.target.value)} />
          </label>
          <label>
            <span>Тип місця</span>
            <select value={createType} onChange={(event) => setCreateType(event.target.value)}>
              <option value="settlement">Населений пункт</option>
              <option value="hamlet">Хутір</option>
              <option value="small_settlement">Присілок</option>
              <option value="village">Село</option>
              <option value="town">Містечко</option>
              <option value="city">Місто</option>
              <option value="parish">Парафія</option>
              <option value="other">Інше</option>
            </select>
          </label>
          <div className="historical-place-inline-create-actions">
            <button type="button" className="button button-secondary" onClick={() => setCreateOpen(false)}>Скасувати</button>
            <button type="button" className="button button-primary" disabled={creating || !createName.trim()} onClick={() => void createUnresolved()}>
              {creating ? "Створюємо…" : "Створити й прив’язати"}
            </button>
          </div>
        </section>
      ) : null}
      {helpText ? <small className="field-hint">{helpText}</small> : null}
    </div>
  );
}
