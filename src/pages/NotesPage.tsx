import { TelegramNotesPanel } from "../components/notes/TelegramNotesPanel";
import type { SupabaseAccount } from "../services/supabaseAuth";
import "../components/notes/TelegramNotesPanel.css";

export interface NotesPageProps {
  account: SupabaseAccount | null;
}

/**
 * Account-level personal inbox.  It intentionally does not belong to a
 * research project or the public Zagulyaky catalogue.
 */
export function NotesPage({ account }: NotesPageProps) {
  return (
    <section className="notes-page" aria-labelledby="notes-page-title">
      <TelegramNotesPanel account={account} />
    </section>
  );
}
