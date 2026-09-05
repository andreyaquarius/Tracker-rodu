import { useEffect, useId, useMemo, useState } from "react";
import { constellationCount, constellationPeopleCount, constellationRecordCount, isConstellationMigration, searchConstellationPlaces, type ConstellationPlace, type ConstellationPlacesModel } from "./constellationPlaces.ts";

export function ConstellationPlacesControls({ model, onlyPerson, showAllLinks, onOnlyPersonChange, onShowAllLinksChange, onSelectPlace }: {
  model: ConstellationPlacesModel; onlyPerson: boolean; showAllLinks: boolean;
  onOnlyPersonChange: (value: boolean) => void; onShowAllLinksChange: (value: boolean) => void; onSelectPlace: (id: string) => void;
}) {
  const id = useId(); const [query, setQuery] = useState("");
  const results = useMemo(() => searchConstellationPlaces(model, query).slice(0, 10), [model, query]);
  const choose = (id: string) => { onSelectPlace(id); setQuery(""); };
  return <section className="constellation-places-controls" aria-label="Керування місцями">
    <div className="constellation-places-control-row">
      <div className="constellation-search">
        <label htmlFor={id}>Знайти місце або історичну назву</label>
        <input id={id} type="search" value={query} placeholder="Населений пункт…" autoComplete="off" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && results[0]) { event.preventDefault(); choose(results[0].id); }
          if (event.key === "Escape") { event.stopPropagation(); setQuery(""); }
        }} />
        {query.trim() ? <div className="constellation-search-results" aria-label="Знайдені місця">
          {results.map(place => <button key={place.id} type="button" onClick={() => choose(place.id)}><strong>{place.label}</strong>
            <small>{constellationPeopleCount(place.personIds.length)} · {place.canonicalId ? `уточнене місце · ${place.canonicalId.slice(-8)}` : "неуточнений запис"}</small>
          </button>)}{!results.length ? <p>Місць не знайдено.</p> : null}
        </div> : null}
      </div>
      <label className="constellation-check"><input type="checkbox" checked={onlyPerson} onChange={event => onOnlyPersonChange(event.target.checked)} />Лише місця вибраної особи</label>
      <label className="constellation-check"><input type="checkbox" disabled={onlyPerson} checked={showAllLinks} onChange={event => onShowAllLinksChange(event.target.checked)} />Переходи інших осіб</label>
    </div>
    <p>Усі роки · {constellationCount(model.places.size, ["група місць", "групи місць", "груп місць"])} · {constellationPeopleCount(model.personCount)} із місцями · {constellationPeopleCount(model.peopleWithoutPlaces)} без місць{model.maskedPeople ? ` · ${constellationPeopleCount(model.maskedPeople)} із прихованими даними` : ""}. Схема не передає географічні відстані та напрямки.</p>
  </section>;
}

