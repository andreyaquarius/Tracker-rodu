import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import Fuse, { type IFuseOptions } from "fuse.js";
import type { AppDatabase, Finding, GeoPoint, Person, PersonEvent } from "../types";
import type { PageKey } from "../components/Sidebar";
import { geoMarkerColor, personEventLabel } from "../utils/geo";
import { primaryParticipantName } from "../utils/findingParticipants";

type MapMarkerKind = "person-event" | "finding";
const PERSON_MARKER_COLOR = "#c49a32";
const FINDING_MARKER_COLOR = "#0f4a42";

interface TrackerMapMarker {
  id: string;
  kind: MapMarkerKind;
  title: string;
  subtitle: string;
  place: string;
  settlement: string;
  researchId: string;
  personIds: string[];
  searchText: string;
  relatedPage: PageKey;
  relatedId: string;
  geo: GeoPoint & { latitude: number; longitude: number };
}

interface TrackerMapMarkerGroup {
  key: string;
  markers: TrackerMapMarker[];
  geo: GeoPoint & { latitude: number; longitude: number };
}

const mapSearchOptions: IFuseOptions<TrackerMapMarker> = {
  keys: [
    { name: "title", weight: 0.3 },
    { name: "subtitle", weight: 0.15 },
    { name: "settlement", weight: 0.22 },
    { name: "place", weight: 0.18 },
    { name: "searchText", weight: 0.15 },
  ],
  includeScore: true,
  ignoreLocation: true,
  isCaseSensitive: false,
  minMatchCharLength: 2,
  threshold: 0.34,
};

function hasCoordinates(value: GeoPoint | null | undefined): value is GeoPoint & { latitude: number; longitude: number } {
  return Boolean(value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude));
}

function markerColor(marker: TrackerMapMarker): string {
  return geoMarkerColor(
    marker.geo.markerColor,
    marker.kind === "finding" ? FINDING_MARKER_COLOR : PERSON_MARKER_COLOR,
  );
}

function markerIcon(color: string, count = 1): L.DivIcon {
  const safeColor = geoMarkerColor(color);
  return L.divIcon({
    className: "tracker-map-marker-shell",
    html: `<span class="tracker-map-marker" style="--marker-color:${safeColor}"></span>${count > 1 ? `<span class="tracker-map-marker-count">${count}</span>` : ""}`,
    iconSize: count > 1 ? [34, 30] : [22, 22],
    iconAnchor: [11, 22],
  });
}

function personName(person: Person): string {
  return person.fullName ||
    [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ") ||
    "Особа без імені";
}

function findingTitle(finding: Finding): string {
  return primaryParticipantName(finding.participants) || finding.people || finding.summary || "Знахідка";
}

function personSearchText(person: Person): string {
  return [
    person.fullName,
    person.surname,
    person.givenName,
    person.patronymic,
    person.nameVariants,
    person.surnameVariants,
    person.birthPlace,
    person.marriagePlace,
    person.deathPlace,
    person.residencePlaces,
  ].join(" ").toLocaleLowerCase("uk");
}

function normalizeMapText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk");
}

function settlementName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized === "Позначка на карті") return "";
  return normalized.split(",")[0]?.trim() ?? "";
}

function markerGroupKey(marker: TrackerMapMarker): string {
  return [
    marker.geo.latitude.toFixed(5),
    marker.geo.longitude.toFixed(5),
  ].join(":");
}

function groupMarkers(markers: TrackerMapMarker[]): TrackerMapMarkerGroup[] {
  const groups = new Map<string, TrackerMapMarkerGroup>();
  for (const marker of markers) {
    const key = markerGroupKey(marker);
    const group = groups.get(key);
    if (group) {
      group.markers.push(marker);
    } else {
      groups.set(key, { key, markers: [marker], geo: marker.geo });
    }
  }
  return Array.from(groups.values());
}

