import type { SyncState } from "../types";

const labels = {
  local: "Збережено локально",
  synced: "Синхронізовано з Google Drive",
  pending: "Очікує синхронізації",
  error: "Помилка синхронізації",
  offline: "Офлайн",
};

export function SyncStatusBadge({ sync }: { sync: SyncState }) {
  return (
    <span className={`sync-badge sync-${sync.status}`} title={sync.message}>
      <span className="sync-dot" />
      {labels[sync.status]}
    </span>
  );
}
