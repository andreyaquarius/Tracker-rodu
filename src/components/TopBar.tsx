import type { GoogleUser, SyncState } from "../types";
import { formatDateTime } from "../utils/dateHelpers";
import { SyncStatusBadge } from "./SyncStatusBadge";

interface TopBarProps {
  user: GoogleUser | null;
  sync: SyncState;
  onMenu: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  isSigningIn: boolean;
}

export function TopBar({
  user,
  sync,
  onMenu,
  onConnect,
  onDisconnect,
  isSigningIn,
}: TopBarProps) {
  return (
    <header className="topbar">
      <button className="mobile-menu" onClick={onMenu} aria-label="Відкрити меню">
        ☰
      </button>
      <div className="topbar-brand">
        <span>Робочий простір для генеалогічного дослідження</span>
      </div>
      <div className="connection-summary">
        <SyncStatusBadge sync={sync} />
        <span className="online-state">{navigator.onLine ? "Онлайн" : "Офлайн"}</span>
        <small>Остання синхронізація: {formatDateTime(sync.lastSyncedAt)}</small>
      </div>
      {user ? (
        <div className="user-menu">
          {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : null}
          <div>
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </div>
          <button className="text-button" onClick={onDisconnect}>
            Вийти
          </button>
        </div>
      ) : (
        <button className="button button-secondary" onClick={onConnect} disabled={isSigningIn}>
          {isSigningIn ? "Підключення…" : "Підключити Google Drive"}
        </button>
      )}
    </header>
  );
}