function buildMarkers(db: AppDatabase): TrackerMapMarker[] {
  const markers: TrackerMapMarker[] = [];
  const peopleIndex = new Map(db.persons.map((person) => [person.id, personSearchText(person)]));
  const researchIndex = new Map(db.researches.map((research) => [research.id, research.title]));
  for (const person of db.persons) {
    for (const event of person.events ?? []) {
      if (!hasCoordinates(event.geo)) continue;
      const title = personName(person);
      const subtitle = personEventTitle(event);
      const place = event.placeName || event.geo.displayName || "";
      const settlement = settlementName(place);
      markers.push({
        id: `person:${person.id}:${event.id}`,
        kind: "person-event",
        title,
        subtitle,
        place,
        settlement,
        researchId: person.researchId,
        personIds: [person.id],
        searchText: [
          title,
          subtitle,
          place,
          settlement,
          researchIndex.get(person.researchId),
          event.geo.displayName,
          event.notes,
          peopleIndex.get(person.id),
        ].join(" ").toLocaleLowerCase("uk"),
        relatedPage: "persons",
        relatedId: person.id,
        geo: event.geo,
      });
    }
  }
  for (const finding of db.findings) {
    if (!hasCoordinates(finding.geo)) continue;
    const title = findingTitle(finding);
    const subtitle = [finding.findingType, finding.eventDate].filter(Boolean).join(" · ") || "Знахідка";
    const place = finding.place || finding.geo.displayName || "";
    const settlement = settlementName(place);
    markers.push({
      id: `finding:${finding.id}`,
      kind: "finding",
      title,
      subtitle,
      place,
      settlement,
      researchId: finding.researchId,
      personIds: finding.personIds,
      searchText: [
        title,
        subtitle,
        place,
        settlement,
        researchIndex.get(finding.researchId),
        finding.people,
        finding.personsText,
        finding.participants.map((participant) => `${participant.name} ${participant.role} ${participant.notes}`).join(" "),
        finding.archive,
        finding.fund,
        finding.description,
        finding.file,
        finding.page,
        finding.summary,
        finding.transcription,
        finding.conclusion,
        finding.notes,
        finding.geo.displayName,
        finding.personIds.map((id) => peopleIndex.get(id) ?? "").join(" "),
      ].join(" ").toLocaleLowerCase("uk"),
      relatedPage: "findings",
      relatedId: finding.id,
      geo: finding.geo,
    });
  }
  return markers;
}

function createMapSearch(markers: TrackerMapMarker[]) {
  const index = Fuse.createIndex(
    ["title", "subtitle", "settlement", "place", "searchText"],
    markers,
  );
  const fuse = new Fuse(markers, mapSearchOptions, index);
  return (query: string) => {
    const normalized = normalizeMapText(query);
    if (!normalized) return markers;
    const matchedIds = new Set(
      markers
        .filter((marker) => marker.searchText.includes(normalized))
        .map((marker) => marker.id),
    );
    for (const result of fuse.search(query)) matchedIds.add(result.item.id);
    return markers.filter((marker) => matchedIds.has(marker.id));
  };
}

function personEventTitle(event: PersonEvent): string {
  return [personEventLabel(event.type), event.date].filter(Boolean).join(" · ");
}

