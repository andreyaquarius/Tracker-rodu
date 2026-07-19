import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import type { PersonTimelineItem } from "./model.ts";
import {
  buildPersonLifeMapStops,
  groupPersonLifeMapStops,
  type PersonLifeMapStopGroup,
} from "./personLifeMapModel.ts";
import { personEventIconSvgMarkup } from "../../utils/personEventVisuals.ts";

export function PersonLifeMapV2({
  timeline,
  onOpenFullMap,
}: {
  timeline: readonly PersonTimelineItem[];
  onOpenFullMap?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const stops = useMemo(() => buildPersonLifeMapStops(timeline), [timeline]);
  const groups = useMemo(() => groupPersonLifeMapStops(stops), [stops]);
  const hasStops = stops.length > 0;

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
    if (!map || !layer || !stops.length) return;
    layer.clearLayers();
    const route = stops.map((stop) => [stop.latitude, stop.longitude] as [number, number]);
    if (route.length > 1) {
      L.polyline(route, {
        color: "#28695e",
        weight: 2,
        opacity: .78,
        dashArray: "5 7",
      }).addTo(layer);
    }
    groups.forEach((group) => {
      const first = group.stops[0];
      const marker = L.marker([group.latitude, group.longitude], {
        icon: lifeMapMarkerIcon(group),
        keyboard: true,
        title: `${first.sequence}. ${first.title}: ${first.placeName}`,
      }).addTo(layer);
      const tooltip = document.createElement("span");
      tooltip.textContent = group.stops
        .map((stop) => `${stop.sequence}. ${stop.title} — ${stop.placeName}`)
        .join(" · ");
      marker.bindTooltip(tooltip, { direction: "top", offset: [0, -18] });
    });
    const bounds = L.latLngBounds(route);
    if (route.length === 1) map.setView(route[0], 11);
    else map.fitBounds(bounds, { padding: [26, 26], maxZoom: 11 });
  }, [groups, stops]);

  return (
    <section className="persons-v2-life-map" aria-labelledby="persons-v2-life-map-title">
      <header>
        <div>
          <span className="persons-v2-life-map__eyebrow">Географія життя</span>
          <h3 id="persons-v2-life-map-title">Карта місць</h3>
        </div>
        {onOpenFullMap ? (
          <button type="button" className="text-button" onClick={onOpenFullMap}>
            Відкрити велику карту ↗
          </button>
        ) : null}
      </header>
      {hasStops ? (
        <>
          <div
            ref={containerRef}
            className="persons-v2-life-map__canvas"
            aria-label={`Карта з ${stops.length} позначками життєвих подій`}
          />
          <ol className="persons-v2-life-map__legend">
            {stops.slice(0, 5).map((stop) => (
              <li key={stop.id}>
                <span
                  className="persons-v2-life-map__legend-icon"
                  style={{ backgroundColor: stop.color }}
                  dangerouslySetInnerHTML={{ __html: personEventIconSvgMarkup(stop.type) }}
                />
                <span>
                  <strong>{stop.title}</strong>
                  <small>{[stop.date, stop.placeName].filter(Boolean).join(" · ")}</small>
                </span>
              </li>
            ))}
          </ol>
          {stops.length > 5 ? (
            <p className="persons-v2-life-map__more">{moreStopsLabel(stops.length - 5)} видно на карті.</p>
          ) : null}
        </>
      ) : (
        <div className="persons-v2-life-map__empty">
          <span aria-hidden="true">⌖</span>
          <strong>Позначок ще немає</strong>
          <p>Додайте координати у розділі «Місця» редактора особи — вони з’являться тут і на великій карті.</p>
        </div>
      )}
    </section>
  );
}

function moreStopsLabel(count: number): string {
  if (count === 1) return "Ще одна позначка";
  const lastTwo = count % 100;
  const last = count % 10;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) {
    return `Ще ${count} позначки`;
  }
  return `Ще ${count} позначок`;
}

function lifeMapMarkerIcon(group: PersonLifeMapStopGroup): L.DivIcon {
  const first = group.stops[0];
  const count = group.stops.length;
  return L.divIcon({
    className: "persons-v2-life-map__marker-shell",
    html: `<span class="persons-v2-life-map__marker" style="--life-map-color:${first.color}">${personEventIconSvgMarkup(first.type)}</span>${count > 1 ? `<span class="persons-v2-life-map__marker-count">+${count - 1}</span>` : ""}`,
    iconSize: count > 1 ? [36, 34] : [30, 34],
    iconAnchor: [15, 32],
  });
}
