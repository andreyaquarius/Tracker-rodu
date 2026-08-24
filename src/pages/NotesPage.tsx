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
      <header className="notes-page__header">
        <span className="eyebrow">Особистий простір</span>
        <h1 id="notes-page-title">Нотатки</h1>
        <p>
          Пересилайте сюди важливі дописи з Telegram або зберігайте посилання
          з Facebook та інших джерел, щоб повернутися до них пізніше.
        </p>
      </header>
      <TelegramNotesPanel account={account} />
    </section>
  );
}
