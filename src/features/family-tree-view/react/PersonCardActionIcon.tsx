"use client";

import type { ReactElement } from "react";

export type PersonCardActionIconKind =
  | "focus"
  | "descendants"
  | "collapse-branches"
  | "expand-branches";

export function PersonCardActionIcon({
  kind,
}: {
  kind: PersonCardActionIconKind;
}): ReactElement {
  if (kind === "focus") {
    return (
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3" />
        <circle cx="12" cy="9" r="2.4" />
        <path d="M7.5 17c.8-2.3 2.3-3.5 4.5-3.5s3.7 1.2 4.5 3.5" />
      </svg>
    );
  }

  if (kind === "descendants") {
    return (
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <circle cx="12" cy="4.5" r="2" />
        <path d="M12 6.5v4.5M5 11h14M5 11v5M12 11v5M19 11v5" />
        <circle cx="5" cy="19" r="2" />
        <circle cx="12" cy="19" r="2" />
        <circle cx="19" cy="19" r="2" />
      </svg>
    );
  }

  const expanded = kind === "collapse-branches";
  return (
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <circle cx="7" cy="6" r="1.8" />
      <circle cx="7" cy="18" r="1.8" />
      <path d="M8.8 6H11a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3h.2M8.8 18H11a3 3 0 0 0 3-3" />
      {expanded ? <path d="m17 7 3 3 3-3" /> : <path d="m17 10 3-3 3 3" />}
    </svg>
  );
}
