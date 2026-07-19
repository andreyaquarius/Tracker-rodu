import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Person, PersonGender, PersonStatus } from "../../types";
import type { ProjectPersonSummary } from "../../services/projectPersonSummaries.ts";
import {
  buildPersonTimeline,
  filterAndSortPersons,
  personDisplayName as personDisplayNameV2,
  personInitials as personInitialsV2,
  personLifeYears as personLifeYearsV2,
  personMainPlaces,
  type PersonCatalogOptions,
} from "./model";
import {
  personEventTypeDisplayLabel,
  personTimelineDateDisplay,
  personTimelineEventDisplayTitle,
} from "./presentation";

export type PersonsCatalogSegmentV2 = "all" | "direct" | "confirmed" | "hypotheses";
export type PersonsCatalogViewV2 = "list" | "grid";
export type PersonsCatalogSortV2 = "family" | "name-asc" | "name-desc" | "recent" | "birth-asc";
export type PersonsCatalogFamilyOrderStatusV2 = "loading" | "ready" | "unavailable";
export type PersonsCatalogLivingFilterV2 = "all" | "living" | "deceased";
export type PersonsCatalogBulkActionV2 = "tag" | "export" | "merge" | "delete";

export interface PersonsCatalogFiltersV2 {
  query: string;
  gender: "all" | PersonGender;
  living: PersonsCatalogLivingFilterV2;
  status: "all" | PersonStatus;
}

export interface PersonsCatalogV2Props {
  persons: readonly Person[];
  directAncestorIds?: ReadonlySet<string> | readonly string[];
  familyOrder?: ReadonlyMap<string, number>;
  familyOrderStatus?: PersonsCatalogFamilyOrderStatusV2;
  initialSegment?: PersonsCatalogSegmentV2;
  initialView?: PersonsCatalogViewV2;
  initialQuery?: string;
  initialPageSize?: number;
  selectedPersonId?: string;
  summaries?: ReadonlyMap<string, ProjectPersonSummary>;
  headerActions?: ReactNode;
  enabledBulkActions?: readonly PersonsCatalogBulkActionV2[];
  photoUrlForPerson?: (person: Person) => string | undefined;
  onOpenPerson: (person: Person) => void;
  onDeletePerson?: (person: Person) => void;
  onCreatePerson?: () => void;
  onSelectionChange?: (persons: readonly Person[]) => void;
  onBulkAction?: (
    action: PersonsCatalogBulkActionV2,
    persons: readonly Person[],
  ) => void;
}

const emptyFilters: PersonsCatalogFiltersV2 = {
  query: "",
  gender: "all",
  living: "all",
  status: "all",
};
const emptyFamilyOrderV2: ReadonlyMap<string, number> = new Map();

const segmentLabels: Record<PersonsCatalogSegmentV2, string> = {
  all: "Усі особи",
  direct: "Прямі предки",
  confirmed: "Підтверджені",
  hypotheses: "Гіпотези",
};

