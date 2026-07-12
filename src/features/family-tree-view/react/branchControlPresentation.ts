import type { TreeContinuation } from "../types.ts";

const COPY = {
  parents: { icon: "↑", label: "предків" },
  children: { icon: "↓", label: "нащадків" },
  partners: { icon: "↔", label: "партнерів" },
  siblings: { icon: "⇄", label: "братів і сестер" },
} as const;

export interface BranchControlPresentation {
  icon: string;
  expanded: boolean;
  title: string;
  ariaLabel: string;
  count?: number;
}

export function branchControlPresentation(
  continuation: TreeContinuation | undefined,
): BranchControlPresentation {
  const copy = continuation ? COPY[continuation.direction] : { icon: "+", label: "гілку" };
  const expanded = Boolean(continuation?.expanded);
  const hiddenCount = !expanded && continuation?.hiddenCount
    ? continuation.hiddenCount
    : undefined;
  const action = expanded ? "Згорнути" : "Розкрити";
  return {
    icon: copy.icon,
    expanded,
    title: `${action} ${copy.label}`,
    ariaLabel: `${action} ${copy.label}${hiddenCount ? `, приховано ${hiddenCount}` : ""}`,
    ...(hiddenCount === undefined ? {} : { count: hiddenCount }),
  };
}
