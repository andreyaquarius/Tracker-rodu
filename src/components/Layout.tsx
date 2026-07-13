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
  onNavigate: (page: PageKey) => void;
  onOpenProjects: () => void;
  onOpenGeneHelp: () => void;
  showGeneHelp: boolean;
  showFamilyTree: boolean;
  customSections: CustomSectionDefinition[];
  account: SupabaseAccount | null;
  workspace: SupabaseWorkspace | null;
  workspaces: SupabaseWorkspace[];
  onSignInAccount: () => void;
  onSignOutAccount: () => void;
  onSwitchWorkspace: (projectId: string) => void;
  onCreateWorkspace: () => void;
  onRenameWorkspace: (projectId: string) => void;
  onDeleteWorkspace: (projectId: string) => void;
  onOpenTeam: () => void;
  isAccountSigningIn: boolean;
  isCreatingWorkspace: boolean;
  children: ReactNode;
}

export function Layout(props: LayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(browserLocalStorage()),
  );

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
          onOpenProjects={props.onOpenProjects}
          onOpenGeneHelp={props.onOpenGeneHelp}
          showGeneHelp={props.showGeneHelp}
          showFamilyTree={props.showFamilyTree}
          customSections={props.customSections}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          desktopCollapsed={sidebarCollapsed}
          onToggleDesktopCollapsed={() => setSidebarCollapsed((current) => !current)}
        />
        <div className="main-shell">
          <TopBar
            account={props.account}
            workspace={props.workspace}
            workspaces={props.workspaces}
            onMenu={() => setMenuOpen(true)}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
            onSignInAccount={props.onSignInAccount}
            onSignOutAccount={props.onSignOutAccount}
            onSwitchWorkspace={props.onSwitchWorkspace}
            onCreateWorkspace={props.onCreateWorkspace}
            onRenameWorkspace={props.onRenameWorkspace}
            onDeleteWorkspace={props.onDeleteWorkspace}
            onOpenTeam={props.onOpenTeam}
            isAccountSigningIn={props.isAccountSigningIn}
            isCreatingWorkspace={props.isCreatingWorkspace}
            helpAction={(
              <>
                <AnnouncementBell account={props.account} />
                <GoogleDriveConnectionButton />
                <HelpCenter
                  key={props.account?.id ?? "anonymous"}
                  page={props.page}
                  accountId={props.account?.id ?? "anonymous"}
                />
              </>
            )}
          />
          <main className={props.page === "familyTree" ? "page family-tree-page" : "page"}>{props.children}</main>
        </div>
      </div>
    </WorkspaceWindowsProvider>
  );
}
