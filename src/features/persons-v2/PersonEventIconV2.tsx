import type { CSSProperties } from "react";
import type { PersonEventType } from "../../types/index.ts";
import { useAppAppearance } from "../../components/appearance/AppAppearanceProvider.tsx";
import { starryTreeTone } from "../family-tree-view/appearance/starrySkyTheme.ts";
import {
  personEventVisual,
  personEventIconSvgBody,
} from "../../utils/personEventVisuals.ts";

export function PersonEventIconV2({
  type,
  className = "",
}: {
  type: PersonEventType;
  className?: string;
}) {
  const visual = personEventVisual(type);
  const { appearance } = useAppAppearance();
  const night = appearance.theme === "starry-dark" ? starryTreeTone(visual.color) : null;
  return (
    <span
      className={`person-event-icon-v2${className ? ` ${className}` : ""}`}
      style={{
        "--person-event-color": night?.stroke ?? visual.color,
        "--person-event-background": night?.fill ?? visual.background,
      } as CSSProperties}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        focusable="false"
        dangerouslySetInnerHTML={{ __html: personEventIconSvgBody(visual.icon) }}
      />
    </span>
  );
}
