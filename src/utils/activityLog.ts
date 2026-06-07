import type {
  ActivityLogEntry,
  AppEntity,
  CollectionKey,
  DocumentRecord,
  Person,
  Research,
  TaskRecord,
  YearMatrixRecord,
} from "../types";
import { nowIso } from "./dateHelpers";
import { createId } from "./id";

export function createActivityEntries(
  collection: CollectionKey,
  previous: AppEntity | undefined,
  next: AppEntity,
): ActivityLogEntry[] {
  const entries: ActivityLogEntry[] = [];
  const add = (
    actionType: ActivityLogEntry["actionType"],
    text: string,
  ) => {
    entries.push({
      id: createId(),
      createdAt: nowIso(),
      actionType,
      text,
      module: collection,
      relatedId: next.id,
    });
  };

  if (collection === "researches") {
    const research = next as Research;
    add(
      previous ? "research_updated" : "research_created",
      previous
        ? `Змінено дослідження «${research.title}»`
        : `Створено дослідження «${research.title}»`,
    );
  }

  if (collection === "documents") {
    const document = next as DocumentRecord;
    const oldDocument = previous as DocumentRecord | undefined;
    if (!oldDocument) {
      add("document_created", `Додано документ «${document.title}»`);
    } else {
      if (oldDocument.reviewStatus !== document.reviewStatus) {
        add(
          "document_status_changed",
          `Статус документа «${document.title}» змінено на «${document.reviewStatus}»`,
        );
      }
      if (oldDocument.lastPage !== document.lastPage) {
        add(
          "document_last_page_updated",
          document.lastPage
            ? `У документі «${document.title}» переглянуто до сторінки ${document.lastPage}`
            : `У документі «${document.title}» очищено останню переглянуту сторінку`,
        );
      }
    }
  }

  if (collection === "tasks") {
    const task = next as TaskRecord;
    const oldTask = previous as TaskRecord | undefined;
    if (!oldTask) {
      add("task_created", `Додано завдання «${task.title}»`);
    } else if (oldTask.status !== task.status) {
      add(
        "task_status_changed",
        `Статус завдання «${task.title}» змінено на «${task.status}»`,
      );
    }
  }

  if (collection === "findings" && !previous) {
    add("finding_created", "Додано нову знахідку");
  }

  if (collection === "hypotheses" && !previous) {
    const hypothesis = next as { title: string };
    add("hypothesis_created", `Додано гіпотезу «${hypothesis.title}»`);
  }

  if (collection === "yearMatrix" && previous) {
    const year = next as YearMatrixRecord;
    const oldYear = previous as YearMatrixRecord;
    if (oldYear.status !== year.status) {
      add(
        "year_status_changed",
        `Статус ${year.year} року змінено на «${year.status}»`,
      );
    }
  }

  if (collection === "persons") {
    const person = next as Person;
    const name = person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ");
    add(
      previous ? "person_updated" : "person_created",
      previous ? `Змінено картку особи «${name}»` : `Створено картку особи «${name}»`,
    );
  }

  return entries;
}
