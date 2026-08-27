import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { DocumentRecord, Finding, PersonName, PersonNameType } from "../../types";
import {
  createProjectPersonName,
  deleteProjectPersonName,
  emptyProjectPersonNameDraft,
  previewProjectPersonNameNormalization,
  projectPersonNameSuggestionMatchLabel,
  projectPersonNameSuggestionQuery,
  projectPersonNameDraft,
  searchProjectPersonNameSuggestions,
  setPrimaryProjectPersonName,
  updateProjectPersonName,
  type ProjectPersonNameSuggestion,
  type ProjectPersonNameDraft,
  type ProjectPersonNameNormalizationPreview,
} from "../../services/projectPersonNames";
import {
  isKnownPersonNameLanguageCode,
  PERSON_NAME_LANGUAGE_OPTIONS,
  personNameLanguageLabel,
} from "../../utils/personNameMetadataOptions";
import {
  applyPersonNameSourceChoice,
  personNameSourceChoice,
} from "../../utils/personNameSourceSelection";
import "./personNamesV2.css";

const nameTypeOptions: ReadonlyArray<{ value: PersonNameType; label: string }> = [
  { value: "primary", label: "Основне ім’я" },
  { value: "birth", label: "Ім’я при народженні" },
  { value: "document", label: "Ім’я в документі" },
  { value: "maiden", label: "Дівоче прізвище" },
  { value: "married", label: "Шлюбне прізвище" },
  { value: "previous", label: "Попереднє прізвище" },
  { value: "alias", label: "Псевдонім" },
  { value: "nickname", label: "Прізвисько" },
  { value: "church", label: "Церковне ім’я" },
  { value: "other_language", label: "Ім’я іншою мовою" },
  { value: "transliteration", label: "Транслітерація" },
  { value: "normalized", label: "Нормалізований варіант" },
  { value: "incorrect", label: "Помилкове написання в джерелі" },
  { value: "variant", label: "Варіант написання" },
  { value: "unknown", label: "Невизначений тип" },
  // Legacy values remain selectable so an existing row is never silently remapped.
  { value: "religious", label: "Церковне ім’я (старий тип)" },
  { value: "language_variant", label: "Ім’я іншою мовою (старий тип)" },
  { value: "source_error", label: "Помилка в джерелі (старий тип)" },
  { value: "original", label: "Оригінальне написання (старий тип)" },
  { value: "patronymic_variant", label: "Варіант по батькові" },
  { value: "surname_variant", label: "Варіант прізвища" },
  { value: "other", label: "Невизначений тип" },
];

export interface PersonNamesEditorV2Props {
  projectId: string;
  personId: string;
  names: readonly PersonName[];
  loading?: boolean;
  loadError?: string;
  documents?: readonly DocumentRecord[];
  findings?: readonly Finding[];
  onChanged: (names: PersonName[]) => void;
}

