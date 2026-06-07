import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AppEntity,
  DocumentRecord,
  Finding,
  FindingParticipant,
  Person,
  Research,
  ScanAttachment,
} from "../types";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import { DataTable } from "../components/DataTable";
import { Modal } from "../components/Modal";
import type { EntityConfig, FieldConfig } from "./entityConfigs";
import {
  participantRoles,
  participantSummary,
  primaryParticipantName,
} from "../utils/findingParticipants";
import { PersonSelector } from "../components/PersonSelector";
import { PersonFormModal } from "../components/PersonFormModal";
import {
  ScanAttachmentsEditor,
  ScanAttachmentsView,
} from "../components/ScanAttachments";
import type { PageKey } from "../components/Sidebar";
import { deleteScanFile } from "../services/scanStorage";

interface CrudPageProps {
  config: EntityConfig;
  items: AppEntity[];
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons?: Person[];
  initialSearch?: string;
  initialOpenEntityId?: string;
  initialCreateRequest?: {
    id: number;
    initialValues: Record<string, unknown>;
  };
  onOpenRelated?: (page: PageKey, entityId: string) => void;
  onSavePerson?: (person: Person) => void;
  onSave: (entity: AppEntity) => void;
  onDelete: (id: string) => void;
}

type FormValue = string | boolean | string[] | FindingParticipant[] | ScanAttachment[];
type FormRecord = Record<string, FormValue>;

export function CrudPage({
  config,
  items,
  researches,
  documents,
  findings,
  persons = [],
  initialSearch = "",
  initialOpenEntityId = "",
  initialCreateRequest,
  onOpenRelated,
  onSavePerson,
  onSave,
  onDelete,
}: CrudPageProps) {
  const [search, setSearch] = useState(initialSearch);
  const [researchFilter, setResearchFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editing, setEditing] = useState<AppEntity | null | "new">(null);
  const [viewing, setViewing] = useState<AppEntity | null>(null);
  const [createInitialValues, setCreateInitialValues] = useState<Record<string, unknown> | undefined>();

  useEffect(() => {
    setSearch(initialSearch);
  }, [initialSearch]);
  useEffect(() => {
    if (!initialOpenEntityId) return;
    const entity = items.find((item) => item.id === initialOpenEntityId);
    if (entity) setViewing(entity);
  }, [initialOpenEntityId, items]);
  useEffect(() => {
    if (!initialCreateRequest) return;
    setViewing(null);
    setCreateInitialValues(initialCreateRequest.initialValues);
    setEditing("new");
  }, [initialCreateRequest?.id]);
  const startNew = () => {
    setCreateInitialValues(undefined);
    setEditing("new");
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("uk");
    return items.filter((item) => {
      const row = item as unknown as Record<string, unknown>;
      const matchesSearch =
        !query ||
        Object.values(row).some((value) => searchableValue(value).includes(query));
      const matchesResearch = !researchFilter || row.researchId === researchFilter;
      const statusValue = row.status ?? row.reviewStatus;
      const matchesStatus = !statusFilter || statusValue === statusFilter;
      return matchesSearch && matchesResearch && matchesStatus;
    });
  }, [items, researchFilter, search, statusFilter]);

  const confirmDelete = async (entity: AppEntity) => {
    if (window.confirm(`Видалити ${config.singular}? Цю дію не можна скасувати.`)) {
      const scans = (entity as unknown as { scans?: ScanAttachment[] }).scans ?? [];
      await Promise.allSettled(scans.map(deleteScanFile));
      onDelete(entity.id);
    }
  };

  const quickStatus = (entity: AppEntity, status: string) => {
    const key = config.statusKey;
    if (!key) return;
    onSave({
      ...(entity as unknown as Record<string, unknown>),
      [key]: status,
      updatedAt: nowIso(),
    } as unknown as AppEntity);
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Робочий простір</span>
          <h1>{config.title}</h1>
          <p>{config.description}</p>
        </div>
        <button className="button button-primary" onClick={startNew}>
          + Додати {config.singular}
        </button>
      </div>

      <section className="panel">
        <div className="filters">
          <label className="search-field">
            <span>Пошук</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={config.searchPlaceholder} />
          </label>
          {config.fields.some((field) => field.type === "research") ? (
            <label>
              <span>Дослідження</span>
              <select value={researchFilter} onChange={(event) => setResearchFilter(event.target.value)}>
                <option value="">Усі дослідження</option>
                {researches.map((research) => (
                  <option key={research.id} value={research.id}>{research.title}</option>
                ))}
              </select>
            </label>
          ) : null}
          {config.statusOptions ? (
            <label>
              <span>Статус</span>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">Усі статуси</option>
                {config.statusOptions.map((status) => <option key={status}>{status}</option>)}
              </select>
            </label>
          ) : null}
          <div className="result-count">{filtered.length} з {items.length}</div>
        </div>

        {filtered.length ? (
          <DataTable
            items={filtered}
            columns={config.columns}
            documents={documents}
            researches={researches}
            onView={setViewing}
            onEdit={setEditing}
            onDelete={(entity) => void confirmDelete(entity)}
            onOpenRelated={onOpenRelated}
            onQuickStatus={config.statusKey ? quickStatus : undefined}
            statusOptions={config.statusOptions}
          />
        ) : (
          <div className="empty-state">
            <button
              type="button"
              className="empty-mark"
              onClick={startNew}
              aria-label={`Додати ${config.singular}`}
              title={`Додати ${config.singular}`}
            >
              +
            </button>
            <h2>{search || researchFilter || statusFilter ? "Нічого не знайдено" : config.emptyText}</h2>
            <p>
              {search || researchFilter || statusFilter
                ? `Змініть фільтри або додайте ${config.singular}.`
                : `Натисніть плюс, щоб додати ${config.singular}.`}
            </p>
          </div>
        )}
      </section>

      {viewing ? (
        <EntityDetailsModal
          config={config}
          entity={viewing}
          researches={researches}
          documents={documents}
          findings={findings}
          persons={persons}
          onOpenRelated={onOpenRelated}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
        />
      ) : null}

      {editing ? (
        <EntityModal
          config={config}
          entity={editing === "new" ? null : editing}
          initialValues={editing === "new" ? createInitialValues : undefined}
          researches={researches}
          documents={documents}
          findings={findings}
          persons={persons}
          onSavePerson={onSavePerson}
          onClose={() => {
            setEditing(null);
            setCreateInitialValues(undefined);
          }}
          onSave={(entity) => {
            onSave(entity);
            setEditing(null);
            setCreateInitialValues(undefined);
          }}
        />
      ) : null}
    </>
  );
}

