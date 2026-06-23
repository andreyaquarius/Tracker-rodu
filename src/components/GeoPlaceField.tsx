import { useEffect, useRef, useState, type CSSProperties } from "react";
import L from "leaflet";
import type { GeoPoint } from "../types";
import { reversePlace, searchPlaces, type PlaceSuggestion } from "../services/placeSearch";
import { Modal } from "./Modal";
import { DEFAULT_GEO_MARKER_COLOR, GEO_MARKER_COLORS, geoMarkerColor } from "../utils/geo";

const DEFAULT_CENTER: [number, number] = [49.0, 31.0];

function hasCoordinates(value: GeoPoint | null): value is GeoPoint & { latitude: number; longitude: number } {
  return Boolean(
    value &&
    Number.isFinite(value.latitude) &&
    Number.isFinite(value.longitude),
  );
}

function formatGeoName(value: GeoPoint | null, fallback = ""): string {
  return value?.displayName || fallback || "Місце вибрано";
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

export function GeoPlaceField({
  label,
  value,
  placeName,
  onChange,
  onPlaceNameChange,
}: {
  label: string;
  value: GeoPoint | null;
  placeName?: string;
  onChange: (value: GeoPoint | null) => void;
  onPlaceNameChange?: (value: string) => void;
}) {
  const [query, setQuery] = useState(placeName || value?.displayName || "");
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedColor, setSelectedColor] = useState(() =>
    geoMarkerColor(value?.markerColor, DEFAULT_GEO_MARKER_COLOR),
  );

  useEffect(() => {
    setQuery(placeName || value?.displayName || "");
  }, [placeName, value?.displayName]);

  useEffect(() => {
    setSelectedColor(geoMarkerColor(value?.markerColor, selectedColor));
  }, [value?.markerColor]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 3) {
      setSuggestions([]);
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
  }, [query]);

  const selectSuggestion = (suggestion: PlaceSuggestion) => {
    setQuery(suggestion.geo.displayName || suggestion.label);
    setSuggestions([]);
    onPlaceNameChange?.(suggestion.geo.displayName || suggestion.label);
    onChange({ ...suggestion.geo, markerColor: selectedColor });
  };

  const updateQuery = (next: string) => {
    setQuery(next);
    onPlaceNameChange?.(next);
    if (!next.trim()) onChange(null);
  };

  const updateMarkerColor = (color: string) => {
    const markerColor = geoMarkerColor(color);
    setSelectedColor(markerColor);
    if (value) onChange({ ...value, markerColor });
  };

  return (
    <div className="geo-field field-wide">
      <div className="geo-field-heading">
        <span>{label}</span>
        {value ? <small>Позначка збережеться на карті</small> : <small>Почніть вводити назву місця</small>}
      </div>
      <div className="geo-search-row">
        <input
          value={query}
          placeholder="Назва населеного пункту або місця"
          onChange={(event) => updateQuery(event.target.value)}
        />
        <button type="button" className="button button-secondary" onClick={() => setPickerOpen(true)}>
          Вибрати на карті
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
      {value ? (
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
          <div className="geo-selected">
            <span>{formatGeoName(value, query)}</span>
            <button type="button" onClick={() => onChange(null)}>Прибрати позначку</button>
          </div>
        </>
      ) : null}
      {pickerOpen ? (
        <GeoMapPicker
          value={value}
          placeName={query}
          markerColor={selectedColor}
          onClose={() => setPickerOpen(false)}
          onSave={(geo) => {
            const displayName = geo.displayName || query || "Позначка на карті";
            onPlaceNameChange?.(displayName);
            setQuery(displayName);
            onChange({ ...geo, displayName, markerColor: selectedColor });
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
  onClose,
  onSave,
}: {
  value: GeoPoint | null;
  placeName: string;
  markerColor: string;
  onClose: () => void;
  onSave: (value: GeoPoint) => void;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const lookupRef = useRef(0);
  const [draft, setDraft] = useState<GeoPoint | null>(value);
  const [resolvingPlace, setResolvingPlace] = useState(false);
  const [lookupError, setLookupError] = useState("");

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;
    const center = hasCoordinates(value) ? [value.latitude, value.longitude] as [number, number] : DEFAULT_CENTER;
    const map = L.map(mapRef.current, { zoomControl: true }).setView(center, hasCoordinates(value) ? 12 : 6);
    mapInstance.current = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    const setMarker = (latlng: L.LatLngExpression) => {
      if (!markerRef.current) {
        markerRef.current = L.marker(latlng, {
          icon: markerIcon(markerColor),
        }).addTo(map);
      } else {
        markerRef.current.setLatLng(latlng);
        markerRef.current.setIcon(markerIcon(markerColor));
      }
    };

    if (hasCoordinates(value)) {
      setMarker([value.latitude, value.longitude]);
    }
    map.on("click", (event) => {
      const lookupId = lookupRef.current + 1;
      lookupRef.current = lookupId;
      setMarker(event.latlng);
      setResolvingPlace(true);
      setLookupError("");
      const fallbackName = placeName || value?.displayName || "Позначка на карті";
      setDraft({
        displayName: fallbackName,
        latitude: event.latlng.lat,
        longitude: event.latlng.lng,
        source: "map_click",
        precision: "approximate",
        provider: "OpenStreetMap",
        externalId: null,
        markerColor,
      });
      reversePlace(event.latlng.lat, event.latlng.lng)
        .then((suggestion) => {
          if (lookupRef.current !== lookupId) return;
          if (!suggestion) return;
          setDraft({
            ...suggestion.geo,
            displayName: suggestion.geo.displayName || suggestion.label || fallbackName,
            latitude: event.latlng.lat,
            longitude: event.latlng.lng,
            source: "map_click",
            precision: suggestion.geo.precision || "approximate",
            markerColor,
          });
        })
        .catch(() => {
          if (lookupRef.current !== lookupId) return;
          setLookupError("Не вдалося автоматично визначити назву місця. Можна зберегти позначку і вписати назву вручну.");
        })
        .finally(() => {
          if (lookupRef.current === lookupId) setResolvingPlace(false);
        });
    });
    window.setTimeout(() => map.invalidateSize(), 50);
    return () => {
      map.remove();
      mapInstance.current = null;
      markerRef.current = null;
    };
  }, []);

  return (
    <Modal title="Вибрати місце на карті" onClose={onClose}>
      <div className="geo-picker">
        <p>Клацніть на карті в потрібному місці, а потім збережіть позначку.</p>
        <div className="geo-picker-map" ref={mapRef} />
        {resolvingPlace ? <p className="geo-hint">Визначаємо назву місця...</p> : null}
        {lookupError ? <p className="geo-hint geo-error">{lookupError}</p> : null}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button
            type="button"
            className="button button-primary"
            disabled={!hasCoordinates(draft) || resolvingPlace}
            onClick={() => draft && onSave(draft)}
          >
            Зберегти позначку
          </button>
        </div>
      </div>
    </Modal>
  );
}
