import { useId, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { AppEntity, DocumentRecord, Finding, Person, PersonRelation } from "../types";
import type { FamilyTreeGraphIssue, GedcomPreservedRecord } from "../types/familyTree";
import { buildGedcomAppImport } from "../utils/gedcomAppImport";
import { decodeGedcomBytes } from "../utils/gedcomEncoding";
import { buildGedcomImportDraft } from "../utils/gedcomImport";
import type {
  GedcomImportExecutionOptions,
  GedcomImportReconciliationPayload,
  GedcomImportReconciliationResult,
} from "../utils/gedcomImportReconciliation.ts";
import {
  toGedcomImportStageError,
  type GedcomImportStage,
} from "../utils/gedcomImportDiagnostics";
import { buildGedcomImportReport, formatGedcomImportReport, type GedcomImportReport } from "../utils/gedcomImportReport";
import {
  buildGedcomPersonSearchIndex,
  gedcomPersonSearchLabel,
  searchGedcomPeople,
} from "../utils/gedcomPersonSearch";
import {
  completeGedcomImportOperation,
  registerGedcomImportTree,
  rollbackGedcomImportOperationToCompletion,
  stopGedcomImportHeartbeat,
} from "../services/gedcomImportOperation.ts";
import { Modal } from "./Modal";

export interface GedcomImportArchivePayload {
  gedcomVersion: string;
  records: GedcomPreservedRecord[];
  personIdByXref: Record<string, string>;
  warnings: FamilyTreeGraphIssue[];
}

interface GedcomImportButtonProps {
  inputId?: string;
  hideTrigger?: boolean;
  defaultResearchId?: string;
  researchRequired?: boolean;
  onImportPersons: (records: AppEntity[]) => Promise<void>;
  onImportGedcom?: (
    input: GedcomImportReconciliationPayload,
    options?: GedcomImportExecutionOptions,
  ) => Promise<GedcomImportReconciliationResult | void>;
  onSaveRelation: (relation: PersonRelation) => Promise<PersonRelation | null> | PersonRelation | null | void;
  onCreateFamilyTree?: (input: {
    fileName: string;
    people: Person[];
    relations: PersonRelation[];
    rootPersonId?: string;
    archive: GedcomImportArchivePayload;
    importOperationId?: string;
  }) => Promise<{ treeId: string; archiveBatchId?: string } | void>;
}

type GedcomImportPreview = {
  fileName: string;
  people: Person[];
  personRecords: AppEntity[];
  documents: DocumentRecord[];
  relations: PersonRelation[];
  findings: Finding[];
  warnings: string[];
  report: GedcomImportReport;
  rootPersonId: string;
  archive: GedcomImportArchivePayload;
  importSourceKey: string;
};

type GedcomImportProgress = {
  step: string;
  percent: number;
  detail: string;
} | null;

export function GedcomImportButton({
  inputId,
  hideTrigger = false,
  defaultResearchId = "",
  researchRequired = false,
  onImportPersons,
  onImportGedcom,
  onSaveRelation,
  onCreateFamilyTree,
}: GedcomImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<GedcomImportPreview | null>(null);
  const [progress, setProgress] = useState<GedcomImportProgress>(null);
  const [rootSearchQuery, setRootSearchQuery] = useState("");
  const rootPersonSearchId = useId();
  const rootCandidates = useMemo(
    () => preview ? sortRootCandidates(preview.people, preview.relations) : [],
    [preview],
  );
  const rootSearchIndex = useMemo(
    () => buildGedcomPersonSearchIndex(rootCandidates),
    [rootCandidates],
  );
  const normalizedRootSearchQuery = rootSearchQuery.trim();
  const rootSearchResults = useMemo(
    () => searchGedcomPeople(rootSearchIndex, rootSearchQuery),
    [rootSearchIndex, rootSearchQuery],
  );
  const selectedRootPerson = useMemo(
    () => preview?.people.find((person) => person.id === preview.rootPersonId) ?? null,
    [preview],
  );

  const selectFile = () => {
    if (!busy) inputRef.current?.click();
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (researchRequired && !defaultResearchId) {
      window.alert("Перед імпортом GEDCOM оберіть дослідження у фільтрі або створіть одне дослідження в проєкті.");
      return;
    }

    let activeStage: GedcomImportStage = "read-file";
    try {
      setProgress({ step: "Читаємо файл", percent: 10, detail: file.name });
      const bytes = await file.arrayBuffer();
      activeStage = "parse-file";
      const draft = buildGedcomImportDraft(decodeGedcomBytes(bytes));
      setProgress({ step: "Готуємо записи", percent: 35, detail: "Розбираємо осіб, сімʼї та звʼязки з GEDCOM." });
      activeStage = "prepare-records";
      const built = buildGedcomAppImport(draft, { defaultResearchId });
      if (!built.people.length) {
        throw new Error("У файлі GEDCOM не знайдено жодної особи для імпорту.");
      }

      const report = buildGedcomImportReport(draft, built);
      const candidates = sortRootCandidates(built.people, built.relations);
      const rootPersonId = built.rootPersonId && built.people.some((person) => person.id === built.rootPersonId)
        ? built.rootPersonId
        : candidates[0]?.id ?? built.people[0]?.id ?? "";
      setRootSearchQuery("");
      setPreview({
        fileName: file.name,
        people: built.people,
        personRecords: built.personRecords,
        documents: built.documents,
        relations: built.relations,
        findings: built.findings,
        warnings: built.warnings,
        report,
        rootPersonId,
        archive: {
          gedcomVersion: draft.summary.gedcomVersion ?? "5.5.1",
          records: built.preservedRecords,
          personIdByXref: built.personIdByXref,
          warnings: draft.warnings,
        },
        importSourceKey: built.importSourceKey,
      });
      setProgress(null);
    } catch (error) {
      const stageError = toGedcomImportStageError(activeStage, error);
      console.error("GEDCOM import preview stage failed", {
        fileName: file.name,
        fileSize: file.size,
        stage: stageError.stage,
        error,
      });
      setProgress(null);
      window.alert(stageError.message);
    }
  };

  const confirmImport = async () => {
    if (!preview) return;
    setBusy(true);
    setProgress({
      step: "Зберігаємо осіб і звʼязки",
      percent: 45,
      detail: `Осіб: ${preview.people.length}, джерел: ${preview.documents.length}, звʼязків: ${preview.relations.length}, знахідок: ${preview.findings.length}.`,
    });
    let activeStage: GedcomImportStage = "people-relations";
    let importOperationId = "";
    try {
      let committed: GedcomImportReconciliationPayload = {
        people: preview.people,
        personRecords: preview.personRecords,
        documents: preview.documents,
        relations: preview.relations,
        findings: preview.findings,
        rootPersonId: preview.rootPersonId,
        personIdByXref: preview.archive.personIdByXref,
        importSourceKey: preview.importSourceKey,
      };
      if (onImportGedcom) {
        const reconciled = await onImportGedcom(committed, {
          onProgress: (nextProgress) => setProgress(nextProgress),
        });
        if (reconciled) {
          committed = reconciled;
          importOperationId = reconciled.importOperationId ?? "";
        }
      } else {
        await onImportPersons(preview.personRecords);
        for (const relation of preview.relations) {
          await onSaveRelation(relation);
        }
      }
      setProgress({
        step: onCreateFamilyTree ? "Створюємо дерево" : "Завершуємо імпорт",
        percent: onCreateFamilyTree ? 75 : 90,
        detail: onCreateFamilyTree ? "Формуємо учасників дерева та родинні звʼязки." : "Оновлюємо дані проєкту.",
      });
      if (onCreateFamilyTree) {
        activeStage = "create-tree";
        const createdTree = await onCreateFamilyTree({
          fileName: preview.fileName,
          people: committed.people,
          relations: committed.relations,
          rootPersonId: committed.rootPersonId,
          archive: {
            ...preview.archive,
            personIdByXref: committed.personIdByXref,
          },
          importOperationId: importOperationId || undefined,
        });
        if (importOperationId && createdTree?.treeId) {
          await registerGedcomImportTree(importOperationId, createdTree.treeId);
        }
      }
      if (importOperationId) {
        await completeGedcomImportOperation(importOperationId);
      }
      setProgress({ step: "Імпорт завершено", percent: 100, detail: "Дані збережено." });
      window.alert([
        "Імпорт GEDCOM завершено.",
        formatGedcomImportReport(preview.report),
      ].join("\n"));
      setPreview(null);
      setRootSearchQuery("");
    } catch (error) {
      if (importOperationId) {
        try {
          const rollback = await rollbackGedcomImportOperationToCompletion(importOperationId);
          console.info("GEDCOM import orchestration rollback requested", {
            importOperationId,
            status: rollback.status,
            rolledBackRows: rollback.rolledBackRows,
            remainingRows: rollback.remainingRows,
          });
        } catch (rollbackError) {
          // The scheduled worker will resume the durable rolling_back operation.
          console.error("GEDCOM import orchestration rollback failed", {
            importOperationId,
            rollbackError,
          });
        }
      }
      const stageError = toGedcomImportStageError(activeStage, error);
      console.error("GEDCOM import commit stage failed", {
        fileName: preview.fileName,
        stage: stageError.stage,
        counts: {
          people: preview.people.length,
          documents: preview.documents.length,
          relations: preview.relations.length,
          findings: preview.findings.length,
        },
        error,
      });
      window.alert(stageError.message);
    } finally {
      if (importOperationId) stopGedcomImportHeartbeat(importOperationId);
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept=".ged,.gedcom,text/plain"
        hidden
        onChange={(event) => void importFile(event)}
      />
      {!hideTrigger ? (
        <button
          type="button"
          className="button button-secondary"
          disabled={busy}
          onClick={selectFile}
        >
          {busy ? "Імпортуємо GEDCOM..." : "Імпорт GEDCOM"}
        </button>
      ) : null}
      {preview ? (
        <Modal
          title="Імпорт GEDCOM"
          className="gedcom-import-modal"
          onClose={() => {
            if (!busy) {
              setPreview(null);
              setRootSearchQuery("");
            }
          }}
        >
          <div className="gedcom-import-dialog-body">
            <div className="gedcom-import-preview">
            <div>
              <span className="eyebrow">Файл</span>
              <h3>{preview.fileName}</h3>
            </div>
            <div className="gedcom-root-person-picker">
              <label htmlFor={`${rootPersonSearchId}-input`}>
                <span>Центральна особа для дерева</span>
              </label>
              <div className="gedcom-root-person-picker__search">
                <input
                  id={`${rootPersonSearchId}-input`}
                  type="search"
                  value={rootSearchQuery}
                  disabled={busy || !onCreateFamilyTree}
                  placeholder="Введіть імʼя, прізвище або рік"
                  autoComplete="off"
                  aria-controls={`${rootPersonSearchId}-results`}
                  aria-describedby={`${rootPersonSearchId}-help`}
                  onChange={(event) => setRootSearchQuery(event.target.value)}
                />
                {normalizedRootSearchQuery ? (
                  <button
                    type="button"
                    className="button button-secondary gedcom-root-person-picker__clear"
                    disabled={busy || !onCreateFamilyTree}
                    onClick={() => setRootSearchQuery("")}
                  >
                    Очистити
                  </button>
                ) : null}
              </div>
              <div className="gedcom-root-person-picker__selected" aria-live="polite">
                <small>Зараз вибрано</small>
                <strong>{selectedRootPerson ? gedcomPersonSearchLabel(selectedRootPerson) : "Особу не вибрано"}</strong>
              </div>
              {normalizedRootSearchQuery ? (
                <div id={`${rootPersonSearchId}-results`} className="gedcom-root-person-picker__results">
                  {rootSearchResults.length ? (
                    <>
                      <small role="status">
                        Показано {rootSearchResults.length}{rootSearchResults.length === 20 ? " найкращих" : ""} збігів.
                      </small>
                      <ul className="gedcom-root-person-picker__list">
                        {rootSearchResults.map(({ person, label }) => (
                          <li key={person.id}>
                            <button
                              type="button"
                              className="gedcom-root-person-picker__result"
                              aria-pressed={person.id === preview.rootPersonId}
                              onClick={() => {
                                setPreview((current) => current ? { ...current, rootPersonId: person.id } : current);
                                setRootSearchQuery("");
                              }}
                            >
                              {label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <small className="gedcom-root-person-picker__empty" role="status">
                      Нікого не знайдено. Спробуйте інше імʼя, дату або рік.
                    </small>
                  )}
                </div>
              ) : (
                <small className="gedcom-root-person-picker__idle" role="status">
                  Почніть вводити запит, щоб знайти людину серед {rootSearchIndex.length.toLocaleString("uk-UA")} осіб.
                </small>
              )}
              <small id={`${rootPersonSearchId}-help`}>
                Пошук працює за повним імʼям, датою або роком народження і смерті.
              </small>
              <small>
                Від цієї особи буде збережено центр дерева після імпорту. Якщо треба, оберіть себе або іншу фокусну особу.
              </small>
            </div>
            <pre>{formatGedcomImportReport(preview.report)}</pre>
            {progress ? (
              <div className="gedcom-import-progress" aria-live="polite">
                <div className="gedcom-import-progress__header">
                  <strong>{progress.step}</strong>
                  <span>{Math.round(progress.percent)}%</span>
                </div>
                <div className="gedcom-import-progress__bar">
                  <span style={{ width: `${Math.max(5, Math.min(100, progress.percent))}%` }} />
                </div>
                <small>{progress.detail}</small>
              </div>
            ) : null}
            {preview.warnings.length ? (
              <div className="gedcom-import-warnings">
                <strong>Попередження: {preview.warnings.length}</strong>
                {preview.warnings.slice(0, 5).map((warning, index) => (
                  <small key={`${warning}-${index}`}>{warning}</small>
                ))}
              </div>
            ) : null}
            </div>
            <div className="details-actions">
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => {
                setPreview(null);
                setRootSearchQuery("");
              }}>
                Скасувати
              </button>
              <button type="button" className="button button-primary" disabled={busy || !preview.rootPersonId} onClick={() => void confirmImport()}>
                {busy ? "Імпортуємо..." : onCreateFamilyTree ? "Імпортувати і створити дерево" : "Імпортувати"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function sortRootCandidates(people: Person[], relations: PersonRelation[]): Person[] {
  const childCounts = new Map<string, number>();
  const parentCounts = new Map<string, number>();
  for (const relation of relations) {
    const type = relation.relationType.toLocaleLowerCase("uk");
    if (isParentRelationLabel(type)) {
      parentCounts.set(relation.personId, (parentCounts.get(relation.personId) ?? 0) + 1);
      childCounts.set(relation.relatedPersonId, (childCounts.get(relation.relatedPersonId) ?? 0) + 1);
    }
    if (isChildRelationLabel(type)) {
      childCounts.set(relation.personId, (childCounts.get(relation.personId) ?? 0) + 1);
      parentCounts.set(relation.relatedPersonId, (parentCounts.get(relation.relatedPersonId) ?? 0) + 1);
    }
  }

  return [...people].sort((first, second) => {
    const scoreDiff = rootCandidateScore(second, childCounts, parentCounts) - rootCandidateScore(first, childCounts, parentCounts);
    if (scoreDiff !== 0) return scoreDiff;
    return personDisplayName(first).localeCompare(personDisplayName(second), "uk");
  });
}

function rootCandidateScore(person: Person, childCounts: Map<string, number>, parentCounts: Map<string, number>): number {
  const birthYear = yearFromDateText(person.birthDate);
  return (
    (person.isLiving ? 1000 : 0) +
    (birthYear ? Math.min(Math.max(birthYear - 1800, 0), 250) : 0) +
    (parentCounts.get(person.id) ?? 0) * 15 -
    (childCounts.get(person.id) ?? 0) * 4
  );
}

function isParentRelationLabel(type: string): boolean {
  return ["бать", "мат", "parent", "father", "mother", "р±р°с‚", "рјр°с‚"].some((part) => type.includes(part));
}

function isChildRelationLabel(type: string): boolean {
  return ["син", "донь", "дит", "child", "son", "daughter", "сѓсђ", "рґрѕрЅ", "рґрё"].some((part) => type.includes(part));
}

function personDisplayName(person: Person): string {
  return person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ") || "Особа без імені";
}

function yearFromDateText(value: string): number | null {
  const match = value.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return match ? Number(match[1]) : null;
}