export function PersonNamesEditorV2({
  projectId,
  personId,
  names,
  loading = false,
  loadError = "",
  documents = [],
  findings = [],
  onChanged,
}: PersonNamesEditorV2Props) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<ProjectPersonNameDraft>(emptyProjectPersonNameDraft);
  const [workingAction, setWorkingAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [normalizationPreview, setNormalizationPreview] =
    useState<ProjectPersonNameNormalizationPreview | null>(null);
  const [nameSuggestions, setNameSuggestions] = useState<ProjectPersonNameSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState("");
  const sortedNames = useMemo(() => [...names].sort(comparePersonNames), [names]);
  const suggestionQuery = useMemo(
    () => editingId ? projectPersonNameSuggestionQuery(draft) : "",
    [draft.fullName, draft.fullNormalized, draft.originalText, editingId],
  );

  useEffect(() => {
    if (!editingId || editingId === "new") return;
    if (!names.some((name) => name.id === editingId)) {
      setEditingId(null);
      setDraft(emptyProjectPersonNameDraft());
    }
  }, [editingId, names]);

  useEffect(() => {
    if (!editingId || !suggestionQuery) {
      setNameSuggestions([]);
      setSuggestionsLoading(false);
      setSuggestionsError("");
      return;
    }

    const controller = new AbortController();
    setNameSuggestions([]);
    // Keep the debounce interval honest in the UI: until this exact query has
    // completed, do not briefly claim that no matching person exists.
    setSuggestionsLoading(true);
    setSuggestionsError("");
    const timer = window.setTimeout(() => {
      setSuggestionsError("");
      void searchProjectPersonNameSuggestions({
        projectId,
        query: suggestionQuery,
        excludePersonId: personId,
        limit: 6,
        signal: controller.signal,
      }).then((suggestions) => {
        if (!controller.signal.aborted) setNameSuggestions(suggestions);
      }).catch((error: unknown) => {
        if (!controller.signal.aborted && !requestAborted(error)) {
          setNameSuggestions([]);
          setSuggestionsError("Не вдалося перевірити можливі збіги. Варіант імені можна зберегти без цієї перевірки.");
        }
      }).finally(() => {
        if (!controller.signal.aborted) setSuggestionsLoading(false);
      });
    }, 320);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [editingId, personId, projectId, suggestionQuery]);

  const beginCreate = () => {
    setEditingId("new");
    setDraft(emptyProjectPersonNameDraft());
    setActionError("");
    setNormalizationPreview(null);
  };

  const beginEdit = (name: PersonName) => {
    setEditingId(name.id);
    setDraft(projectPersonNameDraft(name));
    setActionError("");
    setNormalizationPreview(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(emptyProjectPersonNameDraft());
    setActionError("");
    setNormalizationPreview(null);
  };

  const saveDraft = async () => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.nameType)) {
      setActionError("Код типу має починатися з малої латинської літери або цифри й містити лише a-z, 0-9, дефіс чи підкреслення.");
      return;
    }
    if (!draft.fullName.trim() && !draft.fullNormalized.trim() && !draft.originalText) {
      setActionError("Вкажіть нормалізоване ім’я або точний оригінал із джерела.");
      return;
    }
    setWorkingAction("save");
    setActionError("");
    try {
      const saved = editingId === "new"
        ? await createProjectPersonName({ projectId, personId, draft })
        : await updateProjectPersonName({ projectId, personId, nameId: editingId!, draft });
      onChanged([
        saved,
        ...names.filter((name) => name.id !== saved.id),
      ].sort(comparePersonNames));
      cancelEdit();
    } catch (error) {
      setActionError(errorMessage(error, "Не вдалося зберегти варіант імені."));
    } finally {
      setWorkingAction("");
    }
  };

  const previewNormalization = async () => {
    const value = draft.originalText || draft.fullName || draft.fullNormalized;
    if (!value) {
      setActionError("Спочатку введіть точне написання з джерела або повне ім’я.");
      return;
    }
    setWorkingAction("preview");
    setActionError("");
    try {
      setNormalizationPreview(await previewProjectPersonNameNormalization({ projectId, value }));
    } catch (error) {
      setActionError(errorMessage(error, "Не вдалося підготувати попередній перегляд нормалізації."));
    } finally {
      setWorkingAction("");
    }
  };

  const makePrimary = async (name: PersonName) => {
    setWorkingAction(`primary:${name.id}`);
    setActionError("");
    try {
      onChanged(await setPrimaryProjectPersonName({ projectId, personId, nameId: name.id }));
    } catch (error) {
      setActionError(errorMessage(error, "Не вдалося встановити основне ім’я."));
    } finally {
      setWorkingAction("");
    }
  };

  const removeName = async (name: PersonName) => {
    if (name.isPrimary) return;
    if (!window.confirm(`Видалити варіант «${displayPersonName(name)}»? Особу видалено не буде.`)) return;
    setWorkingAction(`delete:${name.id}`);
    setActionError("");
    try {
      await deleteProjectPersonName({ projectId, personId, nameId: name.id });
      onChanged(names.filter((item) => item.id !== name.id));
      if (editingId === name.id) cancelEdit();
    } catch (error) {
      setActionError(errorMessage(error, "Не вдалося видалити варіант імені."));
    } finally {
      setWorkingAction("");
    }
  };

  return (
    <div className="person-names-v2 field-wide" data-person-names-editor>
      <div className="person-names-v2__heading">
        <div>
          <strong>Структуровані імена</strong>
          <p>Додавайте точне написання з джерела окремо від нормалізованого варіанта.</p>
        </div>
        {!editingId ? (
          <button type="button" className="button button-secondary" onClick={beginCreate} disabled={loading}>
            + Додати варіант
          </button>
        ) : null}
      </div>

      {loading ? <p className="person-names-v2__notice" role="status">Завантажуємо варіанти імен…</p> : null}
      {loadError ? <p className="person-names-v2__notice is-error" role="alert">{loadError}</p> : null}
      {actionError ? <p className="person-names-v2__notice is-error" role="alert">{actionError}</p> : null}

      {!loading && sortedNames.length ? (
        <div className="person-names-v2__list">
          {sortedNames.map((name) => (
            <article className="person-names-v2__item" key={name.id}>
              <div className="person-names-v2__item-copy">
                <div className="person-names-v2__badges">
                  {name.isPrimary ? <span className="status-pill">Основне</span> : null}
                  {isManagedProjectionName(name) ? <span className="status-pill">Поточне ім’я картки</span> : null}
                  <span className="status-pill">{nameTypeLabel(name.nameType)}</span>
                  {name.languageCode ? <span className="status-pill">{personNameLanguageLabel(name.languageCode)}</span> : null}
                </div>
                <strong>{displayPersonName(name)}</strong>
                {name.originalText && name.originalText !== (name.fullNormalized || name.fullName) ? (
                  <span className="person-names-v2__original">Оригінал: {name.originalText}</span>
                ) : null}
                <small>{personNameMeta(name)}</small>
              </div>
              <div className="person-names-v2__actions">
                {!isManagedProjectionName(name) ? (
                  <button type="button" className="button button-ghost" onClick={() => beginEdit(name)}>
                    Редагувати
                  </button>
                ) : null}
                {!name.isPrimary ? (
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={Boolean(workingAction)}
                    onClick={() => void makePrimary(name)}
                  >
                    {workingAction === `primary:${name.id}` ? "Змінюємо…" : "Зробити основним"}
                  </button>
                ) : null}
                {!isManagedProjectionName(name) ? (
                  <button
                    type="button"
                    className="button button-danger"
                    disabled={name.isPrimary || Boolean(workingAction)}
                    title={name.isPrimary ? "Спочатку встановіть інший основний варіант" : undefined}
                    onClick={() => void removeName(name)}
                  >
                    {workingAction === `delete:${name.id}` ? "Видаляємо…" : "Видалити"}
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : !loading ? (
        <p className="person-names-v2__notice">Додаткових структурованих варіантів ще немає. Поточне ім’я картки збережено без змін.</p>
      ) : null}

      {editingId ? (
        <PersonNameDraftFields
          key={editingId}
          draft={draft}
          documents={documents}
          findings={findings}
          disabled={workingAction === "save" || workingAction === "preview"}
          normalizationPreview={normalizationPreview}
          suggestionQuery={suggestionQuery}
          suggestions={nameSuggestions}
          suggestionsLoading={suggestionsLoading}
          suggestionsError={suggestionsError}
          onChange={setDraft}
          onPreviewNormalization={() => void previewNormalization()}
          onApplyNormalization={(value) => {
            setDraft((current) => ({
              ...current,
              fullNormalized: value,
              fullName: !current.fullName || current.fullName === current.fullNormalized
                ? value
                : current.fullName,
            }));
          }}
          onSave={() => void saveDraft()}
          onCancel={cancelEdit}
        />
      ) : null}
    </div>
  );
}

function PersonNameDraftFields({
  draft,
  documents,
  findings,
  disabled,
  normalizationPreview,
  suggestionQuery,
  suggestions,
  suggestionsLoading,
  suggestionsError,
  onChange,
  onPreviewNormalization,
  onApplyNormalization,
  onSave,
  onCancel,
}: {
  draft: ProjectPersonNameDraft;
  documents: readonly DocumentRecord[];
  findings: readonly Finding[];
  disabled: boolean;
  normalizationPreview: ProjectPersonNameNormalizationPreview | null;
  suggestionQuery: string;
  suggestions: readonly ProjectPersonNameSuggestion[];
  suggestionsLoading: boolean;
  suggestionsError: string;
  onChange: (draft: ProjectPersonNameDraft) => void;
  onPreviewNormalization: () => void;
  onApplyNormalization: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const usesCustomNameType = !nameTypeOptions.some((option) => option.value === draft.nameType);
  const [customLanguageMode, setCustomLanguageMode] = useState(
    Boolean(draft.languageCode) && !isKnownPersonNameLanguageCode(draft.languageCode),
  );
  const usesCustomLanguage = customLanguageMode
    || Boolean(draft.languageCode) && !isKnownPersonNameLanguageCode(draft.languageCode);
  const update = <K extends keyof ProjectPersonNameDraft>(key: K, value: ProjectPersonNameDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };
  const sourceChoice = personNameSourceChoice(draft);
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const sourceChoiceAvailable = sourceChoice === ""
    || sourceChoice === "__legacy"
    || sourceChoice.startsWith("document:") && documentsById.has(sourceChoice.slice("document:".length))
    || sourceChoice.startsWith("finding:") && findingsById.has(sourceChoice.slice("finding:".length));
  const updateSource = (event: ChangeEvent<HTMLSelectElement>) => {
    const choice = event.target.value;
    const findingId = choice.startsWith("finding:")
      ? choice.slice("finding:".length)
      : "";
    onChange(applyPersonNameSourceChoice(draft, choice, {
      findingDocumentId: findingsById.get(findingId)?.documentId || null,
    }));
  };
  const updateNormalized = (value: string) => {
    onChange({
      ...draft,
      fullNormalized: value,
      fullName: !draft.fullName || draft.fullName === draft.fullNormalized
        ? value
        : draft.fullName,
    });
  };
  return (
    <div className="person-names-v2__form" aria-label="Редагування варіанта імені">
      <label>
        <span>Тип імені</span>
        <select
          value={usesCustomNameType ? "__custom" : draft.nameType}
          onChange={(event) => update(
            "nameType",
            event.target.value === "__custom" ? "custom" : event.target.value as PersonNameType,
          )}
        >
          {nameTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          <option value="__custom">Інший власний тип…</option>
        </select>
      </label>
      {usesCustomNameType ? (
        <label>
          <span>Код власного типу</span>
          <input
            value={draft.nameType}
            pattern="[a-z0-9][a-z0-9_-]{0,63}"
            maxLength={64}
            placeholder="наприклад, monastic"
            onChange={(event) => update("nameType", event.target.value.toLocaleLowerCase("uk-UA") as PersonNameType)}
          />
          <small>Латинські малі літери, цифри, дефіс або підкреслення.</small>
        </label>
      ) : null}
      <label>
        <span>Мова</span>
        <select
          value={usesCustomLanguage ? "__custom" : draft.languageCode}
          onChange={(event) => {
            const value = event.target.value;
            setCustomLanguageMode(value === "__custom");
            update("languageCode", value === "__custom" ? "" : value);
          }}
        >
          <option value="">Не вказано</option>
          {PERSON_NAME_LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label} ({option.value})</option>
          ))}
          <option value="__custom">Інша мова…</option>
        </select>
      </label>
      {usesCustomLanguage ? (
        <label>
          <span>Код іншої мови</span>
          <input
            value={draft.languageCode}
            maxLength={35}
            placeholder="Наприклад: fr або sr-Latn"
            onChange={(event) => update("languageCode", event.target.value)}
          />
          <small>Код ISO 639 або BCP 47. Наявні нестандартні коди не змінюються автоматично.</small>
        </label>
      ) : null}
      <label>
        <span>Історична орфографія</span>
        <input value={draft.orthography} onChange={(event) => update("orthography", event.target.value)} />
      </label>
      <label>
        <span>Прізвище</span>
        <input value={draft.surname} onChange={(event) => update("surname", event.target.value)} />
      </label>
      <label>
        <span>Дівоче прізвище</span>
        <input value={draft.maidenSurname} onChange={(event) => update("maidenSurname", event.target.value)} />
      </label>
      <label>
        <span>Ім’я</span>
        <input value={draft.givenName} onChange={(event) => update("givenName", event.target.value)} />
      </label>
      <label>
        <span>По батькові</span>
        <input value={draft.patronymic} onChange={(event) => update("patronymic", event.target.value)} />
      </label>
      <label>
        <span>Префікс</span>
        <input value={draft.prefix} onChange={(event) => update("prefix", event.target.value)} />
      </label>
      <label>
        <span>Суфікс</span>
        <input value={draft.suffix} onChange={(event) => update("suffix", event.target.value)} />
      </label>
      <label>
        <span>Прізвисько</span>
        <input value={draft.nickname} onChange={(event) => update("nickname", event.target.value)} />
      </label>
      <label className="field-wide">
        <span>Повне ім’я для відображення</span>
        <input value={draft.fullName} onChange={(event) => update("fullName", event.target.value)} />
        <small>Для нових варіантів автоматично повторює нормалізоване ім’я, але його можна уточнити окремо.</small>
      </label>
      <label className="field-wide">
        <span>Нормалізоване повне ім’я</span>
        <input value={draft.fullNormalized} onChange={(event) => updateNormalized(event.target.value)} />
      </label>
      <label className="field-wide">
        <span>Точне написання в джерелі</span>
        <textarea
          value={draft.originalText}
          rows={3}
          spellCheck={false}
          onChange={(event) => update("originalText", event.target.value)}
        />
        <small>Зберігається символ у символ і не змінюється при редагуванні нормалізованого імені.</small>
      </label>
      <div className="person-names-v2__normalization field-wide">
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled}
          onClick={onPreviewNormalization}
        >
          Переглянути нормалізацію
        </button>
        {normalizationPreview ? (
          <div>
            <span>Пропозиція (оригінал не буде змінено):</span>{" "}
            <strong>{normalizationPreview.normalized || "Немає пропозиції"}</strong>{" "}
            {normalizationPreview.normalized ? (
              <button
                type="button"
                className="button button-ghost"
                onClick={() => onApplyNormalization(normalizationPreview.normalized)}
              >
                Застосувати
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <section
        className="person-names-v2__suggestions field-wide"
        aria-label="Можливі збіги з іншими особами"
        aria-busy={suggestionsLoading}
      >
        <div className="person-names-v2__suggestions-heading">
          <div>
            <strong>Можливі збіги в цьому проєкті</strong>
            <p>Це лише підказки. Нічого не об’єднується, не обирається і не змінюється автоматично — рішення завжди приймаєте ви.</p>
          </div>
          {suggestionQuery ? <small>Перевірка: «{suggestionQuery}»</small> : null}
        </div>
        {!suggestionQuery ? (
          <p className="person-names-v2__suggestions-empty">Введіть щонайменше 2 символи в точному, нормалізованому або повному імені.</p>
        ) : suggestionsLoading ? (
          <p className="person-names-v2__suggestions-empty" role="status">Шукаємо можливі збіги…</p>
        ) : suggestionsError ? (
          <p className="person-names-v2__suggestions-error" role="status">{suggestionsError}</p>
        ) : suggestions.length ? (
          <div className="person-names-v2__suggestion-list" role="list">
            {suggestions.map((suggestion) => (
              <article
                className="person-names-v2__suggestion"
                key={`${suggestion.personId}:${suggestion.personNameId}`}
                role="listitem"
              >
                <div>
                  <span>Наявна картка</span>
                  <strong>{suggestion.displayName}</strong>
                </div>
                <div>
                  <span>Знайдене історичне написання</span>
                  <strong>{suggestion.matchedName}</strong>
                </div>
                <span className="status-pill">
                  {projectPersonNameSuggestionMatchLabel(suggestion.matchType)}
                </span>
              </article>
            ))}
          </div>
        ) : (
          <p className="person-names-v2__suggestions-empty">Схожих осіб у проєкті не знайдено.</p>
        )}
      </section>
      <label>
        <span>Використовувалось від</span>
        <input value={draft.validFrom} placeholder="Дата або рік" onChange={(event) => update("validFrom", event.target.value)} />
      </label>
      <label>
        <span>Використовувалось до</span>
        <input value={draft.validTo} placeholder="Дата або рік" onChange={(event) => update("validTo", event.target.value)} />
      </label>
      <label>
        <span>Точність періоду</span>
        <select value={draft.datePrecision} onChange={(event) => update("datePrecision", event.target.value as ProjectPersonNameDraft["datePrecision"])}>
          <option value="unknown">Не вказано</option>
          <option value="exact">Точна дата</option>
          <option value="day">День</option>
          <option value="month">Місяць</option>
          <option value="year">Рік</option>
          <option value="range">Період</option>
          <option value="circa">Приблизно</option>
          <option value="before">До дати</option>
          <option value="after">Після дати</option>
          <option value="between">Між датами</option>
        </select>
      </label>
      <label>
        <span>Достовірність, %</span>
        <input type="number" min="0" max="100" value={draft.confidence} onChange={(event) => update("confidence", Number(event.target.value))} />
      </label>
      <label>
        <span>Статус доказу</span>
        <select
          value={draft.evidenceStatus}
          onChange={(event) => update(
            "evidenceStatus",
            event.target.value as ProjectPersonNameDraft["evidenceStatus"],
          )}
        >
          <option value="unknown">Не визначено</option>
          <option value="proven">Підтверджено</option>
          <option value="likely">Імовірно</option>
          <option value="disputed">Спірно</option>
          <option value="disproven">Спростовано</option>
        </select>
      </label>
      <label className="field-wide">
        <span>Джерело цього варіанта імені</span>
        <select value={sourceChoice} onChange={updateSource}>
          <option value="">Без документа або знахідки</option>
          {!sourceChoiceAvailable ? (
            <option value={sourceChoice}>Раніше вибране джерело зараз недоступне</option>
          ) : null}
          {sourceChoice === "__legacy" ? (
            <option value="__legacy">Раніше збережене джерело або походження даних</option>
          ) : null}
          {documents.length ? (
            <optgroup label="Документи проєкту">
              {documents.map((document) => (
                <option key={document.id} value={`document:${document.id}`}>
                  {documentSourceOptionLabel(document)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {findings.length ? (
            <optgroup label="Знахідки проєкту">
              {findings.map((finding) => (
                <option key={finding.id} value={`finding:${finding.id}`}>
                  {findingSourceOptionLabel(finding, documentsById.get(finding.documentId))}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <small>Виберіть документ або знахідку з проєкту. Для конкретної сторінки чи фрагмента спочатку створіть знахідку й виберіть її тут.</small>
      </label>
      {sourceChoice === "__legacy" || draft.citationId || draft.documentFragmentId ? (
        <div className="person-names-v2__notice field-wide" role="status">
          Раніше збережене походження даних і технічні зв’язки залишено без змін. UUID вводити не потрібно: оберіть зрозуміле джерело зі списку, якщо хочете замінити основну прив’язку.
        </div>
      ) : null}
      <label className="field-wide">
        <span>Примітка</span>
        <textarea value={draft.notes} rows={2} onChange={(event) => update("notes", event.target.value)} />
      </label>
      <label className="person-names-v2__check">
        <input type="checkbox" checked={draft.isPreferred} onChange={(event) => update("isPreferred", event.target.checked)} />
        <span>Бажаний варіант</span>
      </label>
      <label className="person-names-v2__check">
        <input type="checkbox" checked={draft.isSearchable} onChange={(event) => update("isSearchable", event.target.checked)} />
        <span>Включати в пошук</span>
      </label>
      <div className="person-names-v2__form-actions field-wide">
        <button type="button" className="button button-ghost" onClick={onCancel} disabled={disabled}>Скасувати</button>
        <button type="button" className="button button-primary" onClick={onSave} disabled={disabled}>
          {disabled ? "Зачекайте…" : "Зберегти варіант"}
        </button>
      </div>
    </div>
  );
}

export function nameTypeLabel(type: PersonNameType): string {
  return nameTypeOptions.find((option) => option.value === type)?.label
    ?? `Власний тип: ${type}`;
}

export function displayPersonName(name: PersonName): string {
  return name.fullNormalized || name.fullName || name.originalText || [name.surname, name.givenName, name.patronymic].filter(Boolean).join(" ") || "Ім’я не вказано";
}

function personNameMeta(name: PersonName): string {
  return [
    name.orthography,
    name.validFrom || name.validTo
      ? `${name.validFrom || "…"} — ${name.validTo || "…"}`
      : "",
    name.sourceDocumentId ? "є документ-джерело" : "",
    name.sourceFindingId ? "є знахідка-джерело" : "",
  ].filter(Boolean).join(" · ");
}

function documentSourceOptionLabel(document: DocumentRecord): string {
  const context = [
    document.archive,
    document.fund ? `фонд ${document.fund}` : "",
    document.yearFrom || document.yearTo
      ? `${document.yearFrom || "…"}–${document.yearTo || "…"}`
      : "",
  ].filter(Boolean).join(" · ");
  return compactSourceOptionLabel(
    `${document.title || "Документ без назви"}${context ? ` — ${context}` : ""}`,
  );
}

function findingSourceOptionLabel(finding: Finding, document: DocumentRecord | undefined): string {
  const context = [
    finding.eventDate,
    finding.page ? `сторінка ${finding.page}` : "",
    document?.title ? `документ «${document.title}»` : "",
  ].filter(Boolean).join(" · ");
  const title = finding.summary || finding.people || finding.findingType || "Знахідка без назви";
  return compactSourceOptionLabel(`${title}${context ? ` — ${context}` : ""}`);
}

function compactSourceOptionLabel(value: string, maxLength = 180): string {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1).trimEnd()}…` : compact;
}

function comparePersonNames(left: PersonName, right: PersonName): number {
  return Number(right.isPrimary) - Number(left.isPrimary)
    || Number(right.isPreferred) - Number(left.isPreferred)
    || right.updatedAt.localeCompare(left.updatedAt);
}

function isManagedProjectionName(name: PersonName): boolean {
  return name.metadata.source === "persons_projection"
    || name.metadata.source === "persons_projection_backfill";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function requestAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
