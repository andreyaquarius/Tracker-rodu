import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PhotoPeoplePanel } from "../../../src/components/PhotoPeoplePanel.tsx";
import { PersonTaggedPhotos } from "../../../src/features/persons-v2/PersonTaggedPhotos.tsx";
import type { PhotoPersonTag, PhotoTagsApi } from "../../../src/services/photoPersonTags.ts";
import type { ScanAttachment } from "../../../src/types";
import "../../../src/styles.css";
import "../../../src/components/appearance/appAppearance.css";

// Browser-only synthetic transport. Database/RLS behavior is tested separately
// against the actual migration in photoPersonTagsDatabase.test.ts.
const params = new URLSearchParams(location.search);
const imageUrl = new URL("./group.svg", import.meta.url).href;
const photo: ScanAttachment = { id: "synthetic-photo", name: "Групове фото", mimeType: "image/svg+xml", size: 800,
  createdAt: "2026-09-06T00:00:00Z", storage: "google-drive", storagePath: "synthetic-drive-id" };
const people = [{ id: "anna", name: "Тестова Анна", detail: "1900 · Тестове село" }, { id: "bogdan", name: "Тестовий Богдан", detail: "1898 · Тестове село" }];
const read = (): PhotoPersonTag[] => JSON.parse(localStorage.getItem("photo-tags-qa") ?? "[]");
let failSave = false;
const api: PhotoTagsApi = {
  async list(_project, filter) {
    if (params.has("loadError")) throw { code: "42501" };
    let tags = read();
    if ("personId" in filter) tags = tags.filter((tag) => tag.personId === filter.personId).map((tag) => ({ ...tag,
      photo: { ...photo, name: "Групове фото.png", storage: "external-url", storagePath: "https://photo-tags.example.test/group.png" } }));
    return { photo, tags, canEdit: !params.has("viewer") };
  },
  async search(_project, query) { return people.filter((person) => person.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())); },
  async save(_project, _attachment, personId, rect, previous) {
    if (failSave) { failSave = false; throw new Error("Синтетична помилка мережі. Спробуйте ще раз."); }
    if (params.has("viewer")) throw { code: "42501" };
    const tags = read();
    if (tags.some((tag) => tag.personId === personId && tag.id !== previous?.id)) throw { code: "23505" };
    const id = previous?.id ?? crypto.randomUUID();
    localStorage.setItem("photo-tags-qa", JSON.stringify([...tags.filter((tag) => tag.id !== id), {
      ...rect, id, personId, personName: people.find((p) => p.id === personId)!.name, attachmentId: photo.id, version: (previous?.version ?? 0) + 1, photo,
    }]));
    return id;
  },
  async remove(_project, tag) { localStorage.setItem("photo-tags-qa", JSON.stringify(read().filter((item) => item.id !== tag.id))); },
};
function Fixture() {
  const [focus, setFocus] = useState("");
  const [open, setOpen] = useState(true);
  const [personId, setPersonId] = useState("anna");
  const [dark, setDark] = useState(false);
  return <main style={{ maxWidth: 1250, margin: "auto", padding: 12 }}>
    <p>Демонстрація: синтетичні особи й фото. Позначки зберігаються лише в цьому браузері.</p>
    <nav style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
      <button onClick={() => { setDark(!dark); document.documentElement.dataset.appTheme = dark ? "standard" : "starry-dark"; }}>Змінити тему</button>
      <button onClick={() => setOpen((v) => !v)}>{open ? "Закрити фото" : "Відкрити фото"}</button>
      <button onClick={() => { failSave = true; }}>Помилка наступного збереження</button>
      <span>Поточна особа: {personId}</span>
    </nav>
    {open ? <div className="workspace-viewer-body" style={{ height: "75vh", minHeight: 580 }}><PhotoPeoplePanel key={focus} projectId="synthetic-project" photo={photo}
      imageUrl={params.has("imageError") ? "/missing-image.png" : imageUrl} canEdit={!params.has("viewer")} focusTagId={focus} api={api}
      onOpenPerson={(id) => { setPersonId(id); setOpen(false); }} /></div> : null}
    <PersonTaggedPhotos key={personId} projectId="synthetic-project" personId={personId} api={api}
      onOpenPhoto={(_photo, _photos, tagId) => { setFocus(tagId ?? ""); setOpen(true); }} />
  </main>;
}
async function startFixture() {
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register(new URL("./preview-worker.js", import.meta.url), { scope: "./" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    }
  }
  createRoot(document.getElementById("root")!).render(<Fixture />);
}
void startFixture();
