import { useEffect, useId, useMemo, useRef, useState } from "react";
import L from "leaflet";
import type { GeoPoint } from "../../types";
import { isValidCoordinate } from "../../utils/geo";
import "./ZagulyakyPlacesExplorer.css";

/**
 * A confirmed settlement which is safe to expose in the public Zagulyaky
 * catalogue.  `geo` is optional: places without coordinates must remain
 * discoverable in the list, but are deliberately not placed on the map.
 */
export interface ZagulyakySettlementOption {
  /**
   * Optional stable client key. The current catalogue does not have a global
   * place UUID, so the explorer can derive a deterministic key from the
   * confirmed label and coordinates when this is absent.
   */
  key?: string | null;
  label: string;
  context?: string | null;
  geo?: GeoPoint | null;
}

export type ZagulyakySettlementConnectionDirection = "incoming" | "outgoing" | "local";

export interface ZagulyakySettlementConnectionSample {
  title: string;
  personLabel?: string | null;
  eventLabel?: string | null;
  dateLabel?: string | null;
}

/**
 * One aggregated, public relationship between the selected settlement and a
 * related settlement.  A connection is not a travel route: it means that a
 * public record contains confirmed origin and "where found" places.
 */
export interface ZagulyakySettlementConnection {
  id: string;
  direction: ZagulyakySettlementConnectionDirection;
  relatedPlace: ZagulyakySettlementOption;
  recordCount: number;
  /** Present only when the server can count distinct participant mentions. */
  mentionCount?: number;
  eventLabels?: readonly string[];
  yearFrom?: number | null;
  yearTo?: number | null;
  sample?: ZagulyakySettlementConnectionSample | null;
}

export interface ZagulyakyPlacesExplorerFilters {
  eventType: string;
  eventRole: string;
  yearFrom: number | null;
  yearTo: number | null;
}

export interface ZagulyakyPlacesExplorerRequest {
  /** The confirmed origin/found place selected by the user, not an archive or event-place value. */
  selectedPlace: ZagulyakySettlementOption;
  filters: ZagulyakyPlacesExplorerFilters;
  /** The loader should stop its in-flight request when this signal is aborted. */
  signal: AbortSignal;
}

export interface ZagulyakyPlacesExplorerResult {
  /**
   * Optional canonical representation returned by the server. It can replace
   * a stale local label or add coordinates which were not included in `places`.
   */
  selectedPlace?: ZagulyakySettlementOption | null;
  connections: readonly ZagulyakySettlementConnection[];
  totalRecordCount?: number;
  /** Present only when the server can count distinct participant mentions. */
  totalMentionCount?: number;
  /** True only when a very large result hit the server-safe page ceiling. */
  hasMoreConnections?: boolean;
}

export interface ZagulyakyPlacesExplorerFilterOption {
  value: string;
  label: string;
}

export interface ZagulyakyPlacesExplorerOpenRecordsRequest {
  selectedPlace: ZagulyakySettlementOption;
  connection: ZagulyakySettlementConnection;
  filters: ZagulyakyPlacesExplorerFilters;
}

export interface ZagulyakyPlacesExplorerProps {
  /**
   * Optional local fallback for confirmed public settlements. `loadPlaces` is
   * preferred for a large catalogue so the picker never needs to preload every
   * settlement into the browser.
   */
  places?: readonly ZagulyakySettlementOption[];
  /**
   * Search-based public settlement loader. It should return a bounded list of
   * confirmed origin/found places for the supplied query, and never archive or
   * event-location values. It is called with an empty query for initial hints.
   */
  loadPlaces?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<readonly ZagulyakySettlementOption[]>;
  /**
   * Public aggregation loader. It must use only the canonical origin and
   * "where found" fields and return no draft, author, source-storage, or
   * private-record data.
   */
  loadConnections: (
    request: ZagulyakyPlacesExplorerRequest,
  ) => Promise<ZagulyakyPlacesExplorerResult>;
  /** Optional full initial selection when no durable database place id exists. */
  initialPlace?: ZagulyakySettlementOption | null;
  initialPlaceKey?: string;
  eventTypeOptions?: readonly ZagulyakyPlacesExplorerFilterOption[];
  eventRoleOptions?: readonly ZagulyakyPlacesExplorerFilterOption[];
  /** Opens the public catalogue filtered to the records that formed a connection. */
  onOpenRecords?: (request: ZagulyakyPlacesExplorerOpenRecordsRequest) => void;
  className?: string;
}

