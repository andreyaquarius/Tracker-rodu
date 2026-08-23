import type { GeoPoint } from "../../types";
import { isValidCoordinate } from "../../utils/geo.ts";

export type ZagulyakaMapRole = "origin" | "found";

export type ZagulyakaResolvedGeoPoint = GeoPoint & {
  latitude: number;
  longitude: number;
};

export interface ZagulyakaRouteMapStop {
  role: ZagulyakaMapRole;
  roleLabel: string;
  placeLabel: string;
  geo: ZagulyakaResolvedGeoPoint;
}

function resolvedGeoPoint(value: GeoPoint | null | undefined): ZagulyakaResolvedGeoPoint | null {
  if (!value || !isValidCoordinate(value.latitude, value.longitude)) return null;
  return {
    ...value,
    latitude: Number(value.latitude),
    longitude: Number(value.longitude),
  };
}

function displayLabel(placeLabel: string | null | undefined, geo: GeoPoint): string {
  return placeLabel?.trim() || geo.displayName?.trim() || "Точне місце на карті";
}

/**
 * Map pins are independent from the source wording.  This model intentionally
 * accepts one pin too: a partial, confirmed location remains useful, but it
 * never implies a line or a route.
 */
export function buildZagulyakaRouteMapStops({
  origin,
  found,
  originPlaceLabel,
  foundPlaceLabel,
  originRoleLabel = "Звідки",
  foundRoleLabel = "Де знайдено",
}: {
  origin: GeoPoint | null | undefined;
  found: GeoPoint | null | undefined;
  originPlaceLabel?: string | null;
  foundPlaceLabel?: string | null;
  originRoleLabel?: string;
  foundRoleLabel?: string;
}): ZagulyakaRouteMapStop[] {
  const originPoint = resolvedGeoPoint(origin);
  const foundPoint = resolvedGeoPoint(found);
  return [
    originPoint ? {
      role: "origin" as const,
      roleLabel: originRoleLabel,
      placeLabel: displayLabel(originPlaceLabel, originPoint),
      geo: originPoint,
    } : null,
    foundPoint ? {
      role: "found" as const,
      roleLabel: foundRoleLabel,
      placeLabel: displayLabel(foundPlaceLabel, foundPoint),
      geo: foundPoint,
    } : null,
  ].filter((item): item is ZagulyakaRouteMapStop => item !== null);
}

export function hasZagulyakaRouteMapLine(stops: readonly ZagulyakaRouteMapStop[]): boolean {
  if (stops.length !== 2) return false;
  const [first, second] = stops;
  return first.geo.latitude !== second.geo.latitude || first.geo.longitude !== second.geo.longitude;
}
