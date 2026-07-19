export interface EditorSectionViewportRect<Key extends string = string> {
  key: Key;
  top: number;
  bottom: number;
}

const ACTIVE_BAND_TOP_RATIO = 0.15;
const ACTIVE_BAND_BOTTOM_RATIO = 0.35;

/**
 * Resolves the editor section occupying the stable activation band near the
 * top of the viewport. A section requested by a navigation click wins while
 * the browser is completing the programmatic scroll.
 */
export function resolveEditorSectionAtViewport<Key extends string>(
  requestedSection: Key | null,
  sections: readonly EditorSectionViewportRect<Key>[],
  viewportHeight: number,
): Key | null {
  if (requestedSection) return requestedSection;
  if (!sections.length || viewportHeight <= 0) return null;

  const bandTop = viewportHeight * ACTIVE_BAND_TOP_RATIO;
  const bandBottom = viewportHeight * ACTIVE_BAND_BOTTOM_RATIO;
  let best: { key: Key; overlap: number; distance: number; order: number } | null = null;

  for (let order = 0; order < sections.length; order += 1) {
    const section = sections[order];
    const overlap = Math.max(
      0,
      Math.min(section.bottom, bandBottom) - Math.max(section.top, bandTop),
    );
    if (overlap <= 0) continue;
    const distance = Math.abs(section.top - bandTop);
    if (
      !best
      || overlap > best.overlap
      || (overlap === best.overlap && distance < best.distance)
      || (overlap === best.overlap && distance === best.distance && order < best.order)
    ) {
      best = { key: section.key, overlap, distance, order };
    }
  }

  return best?.key ?? null;
}