type ExplorerView = "list" | "map";

const initialFilters: ZagulyakyPlacesExplorerFilters = {
  eventType: "",
  eventRole: "",
  yearFrom: null,
  yearTo: null,
};

const directionMeta: Record<ZagulyakySettlementConnectionDirection, {
  title: (settlement: string) => string;
  empty: (settlement: string) => string;
  mapLabel: string;
}> = {
  incoming: {
    title: (settlement) => `Звідки люди, знайдені в ${settlement}`,
    empty: (settlement) => `Поки немає публічних згадок про походження людей, знайдених у ${settlement}.`,
    mapLabel: "Походження → де знайдено",
  },
  outgoing: {
    title: (settlement) => `Де знайдено людей із ${settlement}`,
    empty: (settlement) => `Поки немає публічних згадок про людей із ${settlement}, знайдених в інших пунктах.`,
    mapLabel: "Походження → де знайдено",
  },
  local: {
    title: (settlement) => `Згадки в межах ${settlement}`,
    empty: (settlement) => `Поки немає публічних згадок, у яких обидва підтверджені місця належать ${settlement}.`,
    mapLabel: "В межах одного пункту",
  },
};

const mapColors: Record<ZagulyakySettlementConnectionDirection | "selected", string> = {
  selected: "#0f4a42",
  incoming: "#c49a32",
  outgoing: "#28695e",
  local: "#6a675d",
};

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase("uk-UA");
}

/**
 * Keep selection independent of a future database `place_id`. The server may
 * use the full selected-place JSON (including canonical coordinates) to build
 * its aggregation query; this key is solely UI state.
 */
export function zagulyakySettlementKey(place: ZagulyakySettlementOption): string {
  if (place.key?.trim()) return place.key.trim();
  const latitude = isMappedPoint(place.geo) ? Number(place.geo.latitude).toFixed(6) : "";
  const longitude = isMappedPoint(place.geo) ? Number(place.geo.longitude).toFixed(6) : "";
  const externalId = place.geo?.externalId?.trim() ?? "";
  return [normalizeText(place.label), normalizeText(place.context ?? ""), latitude, longitude, externalId].join("|");
}

function readableNumber(value: number | undefined): string {
  return new Intl.NumberFormat("uk-UA").format(Math.max(0, value ?? 0));
}

function cleanYear(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 2100 ? parsed : null;
}

function isSamePoint(first: GeoPoint | null | undefined, second: GeoPoint | null | undefined): boolean {
  if (!isMappedPoint(first) || !isMappedPoint(second)) return false;
  return Number(first.latitude) === Number(second.latitude) && Number(first.longitude) === Number(second.longitude);
}

function isMappedPoint(point: GeoPoint | null | undefined): point is GeoPoint & { latitude: number; longitude: number } {
  return Boolean(point && isValidCoordinate(point.latitude, point.longitude));
}

function displayPlace(place: ZagulyakySettlementOption): string {
  return place.context?.trim() ? `${place.label} · ${place.context.trim()}` : place.label;
}

/**
 * Place keys distinguish same-named settlements. Keep the usual picker terse,
 * but reveal public confirmed coordinates when two different points in the
 * current results have the same visible name.
 */
function placePickerLabel(
  place: ZagulyakySettlementOption,
  candidates: readonly ZagulyakySettlementOption[],
): string {
  const duplicateName = candidates.some((candidate) => (
    zagulyakySettlementKey(candidate) !== zagulyakySettlementKey(place)
    && normalizeText(candidate.label) === normalizeText(place.label)
  ));
  if (!duplicateName || !isMappedPoint(place.geo)) return displayPlace(place);
  return `${displayPlace(place)} · ${Number(place.geo.latitude).toFixed(4)}, ${Number(place.geo.longitude).toFixed(4)}`;
}

