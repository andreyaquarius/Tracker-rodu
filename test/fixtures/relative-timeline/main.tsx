import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { PersonProfileV2 } from "../../../src/features/persons-v2/PersonProfileV2.tsx";
import { PersonEditorV2 } from "../../../src/features/persons-v2/PersonEditorV2.tsx";
import { createEmptyDatabase } from "../../../src/utils/database.ts";
import type { Person, PersonRelation } from "../../../src/types/index.ts";
import type { ProjectPersonMarriage } from "../../../src/services/projectPersonMarriages.ts";
import "../../../src/styles.css";
import "../../../src/components/appearance/appAppearance.css";

// Real profile + real editor, synthetic in-memory transport. No auth, external
// requests, project id, persistent browser state or production writes.
function makePerson(id: string, givenName: string, patch: Partial<Person> = {}): Person {
  return {
    id, givenName, surname: "Тестовий", patronymic: "", fullName: `Тестовий ${givenName}`, maidenSurname: "",
    researchId: "", createdAt: "", updatedAt: "", gender: "чоловік", status: "доведена", nameVariants: "", surnameVariants: "",
    birthDate: "", birthPlace: "", birthYearFrom: "", birthYearTo: "", deathDate: "", deathPlace: "", deathYearFrom: "", deathYearTo: "",
    marriageDate: "", marriagePlace: "", residencePlaces: "", occupation: "", socialStatus: "", religion: "", notes: "",
    isLiving: false, privacyStatus: "project", photos: [], birthScans: [], marriageScans: [], deathScans: [], mentionScans: [], events: [], customFields: {}, ...patch,
  };
}
const initialPeople = [
  makePerson("father", "Іван", { birthDate: "1840", deathDate: "1930" }),
  makePerson("child", "Петро", { birthDate: "1870-05-14", birthPlace: "Вербівка", deathDate: "1910", events: [{
    id: "finding:birth-source", personId: "child", type: "birth", date: "1870-05-14", placeName: "Вербівка",
    sourceFindingId: "birth-source", notes: "Тестовий запис про народження.",
  }] }),
  makePerson("sister", "Олена", { surname: "Тестова", fullName: "Тестова Олена", gender: "жінка", birthDate: "1872", marriageDate: "1892", deathDate: "1912" }),
  makePerson("brother", "Микола", { birthDate: "1860", deathDate: "1865" }),
  makePerson("partner", "Марія", { surname: "Тестова", fullName: "Тестова Марія", gender: "жінка" }),
];
const initialRelations: PersonRelation[] = ["child", "sister", "brother"].map((id) => ({
  id: `parent:${id}`, personId: id, relatedPersonId: "father", relationType: "батько",
  status: "доведено", evidenceText: "", notes: "", createdAt: "", updatedAt: "",
}));
const initialMarriages: ProjectPersonMarriage[] = [{
  id: "m1", projectId: "synthetic", treeId: "synthetic", personAId: "child", personBId: "partner",
  date: "1890-10-20", place: "Київ", address: "буд. 2", evidenceStatus: "proven", createdAt: "", updatedAt: "",
}];

function Fixture() {
  const [people, setPeople] = useState(initialPeople);
  const [relations, setRelations] = useState(initialRelations);
  const [marriages, setMarriages] = useState(initialMarriages);
  const [personId, setPersonId] = useState("father");
  const [editingId, setEditingId] = useState("");
  const [notice, setNotice] = useState("");
  const readOnly = new URLSearchParams(location.search).has("viewer");
  const db = { ...createEmptyDatabase(), persons: people, personRelations: relations };
  const person = people.find((value) => value.id === (editingId || personId))!;
  return <main style={{ maxWidth: 1300, margin: "auto", padding: 12 }}>
    <p>Локальна перевірка. Усі імена й записи вигадані, зміни не надсилаються на сервер.</p>
    <nav aria-label="Тестові сценарії" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      <button onClick={() => { setEditingId(""); setPersonId("father"); }}>Картка батька</button>
      <button onClick={() => { setEditingId(""); setPersonId("child"); }}>Картка сина</button>
      <button onClick={() => setPeople((values) => values.map((value) => value.id === "child" ? {
        ...value, deathDate: "", deathYearFrom: "", deathYearTo: "",
        events: value.events.map((event) => event.type === "death" ? { ...event, date: null } : event),
      } : value))}>Невідома дата смерті сина (тест)</button>
      <button onClick={() => setRelations((values) => values.some((value) => value.personId === "child") ? values.filter((value) => value.personId !== "child") : initialRelations)}>
        {relations.some((value) => value.personId === "child") ? "Від’єднати сина (тест)" : "Повернути зв’язок (тест)"}
      </button>
      <button onClick={() => { document.documentElement.dataset.appTheme = document.documentElement.dataset.appTheme === "starry-dark" ? "standard" : "starry-dark"; }}>Змінити тему</button>
    </nav>
    <output aria-live="polite">{notice}</output>
    {editingId ? <PersonEditorV2 key={editingId} db={db} person={person} persons={people} relations={relations} marriages={marriages} researches={[]}
      onSave={(updated) => { setPeople((values) => values.map((value) => value.id === updated.id ? updated : value)); setNotice(`Збережено: ${updated.id}`); return updated; }}
      onSaveMarriages={async ({ personId: savedId, marriages: drafts }) => {
        const next = drafts.map((draft, index) => ({ ...initialMarriages[0], id: draft.relationshipId || `new:${index}`, personAId: savedId,
          personBId: draft.partnerId, date: draft.date, place: draft.place, address: draft.address }));
        setMarriages(next); return next;
      }}
      onCancel={() => setEditingId("")}
      onOpenProfile={(value) => { setEditingId(""); setPersonId(value.id); }}
    /> : <PersonProfileV2 key={personId} db={db} person={person} persons={people} relations={relations} marriages={marriages} defaultTab="timeline"
      onOpenPerson={(value) => { setPersonId(value.id); setNotice(`Відкрито: ${value.id}`); }}
      onEdit={readOnly ? undefined : (value) => { setEditingId(value.id); setNotice(`Редагування: ${value.id}`); }}
      onOpenFindingById={(id) => setNotice(`Знахідка: ${id}`)}
    />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<RouterProvider router={createMemoryRouter([{ path: "*", element: <Fixture /> }])} />);
