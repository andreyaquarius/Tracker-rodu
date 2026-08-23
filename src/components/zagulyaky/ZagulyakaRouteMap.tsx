import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import type { GeoPoint } from "../../types";
import {
  buildZagulyakaRouteMapStops,
  hasZagulyakaRouteMapLine,
} from "../../features/zagulyaky/zagulyakaRouteMapModel";

const MAP_COLORS = {
  origin: "#c49a32",
  found: "#0f4a42",
} as const;

export function ZagulyakaRouteMap({
  origin,
  found,
  originPlaceLabel,
  foundPlaceLabel,
  originRoleLabel = "Звідки",
  foundRoleLabel = "Де знайдено",
  title = "Карта пов’язаних місць",
  preview = false,
}: {
  origin: GeoPoint | null | undefined;
  found: GeoPoint | null | undefined;
  originPlaceLabel?: string | null;
  foundPlaceLabel?: string | null;
  originRoleLabel?: string;
  foundRoleLabel?: string;
  title?: string;
  /** The same map may be shown before saving a draft. */
  preview?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const stops = useMemo(() => buildZagulyakaRouteMapStops({
    origin,
    found,
    originPlaceLabel,
    foundPlaceLabel,
    originRoleLabel,
    foundRoleLabel,
  }), [origin, found, originPlaceLabel, foundPlaceLabel, originRoleLabel, foundRoleLabel]);
  const hasStops = stops.length > 0;
  const hasLine = hasZagulyakaRouteMapLine(stops);

  useEffect(() => {
    if (!hasStops || !containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      attributionControl: true,
      scrollWheelZoom: false,
      zoomControl: true,
    }).setView([49, 31], 6);
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
    window.setTimeout(() => map.invalidateSize({ pan: false }), 80);
    return () => {
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, [hasStops]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer || !hasStops) return;
    layer.clearLayers();

    const coordinates = stops.map((stop) => [stop.geo.latitude, stop.geo.longitude] as [number, number]);
    if (hasLine) {
      L.polyline(coordinates, {
        color: "#28695e",
        weight: 2,
        opacity: 0.82,
        dashArray: "5 7",
      }).addTo(layer);
    }

    const samePoint = stops.length === 2 && !hasLine;
    if (samePoint) {
      const [originStop, foundStop] = stops;
      const outer = L.circleMarker(coordinates[0], {
        radius: 10,
        color: MAP_COLORS.origin,
        weight: 3,
        fillColor: MAP_COLORS.origin,
        fillOpacity: 0.24,
      }).addTo(layer);
      L.circleMarker(coordinates[0], {
        radius: 5,
        color: MAP_COLORS.found,
        weight: 2,
        fillColor: MAP_COLORS.found,
        fillOpacity: 0.96,
      }).addTo(layer);
      const tooltip = document.createElement("span");
      tooltip.textContent = `${originStop.roleLabel}: ${originStop.placeLabel} · ${foundStop.roleLabel}: ${foundStop.placeLabel}`;
      outer.bindTooltip(tooltip, { direction: "top", offset: [0, -10] });
    } else {
      stops.forEach((stop) => {
        const marker = L.circleMarker([stop.geo.latitude, stop.geo.longitude], {
          radius: 7,
          color: MAP_COLORS[stop.role],
          weight: 2,
          fillColor: MAP_COLORS[stop.role],
          fillOpacity: 0.9,
        }).addTo(layer);
        const tooltip = document.createElement("span");
        tooltip.textContent = `${stop.roleLabel}: ${stop.placeLabel}`;
        marker.bindTooltip(tooltip, { direction: "top", offset: [0, -8] });
      });
    }

    if (coordinates.length === 1 || samePoint) map.setView(coordinates[0], 11);
    else map.fitBounds(L.latLngBounds(coordinates), { padding: [26, 26], maxZoom: 11 });
  }, [hasLine, hasStops, stops]);

  if (!hasStops) return null;

  return (
    <section className={`zagulyaky-route-map${preview ? " zagulyaky-route-map-preview" : ""}`} aria-label={title}>
      <header>
        <div>
          <span className="eyebrow">Географічний зв’язок</span>
          <h3>{title}</h3>
        </div>
        <ul aria-label="Позначки карти">
          {stops.map((stop) => (
            <li key={stop.role} className={`zagulyaky-route-map__legend-${stop.role}`}>
              <span aria-hidden="true" />
              <div><strong>{stop.roleLabel}</strong><small>{stop.placeLabel}</small></div>
            </li>
          ))}
        </ul>
      </header>
      <div
        ref={containerRef}
        className="zagulyaky-route-map__canvas"
        aria-label={`Карта: ${stops.map((stop) => `${stop.roleLabel} — ${stop.placeLabel}`).join("; ")}`}
      />
      <p>
        {hasLine
          ? "Пунктир поєднує два підтверджені місця. Це не маршрут або доказ переміщення людини."
          : "Додано одну точку. Лінія з’явиться, коли будуть підтверджені обидва місця."}
      </p>
    </section>
  );
}

