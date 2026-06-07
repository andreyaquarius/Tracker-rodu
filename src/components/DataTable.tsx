import type { AppEntity, DocumentRecord, Research } from "../types";
import type { PageKey } from "./Sidebar";

export interface TableColumn {
  key: string;
  label: string;
  render?: (entity: AppEntity) => string;
}

interface DataTableProps {
  items: AppEntity[];
  columns: TableColumn[];
  documents: DocumentRecord[];
  researches: Research[];
  onView: (entity: AppEntity) => void;
  onEdit: (entity: AppEntity) => void;
  onDelete: (entity: AppEntity) => void;
  onOpenRelated?: (page: PageKey, entityId: string) => void;
  onQuickStatus?: (entity: AppEntity, status: string) => void;
  statusOptions?: string[];
}

export function DataTable({
  items,
  columns,
  documents,
  researches,
  onView,
  onEdit,
  onDelete,
  onOpenRelated,
  onQuickStatus,
  statusOptions,
}: DataTableProps) {
  if (!items.length) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
            <th className="actions-column">Дії</th>
          </tr>
        </thead>
        <tbody>
          {items.map((entity) => {
            const record = entity as unknown as Record<string, unknown>;
            return (
              <tr
                key={entity.id}
                className="clickable-row"
                tabIndex={0}
                onClick={() => onView(entity)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onView(entity);
                  }
                }}
                aria-label="Відкрити запис"
              >
                {columns.map((column) => {
                  const relatedId = String(record[column.key] ?? "");
                  const value = column.key === "documentId"
                    ? documentTitle(documents, relatedId)
                    : column.key === "researchId"
                      ? researchTitle(researches, relatedId)
                      : column.render?.(entity) ?? String(record[column.key] ?? "—");
                  const isStatus = column.key === "status" || column.key === "reviewStatus";
                  const relatedPage = column.key === "documentId"
                    ? "documents"
                    : column.key === "researchId"
                      ? "researches"
                      : null;
                  return (
                    <td key={column.key} data-label={column.label}>
                      {isStatus ? (
                        <span className={`status-pill status-${slug(value)}`}>{value}</span>
                      ) : relatedPage && relatedId && onOpenRelated ? (
                        <button
                          type="button"
                          className="table-related-link"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenRelated(relatedPage, relatedId);
                          }}
                        >
                          {value} →
                        </button>
                      ) : value}
                    </td>
                  );
                })}
                <td className="row-actions" data-label="Дії">
                  {onQuickStatus && statusOptions ? (
                    <select
                      aria-label="Швидко змінити статус"
                      value={String(record.status ?? record.reviewStatus ?? "")}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        event.stopPropagation();
                        onQuickStatus(entity, event.target.value);
                      }}
                    >
                      {statusOptions.map((status) => (
                        <option key={status}>{status}</option>
                      ))}
                    </select>
                  ) : null}
                  <button
                    className="icon-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onEdit(entity);
                    }}
                    title="Редагувати"
                  >
                    ✎
                  </button>
                  <button
                    className="icon-button danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(entity);
                    }}
                    title="Видалити"
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function documentTitle(documents: DocumentRecord[], id: string): string {
  if (!id) return "Не прив’язано";
  const document = documents.find((item) => item.id === id);
  return document?.title ?? "Документ недоступний";
}

function researchTitle(researches: Research[], id: string): string {
  if (!id) return "Без прив’язки";
  const research = researches.find((item) => item.id === id);
  return research?.title ?? "Дослідження недоступне";
}

function slug(value: string): string {
  return value
    .toLocaleLowerCase("uk")
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");
}
