import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
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
  researchId: string;
  personIds: string[];
  searchText: string;
  relatedPage: PageKey;
  relatedId: string;
  geo: GeoPoint & { latitude: number; longitude: number };
}

function hasCoordinates(value: GeoPoint | null | undefined): value is GeoPoint & { latitude: number; longitude: number } {
  return Boolean(value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude));
}

function markerColor(marker: TrackerMapMarker): string {
  return geoMarkerColor(
    marker.geo.markerColor,
    marker.kind === "finding" ? FINDING_MARKER_COLOR : PERSON_MARKER_COLOR,
  );
}

function markerIcon(color: string): L.DivIcon {
  const safeColor = geoMarkerColor(color);
  return L.divIcon({
    className: "tracker-map-marker-shell",
    html: `<span class="tracker-map-marker" style="--marker-color:${safeColor}"></span>`,
    iconSize: [22, 22],
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

function buildMarkers(db: AppDatabase): TrackerMapMarker[] {
  const markers: TrackerMapMarker[] = [];
  const peopleIndex = new Map(db.persons.map((person) => [person.id, personSearchText(person)]));
  for (const person of db.persons) {
    for (const event of person.events ?? []) {
      if (!hasCoordinates(event.geo)) continue;
      const title = personName(person);
      const subtitle = personEventTitle(event);
      const place = event.placeName || event.geo.displayName || "";
      markers.push({
        id: `person:${person.id}:${event.id}`,
        kind: "person-event",
        title,
        subtitle,
        place,
        researchId: person.researchId,
        personIds: [person.id],
        searchText: [
          title,
          subtitle,
          place,
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
    markers.push({
      id: `finding:${finding.id}`,
      kind: "finding",
      title,
      subtitle,
      place,
      researchId: finding.researchId,
      personIds: finding.personIds,
      searchText: [
        title,
        subtitle,
        place,
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
  const [personId, setPersonId] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const markers = useMemo(() => buildMarkers(db), [db.persons, db.findings]);
  const normalizedQuery = query.trim().toLocaleLowerCase("uk");
  const filtered = useMemo(() => markers.filter((marker) => {
    const matchesResearch = !researchId || marker.researchId === researchId;
    const matchesKind = kind === "all" || marker.kind === kind;
    const matchesPerson = !personId || marker.personIds.includes(personId);
    return matchesResearch && matchesKind && matchesPerson && (!normalizedQuery || marker.searchText.includes(normalizedQuery));
  }), [markers, researchId, kind, personId, normalizedQuery]);
  const selectedMarker = filtered.find((marker) => marker.id === selectedId) ?? filtered[0];

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
            selectedId={selectedMarker?.id ?? ""}
            onSelect={setSelectedId}
            onOpenRelated={onOpenRelated}
          />
          <div className="map-marker-list">
            {filtered.length ? filtered.map((marker) => (
              <button
                type="button"
                key={marker.id}
                className={marker.id === selectedMarker?.id ? "active" : ""}
                onClick={() => setSelectedId(marker.id)}
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
  selectedId,
  onSelect,
  onOpenRelated,
}: {
  markers: TrackerMapMarker[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenRelated?: (page: PageKey, entityId: string) => void;
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
    markers.forEach((marker) => {
      const latlng: L.LatLngExpression = [marker.geo.latitude, marker.geo.longitude];
      bounds.push(latlng);
      const leafletMarker = L.marker(latlng, {
        icon: markerIcon(markerColor(marker)),
      }).addTo(layer);
      leafletMarker.bindPopup(`
        <strong>${escapeHtml(marker.title)}</strong>
        <span>${escapeHtml(marker.subtitle)}</span>
        ${marker.place ? `<em>${escapeHtml(marker.place)}</em>` : ""}
      `);
      leafletMarker.on("click", () => onSelect(marker.id));
    });
    if (bounds.length > 1) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [36, 36], maxZoom: 12 });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 11);
    }
  }, [markers, onSelect]);

  useEffect(() => {
    const marker = markers.find((item) => item.id === selectedId);
    const map = mapRef.current;
    if (!marker || !map) return;
    map.panTo([marker.geo.latitude, marker.geo.longitude]);
  }, [selectedId, markers]);

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
      {selectedId ? (
        <button
          type="button"
          className="button button-secondary map-open-button"
          onClick={() => {
            const marker = markers.find((item) => item.id === selectedId);
            if (marker) onOpenRelated?.(marker.relatedPage, marker.relatedId);
          }}
        >
          Відкрити запис
        </button>
      ) : null}
    </div>
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
