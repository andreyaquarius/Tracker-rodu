"use client";

import type { ReactElement } from "react";
import type { FamilyContinuation, TreePerson } from "../types.ts";

export interface FamilyBranchControlProps {
  continuation: FamilyContinuation;
  people: ReadonlyMap<string, TreePerson>;
  onToggle?: (continuation: FamilyContinuation) => void;
}

function familyLabel(
  continuation: FamilyContinuation,
  people: ReadonlyMap<string, TreePerson>,
): string {
  const names = continuation.scope.parentIds
    .map(personId => people.get(personId)?.displayName)
    .filter((name): name is string => Boolean(name));
  if (names.length >= 2) return names.slice(0, 2).join(" і ");
  return names[0] ?? "цієї сім’ї";
}

export function FamilyBranchControl({
  continuation,
  people,
  onToggle,
}: FamilyBranchControlProps): ReactElement {
  const expanded = Boolean(continuation.expanded);
  const count = !expanded && continuation.hiddenCount
    ? continuation.hiddenCount
    : undefined;
  const family = familyLabel(continuation, people);
  const action = expanded ? "Згорнути дітей" : "Показати дітей";
  const label = `${action}: ${family}${count ? `, приховано ${count}` : ""}`;

  return (
    <button
      type="button"
      className="ft-family-continuation"
      title={`${action} цієї пари`}
      aria-label={label}
      aria-expanded={expanded}
      onClick={() => onToggle?.(continuation)}
    >
      <span aria-hidden="true">{expanded ? "▴" : "↓"}</span>
      {count ? <small>{count}</small> : null}
    </button>
  );
}
