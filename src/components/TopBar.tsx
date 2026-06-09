import type { GoogleUser, SyncState } from "../types";
import type { SupabaseAccount, SupabaseWorkspace } from "../services/supabaseAuth";
import { formatDateTime } from "../utils/dateHelpers";
import { SyncStatusBadge } from "./SyncStatusBadge";

interface TopBarProps {
  driveUser: GoogleUser | null;
  account: SupabaseAccount | null;
  workspace: SupabaseWorkspace | null;
  workspaces: SupabaseWorkspace[];
  sync: SyncState;
  onMenu: () => void;
  onConnect: () => void;
  onDisconnectDrive: () => void;
  onSignInAccount: () => void;
  onSignOutAccount: () => void;
  onSwitchWorkspace: (projectId: string) => void;
  onCreateWorkspace: () => void;
  onDeleteWorkspace: (projectId: string) => void;
  onOpenTeam: () => void;
  isSigningIn: boolean;
  isAccountSigningIn: boolean;
  isCreatingWorkspace: boolean;
}

function roleLabel(role: SupabaseWorkspace["role"]): string {
  if (role === "owner") return "Власник";
  if (role === "editor") return "Редактор";
  return "Лише перегляд";
}

export function TopBar({
  driveUser,
  account,
  workspace,
  workspaces,
  sync,
  onMenu,
  onConnect,
  onDisconnectDrive,
  onSignInAccount,
  onSignOutAccount,
  onSwitchWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  onOpenTeam,
  isSigningIn,
  isAccountSigningIn,
  isCreatingWorkspace,
}: TopBarProps) {
  const initials = account?.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "К";

  return (
    <header className="topbar">
      <button className="mobile-menu" onClick={onMenu} aria-label="Відкрити меню">
        ☰
      </button>
      <div className="topbar-brand">
        <span>Робочий простір для генеалогічного дослідження</span>
        {workspace ? <small>{workspace.projectName}</small> : null}
      </div>
      <div className="connection-summary">
        <SyncStatusBadge sync={sync} />
        <span className="online-state">{navigator.onLine ? "Онлайн" : "Офлайн"}</span>
        <small>Остання синхронізація: {formatDateTime(sync.lastSyncedAt)}</small>
      </div>
      {driveUser ? (
        <div className="drive-menu">
          <span>Google Drive підключено</span>
          <button className="text-button" onClick={onDisconnectDrive}>
            Від'єднати
          </button>
        </div>
      ) : (
        <button className="button button-secondary" onClick={onConnect} disabled={isSigningIn}>
          {isSigningIn ? "Підключення…" : "Підключити Google Drive"}
        </button>
      )}
      {account ? (
        <details className="account-menu">
          <summary aria-label="Відкрити меню профілю">
            {account.picture ? (
              <img src={account.picture} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span className="account-avatar">{initials}</span>
            )}
            <span className="account-name">{account.name}</span>
            <span className="account-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div className="account-popover">
            <strong>{account.name}</strong>
            <small>{account.email}</small>
            {workspace ? (
              <p className="account-project">
                <span>{workspace.projectName}</span>
                <small>{roleLabel(workspace.role)}</small>
              </p>
            ) : null}
            <div className="workspace-switcher">
              <div className="workspace-switcher-heading">
                <span>Ваші проєкти</span>
                <button className="text-button" onClick={onCreateWorkspace} disabled={isCreatingWorkspace}>
                  {isCreatingWorkspace ? "Створення…" : "Новий проєкт"}
                </button>
              </div>
              <div className="workspace-switcher-list">
                {workspaces.map((item) => (
                  <div
                    key={item.projectId}
                    className={`workspace-switcher-item ${
                      workspace?.projectId === item.projectId ? "active" : ""
                    }`}
                  >
                    <button
                      className="workspace-switcher-select"
                      onClick={() => onSwitchWorkspace(item.projectId)}
                      type="button"
                    >
                      <strong>{item.projectName}</strong>
                      <small>{roleLabel(item.role)}</small>
                    </button>
                    {item.role === "owner" ? (
                      <button
                        className="workspace-delete"
                        onClick={() => onDeleteWorkspace(item.projectId)}
                        type="button"
                        aria-label={`Видалити проєкт ${item.projectName}`}
                        title="Видалити проєкт"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <button
              className="button button-secondary account-team-button"
              onClick={onOpenTeam}
              type="button"
            >
              Учасники та запрошення
            </button>
            <button className="button button-secondary" onClick={onSignOutAccount}>
              Вийти з облікового запису
            </button>
          </div>
        </details>
      ) : (
        <div className="local-account-actions">
          <span className="local-account-label">Локальний режим</span>
          <button
            className="button button-primary"
            type="button"
            onClick={onSignInAccount}
            disabled={isAccountSigningIn}
          >
            {isAccountSigningIn ? "Вхід…" : "Увійти через Google"}
          </button>
        </div>
      )}
    </header>
  );
}
