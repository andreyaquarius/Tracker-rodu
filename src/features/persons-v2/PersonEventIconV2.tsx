import type { CSSProperties } from "react";
import type { PersonEventType } from "../../types/index.ts";
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
  return (
    <span
      className={`person-event-icon-v2${className ? ` ${className}` : ""}`}
      style={{
        "--person-event-color": visual.color,
        "--person-event-background": visual.background,
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
