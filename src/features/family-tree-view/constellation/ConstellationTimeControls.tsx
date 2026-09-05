import { useEffect, useId, useState } from "react";
import { CONSTELLATION_LIFE_LABELS, type ConstellationTimeModel, type ConstellationTimeSlice } from "./constellationTime.ts";

export function ConstellationTimeControls({ model, slice, onYearChange }: {
  model: ConstellationTimeModel; slice: ConstellationTimeSlice; onYearChange: (year: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(slice.year));
  useEffect(() => setDraft(String(slice.year)), [slice.year]);
  const previous = model.years.filter(year => year < slice.year).at(-1);
  const next = model.years.find(year => year > slice.year);
  const commit = () => {
    if (!model.range) return;
    const value = Number(draft);
    if (!draft.trim() || !Number.isInteger(value)) { setDraft(String(slice.year)); return; }
    const year = Math.max(model.range.min, Math.min(model.range.max, value));
    setDraft(String(year)); onYearChange(year);
  };
  return <section className="constellation-time-controls" aria-label="Подорож у часі">
    <div className="constellation-time-slider">
      <label className="constellation-year-field" htmlFor={id}>Рік зрізу<input id={id} type="number" inputMode="numeric" min={model.range?.min} max={model.range?.max}
        value={draft} disabled={!model.range} onChange={event => setDraft(event.target.value)} onBlur={commit}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} /></label>
      <button type="button" aria-label="Попередній рік із подіями" title="Попередній рік із подіями" disabled={previous === undefined} onClick={() => previous !== undefined && onYearChange(previous)}>←</button>
      <div className="constellation-year-track">
        <input type="range" aria-label="Рік на шкалі часу" aria-valuetext={`${slice.year} рік`} min={model.range?.min ?? slice.year} max={model.range?.max ?? slice.year}
          step={1} value={slice.year} disabled={!model.range} onChange={event => onYearChange(Number(event.target.value))} />
        <div><span>{model.range?.min ?? "—"}</span><span>{model.range?.max ?? "—"}</span></div>
      </div>
      <button type="button" aria-label="Наступний рік із подіями" title="Наступний рік із подіями" disabled={next === undefined} onClick={() => next !== undefined && onYearChange(next)}>→</button>
    </div>
    <div className="constellation-time-legend" aria-label="Особи за роком">
      {(["alive", "deceased", "future", "unknown"] as const).map(state => <span key={state}><i className={`time-state-${state}`} aria-hidden="true" />{CONSTELLATION_LIFE_LABELS[state]} <b>{slice.counts[state]}</b></span>)}
      <span><i className="time-state-event" aria-hidden="true" />Подія / орієнтир року</span>
    </div>
    <p>{model.range ? "Зріз за роком, не за днем. Немає дати смерті ≠ особа жива. Невизначені дати не приховуємо; родинні зв’язки зберігаємо." : "У завантаженому оточенні немає розпізнаних дат. Додайте дати в картки осіб — шкала стане доступною."}</p>
  </section>;
}

export function ConstellationTimeDetails({ model, slice, selectedId, nameOf, onSelect, onYearChange }: {
  model: ConstellationTimeModel; slice: ConstellationTimeSlice; selectedId: string;
  nameOf: (id: string) => string; onSelect: (id: string) => void; onYearChange: (year: number) => void;
}) {
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [limit, setLimit] = useState(30);
  const [historyLimit, setHistoryLimit] = useState(30);
  useEffect(() => setLimit(30), [slice.year, selectedId, selectedOnly]);
  useEffect(() => setHistoryLimit(30), [selectedId]);
  const person = model.persons.get(selectedId);
  const state = slice.persons.get(selectedId);
  const events = slice.events.filter(({ event }) => !selectedOnly || event.personIds.includes(selectedId));
  const history = [...(person?.events ?? [])].sort((a, b) => (a.date.reference ?? Infinity) - (b.date.reference ?? Infinity));
  const uncertainCount = model.events.filter(event => event.date.precision !== "exact").length;
  return <section className="constellation-time-details" aria-label="Події та місця у часі">
    <h4>{slice.year} · вибрана особа</h4>
    <p className="constellation-time-person-state" role="status"><i className={`time-state-${state?.state ?? "unknown"}`} aria-hidden="true" />
      {person?.masked ? "Часові дані особи приховано правилами доступу" : state?.conflict ? "Суперечливі дати — перевірте картку особи" : CONSTELLATION_LIFE_LABELS[state?.state ?? "unknown"]}</p>
    {state?.lastPlaces.length ? <div className="constellation-time-place"><strong>Останні датовані згадки місця до цього року включно</strong>
      <ul>{state.lastPlaces.map(event => <li key={event.id}><span>{event.place}</span><small>{event.date.text} · {event.title}</small></li>)}</ul>
      <small>Це місця подій, а не підтверджена адреса проживання у вибраному році.</small>
    </div> : <p>Немає датованих згадок місця до вибраного року.</p>}
    <div className="constellation-time-events">
      <h4>Події {slice.year} року <span>({events.length})</span></h4>
      <label className="constellation-check"><input type="checkbox" checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)} />Лише вибрана особа</label>
      {!events.length ? <p>Подій на цей рік не знайдено. Стрілками біля шкали перейдіть до наступної або попередньої дати.</p> : null}
      <ul>{events.slice(0, limit).map(({ event, certainty }) => <li key={event.id}>
        <button type="button" onClick={() => onSelect(event.personIds.includes(selectedId) ? selectedId : event.personIds[0]!)}>
          <small>{event.date.text}{certainty === "possible" ? " · можливий рік у межах періоду" : certainty === "approximate" ? " · орієнтир, не точний рік" : ""}</small>
          <strong>{event.title}</strong><span>{event.personIds.map(nameOf).join(" · ")}</span>{event.place ? <span>{event.place}</span> : null}
        </button>
      </li>)}</ul>
      {events.length > limit ? <button type="button" onClick={() => setLimit(value => value + 30)}>Ще події цього року</button> : null}
      <small>{uncertainCount} подій мають неповні, приблизні або нерозпізнані дати. Вони залишаються в історії особи, навіть якщо не потрапляють на цей рік.</small>
    </div>
    <details className="constellation-time-history">
      <summary>Усі події вибраної особи ({history.length})</summary>
      <ul>{history.slice(0, historyLimit).map(event => <li key={event.id}>
        <strong>{event.title}</strong><span>{event.date.text || "Дата не вказана"}</span>{event.place ? <span>{event.place}</span> : null}
        {event.date.reference !== undefined ? <button type="button" onClick={() => onYearChange(event.date.reference!)}>До {event.date.reference} року{event.date.precision !== "exact" ? " (орієнтир)" : ""}</button> : null}
      </li>)}</ul>
      {!history.length ? <p>Доступних подій немає.</p> : null}
      {history.length > historyLimit ? <button type="button" onClick={() => setHistoryLimit(value => value + 30)}>Ще з історії особи</button> : null}
    </details>
  </section>;
}
