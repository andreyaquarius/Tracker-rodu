import { useState, type ReactNode } from "react";
import type { CustomSectionDefinition } from "../types";
import type { SupabaseAccount, SupabaseWorkspace } from "../services/supabaseAuth";
import { Sidebar, type PageKey } from "./Sidebar";
import { TopBar } from "./TopBar";

interface LayoutProps {
  page: PageKey | null;
  onNavigate: (page: PageKey) => void;
  onOpenProjects: () => void;
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
    <div className="app-shell">
      <Sidebar
        page={props.page}
        onNavigate={props.onNavigate}
        onOpenProjects={props.onOpenProjects}
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
        />
        <main className="page">{props.children}</main>
      </div>
    </div>
  );
}
