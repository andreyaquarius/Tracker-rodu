import { useRef, useState, type ChangeEvent } from "react";
import type {
  AppDatabase,
  AppEntity,
  CollectionKey,
  CustomFieldDefinition,
} from "../types";
import type { FieldConfig } from "../pages/entityConfigs";
import {
  buildImportedRecords,
  parseImportTableFile,
  supportedImportAccept,
} from "../utils/tableDataImport";

interface TableDataImportButtonProps {
  collection: CollectionKey;
  db: AppDatabase;
  fields: FieldConfig[];
  customFieldDefinitions?: CustomFieldDefinition[];
  onImport: (records: AppEntity[]) => Promise<void>;
}

export function TableDataImportButton({
  collection,
  db,
  fields,
  customFieldDefinitions = [],
  onImport,
}: TableDataImportButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const selectFile = () => {
    if (!busy) inputRef.current?.click();
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    try {
      const parsed = await parseImportTableFile(file);
      const { records, warnings, addedCount, updatedCount, unchangedCount } = buildImportedRecords({
        db,
        collection,
        fields,
        rows: parsed.rows,
        customFieldDefinitions,
      });
      if (!records.length && unchangedCount > 0) {
        window.alert(`Нових або змінених записів немає. Без змін: ${unchangedCount}.`);
        return;
      }
      if (!records.length) {
        throw new Error("У таблиці не знайдено заповнених рядків із колонками цього розділу.");
      }

      const warningText = warnings.length
        ? `\n\nЗверніть увагу:\n${warnings.slice(0, 5).join("\n")}${warnings.length > 5 ? `\nЩе попереджень: ${warnings.length - 5}.` : ""}`
        : "";
      const confirmed = window.confirm(
        `Аркуш «${parsed.sheetName}».\nНові записи: ${addedCount}.\nОновлені записи: ${updatedCount}.\nБез змін: ${unchangedCount}.${warningText}\n\nПродовжити імпорт?`,
      );
      if (!confirmed) return;

      await onImport(records);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Не вдалося імпортувати таблицю.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={supportedImportAccept()}
        hidden
        onChange={(event) => void importFile(event)}
      />
      <button
        type="button"
        className="button button-secondary"
        disabled={busy}
        onClick={selectFile}
      >
        {busy ? "Імпортуємо..." : "Імпорт даних"}
      </button>
    </>
  );
}
