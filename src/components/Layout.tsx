import { useEffect, useState, type ReactNode } from "react";
import type { CustomSectionDefinition } from "../types";
import type { SupabaseAccount, SupabaseWorkspace } from "../services/supabaseAuth";
import { Sidebar, type PageKey } from "./Sidebar";
import { AnnouncementBell } from "./AnnouncementBell";
import { HelpCenter } from "./HelpCenter";
import { GoogleDriveConnectionButton } from "./GoogleDriveConnectionButton";
import { TopBar } from "./TopBar";
import { WorkspaceWindowsProvider } from "./WorkspaceWindows";
import {
  browserLocalStorage,
  DESKTOP_SIDEBAR_WIDTH,
  readSidebarCollapsed,
  SIDEBAR_LAYOUT_CHANGE_EVENT,
  writeSidebarCollapsed,
} from "../utils/sidebarPreference";

interface LayoutProps {
  page: PageKey | null;
  familyTreeView?: "tree" | "statistics";
  focusedPersonContext?: boolean;
  onNavigate: (page: PageKey) => void;
  onOpenZagulyaky: () => void;
  onOpenNotes: () => void;
  isNotesActive: boolean;
  onOpenProjects: () => void;
  onOpenHelp: () => void;
  showFamilyTree: boolean;
  customSections: CustomSectionDefinition[];
  account: SupabaseAccount | null;
  workspace: SupabaseWorkspace | null;
  workspaces: SupabaseWorkspace[];
  onSignInAccount: () => void;
  onSignOutAccount: () => void;
  onDeleteAccount: () => void;
  canDeleteAccount: boolean;
  onSwitchWorkspace: (projectId: string) => void;
  onCreateWorkspace: () => void;
  onRenameWorkspace: (projectId: string) => void;
  onDeleteWorkspace: (projectId: string) => void;
  onOpenWorkspaceDeletion: (projectId: string) => void;
  onOpenTeam: () => void;
  isAdmin: boolean;
  onOpenAdmin: () => void;
  isAccountSigningIn: boolean;
  isCreatingWorkspace: boolean;
  children: ReactNode;
}

export function Layout(props: LayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(browserLocalStorage()),
  );
  const isFamilyTreeStatistics =
    props.page === "familyTree" && props.familyTreeView === "statistics";
  const pageClassName = props.page === "familyTree"
    ? isFamilyTreeStatistics
      ? "page family-tree-statistics-host"
      : "page family-tree-page"
    : props.page === "persons"
      ? `page persons-v2-page${props.focusedPersonContext ? " person-context-page" : ""}`
      : "page";

  useEffect(() => {
    writeSidebarCollapsed(browserLocalStorage(), sidebarCollapsed);

    document.documentElement.style.setProperty(
      "--app-sidebar-width",
      sidebarCollapsed ? "0px" : `${DESKTOP_SIDEBAR_WIDTH}px`,
    );
    document.body.classList.toggle("sidebar-desktop-collapsed", sidebarCollapsed);
    window.dispatchEvent(new Event(SIDEBAR_LAYOUT_CHANGE_EVENT));
  }, [sidebarCollapsed]);

  useEffect(() => {
    return () => {
      document.body.classList.remove("sidebar-desktop-collapsed");
      document.documentElement.style.removeProperty("--app-sidebar-width");
    };
  }, []);

  return (
    <WorkspaceWindowsProvider scopeKey={props.workspace?.projectId ?? "no-project"}>
      <div className={`app-shell ${sidebarCollapsed ? "app-shell-sidebar-collapsed" : ""}`}>
        <Sidebar
          page={props.page}
          onNavigate={props.onNavigate}
          onOpenZagulyaky={props.onOpenZagulyaky}
          onOpenNotes={props.onOpenNotes}
          isNotesActive={props.isNotesActive}
          onOpenProjects={props.onOpenProjects}
          onOpenHelp={props.onOpenHelp}
          showFamilyTree={props.showFamilyTree}
          customSections={props.customSections}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          desktopCollapsed={sidebarCollapsed}
          onToggleDesktopCollapsed={() => setSidebarCollapsed((current) => !current)}
          accountId={props.account?.id}
        />
        <div
          className={
            props.page === "familyTree"
              ? isFamilyTreeStatistics
                ? "main-shell main-shell-family-tree main-shell-family-tree-statistics"
                : "main-shell main-shell-family-tree"
              : props.focusedPersonContext
                ? "main-shell main-shell-person-context"
                : "main-shell"
          }
        >
          <TopBar
            account={props.account}
            workspace={props.workspace}
            workspaces={props.workspaces}
            onMenu={() => setMenuOpen(true)}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
            onSignInAccount={props.onSignInAccount}
            onSignOutAccount={props.onSignOutAccount}
            onDeleteAccount={props.onDeleteAccount}
            canDeleteAccount={props.canDeleteAccount}
            onSwitchWorkspace={props.onSwitchWorkspace}
            onCreateWorkspace={props.onCreateWorkspace}
            onRenameWorkspace={props.onRenameWorkspace}
            onDeleteWorkspace={props.onDeleteWorkspace}
            onOpenWorkspaceDeletion={props.onOpenWorkspaceDeletion}
            onOpenTeam={props.onOpenTeam}
            isAdmin={props.isAdmin}
            onOpenAdmin={props.onOpenAdmin}
            isAccountSigningIn={props.isAccountSigningIn}
            isCreatingWorkspace={props.isCreatingWorkspace}
            helpAction={(
              <>
                <AnnouncementBell
                  key={`announcements:${props.account?.id ?? "anonymous"}`}
                  account={props.account}
                />
                <GoogleDriveConnectionButton />
                <HelpCenter
                  key={`help:${props.account?.id ?? "anonymous"}`}
                  page={props.page}
                  accountId={props.account?.id ?? "anonymous"}
                />
              </>
            )}
          />
          <main className={pageClassName}>{props.children}</main>
        </div>
      </div>
    </WorkspaceWindowsProvider>
  );
}