function distinctSettlements(values: readonly ZagulyakySettlementOption[]): ZagulyakySettlementOption[] {
  const seen = new Set<string>();
  return values.filter((place) => {
    const key = zagulyakySettlementKey(place);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatPeriod(connection: ZagulyakySettlementConnection): string | null {
  const from = connection.yearFrom;
  const to = connection.yearTo;
  if (from && to && from !== to) return `${from}–${to}`;
  if (from) return String(from);
  if (to) return String(to);
  return null;
}

function filtersAreEmpty(filters: ZagulyakyPlacesExplorerFilters): boolean {
  return !filters.eventType && !filters.eventRole && filters.yearFrom === null && filters.yearTo === null;
}

function requestAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function createPopupContent(connection: ZagulyakySettlementConnection): HTMLElement {
  const root = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = connection.relatedPlace.label;
  root.append(title);

  if (connection.relatedPlace.context) {
    const context = document.createElement("span");
    context.textContent = connection.relatedPlace.context;
    root.append(context);
  }

  const counts = document.createElement("em");
  counts.textContent = `${readableNumber(connection.recordCount)} записів${connection.mentionCount === undefined ? "" : ` · ${readableNumber(connection.mentionCount)} згадок`}`;
  root.append(counts);
  return root;
}

interface PlacesConnectionsMapProps {
  selectedPlace: ZagulyakySettlementOption;
  connections: readonly ZagulyakySettlementConnection[];
  localRecordCount: number;
  activeConnectionId: string | null;
  onSelectConnection: (connectionId: string) => void;
}

/**
 * Leaflet view that deliberately draws only direct origin/found relationships.
 * Its text and line styling avoid communicating a migration or travel route.
 */
function PlacesConnectionsMap({
  selectedPlace,
  connections,
  localRecordCount,
  activeConnectionId,
  onSelectConnection,
}: PlacesConnectionsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const selectedPoint = selectedPlace.geo;
  const mapConnections = useMemo(() => connections.filter((connection) => (
    connection.direction !== "local" && isMappedPoint(connection.relatedPlace.geo)
  )), [connections]);

  useEffect(() => {
    if (!isMappedPoint(selectedPoint) || !containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      attributionControl: true,
      scrollWheelZoom: false,
      zoomControl: true,
    }).setView([selectedPoint.latitude, selectedPoint.longitude], 8);
    mapRef.current = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => map.invalidateSize({ pan: false }));
    resizeObserver?.observe(containerRef.current);
    const timer = window.setTimeout(() => map.invalidateSize({ pan: false }), 80);
    return () => {
      window.clearTimeout(timer);
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [selectedPoint]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer || !isMappedPoint(selectedPoint)) return;
    layer.clearLayers();

    const selectedCoordinates: L.LatLngExpression = [selectedPoint.latitude, selectedPoint.longitude];
    const selectedMarker = L.circleMarker(selectedCoordinates, {
      radius: 9,
      color: mapColors.selected,
      weight: 3,
      fillColor: mapColors.selected,
      fillOpacity: 0.92,
    }).addTo(layer);
    const selectedTooltip = document.createElement("span");
    selectedTooltip.textContent = `Обраний пункт: ${displayPlace(selectedPlace)}${localRecordCount ? ` · згадок у межах пункту: ${readableNumber(localRecordCount)}` : ""}`;
    selectedMarker.bindTooltip(selectedTooltip, { direction: "top", offset: [0, -10] });

    const bounds = L.latLngBounds([selectedCoordinates]);
    mapConnections.forEach((connection) => {
      const relatedPoint = connection.relatedPlace.geo;
      if (!isMappedPoint(relatedPoint)) return;
      const relatedCoordinates: L.LatLngExpression = [relatedPoint.latitude, relatedPoint.longitude];
      bounds.extend(relatedCoordinates);
      const active = activeConnectionId === connection.id;
      const lineCoordinates: L.LatLngExpression[] = connection.direction === "incoming"
        ? [relatedCoordinates, selectedCoordinates]
        : [selectedCoordinates, relatedCoordinates];

      if (!isSamePoint(selectedPoint, relatedPoint)) {
        const line = L.polyline(lineCoordinates, {
          color: mapColors[connection.direction],
          weight: active ? 5 : Math.min(4, 2 + Math.log2(Math.max(1, connection.recordCount))),
          opacity: active ? 1 : 0.78,
          dashArray: "5 7",
        }).addTo(layer);
        line.bindPopup(createPopupContent(connection));
        line.on("click", () => onSelectConnection(connection.id));
      }

      const marker = L.circleMarker(relatedCoordinates, {
        radius: active ? 9 : 7,
        color: mapColors[connection.direction],
        weight: active ? 3 : 2,
        fillColor: mapColors[connection.direction],
        fillOpacity: active ? 0.98 : 0.86,
      }).addTo(layer);
      marker.bindPopup(createPopupContent(connection));
      marker.bindTooltip(connection.relatedPlace.label, { direction: "top", offset: [0, -8] });
      marker.on("click", () => onSelectConnection(connection.id));
    });

    if (mapConnections.length === 0) map.setView(selectedCoordinates, 10);
    else map.fitBounds(bounds, { padding: [28, 28], maxZoom: 11 });
  }, [activeConnectionId, localRecordCount, mapConnections, onSelectConnection, selectedPlace, selectedPoint]);

  if (!isMappedPoint(selectedPoint)) {
    return (
      <div className="zagulyaky-places-explorer__map-empty" role="status">
        Для «{selectedPlace.label}» ще немає підтверджених координат. Пов’язані населені пункти доступні у режимі списку.
      </div>
    );
  }

  return (
    <figure className="zagulyaky-places-explorer__map-figure">
      <div
        ref={containerRef}
        className="zagulyaky-places-explorer__map"
        role="region"
        aria-label={`Карта пов’язаних населених пунктів для ${selectedPlace.label}`}
      />
      <figcaption>
        Пунктир показує зв’язок «походження — де знайдено» у публічних записах. Це не маршрут і не доказ переміщення людини.
      </figcaption>
    </figure>
  );
}

function ConnectionList({
  direction,
  settlement,
  connections,
  activeConnectionId,
  onSelectConnection,
  onOpenRecords,
  filters,
  headingId,
}: {
  direction: ZagulyakySettlementConnectionDirection;
  settlement: ZagulyakySettlementOption;
  connections: readonly ZagulyakySettlementConnection[];
  activeConnectionId: string | null;
  onSelectConnection: (connectionId: string) => void;
  onOpenRecords?: (request: ZagulyakyPlacesExplorerOpenRecordsRequest) => void;
  filters: ZagulyakyPlacesExplorerFilters;
  headingId: string;
}) {
  const meta = directionMeta[direction];
  return (
    <section className={`zagulyaky-places-explorer__connection-group zagulyaky-places-explorer__connection-group--${direction}`} aria-labelledby={`${headingId}-${direction}`}>
      <header>
        <div>
          <span className="eyebrow">{meta.mapLabel}</span>
          <h3 id={`${headingId}-${direction}`}>{meta.title(settlement.label)}</h3>
        </div>
        <strong aria-label={`${connections.length} пов’язаних населених пунктів`}>{readableNumber(connections.length)}</strong>
      </header>
      {connections.length === 0 ? <p className="zagulyaky-places-explorer__empty">{meta.empty(settlement.label)}</p> : (
        <ul>
          {connections.map((connection) => {
            const period = formatPeriod(connection);
            return (
              <li key={connection.id} className={activeConnectionId === connection.id ? "is-active" : ""}>
                <button
                  type="button"
                  className="zagulyaky-places-explorer__connection-button"
                  onClick={() => onSelectConnection(connection.id)}
                  aria-pressed={activeConnectionId === connection.id}
                >
                  <span className="zagulyaky-places-explorer__connection-dot" aria-hidden="true" />
                  <span className="zagulyaky-places-explorer__connection-main">
                    <strong>{connection.relatedPlace.label}</strong>
                    {connection.relatedPlace.context ? <small>{connection.relatedPlace.context}</small> : null}
                    <small>
                      {readableNumber(connection.recordCount)} записів
                      {connection.mentionCount === undefined ? "" : ` · ${readableNumber(connection.mentionCount)} згадок`}
                      {period ? ` · ${period}` : ""}
                    </small>
                    {connection.eventLabels?.length ? <em>{connection.eventLabels.join(", ")}</em> : null}
                    {connection.sample ? (
                      <span className="zagulyaky-places-explorer__connection-sample">
                        {connection.sample.personLabel ? `${connection.sample.personLabel} · ` : ""}{connection.sample.title}
                        {connection.sample.eventLabel ? ` · ${connection.sample.eventLabel}` : ""}
                        {connection.sample.dateLabel ? ` · ${connection.sample.dateLabel}` : ""}
                      </span>
                    ) : null}
                  </span>
                </button>
                {onOpenRecords ? (
                  <button
                    type="button"
                    className="button button-secondary zagulyaky-places-explorer__records-button"
                    onClick={() => onOpenRecords({ selectedPlace: settlement, connection, filters })}
                  >
                    Відкрити записи
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Public, loader-driven explorer for settlement relationships in Zagulyaky.
 *
 * The component intentionally owns no Supabase details and no route logic:
 * its host supplies only confirmed public settlement data plus an aggregation
 * loader. This keeps the same explorer usable on a full page, in an embedded
 * catalogue tab, or after a future map-specific route is introduced.
 */
export function ZagulyakyPlacesExplorer({
  places = [],
  loadPlaces,
  loadConnections,
  initialPlace = null,
  initialPlaceKey = "",
  eventTypeOptions = [],
  eventRoleOptions = [],
  onOpenRecords,
  className = "",
}: ZagulyakyPlacesExplorerProps) {
  const headingId = useId();
  const placePickerId = useId();
  const placeSearchId = useId();
  const [view, setView] = useState<ExplorerView>("list");
  const [placeSearch, setPlaceSearch] = useState("");
  const [searchedPlaces, setSearchedPlaces] = useState<readonly ZagulyakySettlementOption[]>([]);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [placeSearchError, setPlaceSearchError] = useState("");
  const [selectedPlaceKey, setSelectedPlaceKey] = useState(
    initialPlace ? zagulyakySettlementKey(initialPlace) : initialPlaceKey,
  );
  const [selectedPlaceSnapshot, setSelectedPlaceSnapshot] = useState<ZagulyakySettlementOption | null>(initialPlace);
  const [filters, setFilters] = useState<ZagulyakyPlacesExplorerFilters>(initialFilters);
  const [result, setResult] = useState<ZagulyakyPlacesExplorerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);

  const availablePlaces = useMemo(
    () => distinctSettlements([...places, ...searchedPlaces]),
    [places, searchedPlaces],
  );
  const selectedFromPicker = useMemo(() => {
    if (selectedPlaceSnapshot && zagulyakySettlementKey(selectedPlaceSnapshot) === selectedPlaceKey) return selectedPlaceSnapshot;
    return availablePlaces.find((place) => zagulyakySettlementKey(place) === selectedPlaceKey) ?? null;
  }, [availablePlaces, selectedPlaceKey, selectedPlaceSnapshot]);
  const selectedPlace = result?.selectedPlace ?? selectedFromPicker;
  const shownPlaces = useMemo(() => {
    const query = normalizeText(placeSearch);
    const matches = query
      ? availablePlaces.filter((place) => normalizeText(`${place.label} ${place.context ?? ""}`).includes(query))
      : availablePlaces;
    const selectionIsPresent = selectedFromPicker && matches.some((place) => (
      zagulyakySettlementKey(place) === zagulyakySettlementKey(selectedFromPicker)
    ));
    return (selectionIsPresent || !selectedFromPicker ? matches : [selectedFromPicker, ...matches]).slice(0, 100);
  }, [availablePlaces, placeSearch, selectedFromPicker]);
  const groups = useMemo(() => {
    const connections = result?.connections ?? [];
    return {
      incoming: connections.filter((connection) => connection.direction === "incoming"),
      outgoing: connections.filter((connection) => connection.direction === "outgoing"),
      local: connections.filter((connection) => connection.direction === "local"),
    } as const;
  }, [result]);
  const visibleConnectionCount = groups.incoming.length + groups.outgoing.length + groups.local.length;
  const totalRecordCount = result?.totalRecordCount ?? result?.connections.reduce((total, item) => total + item.recordCount, 0) ?? 0;
  const totalMentionCount = result?.totalMentionCount;
  const hasMoreConnections = Boolean(result?.hasMoreConnections);
  const localRecordCount = groups.local.reduce((total, connection) => total + connection.recordCount, 0);

  const initialSelectionKey = initialPlace ? zagulyakySettlementKey(initialPlace) : "";

  useEffect(() => {
    if (initialPlace) {
      setSelectedPlaceSnapshot(initialPlace);
      setSelectedPlaceKey(initialSelectionKey);
    } else if (initialPlaceKey) {
      setSelectedPlaceKey(initialPlaceKey);
    }
  // A stable key avoids resetting an in-progress user choice if a host passes
  // a freshly allocated but otherwise identical `initialPlace` object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPlaceKey, initialSelectionKey]);

  useEffect(() => {
    if (!loadPlaces) {
      setSearchedPlaces([]);
      setPlaceSearchError("");
      setPlacesLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPlacesLoading(true);
      setPlaceSearchError("");
      void loadPlaces(placeSearch.trim(), controller.signal).then((next) => {
        if (!controller.signal.aborted) setSearchedPlaces(next);
      }).catch((searchError: unknown) => {
        if (!controller.signal.aborted && !requestAborted(searchError)) {
          setSearchedPlaces([]);
          setPlaceSearchError("Не вдалося знайти населені пункти. Спробуйте змінити запит.");
        }
      }).finally(() => {
        if (!controller.signal.aborted) setPlacesLoading(false);
      });
    }, placeSearch.trim() ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadPlaces, placeSearch]);

  useEffect(() => {
    if (!selectedFromPicker) {
      setResult(null);
      setError("");
      setLoading(false);
      setActiveConnectionId(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setActiveConnectionId(null);
    void loadConnections({ selectedPlace: selectedFromPicker, filters, signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setResult(next);
    }).catch((loadError: unknown) => {
      if (!controller.signal.aborted && !requestAborted(loadError)) {
        setResult(null);
        setError("Не вдалося завантажити зв’язки населеного пункту. Спробуйте ще раз.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [filters, loadConnections, selectedFromPicker]);

  const updateFilter = <Key extends keyof ZagulyakyPlacesExplorerFilters>(
    key: Key,
    value: ZagulyakyPlacesExplorerFilters[Key],
  ) => setFilters((current) => ({ ...current, [key]: value }));

  return (
    <section className={`zagulyaky-places-explorer ${className}`.trim()} aria-labelledby={headingId}>
      <header className="zagulyaky-places-explorer__header">
        <div>
          <span className="eyebrow">Географія Загуляк</span>
          <h2 id={headingId}>Загуляки за населеними пунктами</h2>
          <p>Оберіть населений пункт, щоб побачити підтверджені зв’язки між полями «Походження» та «Де знайдено».</p>
        </div>
        <div className="zagulyaky-places-explorer__view-switch" aria-label="Подання результатів">
          <button type="button" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}>Список</button>
          <button type="button" aria-pressed={view === "map"} className={view === "map" ? "active" : ""} onClick={() => setView("map")}>Карта</button>
        </div>
      </header>

      <div className="zagulyaky-places-explorer__controls">
        <div className="zagulyaky-places-explorer__place-picker">
          <label htmlFor={placeSearchId}><span>Пошук населеного пункту</span><input id={placeSearchId} type="search" value={placeSearch} onChange={(event) => setPlaceSearch(event.target.value)} placeholder="Почніть вводити назву" autoComplete="off" /></label>
          <label htmlFor={placePickerId}><span>Населений пункт</span><select id={placePickerId} value={selectedPlaceKey} onChange={(event) => {
            const nextKey = event.target.value;
            setSelectedPlaceKey(nextKey);
            setSelectedPlaceSnapshot(availablePlaces.find((place) => zagulyakySettlementKey(place) === nextKey) ?? null);
          }}><option value="">Оберіть населений пункт</option>{shownPlaces.map((place) => <option key={zagulyakySettlementKey(place)} value={zagulyakySettlementKey(place)}>{placePickerLabel(place, shownPlaces)}</option>)}</select></label>
          <small aria-live="polite">{placesLoading ? "Шукаємо населені пункти…" : placeSearchError || (shownPlaces.length === 100 ? "Показано перші 100 відповідників. Уточніть пошук." : `${readableNumber(shownPlaces.length)} доступних пунктів`)}</small>
        </div>

        <fieldset className="zagulyaky-places-explorer__filters">
          <legend>Фільтри</legend>
          <label><span>Подія</span><select value={filters.eventType} onChange={(event) => updateFilter("eventType", event.target.value)}><option value="">Усі події</option>{eventTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {eventRoleOptions.length ? <label><span>Роль у події</span><select value={filters.eventRole} onChange={(event) => updateFilter("eventRole", event.target.value)}><option value="">Усі ролі</option>{eventRoleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label> : null}
          <label><span>Рік від</span><input type="number" min="1" max="2100" inputMode="numeric" value={filters.yearFrom ?? ""} onChange={(event) => updateFilter("yearFrom", cleanYear(event.target.value))} /></label>
          <label><span>Рік до</span><input type="number" min="1" max="2100" inputMode="numeric" value={filters.yearTo ?? ""} onChange={(event) => updateFilter("yearTo", cleanYear(event.target.value))} /></label>
          <button type="button" className="button button-secondary" onClick={() => setFilters(initialFilters)} disabled={filtersAreEmpty(filters)}>Скинути</button>
        </fieldset>
      </div>

      <div className="zagulyaky-places-explorer__status" aria-live="polite">
        {loading ? "Оновлюємо зв’язки…" : error || (selectedPlace ? `${readableNumber(totalRecordCount)} записів${totalMentionCount === undefined ? "" : ` · ${readableNumber(totalMentionCount)} згадок`} · ${readableNumber(visibleConnectionCount)} пов’язаних пунктів${hasMoreConnections ? ". Показано першу безпечну частину великого списку." : ""}` : "Оберіть населений пункт для перегляду зв’язків.")}
      </div>

      {selectedPlace && !loading && !error ? (
        view === "map" ? (
          <div className="zagulyaky-places-explorer__map-panel">
            <div className="zagulyaky-places-explorer__map-legend" aria-label="Позначки карти">
              <span className="selected"><i aria-hidden="true" />Обраний пункт</span>
              <span className="incoming"><i aria-hidden="true" />Звідки люди, знайдені тут</span>
              <span className="outgoing"><i aria-hidden="true" />Де знайдено людей звідси</span>
              {localRecordCount ? <span className="local"><i aria-hidden="true" />{readableNumber(localRecordCount)} згадок у межах цього пункту</span> : null}
            </div>
            <PlacesConnectionsMap selectedPlace={selectedPlace} connections={[...groups.incoming, ...groups.outgoing]} localRecordCount={localRecordCount} activeConnectionId={activeConnectionId} onSelectConnection={setActiveConnectionId} />
            <p className="zagulyaky-places-explorer__map-list-hint">Щоб переглянути всі записи та згадки без координат, перемкніться на «Список».</p>
          </div>
        ) : (
          <div className="zagulyaky-places-explorer__connection-groups">
            <ConnectionList direction="incoming" settlement={selectedPlace} connections={groups.incoming} activeConnectionId={activeConnectionId} onSelectConnection={setActiveConnectionId} onOpenRecords={onOpenRecords} filters={filters} headingId={headingId} />
            <ConnectionList direction="outgoing" settlement={selectedPlace} connections={groups.outgoing} activeConnectionId={activeConnectionId} onSelectConnection={setActiveConnectionId} onOpenRecords={onOpenRecords} filters={filters} headingId={headingId} />
            <ConnectionList direction="local" settlement={selectedPlace} connections={groups.local} activeConnectionId={activeConnectionId} onSelectConnection={setActiveConnectionId} onOpenRecords={onOpenRecords} filters={filters} headingId={headingId} />
          </div>
        )
      ) : null}
    </section>
  );
}