export function PersonsCatalogV2({
  persons,
  directAncestorIds = [],
  familyOrder = emptyFamilyOrderV2,
  familyOrderStatus = familyOrder.size ? "ready" : "unavailable",
  initialSegment = "all",
  initialView = "list",
  initialQuery = "",
  initialPageSize = 25,
  selectedPersonId,
  summaries = new Map(),
  headerActions,
  enabledBulkActions = [],
  photoUrlForPerson,
  onOpenPerson,
  onDeletePerson,
  onCreatePerson,
  onSelectionChange,
  onBulkAction,
}: PersonsCatalogV2Props) {
  const [segment, setSegment] = useState<PersonsCatalogSegmentV2>(initialSegment);
  const [view, setView] = useState<PersonsCatalogViewV2>(initialView);
  const [sort, setSort] = useState<PersonsCatalogSortV2>("family");
  const [filters, setFilters] = useState<PersonsCatalogFiltersV2>(() => ({
    ...emptyFilters,
    query: initialQuery,
  }));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(Math.max(5, initialPageSize));
  const directIds = useMemo(
    () => new Set(directAncestorIds),
    [directAncestorIds],
  );

  const segmentCounts = useMemo<Record<PersonsCatalogSegmentV2, number>>(() => ({
    all: persons.length,
    direct: filterAndSortPersons(persons, { segment: "direct", directPersonIds: directIds }).length,
    confirmed: filterAndSortPersons(persons, { segment: "confirmed" }).length,
    hypotheses: filterAndSortPersons(persons, { segment: "hypotheses" }).length,
  }), [directIds, persons]);

  const result = useMemo(() => filterAndSortPersons(persons, {
    query: filters.query,
    gender: filters.gender,
    lifeStatus: filters.living,
    status: filters.status,
    segment,
    directPersonIds: directIds,
    familyOrder,
    ...catalogSortOptionsV2(sort),
  }), [directIds, familyOrder, filters, persons, segment, sort]);

  const totalPages = Math.max(1, Math.ceil(result.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visiblePersons = result.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const selectedPersons = useMemo(
    () => persons.filter((person) => selectedIds.has(person.id)),
    [persons, selectedIds],
  );
  const visibleSelectionCount = visiblePersons.filter((person) => selectedIds.has(person.id)).length;
  const allVisibleSelected = visiblePersons.length > 0 && visibleSelectionCount === visiblePersons.length;

  useEffect(() => {
    setPage(1);
  }, [familyOrder, filters, pageSize, segment, sort]);

  useEffect(() => {
    if (segment === "direct" && directIds.size === 0) setSegment("all");
  }, [directIds.size, segment]);

  useEffect(() => {
    setFilters((current) => current.query === initialQuery
      ? current
      : { ...current, query: initialQuery });
  }, [initialQuery]);

  useEffect(() => {
    const knownIds = new Set(persons.map((person) => person.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => knownIds.has(id)));
      if (next.size === current.size) return current;
      return next;
    });
  }, [persons]);

  useEffect(() => {
    onSelectionChange?.(selectedPersons);
  }, [onSelectionChange, selectedPersons]);

  const updateFilter = <K extends keyof PersonsCatalogFiltersV2>(
    key: K,
    value: PersonsCatalogFiltersV2[K],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const toggleSelected = (personId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visiblePersons.forEach((person) => next.delete(person.id));
      else visiblePersons.forEach((person) => next.add(person.id));
      return next;
    });
  };

  const runBulkAction = (action: PersonsCatalogBulkActionV2) => {
    if (!onBulkAction || !selectedPersons.length) return;
    if (action === "merge" && selectedPersons.length !== 2) return;
    onBulkAction(action, selectedPersons);
  };

  const openFromKeyboard = (event: KeyboardEvent<HTMLElement>, person: Person) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpenPerson(person);
  };

  return (
    <section className="persons-v2-catalog" aria-labelledby="persons-v2-title">
      <header className="page-heading persons-v2-catalog__heading">
        <div>
          <span className="eyebrow">Дослідницький каталог</span>
          <h1 id="persons-v2-title">Особи</h1>
          <p>Люди проєкту, життєві факти, джерела та родинні зв’язки.</p>
        </div>
        <div className="page-heading-actions">
          {headerActions}
          {onCreatePerson ? (
            <button type="button" className="button button-primary" onClick={onCreatePerson}>
              + Додати особу
            </button>
          ) : null}
        </div>
      </header>

      <nav className="persons-v2-segments" aria-label="Групи осіб">
        {(Object.keys(segmentLabels) as PersonsCatalogSegmentV2[])
          .filter((key) => key !== "direct" || directIds.size > 0)
          .map((key) => (
          <button
            type="button"
            key={key}
            className={segment === key ? "active" : ""}
            aria-current={segment === key ? "page" : undefined}
            onClick={() => setSegment(key)}
          >
            {segmentLabels[key]} <span>{segmentCounts[key]}</span>
          </button>
          ))}
      </nav>

      <div className="panel persons-v2-catalog__filters">
        <label className="search-field persons-v2-catalog__search">
          <span>Пошук</span>
          <input
            type="search"
            value={filters.query}
            placeholder="Ім’я, прізвище, місце, подія або нотатка…"
            onChange={(event) => updateFilter("query", event.target.value)}
          />
        </label>
        <label>
          <span>Стать</span>
          <select
            value={filters.gender}
            onChange={(event) => updateFilter("gender", event.target.value as PersonsCatalogFiltersV2["gender"])}
          >
            <option value="all">Будь-яка</option>
            {uniqueValuesV2(persons.map((person) => person.gender)).map((gender) => (
              <option key={gender} value={gender}>{gender}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Стан життя</span>
          <select
            value={filters.living}
            onChange={(event) => updateFilter("living", event.target.value as PersonsCatalogLivingFilterV2)}
          >
            <option value="all">Усі</option>
            <option value="living">Живі</option>
            <option value="deceased">Померлі</option>
          </select>
        </label>
        <label>
          <span>Статус дослідження</span>
          <select
            value={filters.status}
            onChange={(event) => updateFilter("status", event.target.value as PersonsCatalogFiltersV2["status"])}
          >
            <option value="all">Усі статуси</option>
            {uniqueValuesV2(persons.map((person) => person.status)).map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button button-ghost"
          disabled={filters === emptyFilters || isEmptyFiltersV2(filters)}
          onClick={() => setFilters(emptyFilters)}
        >
          Скинути фільтри
        </button>
      </div>

      <div className="persons-v2-catalog__toolbar" aria-label="Дії з каталогом">
        <label className="persons-v2-select-all">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            aria-label="Вибрати всі записи на сторінці"
            onChange={toggleVisible}
          />
          <span>{selectedPersons.length ? `Вибрано: ${selectedPersons.length}` : "Вибрати сторінку"}</span>
        </label>
        <div className="persons-v2-bulk-actions" aria-label="Групові дії">
          {enabledBulkActions.includes("tag") ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={!onBulkAction || !selectedPersons.length}
              onClick={() => runBulkAction("tag")}
            >
              Додати тег
            </button>
          ) : null}
          {enabledBulkActions.includes("export") ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={!onBulkAction || !selectedPersons.length}
              onClick={() => runBulkAction("export")}
            >
              Експорт
            </button>
          ) : null}
          {enabledBulkActions.includes("merge") ? (
            <button
              type="button"
              className="button button-secondary"
              title={selectedPersons.length === 2 ? undefined : "Для об’єднання виберіть рівно дві особи"}
              disabled={!onBulkAction || selectedPersons.length !== 2}
              onClick={() => runBulkAction("merge")}
            >
              Об’єднати
            </button>
          ) : null}
          {enabledBulkActions.includes("delete") ? (
            <button
              type="button"
              className="button button-danger"
              disabled={!onBulkAction || !selectedPersons.length}
              onClick={() => runBulkAction("delete")}
            >
              Видалити вибраних
            </button>
          ) : null}
        </div>
        <label>
          <span className="visually-hidden">Сортування</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as PersonsCatalogSortV2)}>
            <option value="family">
              {familyOrderStatus === "ready"
                ? "Від центральної особи"
                : familyOrderStatus === "loading"
                  ? "Від центральної особи (завантаження…)"
                  : "Ім’я: А–Я (дерево недоступне)"}
            </option>
            <option value="name-asc">Ім’я: А–Я</option>
            <option value="name-desc">Ім’я: Я–А</option>
            <option value="recent">Останні зміни</option>
            <option value="birth-asc">Рік народження</option>
          </select>
        </label>
        <div className="persons-v2-view-toggle" role="group" aria-label="Вигляд каталогу">
          <button
            type="button"
            aria-pressed={view === "list"}
            className={view === "list" ? "active" : ""}
            onClick={() => setView("list")}
          >
            Список
          </button>
          <button
            type="button"
            aria-pressed={view === "grid"}
            className={view === "grid" ? "active" : ""}
            onClick={() => setView("grid")}
          >
            Плитка
          </button>
        </div>
      </div>

      {visiblePersons.length ? (
        view === "list" ? (
          <PersonsListV2
            persons={visiblePersons}
            directIds={directIds}
            selectedIds={selectedIds}
            activePersonId={selectedPersonId}
            summaries={summaries}
            photoUrlForPerson={photoUrlForPerson}
            onToggleSelected={toggleSelected}
            onOpenPerson={onOpenPerson}
            onDeletePerson={onDeletePerson}
            onOpenFromKeyboard={openFromKeyboard}
          />
        ) : (
          <PersonsGridV2
            persons={visiblePersons}
            directIds={directIds}
            selectedIds={selectedIds}
            activePersonId={selectedPersonId}
            summaries={summaries}
            photoUrlForPerson={photoUrlForPerson}
            onToggleSelected={toggleSelected}
            onOpenPerson={onOpenPerson}
            onDeletePerson={onDeletePerson}
            onOpenFromKeyboard={openFromKeyboard}
          />
        )
      ) : (
        <div className="panel empty-inline persons-v2-catalog__empty">
          <strong>Осіб за цими умовами не знайдено.</strong>
          <span>Змініть пошук або скиньте фільтри.</span>
        </div>
      )}

      <footer className="persons-v2-pagination">
        <span>
          Показано {result.length ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, result.length)} з {result.length}
        </span>
        <label>
          <span>На сторінці</span>
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <div role="group" aria-label="Сторінки каталогу">
          <button type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
            Назад
          </button>
          <span aria-live="polite">{currentPage} / {totalPages}</span>
          <button type="button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
            Далі
          </button>
        </div>
      </footer>
    </section>
  );
}