function EntityDetailsModal({
  config,
  entity,
  researches,
  documents,
  findings,
  persons,
  onOpenRelated,
  onClose,
  onEdit,
}: {
  config: EntityConfig;
  entity: AppEntity;
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons: Person[];
  onOpenRelated?: (page: PageKey, entityId: string) => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const record = entity as unknown as Record<string, unknown>;
  const visibleFields = config.fields.filter((field) => {
    const value = record[field.key];
    return value === true || (
      value !== false &&
      value !== null &&
      value !== undefined &&
      (Array.isArray(value) ? value.length > 0 : String(value).trim() !== "")
    );
  });

  return (
    <Modal title={getEntityTitle(config, record)} onClose={onClose}>
      <div className="details-body">
        {visibleFields.length ? (
          <div className="details-grid">
            {visibleFields.map((field) => (
              <div
                key={field.key}
                className={`detail-item ${field.wide || field.type === "textarea" ? "detail-wide" : ""}`}
              >
                <span>{field.label}</span>
                <DetailValue
                  field={field}
                  value={record[field.key]}
                  researches={researches}
                  documents={documents}
                  findings={findings}
                  persons={persons}
                  onOpenRelated={onOpenRelated}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-inline">У цьому записі ще немає заповнених даних.</div>
        )}
        <div className="details-meta">
          <span>Створено: {formatEntityDate(entity.createdAt)}</span>
          <span>Оновлено: {formatEntityDate(entity.updatedAt)}</span>
        </div>
        <div className="details-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Закрити
          </button>
          <button type="button" className="button button-primary" onClick={onEdit}>
            Редагувати
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DetailValue({
  field,
  value,
  researches,
  documents,
  findings,
  persons,
  onOpenRelated,
}: {
  field: FieldConfig;
  value: unknown;
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons: Person[];
  onOpenRelated?: (page: PageKey, entityId: string) => void;
}) {
  if (field.type === "research") {
    const research = researches.find((item) => item.id === value);
    return research ? (
      <RelatedButton onClick={() => onOpenRelated?.("researches", research.id)}>
        {research.title}
      </RelatedButton>
    ) : <strong>Без прив’язки</strong>;
  }
  if (field.type === "checkbox") {
    return <strong>{value ? "Так" : "Ні"}</strong>;
  }
  if (field.type === "document") {
    const document = documents.find((item) => item.id === value);
    return document ? (
      <RelatedButton onClick={() => onOpenRelated?.("documents", document.id)}>
        {documentLabel(document)}
      </RelatedButton>
    ) : <strong>Не вибрано</strong>;
  }
  if (field.type === "documents") {
    const ids = Array.isArray(value) ? value : [];
    return (
      <div className="linked-items">
        {ids.map((id) => {
          const document = documents.find((item) => item.id === id);
          return document ? (
            <RelatedButton key={id} onClick={() => onOpenRelated?.("documents", document.id)}>
              {documentLabel(document)}
            </RelatedButton>
          ) : <span key={id}>Документ недоступний</span>;
        })}
      </div>
    );
  }
  if (field.type === "findings") {
    const ids = Array.isArray(value) ? value : [];
    return (
      <div className="linked-items">
        {ids.map((id) => {
          const finding = findings.find((item) => item.id === id);
          return finding ? (
            <RelatedButton key={id} onClick={() => onOpenRelated?.("findings", finding.id)}>
              {findingLabel(finding)}
            </RelatedButton>
          ) : <span key={id}>Знахідка недоступна</span>;
        })}
      </div>
    );
  }
  if (field.type === "persons") {
    const ids = Array.isArray(value) ? value : [];
    return (
      <div className="linked-items">
        {ids.map((id) => {
          const person = persons.find((item) => item.id === id);
          return person ? (
            <RelatedButton key={id} onClick={() => onOpenRelated?.("persons", person.id)}>
              {personName(person)}
            </RelatedButton>
          ) : <span key={id}>Особа недоступна</span>;
        })}
      </div>
    );
  }
  if (field.type === "scans") {
    const scans = Array.isArray(value) ? value as ScanAttachment[] : [];
    return <ScanAttachmentsView scans={scans} />;
  }
  if (field.type === "participants") {
    const participants = Array.isArray(value) ? value as FindingParticipant[] : [];
    return (
      <div className="participant-details">
        {participants.map((participant) => (
          <div key={participant.id}>
            <strong>{participant.role}</strong>
            <span>{participant.name}</span>
            {participant.notes ? <small>{participant.notes}</small> : null}
          </div>
        ))}
      </div>
    );
  }
  if (field.type === "url" && typeof value === "string") {
    return (
      <a href={value} target="_blank" rel="noreferrer">
        Відкрити посилання ↗
      </a>
    );
  }
  const text = String(value ?? "");
  const isStatus = field.key === "status" || field.key === "reviewStatus";
  return isStatus ? (
    <span className="status-pill">{text}</span>
  ) : (
    <div className="detail-text">{text}</div>
  );
}

function RelatedButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="related-record-button" onClick={onClick}>
      <span>{children}</span>
      <small>Відкрити →</small>
    </button>
  );
}

function getEntityTitle(config: EntityConfig, record: Record<string, unknown>): string {
  if (Array.isArray(record.participants)) {
    const participantName = primaryParticipantName(record.participants as FindingParticipant[]);
    if (participantName) return participantName;
  }
  const preferredKeys = ["title", "people", "year", "personName"];
  const value = preferredKeys.map((key) => record[key]).find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value : `Перегляд: ${config.singular}`;
}

function formatEntityDate(value: string): string {
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function EntityModal({
  config,
  entity,
  initialValues,
  researches,
  documents,
  findings,
  persons,
  onSavePerson,
  onClose,
  onSave,
}: {
  config: EntityConfig;
  entity: AppEntity | null;
  initialValues?: Record<string, unknown>;
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons: Person[];
  onSavePerson?: (person: Person) => void;
  onClose: () => void;
  onSave: (entity: AppEntity) => void;
}) {
  const initial = (entity ?? initialValues ?? {}) as unknown as FormRecord;
  const [form, setForm] = useState<FormRecord>(() => {
    const defaults: FormRecord = {};
    for (const field of config.fields) {
      defaults[field.key] = initial[field.key] ?? defaultFieldValue(field);
    }
    return defaults;
  });
  const [personSeed, setPersonSeed] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const timestamp = nowIso();
    const participants = Array.isArray(form.participants)
      ? form.participants as FindingParticipant[]
      : [];
    if (
      config.collection === "findings" &&
      !participants.some((participant) => participant.name.trim())
    ) {
      window.alert("Додайте принаймні одну особу, згадану в записі.");
      return;
    }
    onSave({
      ...(entity ?? {}),
      ...form,
      ...(config.collection === "findings"
        ? { people: participantSummary(participants), participants }
        : {}),
      id: entity?.id ?? createId(),
      createdAt: entity?.createdAt ?? timestamp,
      updatedAt: timestamp,
    } as unknown as AppEntity);
  };

  return (
    <Modal title={`${entity ? "Редагувати" : "Додати"} ${config.singular}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="form-grid">
          {config.fields.map((field) => (
            <FormField
              key={field.key}
              field={field}
              value={form[field.key]}
              researches={researches}
              documents={documents}
              findings={findings}
              persons={persons}
              researchId={String(form.researchId ?? "")}
              matrixYear={config.collection === "yearMatrix" ? String(form.year ?? "") : ""}
              matrixDocumentType={
                config.collection === "yearMatrix" ? String(form.documentType ?? "") : ""
              }
              findingType={config.collection === "findings" ? String(form.findingType ?? "") : ""}
              onCreatePerson={() => {
                const seed = config.collection === "findings"
                  ? String(form.personsText || participantSummary(
                      Array.isArray(form.participants) ? form.participants as FindingParticipant[] : [],
                    ))
                  : config.collection === "tasks"
                    ? String(form.personName ?? "")
                    : String(form.relatedPeople ?? "");
                setPersonSeed(seed);
              }}
              onChange={(value) => setForm((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Скасувати</button>
          <button type="submit" className="button button-primary">Зберегти</button>
        </div>
      </form>
      {personSeed !== null && onSavePerson ? (
        <PersonFormModal
          researches={researches}
          initialFullName={personSeed}
          initialResearchId={String(form.researchId ?? "")}
          onClose={() => setPersonSeed(null)}
          onSave={(person) => {
            onSavePerson(person);
            const selected = Array.isArray(form.personIds) ? form.personIds as string[] : [];
            setForm((current) => ({ ...current, personIds: [...new Set([...selected, person.id])] }));
            setPersonSeed(null);
          }}
        />
      ) : null}
    </Modal>
  );
}

function FormField({
  field,
  value,
  researches,
  documents,
  findings,
  persons,
  researchId,
  matrixYear,
  matrixDocumentType,
  findingType,
  onCreatePerson,
  onChange,
}: {
  field: FieldConfig;
  value: FormValue;
  researches: Research[];
  documents: DocumentRecord[];
  findings: Finding[];
  persons: Person[];
  researchId: string;
  matrixYear: string;
  matrixDocumentType: string;
  findingType: string;
  onCreatePerson: () => void;
  onChange: (value: FormValue) => void;
}) {
  if (field.type === "checkbox") {
    return (
      <label className={`checkbox-field ${field.wide ? "field-wide" : ""}`}>
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.type === "participants") {
    const participants = Array.isArray(value) ? value as FindingParticipant[] : [];
    return (
      <ParticipantsEditor
        participants={participants}
        findingType={findingType}
        required={field.required}
        onChange={onChange}
      />
    );
  }
  if (field.type === "scans") {
    const scans = Array.isArray(value) ? value as ScanAttachment[] : [];
    return <ScanAttachmentsEditor scans={scans} onChange={onChange} />;
  }
  if (field.type === "persons") {
    const selected = Array.isArray(value) ? value as string[] : [];
    return (
      <PersonSelector
        persons={persons}
        selectedIds={selected}
        researchId={researchId}
        createLabel={field.key === "personIds" && findingType ? "Створити особу зі знахідки" : "Створити нову особу"}
        onChange={onChange}
        onCreate={onCreatePerson}
      />
    );
  }
  const availableDocuments = documents.filter((item) => {
    const matchesResearch = !researchId || !item.researchId || item.researchId === researchId;
    const matchesYear = !matrixYear || documentCoversYear(item, Number(matrixYear));
    const matchesType =
      !matrixDocumentType ||
      !item.documentType ||
      normalizeDocumentType(item.documentType) === normalizeDocumentType(matrixDocumentType);
    return matchesResearch && matchesYear && matchesType;
  });
  const availableFindings = findings.filter(
    (item) => !researchId || !item.researchId || item.researchId === researchId,
  );
  if (field.type === "documents" || field.type === "findings") {
    const selected = Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value as string[]
      : [];
    const options =
      field.type === "documents"
        ? availableDocuments.map((item) => ({ id: item.id, label: documentLabel(item) }))
        : availableFindings.map((item) => ({ id: item.id, label: findingLabel(item) }));
    return (
      <RelationSelector
        label={field.label}
        addLabel={field.type === "documents" ? "Додати документ" : "Додати знахідку"}
        searchPlaceholder={field.type === "documents" ? "Пошук документа…" : "Пошук знахідки…"}
        emptyLabel={field.type === "documents" ? "Пов’язаних документів не вибрано." : "Пов’язаних знахідок не вибрано."}
        noOptionsLabel={`Спочатку додайте ${field.type === "documents" ? "документи" : "знахідки"} до цього дослідження.`}
        options={options}
        selectedIds={selected}
        wide={field.wide}
        onChange={onChange}
      />
    );
  }
  const common = {
    value: Array.isArray(value) ? "" : String(value ?? ""),
    required: field.required,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(event.target.value),
  };
  return (
    <label className={field.wide ? "field-wide" : ""}>
      <span>{field.label}{field.required ? " *" : ""}</span>
      {field.type === "textarea" ? (
        <textarea {...common} rows={4} />
      ) : field.type === "select" ? (
        <select {...common}>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
      ) : field.type === "research" ? (
        <select {...common}>
          <option value="">Без прив’язки</option>
          {researches.map((research) => <option key={research.id} value={research.id}>{research.title}</option>)}
        </select>
      ) : field.type === "document" ? (
        <select {...common}>
          <option value="">Без пов’язаного документа</option>
          {availableDocuments.map((document) => (
            <option key={document.id} value={document.id}>{documentLabel(document)}</option>
          ))}
        </select>
      ) : (
        <input {...common} type={field.type ?? "text"} />
      )}
    </label>
  );
}

function RelationSelector({
  label,
  addLabel,
  searchPlaceholder,
  emptyLabel,
  noOptionsLabel,
  options,
  selectedIds,
  wide,
  onChange,
}: {
  label: string;
  addLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  noOptionsLabel: string;
  options: Array<{ id: string; label: string }>;
  selectedIds: string[];
  wide?: boolean;
  onChange: (value: FormValue) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("uk");
  const filteredOptions = options.filter((option) =>
    !normalizedQuery || option.label.toLocaleLowerCase("uk").includes(normalizedQuery)
  );
  const selectedOptions = selectedIds.map((id) => ({
    id,
    label: options.find((option) => option.id === id)?.label ?? "Запис недоступний",
  }));

  return (
    <fieldset className={`relation-picker ${wide ? "field-wide" : ""}`}>
      <div className="person-selector-heading">
        <legend>{label}</legend>
        <button
          type="button"
          className="button button-secondary relation-add-button"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Закрити вибір" : `+ ${addLabel}`}
        </button>
      </div>
      {selectedOptions.length ? (
        <div className="selected-relations">
          {selectedOptions.map((option) => (
            <div key={option.id}>
              <span><strong>{option.label}</strong></span>
              <button
                type="button"
                aria-label="Прибрати зв’язок"
                title="Прибрати зв’язок"
                onClick={() => onChange(selectedIds.filter((id) => id !== option.id))}
              >×</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="relation-empty-hint">{emptyLabel}</p>
      )}
      {expanded ? (
        <div className="relation-chooser">
          <input
            autoFocus
            value={query}
            placeholder={searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
          />
          {options.length ? (
            filteredOptions.length ? (
              <div className="relation-options">
                {filteredOptions.map((option) => (
                  <label key={option.id}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(option.id)}
                      onChange={(event) =>
                        onChange(
                          event.target.checked
                            ? [...selectedIds, option.id]
                            : selectedIds.filter((id) => id !== option.id),
                        )
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            ) : <p>За цим запитом нічого не знайдено.</p>
          ) : <p>{noOptionsLabel}</p>}
        </div>
      ) : null}
    </fieldset>
  );
}

function defaultFieldValue(field: FieldConfig): FormValue {
  if (field.type === "checkbox") return false;
  if (
    field.type === "documents" ||
    field.type === "findings" ||
    field.type === "participants" ||
    field.type === "persons" ||
    field.type === "scans"
  ) return [];
  if (field.type === "select") return field.options?.[0] ?? "";
  return "";
}

function documentLabel(document: DocumentRecord): string {
  const details = [
    document.documentType,
    documentPeriod(document),
    document.place,
  ].filter(Boolean).join(" · ");
  return details ? `${document.title} — ${details}` : document.title;
}

function documentPeriod(document: DocumentRecord): string {
  const from = document.yearFrom.trim();
  const to = document.yearTo.trim();
  if (from && to && from !== to) return `${from}–${to}`;
  if (from || to) return from || to;
  return "рік не вказано";
}

function documentCoversYear(document: DocumentRecord, year: number): boolean {
  if (!Number.isFinite(year)) return true;
  const from = Number(document.yearFrom);
  const to = Number(document.yearTo);
  const hasFrom = Number.isFinite(from) && document.yearFrom.trim() !== "";
  const hasTo = Number.isFinite(to) && document.yearTo.trim() !== "";
  if (!hasFrom && !hasTo) return true;
  if (hasFrom && year < from) return false;
  if (hasTo && year > to) return false;
  return true;
}

function normalizeDocumentType(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("uk");
  const aliases: Record<string, string> = {
    "метрична книга": "народження",
    "народження": "народження",
    "шлюб": "шлюби",
    "шлюби": "шлюби",
    "смерть": "смерті",
    "смерті": "смерті",
    "сповідний розпис": "сповідки",
    "сповідки": "сповідки",
    "ревізія": "ревізії",
    "ревізії": "ревізії",
    "інвентар": "інвентарі",
    "інвентарі": "інвентарі",
  };
  return aliases[normalized] ?? normalized;
}

function findingLabel(finding: Finding): string {
  const title = primaryParticipantName(finding.participants) || finding.people || finding.summary || "Знахідка";
  const details = [finding.findingType, finding.eventDate, finding.place].filter(Boolean).join(" · ");
  return details ? `${title} — ${details}` : title;
}

function personName(person: Person): string {
  return person.fullName ||
    [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ") ||
    "Особа без імені";
}

function ParticipantsEditor({
  participants,
  findingType,
  required,
  onChange,
}: {
  participants: FindingParticipant[];
  findingType: string;
  required?: boolean;
  onChange: (value: FormValue) => void;
}) {
  const roles = participantRoles(findingType);
  const addParticipant = () => {
    onChange([
      ...participants,
      {
        id: createId(),
        role: roles[0] ?? "Інша особа",
        name: "",
        notes: "",
      },
    ]);
  };
  const updateParticipant = (id: string, patch: Partial<FindingParticipant>) => {
    onChange(participants.map((participant) =>
      participant.id === id ? { ...participant, ...patch } : participant,
    ));
  };
  const removeParticipant = (id: string) => {
    onChange(participants.filter((participant) => participant.id !== id));
  };

  return (
    <fieldset className="participants-editor field-wide">
      <div className="participants-heading">
        <div>
          <legend>Учасники запису{required ? " *" : ""}</legend>
          <p>Додайте всіх осіб, згаданих у джерелі, та вкажіть їхню роль.</p>
        </div>
        <button type="button" className="button button-secondary" onClick={addParticipant}>
          + Додати особу
        </button>
      </div>
      {participants.length ? (
        <div className="participant-list">
          {participants.map((participant, index) => {
            const availableRoles = participant.role && !roles.includes(participant.role)
              ? [...roles, participant.role]
              : roles;
            return (
              <div className="participant-row" key={participant.id}>
                <span className="participant-number">{index + 1}</span>
                <label>
                  <span>Роль</span>
                  <select
                    value={participant.role}
                    onChange={(event) => updateParticipant(participant.id, { role: event.target.value })}
                  >
                    {availableRoles.map((role) => <option key={role}>{role}</option>)}
                  </select>
                </label>
                <label>
                  <span>ПІБ або ім’я</span>
                  <input
                    value={participant.name}
                    required={required && index === 0}
                    placeholder="Як записано у джерелі"
                    onChange={(event) => updateParticipant(participant.id, { name: event.target.value })}
                  />
                </label>
                <label className="participant-notes">
                  <span>Уточнення</span>
                  <input
                    value={participant.notes}
                    placeholder="Вік, стан, спорідненість, місце проживання…"
                    onChange={(event) => updateParticipant(participant.id, { notes: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="icon-button danger participant-remove"
                  onClick={() => removeParticipant(participant.id)}
                  title="Видалити особу"
                  aria-label="Видалити особу"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <button type="button" className="participant-empty" onClick={addParticipant}>
          Ще немає учасників. Натисніть, щоб додати першу особу.
        </button>
      )}
    </fieldset>
  );
}

function searchableValue(value: unknown): string {
  if (typeof value === "string") return value.toLocaleLowerCase("uk");
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          return Object.values(item).filter((part) => typeof part === "string").join(" ");
        }
        return String(item ?? "");
      })
      .join(" ")
      .toLocaleLowerCase("uk");
  }
  return "";
}
