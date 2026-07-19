import { useEffect, useRef, useState, type CSSProperties } from "react";
import L from "leaflet";
import type { GeoPoint, PersonEventType } from "../types";
import { reversePlace, searchPlaces, type PlaceSuggestion } from "../services/placeSearch";
import { Modal } from "./Modal";
import {
  DEFAULT_GEO_MARKER_COLOR,
  formatGeoCoordinates,
  formatGeoSelectionLabel,
  GEO_MARKER_COLORS,
  geoMarkerColor,
  shouldSearchGeoPlaces,
} from "../utils/geo";
import { personEventIconSvgMarkup, personEventVisual } from "../utils/personEventVisuals";

const DEFAULT_CENTER: [number, number] = [49.0, 31.0];

function hasCoordinates(value: GeoPoint | null): value is GeoPoint & { latitude: number; longitude: number } {
  return Boolean(
    value &&
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude),
  );
}

function markerIcon(color: string, eventType?: PersonEventType): L.DivIcon {
  const safeColor = geoMarkerColor(color);
  if (eventType) {
    return L.divIcon({
      className: "tracker-map-marker-shell tracker-map-event-marker-shell",
      html: `<span class="tracker-map-event-marker" style="--marker-color:${safeColor}">${personEventIconSvgMarkup(eventType)}</span>`,
      iconSize: [30, 32],
      iconAnchor: [15, 30],
    });
  }
  return L.divIcon({
    className: "tracker-map-marker-shell",
    html: `<span class="tracker-map-marker" style="--marker-color:${safeColor}"></span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
  });
}

export function GeoPlaceField({
  label,
  value,
  placeName,
  eventType,
  onChange,
  onPlaceNameChange,
}: {
  label: string;
  value: GeoPoint | null;
  placeName?: string;
  eventType?: PersonEventType;
  onChange: (value: GeoPoint | null) => void;
  onPlaceNameChange?: (value: string) => void;
}) {
  const eventDefaultColor = eventType
    ? personEventVisual(eventType).color
    : DEFAULT_GEO_MARKER_COLOR;
  const [query, setQuery] = useState(placeName || value?.displayName || "");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedColor, setSelectedColor] = useState(() =>
    geoMarkerColor(value?.markerColor, eventDefaultColor),
  );

  useEffect(() => {
    setQuery(placeName || value?.displayName || "");
  }, [placeName, value?.displayName]);

  useEffect(() => {
    setSelectedColor(geoMarkerColor(value?.markerColor, eventDefaultColor));
  }, [eventDefaultColor, value?.markerColor]);

  useEffect(() => {
    const normalized = query.trim();
    if (!shouldSearchGeoPlaces(query, value)) {
      setSuggestions([]);
      setLoading(false);
      setError("");
      return;
    }
    let active = true;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      searchPlaces(normalized)
        .then((items) => {
          if (!active) return;
          setSuggestions(items);
          setError("");
        })
        .catch((err) => {
          if (!active) return;
          setSuggestions([]);
          setError(err instanceof Error ? err.message : "Не вдалося знайти місце.");
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 420);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [query, value?.latitude, value?.longitude]);

  const selectSuggestion = (suggestion: PlaceSuggestion) => {
    const nextName = suggestion.label || suggestion.geo.displayName || "Вибране місце";
    setQuery(nextName);
    setSuggestions([]);
    onPlaceNameChange?.(nextName);
    onChange({ ...suggestion.geo, markerColor: selectedColor });
  };

  const updateQuery = (next: string) => {
    setQuery(next);
    onPlaceNameChange?.(next);
  };

  const updateMarkerColor = (color: string) => {
    const markerColor = geoMarkerColor(color);
    setSelectedColor(markerColor);
    if (value) onChange({ ...value, markerColor });
  };

  const coordinates = formatGeoCoordinates(value);
  const selectedPointName = query.trim() || "Точна точка на карті";

  return (
    <div className="geo-field field-wide">
      <div className="geo-field-heading">
        <span>{label}</span>
        {hasCoordinates(value)
          ? <small>Точну точку збережено; назву можна змінити</small>
          : <small>Знайдіть місце або поставте точку вручну</small>}
      </div>
      <div className="geo-search-row">
        <input
          value={query}
          placeholder={hasCoordinates(value)
            ? "Власна назва точки або будинку"
            : "Назва населеного пункту або місця"}
          onChange={(event) => updateQuery(event.target.value)}
        />
        <button type="button" className="button button-secondary" onClick={() => setPickerOpen(true)}>
          {hasCoordinates(value) ? "Змінити точну точку" : "Поставити точку на карті"}
        </button>
      </div>
      {loading ? <p className="geo-hint">Шукаємо місця...</p> : null}
      {error ? <p className="geo-hint geo-error">{error}</p> : null}
      {suggestions.length ? (
        <div className="geo-suggestions">
          {suggestions.map((suggestion) => (
            <button type="button" key={suggestion.id} onClick={() => selectSuggestion(suggestion)}>
              <strong>{suggestion.label}</strong>
              {suggestion.details ? <span>{suggestion.details}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {hasCoordinates(value) ? (
        <>
          <div className="geo-color-picker">
            <span>Колір маркера</span>
            <div>
              {GEO_MARKER_COLORS.map((color) => (
                <button
                  type="button"
                  key={color}
                  className={geoMarkerColor(value.markerColor, selectedColor) === color ? "active" : ""}
                  style={{ "--swatch-color": color } as CSSProperties}
                  aria-label={`Вибрати колір маркера ${color}`}
                  onClick={() => updateMarkerColor(color)}
                />
              ))}
            </div>
          </div>
          <div
            className="geo-selected"
            aria-label={formatGeoSelectionLabel(query, value)}
          >
            <div className="geo-selected__details">
              <span>{selectedPointName}</span>
              <code>{coordinates}</code>
              {value.displayName && value.displayName !== selectedPointName
                ? <small>Адреса за картою: {value.displayName}</small>
                : null}
            </div>
            <button type="button" onClick={() => onChange(null)}>Прибрати позначку</button>
          </div>
        </>
      ) : null}
      {pickerOpen ? (
        <GeoMapPicker
          value={value}
          placeName={query}
          markerColor={selectedColor}
          eventType={eventType}
          onClose={() => setPickerOpen(false)}
          onSave={(geo, pointName) => {
            const nextName = pointName.trim() || query.trim() || geo.displayName || "Точна точка на карті";
            onPlaceNameChange?.(nextName);
            setQuery(nextName);
            onChange({ ...geo, markerColor: selectedColor });
            setPickerOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function GeoMapPicker({
  value,
  placeName,
  markerColor,
  eventType,
  onClose,
  onSave,
}: {
  value: GeoPoint | null;
  placeName: string;
  markerColor: string;
  eventType?: PersonEventType;
  onClose: () => void;
  onSave: (value: GeoPoint, pointName: string) => void;
}) {
  const initialPointName = placeName.trim() || value?.displayName || "";
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const lookupRef = useRef(0);
  const pointNameRef = useRef(initialPointName);
  const pointNameEditedRef = useRef(Boolean(placeName.trim()));
  const [draft, setDraft] = useState<GeoPoint | null>(value);
  const [draftName, setDraftName] = useState(initialPointName);
  const [resolvingPlace, setResolvingPlace] = useState(false);
  const [lookupError, setLookupError] = useState("");

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const center = hasCoordinates(value) ? [value.latitude, value.longitude] as [number, number] : DEFAULT_CENTER;
    const map = L.map(mapRef.current, { zoomControl: true }).setView(center, hasCoordinates(value) ? 18 : 6);
    mapInstance.current = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    function selectPoint(latitude: number, longitude: number) {
      const lookupId = lookupRef.current + 1;
      lookupRef.current = lookupId;
      setMarker([latitude, longitude]);
      setResolvingPlace(true);
      setLookupError("");
      const fallbackAddress = value?.displayName || null;
      setDraft({
        displayName: fallbackAddress,
        latitude,
        longitude,
        source: "map_click",
        precision: "exact",
        provider: "OpenStreetMap",
        externalId: null,
        markerColor,
      });
      reversePlace(latitude, longitude)
        .then((suggestion) => {
          if (lookupRef.current !== lookupId || !suggestion) return;
          const fullAddress = suggestion.geo.displayName || suggestion.details || suggestion.label || fallbackAddress;
          setDraft({
            ...suggestion.geo,
            displayName: fullAddress,
            latitude,
            longitude,
            source: "map_click",
            precision: "exact",
            markerColor,
          });
          if (!pointNameEditedRef.current) {
            const suggestedName = suggestion.label || fullAddress || "Точна точка на карті";
            pointNameRef.current = suggestedName;
            setDraftName(suggestedName);
          }
        })
        .catch(() => {
          if (lookupRef.current !== lookupId) return;
          setLookupError("Не вдалося автоматично визначити адресу. Точні координати вже можна зберегти, а назву — вписати вручну.");
        })
        .finally(() => {
          if (lookupRef.current === lookupId) setResolvingPlace(false);
        });
    }

    function setMarker(latlng: L.LatLngExpression) {
      if (!markerRef.current) {
        const marker = L.marker(latlng, {
          icon: markerIcon(markerColor, eventType),
          draggable: true,
        }).addTo(map);
        marker.on("dragend", () => {
          const position = marker.getLatLng();
          selectPoint(position.lat, position.lng);
        });
        markerRef.current = marker;
      } else {
        markerRef.current.setLatLng(latlng);
        markerRef.current.setIcon(markerIcon(markerColor, eventType));
      }
    }

    if (hasCoordinates(value)) {
      setMarker([value.latitude, value.longitude]);
    }
    map.on("click", (event) => selectPoint(event.latlng.lat, event.latlng.lng));
    window.setTimeout(() => map.invalidateSize(), 50);
    return () => {
      lookupRef.current += 1;
      map.remove();
      mapInstance.current = null;
      markerRef.current = null;
    };
  }, []);

  const updateDraftName = (next: string) => {
    pointNameEditedRef.current = true;
    pointNameRef.current = next;
    setDraftName(next);
  };

  return (
    <Modal title="Вибрати точне місце на карті" onClose={onClose}>
      <div className="geo-picker">
        <p>Клацніть у потрібному місці або перетягніть позначку прямо на будинок.</p>
        <div className="geo-picker-map" ref={mapRef} />
        {hasCoordinates(draft) ? (
          <div className="geo-picker-point-editor">
            <label>
              <span>Назва точки або будинку</span>
              <input
                value={draftName}
                placeholder="Наприклад: Хата № 2 або Садиба біля церкви"
                onChange={(event) => updateDraftName(event.target.value)}
              />
            </label>
            <div className="geo-picker-point-editor__coordinates">
              <span>Точні координати</span>
              <code>{formatGeoCoordinates(draft)}</code>
            </div>
            {draft.displayName ? <p>Адреса за картою: {draft.displayName}</p> : null}
          </div>
        ) : null}
        {resolvingPlace ? <p className="geo-hint">Уточнюємо адресу; точку вже можна зберегти...</p> : null}
        {lookupError ? <p className="geo-hint geo-error">{lookupError}</p> : null}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button
            type="button"
            className="button button-primary"
            disabled={!hasCoordinates(draft)}
            onClick={() => draft && onSave(draft, pointNameRef.current)}
          >
            Зберегти точну точку
          </button>
        </div>
      </div>
    </Modal>
  );
}