export function ConstellationPlacesDetails({ model, place, selectedPersonId, nameOf, onSelectPlace, onSelectPerson, onOpenPerson, onMakeCentral, onYearSelect }: {
  model: ConstellationPlacesModel; place?: ConstellationPlace; selectedPersonId: string;
  nameOf: (id: string) => string; onSelectPlace: (id: string) => void; onSelectPerson: (id: string) => void;
  onOpenPerson?: (id: string) => void; onMakeCentral?: (id: string) => void; onYearSelect: (year: number, personId: string) => void;
}) {
  const [peopleLimit, setPeopleLimit] = useState(30); const [eventsLimit, setEventsLimit] = useState(25);
  const [historyLimit, setHistoryLimit] = useState(30); const [placesLimit, setPlacesLimit] = useState(40);
  const [peopleQuery, setPeopleQuery] = useState(""); const [placesQuery, setPlacesQuery] = useState("");
  useEffect(() => { setPeopleLimit(30); setEventsLimit(25); setPeopleQuery(""); }, [place?.id]);
  useEffect(() => setHistoryLimit(30), [selectedPersonId]);
  const journey = model.journeys.get(selectedPersonId);
  const placeList = useMemo(() => searchConstellationPlaces(model, placesQuery), [model, placesQuery]);
  const people = (place?.personIds ?? []).filter(id => nameOf(id).toLocaleLowerCase("uk").includes(peopleQuery.toLocaleLowerCase("uk").trim()));
  const selectedName = nameOf(selectedPersonId);
  return <div className="constellation-places-details">
    <span className="constellation-eyebrow">Місця роду</span>
    <h3>{place?.label ?? "Виберіть місце"}</h3>
    {place ? <>
      <span className="constellation-place-kind">{place.canonicalId ? "Уточнене місце" : "Група за однаковим написанням"}</span>
      <p>{constellationPeopleCount(place.personIds.length)} · {constellationRecordCount(place.events.length)} подій{place.migrationEventCount ? ` · ${constellationCount(place.migrationEventCount, ["міграційна подія", "міграційні події", "міграційних подій"])}` : ""}</p>
      {!place.canonicalId ? <p className="constellation-place-note">Однакові назви можуть стосуватися різних населених пунктів. Для точного об’єднання уточніть місце в події особи.</p> : null}
      <details className="constellation-place-aliases"><summary>Написання у джерелах ({place.aliases.length})</summary>
        <ul>{place.aliases.map(alias => <li key={alias}>{alias}</li>)}</ul>{place.canonicalId ? <small>Ідентифікатор місця: {place.canonicalId}</small> : null}
      </details>
    </> : <p>Додайте місця в події осіб або оберіть іншу особу. Довільні координати не підставляються.</p>}
    <div className="constellation-place-person">
      <span className="constellation-eyebrow">Підсвічена особа</span><h4>{selectedName}</h4>
      <div className="constellation-person-actions">
        {onOpenPerson ? <button type="button" className="constellation-primary" onClick={() => onOpenPerson(selectedPersonId)}>Відкрити картку особи</button> : null}
        {onMakeCentral ? <button type="button" onClick={() => onMakeCentral(selectedPersonId)}>Зробити центральною</button> : null}
      </div>
      <h4>Послідовність місць у записах</h4>
      <small>Стрілки з’єднують датовані згадки. Вони не доводять прямого переїзду: могли бути інші місця, подорожі та прогалини в джерелах.</small>
      {journey?.transitions.length ? <ol className="constellation-place-transitions">{journey.transitions.slice(0, historyLimit).map(transition => <li key={transition.id}>
        <button type="button" onClick={() => onSelectPlace(transition.source)}>{model.places.get(transition.source)?.label}<small>{transition.from.event.date.text} · {transition.from.event.title}</small></button>
        <span aria-hidden="true">↓</span><button type="button" onClick={() => onSelectPlace(transition.target)}>{model.places.get(transition.target)?.label}<small>{transition.to.event.date.text} · {transition.to.event.title}</small></button>
        {transition.hasMigrationEvent ? <span className="constellation-migration-badge">Є запис про еміграцію / імміграцію</span> : null}
      </li>)}</ol> : <p>Немає однозначно впорядкованих згадок у різних місцях.</p>}
      {journey && journey.transitions.length > historyLimit ? <button type="button" onClick={() => setHistoryLimit(value => value + 30)}>Ще переходи</button> : null}
      {journey?.ambiguousGroupCount ? <p>{journey.ambiguousGroupCount} груп подій мають накладені дати й різні місця. Стрілки через ці групи не проводимо.</p> : null}
      {journey?.unsequenced.length ? <p>{journey.unsequenced.length} згадок без достатньо точної дати залишено без стрілок.</p> : null}
      <details className="constellation-place-records"><summary>Усі згадки особи ({journey?.observations.length ?? 0})</summary>
        <ul>{journey?.observations.slice(0, historyLimit).map(observation => <li key={observation.id}>
          <button type="button" onClick={() => onSelectPlace(observation.placeId)}>{observation.event.place || model.places.get(observation.placeId)?.label}</button>
          <strong>{observation.event.title}</strong><span>{observation.event.date.text || "Дата невідома"}</span>
          {observation.event.date.reference !== undefined ? <button type="button" onClick={() => onYearSelect(observation.event.date.reference!, selectedPersonId)}>Переглянути у часі · {observation.event.date.reference}</button> : null}
        </li>)}</ul>
        {journey && journey.observations.length > historyLimit ? <button type="button" onClick={() => setHistoryLimit(value => value + 30)}>Ще згадки</button> : null}
      </details>
    </div>
    {place ? <>
      <section className="constellation-place-members" aria-label="Особи вибраного місця"><h4>Особи в цьому місці</h4>
        {place.personIds.length > 10 ? <label>Пошук серед осіб місця<input type="search" value={peopleQuery} onChange={event => { setPeopleQuery(event.target.value); setPeopleLimit(30); }} /></label> : null}
        <ul>{people.slice(0, peopleLimit).map(id => <li key={id}><button type="button" aria-pressed={id === selectedPersonId} onClick={() => onSelectPerson(id)}>{nameOf(id)}</button></li>)}</ul>
        {!people.length ? <p>Осіб не знайдено.</p> : null}{people.length > peopleLimit ? <button type="button" onClick={() => setPeopleLimit(value => value + 30)}>Ще особи</button> : null}
      </section>
      <details className="constellation-place-records"><summary>Події в цьому місці ({place.events.length})</summary>
        <ul>{place.events.slice(0, eventsLimit).map(event => <li key={event.id}>
          <strong>{event.title}{isConstellationMigration(event) ? " ◇" : ""}</strong><span>{event.date.text || "Дата невідома"}</span><span>{event.place}</span>
          {event.personIds.map(id => <button type="button" key={id} onClick={() => onSelectPerson(id)}>{nameOf(id)}</button>)}
          {event.date.reference !== undefined ? <button type="button" onClick={() => onYearSelect(event.date.reference!, event.personIds.includes(selectedPersonId) ? selectedPersonId : event.personIds[0]!)}>Переглянути у часі · {event.date.reference}</button> : null}
        </li>)}</ul>{place.events.length > eventsLimit ? <button type="button" onClick={() => setEventsLimit(value => value + 25)}>Ще події місця</button> : null}
      </details>
    </> : null}
    <details className="constellation-place-directory"><summary>Усі групи місць ({model.places.size})</summary>
      <label>Пошук у списку місць<input type="search" value={placesQuery} onChange={event => { setPlacesQuery(event.target.value); setPlacesLimit(40); }} /></label>
      <ul>{placeList.slice(0, placesLimit).map(item => <li key={item.id}><button type="button" aria-pressed={item.id === place?.id} onClick={() => onSelectPlace(item.id)}>{item.label}<small>{constellationPeopleCount(item.personIds.length)} · {item.canonicalId ? `уточнене · ${item.canonicalId.slice(-8)}` : "неуточнене"}</small></button></li>)}</ul>
      {!placeList.length ? <p>Місць не знайдено.</p> : null}{placeList.length > placesLimit ? <button type="button" onClick={() => setPlacesLimit(value => value + 40)}>Ще місця</button> : null}
    </details>
  </div>;
}
