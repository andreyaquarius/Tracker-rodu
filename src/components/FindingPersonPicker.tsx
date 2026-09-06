import { useEffect, useId, useMemo, useState } from "react";
import type { Person } from "../types";
import {
  searchProjectPersonNameSuggestions,
  type ProjectPersonNameSuggestion,
} from "../services/projectPersonNames.ts";
import {
  buildFindingPersonSearchIndex,
  findPeopleForFinding,
  mergeFindingPersonMatches,
  suggestPeopleForFinding,
} from "../utils/findingPersonSearch.ts";
import "./findingPersonPicker.css";

const PAGE_SIZE = 20;
const SUGGESTION_LIMIT = 6;

export interface FindingPersonPickerProps {
  persons: readonly Person[];
  projectId: string;
  originalName: string;
  normalizedName: string;
  selectedId: string;
  disabled?: boolean;
  required?: boolean;
  showSelectedCard?: boolean;
  autoFocus?: boolean;
  onSelect: (personId: string) => void;
  /** Read-only dependency; production uses the existing project-scoped RPC. */
  searchHistoricalNames?: typeof searchProjectPersonNameSuggestions;
}

export function FindingPersonPicker({
  persons, projectId, originalName, normalizedName, selectedId, disabled = false, required = true,
  showSelectedCard = true, autoFocus = false,
  onSelect, searchHistoricalNames = searchProjectPersonNameSuggestions,
}: FindingPersonPickerProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [showAll, setShowAll] = useState(false);
  const [remote, setRemote] = useState<{
    key: string; suggestions: ProjectPersonNameSuggestion[]; loading: boolean; failed: boolean;
  }>({ key: "", suggestions: [], loading: false, failed: false });
  const index = useMemo(() => buildFindingPersonSearchIndex(persons), [persons]);
  const sourceNames = useMemo(() => [originalName, normalizedName], [originalName, normalizedName]);
  const queries = useMemo(() => [...new Set((query.trim() ? [query] : sourceNames)
    .map((value) => value.trim()).filter((value) => value.length >= 2))], [query, sourceNames]);
  const requestKey = JSON.stringify([projectId, queries]);
  const canLookUp = Boolean(projectId && queries.length && index.length && !disabled);
  const historical = remote.key === requestKey ? remote.suggestions : [];
  const loading = canLookUp && (remote.key !== requestKey || remote.loading);
  const failed = remote.key === requestKey && remote.failed;
  const selected = index.find((entry) => entry.person.id === selectedId);
  const automatic = !query.trim() && !showAll;
  const matches = useMemo(() => mergeFindingPersonMatches(
    automatic ? suggestPeopleForFinding(index, sourceNames) : findPeopleForFinding(index, query),
    historical,
    index,
  ), [automatic, index, sourceNames, query, historical]);
  const visible = matches.slice(0, automatic ? SUGGESTION_LIMIT : limit);

  useEffect(() => {
    if (!canLookUp) return;
    const controller = new AbortController();
    setRemote({ key: requestKey, suggestions: [], loading: true, failed: false });
    const timer = window.setTimeout(() => {
      void Promise.allSettled(queries.map((value) => searchHistoricalNames({
        projectId, query: value, limit: 10, signal: controller.signal,
      }))).then((results) => {
        if (controller.signal.aborted) return;
        setRemote({
          key: requestKey,
          suggestions: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
          loading: false,
          failed: results.some((result) => result.status === "rejected"),
        });
      });
    }, 320);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [canLookUp, projectId, queries, requestKey, searchHistoricalNames]);

  return (
    <section className="finding-person-picker" aria-label="Вибір наявної особи">
      <label htmlFor={`${id}-search`}>
        <span>Пошук наявної особи{required ? " *" : ""}</span>
        <input
          id={`${id}-search`}
          type="search"
          value={query}
          disabled={disabled}
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder="Ім’я, прізвище, рік або місце…"
          aria-describedby={`${id}-hint`}
          onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); setShowAll(false); }}
          onKeyDown={(event) => {
            // Enter in a search field must never submit the surrounding finding.
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </label>
      <p id={`${id}-hint`} className="finding-person-picker__hint">
        Пошук серед {index.length.toLocaleString("uk-UA")} доступних осіб. Підказки не підтверджують
        тотожність людей — виберіть картку самостійно.
      </p>
      {selected && showSelectedCard ? (
        <div className="finding-person-picker__selected" role="status">
          <div><small>Вибрано</small><strong>{selected.label}</strong>
            {selected.details ? <span>{selected.details}</span> : null}</div>
          <button type="button" className="button button-secondary" disabled={disabled}
            onClick={() => onSelect("")}>Скасувати вибір</button>
        </div>
      ) : !selected && selectedId ? <p role="alert">Вибрана особа більше недоступна. Оберіть іншу картку.</p> : null}
      <div className="finding-person-picker__heading">
        <strong>{automatic ? "Можливі збіги зі знахідкою" : "Результати пошуку"}</strong>
        <span role="status" aria-live="polite">
          {loading ? "Перевіряємо історичні імена…" : `Знайдено: ${matches.length}`}
        </span>
      </div>
      {failed ? <p className="finding-person-picker__hint" role="status">
        Історичні підказки тимчасово недоступні. Пошук серед завантажених осіб працює.
      </p> : null}
      {visible.length ? (
        <ul className="finding-person-picker__results">
          {visible.map(({ entry, reason, matchedName }) => (
            <li key={entry.person.id}>
              <button type="button" disabled={disabled}
                className="finding-person-picker__option"
                aria-pressed={selectedId === entry.person.id}
                onClick={() => onSelect(entry.person.id)}>
                <span className="finding-person-picker__identity">
                  <strong>{entry.label}</strong>
                  {entry.details ? <span>{entry.details}</span> : <span>Дати й місце не вказані</span>}
                  <small>{reason}{matchedName && matchedName !== entry.label ? `: ${matchedName}` : ""}</small>
                </span>
                <span className="finding-person-picker__action">
                  {selectedId === entry.person.id ? "✓ Вибрано" : "Вибрати"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="finding-person-picker__empty">
        {!index.length ? "У цьому дослідженні немає доступних карток. Можна створити нову особу."
          : loading ? "Місцевих збігів немає. Очікуємо історичні підказки."
            : automatic ? "Можливих збігів не знайдено. Спробуйте пошук за частиною імені або іншим написанням."
              : "За цим запитом нікого не знайдено. Спробуйте коротший запит або інший варіант написання."}
      </p>}
      <div className="finding-person-picker__footer">
        {automatic ? (
          <button type="button" className="button button-secondary" disabled={disabled || !index.length}
            onClick={() => { setShowAll(true); setLimit(PAGE_SIZE); }}>Переглянути всіх доступних осіб</button>
        ) : matches.length > visible.length ? (
          <button type="button" className="button button-secondary" disabled={disabled}
            onClick={() => setLimit((current) => current + PAGE_SIZE)}>Показати ще</button>
        ) : null}
        {matches.length > visible.length ? <small>Показано {visible.length} із {matches.length}</small> : null}
      </div>
    </section>
  );
}
