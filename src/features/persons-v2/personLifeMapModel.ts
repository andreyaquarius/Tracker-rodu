import type { PersonEventType } from "../../types/index.ts";
import { geoMarkerColor, isValidCoordinate } from "../../utils/geo.ts";
import { personEventVisual } from "../../utils/personEventVisuals.ts";
import type { PersonTimelineItem } from "./model.ts";
import {
  personTimelineDateDisplay,
  personTimelineEventDisplayTitle,
} from "./presentation.ts";

export interface PersonLifeMapStop {
  id: string;
  eventId: string;
  type: PersonEventType;
  sequence: number;
  title: string;
  date: string;
  placeName: string;
  latitude: number;
  longitude: number;
  color: string;
}

export interface PersonLifeMapStopGroup {
  key: string;
  latitude: number;
  longitude: number;
  stops: PersonLifeMapStop[];
}

export function buildPersonLifeMapStops(
  timeline: readonly PersonTimelineItem[],
): PersonLifeMapStop[] {
  const located = timeline.filter((event) => isValidCoordinate(
    event.geo?.latitude,
    event.geo?.longitude,
  ));
  return located.map((event, index) => {
    const visual = personEventVisual(event.type);
    return {
      id: `${event.source}:${event.id}`,
      eventId: event.id,
      type: event.type,
      sequence: index + 1,
      title: personTimelineEventDisplayTitle(event),
      date: personTimelineDateDisplay(event.date),
      placeName: event.placeName?.trim() || event.geo?.displayName?.trim() || "Місце без назви",
      latitude: Number(event.geo?.latitude),
      longitude: Number(event.geo?.longitude),
      color: geoMarkerColor(event.geo?.markerColor, visual.color),
    };
  });
}

export function groupPersonLifeMapStops(
  stops: readonly PersonLifeMapStop[],
): PersonLifeMapStopGroup[] {
  const groups = new Map<string, PersonLifeMapStopGroup>();
  for (const stop of stops) {
    const key = `${stop.latitude.toFixed(5)}:${stop.longitude.toFixed(5)}`;
    const group = groups.get(key);
    if (group) group.stops.push(stop);
    else groups.set(key, {
      key,
      latitude: stop.latitude,
      longitude: stop.longitude,
      stops: [stop],
    });
  }
  return [...groups.values()];
}
