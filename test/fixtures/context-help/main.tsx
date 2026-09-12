import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { HelpProvider, SectionHelp } from "../../../src/help/ContextHelp.tsx";
import { HelpCenter } from "../../../src/components/HelpCenter.tsx";
import { Modal } from "../../../src/components/Modal.tsx";
import { PersonProfileV2 } from "../../../src/features/persons-v2/PersonProfileV2.tsx";
import { PersonEditorV2 } from "../../../src/features/persons-v2/PersonEditorV2.tsx";
import { createEmptyDatabase } from "../../../src/utils/database.ts";
import type { PageKey } from "../../../src/components/Sidebar.tsx";
import type { Person } from "../../../src/types/index.ts";
import "../../../src/styles.css";
import "../../../src/components/appearance/appAppearance.css";

const person: Person = {
  id: "fixture-person", givenName: "Іван", surname: "Тестовий", patronymic: "", fullName: "Тестовий Іван", maidenSurname: "",
  researchId: "", createdAt: "", updatedAt: "", gender: "чоловік", status: "доведена", nameVariants: "", surnameVariants: "",
  birthDate: "1880", birthPlace: "", birthYearFrom: "", birthYearTo: "", deathDate: "1950", deathPlace: "", deathYearFrom: "", deathYearTo: "",
  marriageDate: "", marriagePlace: "", residencePlaces: "", occupation: "", socialStatus: "", religion: "", notes: "",
  isLiving: false, privacyStatus: "project", photos: [], birthScans: [], marriageScans: [], deathScans: [], mentionScans: [], events: [], customFields: {},
};
const db = { ...createEmptyDatabase(), persons: [person] };
function Fixture() {
  const [account, setAccount] = useState("a");
  const [page, setPage] = useState<PageKey>("researches");
  const [editor, setEditor] = useState(false);
  const [form, setForm] = useState(false);
  const scope = new URLSearchParams(location.search).get("scope") ?? "default";
  return <HelpProvider accountId={`fixture-help-${scope}-${account}`}>
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--app-border)", position: "sticky", top: 0, zIndex: 2, background: "var(--app-surface, #fffdf8)" }}>
      <strong>Локальна перевірка · {account}</strong><HelpCenter page={page} accountId={account} />
    </header>
    <main style={{ maxWidth: 1150, padding: 16, margin: "auto" }}>
      <p>Вигадані дані. Серверні запити заблоковані; зберігаються лише тестові налаштування підказок.</p>
      <nav aria-label="Тестові екрани" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button onClick={() => { setPage("researches"); setEditor(false); }}>Дослідження</button>
        <button onClick={() => { setPage("findings"); setEditor(false); }}>Знахідки</button>
        <button onClick={() => { setPage("persons"); setEditor(false); }}>Картка особи</button>
        <button onClick={() => setAccount((value) => value === "a" ? "b" : "a")}>Змінити тестовий акаунт</button>
        <button onClick={() => { document.documentElement.dataset.appTheme = document.documentElement.dataset.appTheme === "starry-dark" ? "standard" : "starry-dark"; }}>Змінити тему</button>
      </nav>
      {page === "persons" ? editor ? <PersonEditorV2 db={db} person={person} persons={db.persons} relations={[]} researches={[]} onSave={(value) => value} onCancel={() => setEditor(false)} /> :
        <PersonProfileV2 db={db} person={person} persons={db.persons} relations={[]} onEdit={() => setEditor(true)} /> : <>
        <h1>{page === "findings" ? "Знахідки" : "Дослідження"}</h1>
        <section className="panel"><h2>Робочі записи</h2><p>Перед заголовком немає окремої смуги інструкцій. Кнопка ? розміщена у верхній панелі.</p>
          <button onClick={() => setForm(true)}>Додати знахідку</button><label>Тестове поле<input placeholder="Можна працювати, не закриваючи підказку" /></label></section>
      </>}
      {form ? <Modal title="Нова знахідка (тест)" onClose={() => setForm(false)} headerActions={<SectionHelp guideKey="findings" topic="edit" />}>
        <label>Назва<input /></label><p>У формі кнопка довідки поруч із заголовком.</p>
      </Modal> : null}
    </main>
  </HelpProvider>;
}
createRoot(document.getElementById("root")!).render(<RouterProvider router={createMemoryRouter([{ path: "*", element: <Fixture /> }])} />);
