export interface FamilyTreeFocusHistoryState {
  history: string[];
  index: number;
}

export interface FamilyTreeScopedFocus {
  treeId: string;
  centralPersonId: string;
}

export function scopedFamilyTreeFocusPersonId(
  focus: FamilyTreeScopedFocus | null,
  selectedTreeId?: string | null,
): string {
  return focus && selectedTreeId && focus.treeId === selectedTreeId
    ? focus.centralPersonId
    : "";
}

export function pushFamilyTreeFocus(
  history: readonly string[],
  index: number,
  nextPersonId: string,
): FamilyTreeFocusHistoryState {
  const safeIndex = Math.min(Math.max(0, index), Math.max(0, history.length - 1));
  if (!nextPersonId || history[safeIndex] === nextPersonId) {
    return { history: [...history], index: safeIndex };
  }
  const nextHistory = [...history.slice(0, safeIndex + 1), nextPersonId];
  return { history: nextHistory, index: nextHistory.length - 1 };
}

export function moveFamilyTreeFocus(
  history: readonly string[],
  index: number,
  direction: -1 | 1,
): FamilyTreeFocusHistoryState {
  if (!history.length) return { history: [], index: 0 };
  return {
    history: [...history],
    index: Math.min(history.length - 1, Math.max(0, index + direction)),
  };
}
