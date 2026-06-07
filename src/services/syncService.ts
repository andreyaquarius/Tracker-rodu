export function scheduleAutoSave(action: () => void, delay = 1500): () => void {
  const timer = window.setTimeout(action, delay);
  return () => window.clearTimeout(timer);
}
