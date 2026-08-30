export const TRACKER_RODU_CHART_BRAND_NAME = "Трекер Роду";
export const TRACKER_RODU_CHART_LOGO_URL = "/tracker-rodu-logo.png";

const SVG_XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const BRAND_VIEWBOX_WIDTH = 240;
const BRAND_VIEWBOX_HEIGHT = 56;
const BRAND_ASPECT_RATIO = BRAND_VIEWBOX_WIDTH / BRAND_VIEWBOX_HEIGHT;

export interface FamilyTreeChartBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FamilyTreeChartViewport {
  width: number;
  height: number;
}

export interface FamilyTreeChartBrandPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FamilyTreeChartBrandCorner = "top-right" | "bottom-right";

let logoDataUrlPromise: Promise<string> | null = null;

/**
 * Keeps the on-screen badge readable while the chart is zoomed or panned.
 * The returned values use chart-world coordinates, but resolve to an almost
 * constant pixel size in the current viewport.
 */
export function familyTreeChartBrandScreenPlacement(
  bounds: FamilyTreeChartBounds,
  viewport: FamilyTreeChartViewport,
  corner: FamilyTreeChartBrandCorner = "bottom-right",
): FamilyTreeChartBrandPlacement {
  const normalizedBounds = normalizeBounds(bounds);
  const viewportWidth = positiveFinite(viewport.width, 800);
  const viewportHeight = positiveFinite(viewport.height, 600);
  const pixelsPerWorldUnit = Math.max(
    1e-6,
    Math.min(
      viewportWidth / normalizedBounds.width,
      viewportHeight / normalizedBounds.height,
    ),
  );
  const worldUnitsPerPixel = 1 / pixelsPerWorldUnit;
  const targetWidthPixels = clamp(viewportWidth * 0.24, 118, 184);
  const width = Math.min(
    targetWidthPixels * worldUnitsPerPixel,
    normalizedBounds.width * 0.4,
  );
  const height = width / BRAND_ASPECT_RATIO;
  const inset = 12 * worldUnitsPerPixel;

  return roundedPlacement({
    x: normalizedBounds.x + normalizedBounds.width - width - inset,
    y: corner === "top-right"
      ? normalizedBounds.y + inset
      : normalizedBounds.y + normalizedBounds.height - height - inset,
    width,
    height,
  });
}

/** Reanchors the badge to the full chart rather than the current camera. */
export function familyTreeChartBrandExportPlacement(
  bounds: FamilyTreeChartBounds,
  corner: FamilyTreeChartBrandCorner = "bottom-right",
): FamilyTreeChartBrandPlacement {
  const normalizedBounds = normalizeBounds(bounds);
  const shortSide = Math.min(normalizedBounds.width, normalizedBounds.height);
  const height = clamp(shortSide * 0.055, 32, 72);
  const width = height * BRAND_ASPECT_RATIO;
  const inset = height * 0.3;

  return roundedPlacement({
    x: normalizedBounds.x + normalizedBounds.width - width - inset,
    y: corner === "top-right"
      ? normalizedBounds.y + inset
      : normalizedBounds.y + normalizedBounds.height - height - inset,
    width,
    height,
  });
}

/**
 * Uses the canonical public logo and caches its self-contained representation.
 * Exported SVG, PNG and PDF files therefore never depend on a live website URL.
 */
export function loadTrackerRoduChartLogoDataUrl(): Promise<string> {
  if (logoDataUrlPromise) return logoDataUrlPromise;

  logoDataUrlPromise = fetch(TRACKER_RODU_CHART_LOGO_URL, {
    cache: "force-cache",
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.blob();
    })
    .then(blobToDataUrl)
    .catch((error: unknown) => {
      logoDataUrlPromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Не вдалося додати логотип Трекера Роду до діаграми: ${detail}`);
    });

  return logoDataUrlPromise;
}

export function prepareFamilyTreeChartBrandForExport(
  svg: SVGSVGElement,
  bounds: FamilyTreeChartBounds,
  logoDataUrl: string,
  corner: FamilyTreeChartBrandCorner = "bottom-right",
): void {
  if (!logoDataUrl.startsWith("data:image/")) {
    throw new Error("Логотип діаграми не вдалося вбудувати у файл.");
  }

  const brand = svg.querySelector<SVGSVGElement>(
    "[data-family-tree-chart-brand]",
  );
  const logo = brand?.querySelector<SVGImageElement>(
    "[data-family-tree-chart-brand-logo]",
  );
  if (!brand || !logo) {
    throw new Error("У діаграмі відсутній фірмовий підпис Трекера Роду.");
  }

  const placement = familyTreeChartBrandExportPlacement(bounds, corner);
  brand.setAttribute("x", String(placement.x));
  brand.setAttribute("y", String(placement.y));
  brand.setAttribute("width", String(placement.width));
  brand.setAttribute("height", String(placement.height));
  logo.setAttribute("href", logoDataUrl);
  logo.setAttributeNS(SVG_XLINK_NAMESPACE, "xlink:href", logoDataUrl);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:image/")) {
        resolve(reader.result);
        return;
      }
      reject(new Error("отримано некоректний формат зображення"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("не вдалося прочитати файл логотипа"));
    reader.readAsDataURL(blob);
  });
}

function normalizeBounds(bounds: FamilyTreeChartBounds): FamilyTreeChartBounds {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new Error("Не вдалося визначити межі діаграми для фірмового підпису.");
  }
  return bounds;
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundedPlacement(
  placement: FamilyTreeChartBrandPlacement,
): FamilyTreeChartBrandPlacement {
  return {
    x: round(placement.x),
    y: round(placement.y),
    width: round(placement.width),
    height: round(placement.height),
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