interface PersonsCollectionViewPropsV2 {
  persons: readonly Person[];
  directIds: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  activePersonId?: string;
  summaries: ReadonlyMap<string, ProjectPersonSummary>;
  photoUrlForPerson?: (person: Person) => string | undefined;
  onToggleSelected: (personId: string) => void;
  onOpenPerson: (person: Person) => void;
  onDeletePerson?: (person: Person) => void;
  onOpenFromKeyboard: (event: KeyboardEvent<HTMLElement>, person: Person) => void;
}

function PersonsListV2({
  persons,
  directIds,
  selectedIds,
  activePersonId,
  summaries,
  photoUrlForPerson,
  onToggleSelected,
  onOpenPerson,
  onDeletePerson,
  onOpenFromKeyboard,
}: PersonsCollectionViewPropsV2) {
  return (
    <div className="panel table-wrapper persons-v2-list">
      <table>
        <thead>
          <tr>
            <th aria-label="Вибір" />
            <th>Особа</th>
            <th>Роки життя</th>
            <th>Статус</th>
            <th>Ключовий зв’язок</th>
            <th>Місця</th>
            <th>Документи</th>
            <th>Остання подія</th>
            {onDeletePerson ? <th aria-label="Дії" /> : null}
          </tr>
        </thead>
        <tbody>
          {persons.map((person) => (
            <tr
              key={person.id}
              tabIndex={0}
              className={activePersonId === person.id ? "is-active" : ""}
              aria-selected={activePersonId === person.id}
              onClick={() => onOpenPerson(person)}
              onKeyDown={(event) => onOpenFromKeyboard(event, person)}
            >
              <td>
                <input
                  type="checkbox"
                  checked={selectedIds.has(person.id)}
                  aria-label={`Вибрати ${personDisplayNameV2(person)}`}
                  onClick={stopPropagationV2}
                  onKeyDown={stopKeyboardPropagationV2}
                  onChange={() => onToggleSelected(person.id)}
                />
              </td>
              <td>
                <PersonIdentityV2 person={person} photoUrl={photoUrlForPerson?.(person)} />
              </td>
              <td>{personLifeYearsV2(person)}</td>
              <td><span className="status-pill">{person.status}</span></td>
              <td>{directIds.has(person.id) ? "Прямий предок" : "—"}</td>
              <td>{personPlacesV2(person) || "—"}</td>
              <td>{summaries.get(person.id)?.documentCount ?? 0}</td>
              <td>{lastEventLabelV2(person, summaries.get(person.id))}</td>
              {onDeletePerson ? (
                <td className="persons-v2-list__actions">
                  <button
                    type="button"
                    className="button button-danger persons-v2-delete-person"
                    aria-label={`Видалити ${personDisplayNameV2(person)}`}
                    title="Видалити особу"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeletePerson(person);
                    }}
                    onKeyDown={stopKeyboardPropagationV2}
                  >
                    Видалити
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonsGridV2({
  persons,
  directIds,
  selectedIds,
  activePersonId,
  summaries,
  photoUrlForPerson,
  onToggleSelected,
  onOpenPerson,
  onDeletePerson,
  onOpenFromKeyboard,
}: PersonsCollectionViewPropsV2) {
  return (
    <div className="persons-v2-grid" role="list">
      {persons.map((person) => (
        <article
          key={person.id}
          role="listitem"
          tabIndex={0}
          className={`panel persons-v2-grid-card${activePersonId === person.id ? " is-active" : ""}`}
          onClick={() => onOpenPerson(person)}
          onKeyDown={(event) => onOpenFromKeyboard(event, person)}
        >
          <div className="persons-v2-grid-card__controls">
            <input
              type="checkbox"
              checked={selectedIds.has(person.id)}
              aria-label={`Вибрати ${personDisplayNameV2(person)}`}
              onClick={stopPropagationV2}
              onKeyDown={stopKeyboardPropagationV2}
              onChange={() => onToggleSelected(person.id)}
            />
            {onDeletePerson ? (
              <button
                type="button"
                className="button button-danger persons-v2-grid-card__delete"
                aria-label={`Видалити ${personDisplayNameV2(person)}`}
                title="Видалити особу"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeletePerson(person);
                }}
                onKeyDown={stopKeyboardPropagationV2}
              >
                Видалити
              </button>
            ) : null}
          </div>
          <PersonIdentityV2 person={person} photoUrl={photoUrlForPerson?.(person)} large />
          <span className="status-pill">{person.status}</span>
          <dl>
            <div><dt>Роки життя</dt><dd>{personLifeYearsV2(person)}</dd></div>
            <div><dt>Стать</dt><dd>{person.gender}</dd></div>
            <div><dt>Місця</dt><dd>{personPlacesV2(person) || "—"}</dd></div>
            <div><dt>Документи</dt><dd>{summaries.get(person.id)?.documentCount ?? 0}</dd></div>
          </dl>
          {directIds.has(person.id) ? <strong className="persons-v2-direct-badge">Прямий предок</strong> : null}
        </article>
      ))}
    </div>
  );
}

function PersonIdentityV2({ person, photoUrl, large = false }: {
  person: Person;
  photoUrl?: string;
  large?: boolean;
}) {
  return (
    <div className={`persons-v2-identity${large ? " is-large" : ""}`}>
      <span className="persons-v2-avatar" aria-hidden="true">
        {photoUrl ? <img src={photoUrl} alt="" /> : personInitialsV2(person)}
      </span>
      <span>
        <strong>{personDisplayNameV2(person)}</strong>
        <small>ID: {person.id}</small>
      </span>
    </div>
  );
}

function personPlacesV2(person: Person): string {
  return personMainPlaces(person).all.slice(0, 3).join(", ");
}

function lastEventLabelV2(person: Person, summary?: ProjectPersonSummary): string {
  if (summary?.lastEventType || summary?.lastEventDate) {
    return [
      personEventTypeDisplayLabel(summary.lastEventType),
      personTimelineDateDisplay(summary.lastEventDate),
    ].filter(Boolean).join(" · ");
  }
  const event = buildPersonTimeline(person).at(-1);
  return event
    ? [
        personTimelineEventDisplayTitle(event),
        personTimelineDateDisplay(event.date),
      ].filter(Boolean).join(" · ")
    : "—";
}

function catalogSortOptionsV2(sort: PersonsCatalogSortV2): Pick<PersonCatalogOptions, "sortBy" | "sortDirection"> {
  switch (sort) {
    case "family": return { sortBy: "family", sortDirection: "asc" };
    case "name-asc": return { sortBy: "name", sortDirection: "asc" };
    case "name-desc": return { sortBy: "name", sortDirection: "desc" };
    case "recent": return { sortBy: "updated", sortDirection: "desc" };
    case "birth-asc": return { sortBy: "birth", sortDirection: "asc" };
  }
}

function uniqueValuesV2<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right, "uk"));
}

function isEmptyFiltersV2(filters: PersonsCatalogFiltersV2): boolean {
  return !filters.query && filters.gender === "all" && filters.living === "all" && filters.status === "all";
}

function stopPropagationV2(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

function stopKeyboardPropagationV2(event: KeyboardEvent<HTMLElement>) {
  event.stopPropagation();
}
