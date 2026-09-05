const activeUnsavedWork = new Set<string>();

/**
 * Registers browser-local work that must survive or defer an automatic page
 * reload. Callers own their key and must clear it when the editor unmounts.
 */
export function setUnsavedWork(key: string, active: boolean): void {
  if (!key) return;
  if (active) activeUnsavedWork.add(key);
  else activeUnsavedWork.delete(key);
}

export function hasUnsavedWork(): boolean {
  return activeUnsavedWork.size > 0;
}

export function resetUnsavedWorkForTests(): void {
  activeUnsavedWork.clear();
}
