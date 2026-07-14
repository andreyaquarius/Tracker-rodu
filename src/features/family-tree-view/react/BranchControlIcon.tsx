"use client";

import type { ReactElement } from "react";
import type { TreeContinuation } from "../types.ts";

export interface BranchControlIconProps {
  direction: TreeContinuation["direction"] | "family-children";
  expanded?: boolean;
}

/**
 * Small branch controls need shapes that remain distinguishable when the
 * canvas is zoomed. These icons deliberately use different silhouettes, not
 * just different colours, so the action is still clear in monochrome and for
 * users with colour-vision differences.
 */
export function BranchControlIcon({
  direction,
  expanded = false,
}: BranchControlIconProps): ReactElement {
  if (expanded) {
    return (
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M5.5 15.5 12 9l6.5 6.5" />
        <path d="M12 9v10" />
      </svg>
    );
  }

  if (direction === "parents") {
    return (
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M12 20v-7M12 13 6.5 7.5M12 13l5.5-5.5" />
        <circle cx="6.5" cy="6" r="2" />
        <circle cx="17.5" cy="6" r="2" />
      </svg>
    );
  }

  if (direction === "partners") {
    return (
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <circle cx="6.5" cy="12" r="3" />
        <circle cx="17.5" cy="12" r="3" />
        <path d="M9.5 12h5" />
      </svg>
    );
  }

  if (direction === "siblings") {
    return (
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <circle cx="5" cy="12" r="2.25" />
        <circle cx="12" cy="12" r="2.25" />
        <circle cx="19" cy="12" r="2.25" />
        <path d="M7.25 12h2.5M14.25 12h2.5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M12 4v7M5.5 12h13M6.5 12v5.5M17.5 12v5.5" />
      <circle cx="6.5" cy="19" r="2" />
      <circle cx="17.5" cy="19" r="2" />
    </svg>
  );
}
