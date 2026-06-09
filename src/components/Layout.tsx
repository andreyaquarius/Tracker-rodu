import { useState, type ReactNode } from "react";
import type { CustomSectionDefinition, GoogleUser, SyncState } from "../types";
import type { SupabaseAccount, SupabaseWorkspace } from "../services/supabaseAuth";
import { Sidebar, type PageKey } from "./Sidebar";
import { TopBar } from "./TopBar";

interface LayoutProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  customSections: CustomSectionDefinition[];
  driveUser: GoogleUser | null;
  account: SupabaseAccount | null;
  workspace: SupabaseWorkspace | null;
  workspaces: SupabaseWorkspace[];
  sync: SyncState;
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
  children: ReactNode;
}

export function Layout(props: LayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="app-shell">
      <Sidebar
        page={props.page}
        onNavigate={props.onNavigate}
        customSections={props.customSections}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
      <div className="main-shell">
        <TopBar
          driveUser={props.driveUser}
          account={props.account}
          workspace={props.workspace}
          workspaces={props.workspaces}
          sync={props.sync}
          onMenu={() => setMenuOpen(true)}
          onConnect={props.onConnect}
          onDisconnectDrive={props.onDisconnectDrive}
          onSignInAccount={props.onSignInAccount}
          onSignOutAccount={props.onSignOutAccount}
          onSwitchWorkspace={props.onSwitchWorkspace}
          onCreateWorkspace={props.onCreateWorkspace}
          onDeleteWorkspace={props.onDeleteWorkspace}
          onOpenTeam={props.onOpenTeam}
          isSigningIn={props.isSigningIn}
          isAccountSigningIn={props.isAccountSigningIn}
          isCreatingWorkspace={props.isCreatingWorkspace}
        />
        <main className="page">{props.children}</main>
      </div>
    </div>
  );
}