export function MapPage({
  db,
  onOpenRelated,
}: {
  db: AppDatabase;
  onOpenRelated?: (page: PageKey, entityId: string) => void;
}) {
  const [kind, setKind] = useState<"all" | MapMarkerKind>("all");
  const [researchId, setResearchId] = useState("");
  const [settlement, setSettlement] = useState("");
  const [personId, setPersonId] = useState("");
  const [query, setQuery] = useState("");
  const [selectedGroupKey, setSelectedGroupKey] = useState("");
  const markers = useMemo(() => buildMarkers(db), [db.persons, db.findings, db.researches]);
  const searchMarkers = useMemo(() => createMapSearch(markers), [markers]);
  const placeOptions = useMemo(() => Array.from(new Set(
    markers.map((marker) => marker.settlement).filter(Boolean),
  )).sort((first, second) => first.localeCompare(second, "uk")), [markers]);
  const searched = useMemo(() => searchMarkers(query), [searchMarkers, query]);
  const filtered = useMemo(() => searched.filter((marker) => {
    const matchesResearch = !researchId || marker.researchId === researchId;
    const matchesSettlement = !settlement || marker.settlement === settlement;
    const matchesKind = kind === "all" || marker.kind === kind;
    const matchesPerson = !personId || marker.personIds.includes(personId);
    return matchesResearch && matchesSettlement && matchesKind && matchesPerson;
  }), [searched, researchId, settlement, kind, personId]);
  const filteredGroups = useMemo(() => groupMarkers(filtered), [filtered]);
  const selectedGroup = selectedGroupKey
    ? filteredGroups.find((group) => group.key === selectedGroupKey) ?? null
    : null;
  const visibleListMarkers = selectedGroup?.markers ?? filtered;

  useEffect(() => {
    if (settlement && !placeOptions.includes(settlement)) setSettlement("");
  }, [placeOptions, settlement]);

  useEffect(() => {
    if (selectedGroupKey && !filteredGroups.some((group) => group.key === selectedGroupKey)) {
      setSelectedGroupKey("");
    }
  }, [filteredGroups, selectedGroupKey]);

  return (
    <div className="map-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Географія дослідження</span>
          <h1>Карта</h1>
          <p>Місця подій осіб і знахідок, які мають збережену позначку.</p>
        </div>
      </div>
      <section className="panel map-panel">
        <div className="map-toolbar">
          <label className="search-field">
            <span>Пошук</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Особа, знахідка або місце" />
          </label>
          <label>
            <span>Дослідження</span>
            <select value={researchId} onChange={(event) => setResearchId(event.target.value)}>
              <option value="">Усі дослідження</option>
              {db.researches.map((research) => (
                <option key={research.id} value={research.id}>{research.title}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Населений пункт</span>
            <select value={settlement} onChange={(event) => setSettlement(event.target.value)}>
              <option value="">Усі населені пункти</option>
              {placeOptions.map((place) => (
                <option key={place} value={place}>{place}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Тип</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as "all" | MapMarkerKind)}>
              <option value="all">Усі позначки</option>
              <option value="person-event">Події осіб</option>
              <option value="finding">Знахідки</option>
            </select>
          </label>
          <PersonMapFilter
            persons={db.persons}
            selectedId={personId}
            onChange={setPersonId}
          />
          <div className="result-count">{filtered.length} з {markers.length}</div>
        </div>
        <div className="map-layout">
          <TrackerMap
            markers={filtered}
            selectedGroupKey={selectedGroupKey}
            onSelectGroup={setSelectedGroupKey}
          />
          <div className="map-marker-list">
            {selectedGroup ? (
              <div className="map-marker-list-filter">
                <strong>
                  {selectedGroup.markers.length} {selectedGroup.markers.length === 1 ? "запис" : "записів"} у цьому місці
                </strong>
                <button type="button" className="text-button" onClick={() => setSelectedGroupKey("")}>
                  Показати всі
                </button>
              </div>
            ) : null}
            {visibleListMarkers.length ? visibleListMarkers.map((marker) => (
              <button
                type="button"
                key={marker.id}
                className={markerGroupKey(marker) === selectedGroupKey ? "active" : ""}
                onClick={() => onOpenRelated?.(marker.relatedPage, marker.relatedId)}
              >
                <span
                  className={`map-kind-dot ${marker.kind}`}
                  style={{ backgroundColor: markerColor(marker) }}
                />
                <strong>{marker.title}</strong>
                <small>{marker.subtitle}</small>
                {marker.place ? <em>{marker.place}</em> : null}
              </button>
            )) : (
              <div className="empty-inline">Немає позначок за вибраними фільтрами.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function PersonMapFilter({
  persons,
  selectedId,
  onChange,
}: {
  persons: Person[];
  selectedId: string;
  onChange: (id: string) => void;
}) {
  const selectedPerson = persons.find((person) => person.id === selectedId);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase("uk");
  const suggestions = useMemo(() => {
    if (!normalizedQuery) return persons.slice(0, 12);
    return persons
      .filter((person) => personSearchText(person).includes(normalizedQuery))
      .slice(0, 20);
  }, [persons, normalizedQuery]);

  useEffect(() => {
    setQuery(selectedPerson ? personName(selectedPerson) : "");
  }, [selectedPerson?.id]);

  return (
    <div className="map-person-filter">
      <span>Особа</span>
      <div className="map-person-picker">
        <input
          value={query}
          placeholder="Введіть прізвище, ім'я або по батькові"
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            setOpen(true);
            if (!next.trim()) onChange("");
          }}
        />
        {selectedId ? (
          <button
            type="button"
            aria-label="Скинути фільтр особи"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("");
              setQuery("");
              setOpen(false);
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="map-person-options">
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("");
              setQuery("");
              setOpen(false);
            }}
          >
            Усі особи
          </button>
          {suggestions.map((person) => (
            <button
              type="button"
              key={person.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(person.id);
                setQuery(personName(person));
                setOpen(false);
              }}
            >
              <strong>{personName(person)}</strong>
              <small>{[person.birthDate, person.birthPlace].filter(Boolean).join(" · ")}</small>
            </button>
          ))}
          {!suggestions.length ? <p>Особу не знайдено.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function TrackerMap({
  markers,
  selectedGroupKey,
  onSelectGroup,
}: {
  markers: TrackerMapMarker[];
  selectedGroupKey: string;
  onSelectGroup: (groupKey: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current).setView([49, 31], 6);
    mapRef.current = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    window.setTimeout(() => map.invalidateSize(), 80);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    const groups = groupMarkers(markers);
    groups.forEach((group) => {
      const latlng: L.LatLngExpression = [group.geo.latitude, group.geo.longitude];
      bounds.push(latlng);
      const primary = group.markers[0];
      const leafletMarker = L.marker(latlng, {
        icon: markerIcon(markerColor(primary), group.markers.length),
      }).addTo(layer);
      leafletMarker.on("click", () => {
        onSelectGroup(group.key);
        map.closePopup();
      });
    });
    if (bounds.length > 1) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [36, 36], maxZoom: 12 });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 11);
    }
  }, [markers, onSelectGroup]);

  useEffect(() => {
    const selectedGroup = selectedGroupKey
      ? groupMarkers(markers).find((group) => group.key === selectedGroupKey)
      : null;
    const map = mapRef.current;
    if (!selectedGroup || !map) return;
    map.panTo([selectedGroup.geo.latitude, selectedGroup.geo.longitude]);
  }, [selectedGroupKey, markers]);

  useEffect(() => {
    window.setTimeout(() => mapRef.current?.invalidateSize(), 80);
  }, [fullscreen]);

  return (
    <div className={`tracker-map-wrap ${fullscreen ? "map-fullscreen" : ""}`}>
      <div className="tracker-map" ref={containerRef} />
      <button
        type="button"
        className="button button-secondary map-fullscreen-button"
        onClick={() => setFullscreen((current) => !current)}
      >
        {fullscreen ? "Згорнути карту" : "На весь екран"}
      </button>
    </div>
  );
}
