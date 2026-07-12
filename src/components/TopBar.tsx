import type { ReactNode } from "react";
import type { SupabaseAccount, SupabaseWorkspace } from "../services/supabaseAuth";
import { useDismissibleDetails } from "../hooks/useDismissibleDetails";

interface TopBarProps {
  account: SupabaseAccount | null;
  workspace: SupabaseWorkspace | null;
  workspaces: SupabaseWorkspace[];
  onMenu: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onSignInAccount: () => void;
  onSignOutAccount: () => void;
  onSwitchWorkspace: (projectId: string) => void;
  onCreateWorkspace: () => void;
  onRenameWorkspace: (projectId: string) => void;
  onDeleteWorkspace: (projectId: string) => void;
  onOpenTeam: () => void;
  isAccountSigningIn: boolean;
  isCreatingWorkspace: boolean;
  helpAction?: ReactNode;
}

function roleLabel(role: SupabaseWorkspace["role"]): string {
  if (role === "owner") return "Власник";
  if (role === "editor") return "Редактор";
  return "Лише перегляд";
}

export function TopBar({
  account,
  workspace,
  workspaces,
  onMenu,
  sidebarCollapsed,
  onToggleSidebar,
  onSignInAccount,
  onSignOutAccount,
  onSwitchWorkspace,
  onCreateWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
  onOpenTeam,
  isAccountSigningIn,
  isCreatingWorkspace,
  helpAction,
}: TopBarProps) {
  const accountMenuRef = useDismissibleDetails();
  const initials = account?.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "К";

  const closeAccountMenu = () => {
    if (accountMenuRef.current) accountMenuRef.current.open = false;
  };

  return (
    <header className="topbar">
      <button className="mobile-menu" onClick={onMenu} aria-label="Відкрити меню">
        ☰
      </button>
      <button
        type="button"
        className="desktop-sidebar-toggle"
        onClick={onToggleSidebar}
        aria-label={sidebarCollapsed ? "Розгорнути ліве меню" : "Згорнути ліве меню"}
        title={sidebarCollapsed ? "Розгорнути ліве меню" : "Згорнути ліве меню"}
        aria-pressed={sidebarCollapsed}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
          <path d={sidebarCollapsed ? "m13 9 3 3-3 3" : "m16 9-3 3 3 3"} />
        </svg>
      </button>
      <div className="topbar-brand">
        <span>Робочий простір для генеалогічного дослідження</span>
        {workspace ? <small>{workspace.projectName}</small> : null}
      </div>
      <div className="connection-summary">
        <span className="sync-badge sync-synced">
          <span className="sync-dot" />
          Збережено
        </span>
        <span className="online-state">{navigator.onLine ? "Онлайн" : "Офлайн"}</span>
        <small>Дані активного проєкту зберігаються автоматично</small>
      </div>
      {helpAction}
      {account ? (
        <details className="account-menu" ref={accountMenuRef}>
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
                <button
                  className="text-button"
                  onClick={() => {
                    closeAccountMenu();
                    onCreateWorkspace();
                  }}
                  disabled={isCreatingWorkspace}
                >
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
                      onClick={() => {
                        closeAccountMenu();
                        onSwitchWorkspace(item.projectId);
                      }}
                      type="button"
                    >
                      <strong>{item.projectName}</strong>
                      <small>{roleLabel(item.role)}</small>
                    </button>
                    {item.role === "owner" ? (
                      <div className="workspace-item-actions">
                        <button
                          className="workspace-rename"
                          onClick={() => {
                            closeAccountMenu();
                            onRenameWorkspace(item.projectId);
                          }}
                          type="button"
                          aria-label={`Перейменувати проєкт ${item.projectName}`}
                          title="Перейменувати проєкт"
                        >
                          ✎
                        </button>
                        <button
                          className="workspace-delete"
                          onClick={() => {
                            closeAccountMenu();
                            onDeleteWorkspace(item.projectId);
                          }}
                          type="button"
                          aria-label={`Видалити проєкт ${item.projectName}`}
                          title="Видалити проєкт"
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            <button
              className="button button-secondary account-team-button"
              onClick={() => {
                closeAccountMenu();
                onOpenTeam();
              }}
              type="button"
            >
              Учасники та запрошення
            </button>
            <button
              className="button button-secondary"
              onClick={() => {
                closeAccountMenu();
                onSignOutAccount();
              }}
            >
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
