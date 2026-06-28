import { useState, type ReactNode } from "react";
import type { CustomSectionDefinition } from "../types";
import type { SupabaseAccount, SupabaseWorkspace } from "../services/supabaseAuth";
import { Sidebar, type PageKey } from "./Sidebar";
import { AnnouncementBell } from "./AnnouncementBell";
import { HelpCenter } from "./HelpCenter";
import { GoogleDriveConnectionButton } from "./GoogleDriveConnectionButton";
import { TopBar } from "./TopBar";
import { WorkspaceWindowsProvider } from "./WorkspaceWindows";

interface LayoutProps {
  page: PageKey | null;
  onNavigate: (page: PageKey) => void;
  onOpenProjects: () => void;
  onOpenGeneHelp: () => void;
  showGeneHelp: boolean;
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
  return (
    <WorkspaceWindowsProvider scopeKey={props.workspace?.projectId ?? "no-project"}>
      <div className="app-shell">
        <Sidebar
          page={props.page}
          onNavigate={props.onNavigate}
          onOpenProjects={props.onOpenProjects}
          onOpenGeneHelp={props.onOpenGeneHelp}
          showGeneHelp={props.showGeneHelp}
          customSections={props.customSections}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
        />
        <div className="main-shell">
          <TopBar
            account={props.account}
            workspace={props.workspace}
            workspaces={props.workspaces}
            onMenu={() => setMenuOpen(true)}
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
                <HelpCenter page={props.page} />
              </>
            )}
          />
          <main className="page">{props.children}</main>
        </div>
      </div>
    </WorkspaceWindowsProvider>
  );
}
