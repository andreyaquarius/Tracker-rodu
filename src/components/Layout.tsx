import { useState, type ReactNode } from "react";
import type { GoogleUser, SyncState } from "../types";
import { Sidebar, type PageKey } from "./Sidebar";
import { TopBar } from "./TopBar";

interface LayoutProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  user: GoogleUser | null;
  sync: SyncState;
  onConnect: () => void;
  onDisconnect: () => void;
  isSigningIn: boolean;
  children: ReactNode;
}

export function Layout(props: LayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="app-shell">
      <Sidebar
        page={props.page}
        onNavigate={props.onNavigate}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
      <div className="main-shell">
        <TopBar
          user={props.user}
          sync={props.sync}
          onMenu={() => setMenuOpen(true)}
          onConnect={props.onConnect}
          onDisconnect={props.onDisconnect}
          isSigningIn={props.isSigningIn}
        />
        <main className="page">{props.children}</main>
      </div>
    </div>
  );
}
