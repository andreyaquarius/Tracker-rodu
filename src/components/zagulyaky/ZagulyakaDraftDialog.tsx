import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import type { SupabaseAccount } from "../../services/supabaseAuth";
import {
  createZagulyakaDraft,
  deleteMyZagulyakySavedPlace,
  deleteMyZagulyakySavedSourcePreset,
  deleteZagulyakaDraftAttachment,
  loadMyZagulyakySavedPlaces,
  loadMyZagulyakySavedSourcePresets,
  saveMyZagulyakySavedPlace,
  saveMyZagulyakySavedSourcePreset,
  saveZagulyakaDraft,
  submitZagulyakaDraft,
  uploadZagulyakaDraftAttachment,
} from "../../services/zagulyakyService";
import {
  type ZagulyakaDatePrecision,
  type ZagulyakaDraftHandle,
  type ZagulyakaDraftAttachment,
  type ZagulyakaDraftInput,
  type ZagulyakaEventRoleCode,
  type ZagulyakaEventType,
  type ZagulyakaKind,
  type ZagulyakaSavedPlace,
  type ZagulyakaSavedSourcePreset,
} from "../../types/zagulyaky";
import { sanitizeWebUrl } from "../../utils/safeUrl";
import { initialZagulyakaDraftForAuthor } from "../../utils/zagulyakyDraftDefaults";
import {
  isZagulyakaEventRoleAllowed,
  zagulyakaEventRoleLabel,
  zagulyakaEventRoleOptions,
} from "../../utils/zagulyakyEventRoles";
import {
  zagulyakaDatePrecisionLabels,
  zagulyakaEventLabels,
} from "../../utils/zagulyakyLabels";
import {
  isZagulyakaTitleAutofillActive,
  nextZagulyakaTitleFromNormalizedName,
} from "../../utils/zagulyakyTitleAutofill";
import { GeoPlaceField } from "../GeoPlaceField";
import { Modal } from "../Modal";
import { ZagulyakaRouteMap } from "./ZagulyakaRouteMap";

const steps = ["Тип запису", "Факти і місця", "Джерело", "Перевірка"];

export function ZagulyakaDraftDialog({
  account,
  initialKind = "person",
  initialDraft,
  initialHandle = null,
  initialRightsConfirmed = false,
  initialAttachments = [],
  onClose,
  onSaved,
}: {
  account: SupabaseAccount;
  initialKind?: ZagulyakaKind;
  initialDraft?: ZagulyakaDraftInput;
  initialHandle?: ZagulyakaDraftHandle | null;
  initialRightsConfirmed?: boolean;
  initialAttachments?: ZagulyakaDraftAttachment[];
  onClose: () => void;
  onSaved?: (submitted: boolean) => void;
}) {
  const [draft, setDraft] = useState<ZagulyakaDraftInput>(() => (
    initialZagulyakaDraftForAuthor(initialKind, account.name, initialDraft)
  ));
  const [step, setStep] = useState(0);
  const [draftHandle, setDraftHandle] = useState<ZagulyakaDraftHandle | null>(initialHandle);
  const [recordTypesText, setRecordTypesText] = useState(() => initialDraft?.recordTypes.join(", ") ?? "");
  const [attachments, setAttachments] = useState<ZagulyakaDraftAttachment[]>(initialAttachments);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedPlaces, setSavedPlaces] = useState<ZagulyakaSavedPlace[]>([]);
  const [savedSourcePresets, setSavedSourcePresets] = useState<ZagulyakaSavedSourcePreset[]>([]);
  const [selectedSavedPlaceId, setSelectedSavedPlaceId] = useState("");
  const [selectedSavedSourcePresetId, setSelectedSavedSourcePresetId] = useState("");
  const [savedInputsLoading, setSavedInputsLoading] = useState(true);
  const [savedInputsBusy, setSavedInputsBusy] = useState(false);
  const [savedInputsError, setSavedInputsError] = useState("");
  const [titleAutofillActive, setTitleAutofillActive] = useState(() => (
    isZagulyakaTitleAutofillActive(
      initialDraft?.kind ?? initialKind,
      initialDraft?.title ?? "",
    )
  ));

  useEffect(() => {
    let active = true;
    setSavedInputsLoading(true);
    setSavedInputsError("");
    void Promise.all([
      loadMyZagulyakySavedPlaces(account.id),
      loadMyZagulyakySavedSourcePresets(account.id),
    ]).then(([places, sourcePresets]) => {
      if (!active) return;
      setSavedPlaces(places);
      setSavedSourcePresets(sourcePresets);
    }).catch((loadError) => {
      if (!active) return;
      setSavedInputsError(savedInputErrorMessage(loadError));
    }).finally(() => {
      if (active) setSavedInputsLoading(false);
    });
    return () => { active = false; };
  }, [account.id]);

  const update = <K extends keyof ZagulyakaDraftInput>(key: K, value: ZagulyakaDraftInput[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice("");
  };

  const updateKind = (kind: ZagulyakaKind) => {
    update("kind", kind);
    setTitleAutofillActive(isZagulyakaTitleAutofillActive(kind, draft.title));
  };

  const updateTitle = (title: string) => {
    update("title", title);
    setTitleAutofillActive(isZagulyakaTitleAutofillActive(draft.kind, title));
  };

  const updateNormalizedNameUk = (normalizedNameUk: string) => {
    setDraft((current) => ({
      ...current,
      normalizedNameUk,
      title: current.kind === "person"
        ? nextZagulyakaTitleFromNormalizedName(current.title, normalizedNameUk, titleAutofillActive)
        : current.title,
    }));
    setNotice("");
  };

  const updateFoundPlace = (foundPlace: string) => {
    setSelectedSavedPlaceId("");
    update("foundPlace", foundPlace);
  };

  const updateFoundGeo = (foundGeo: ZagulyakaDraftInput["foundGeo"]) => {
    setSelectedSavedPlaceId("");
    update("foundGeo", foundGeo);
  };

  const updateSourcePresetField = (
    key: "institutionName" | "archiveReference" | "sourceTitle" | "sourceUrl",
    value: string,
  ) => {
    setSelectedSavedSourcePresetId("");
    update(key, value);
  };

  const updateEventType = (eventType: ZagulyakaEventType | "") => {
    const currentRoleNeedsNewChoice = Boolean(
      draft.eventRoleCode
      && !isZagulyakaEventRoleAllowed(eventType, draft.eventRoleCode),
    );
    setDraft((current) => ({
      ...current,
      eventType,
      eventRoleCode: currentRoleNeedsNewChoice ? "" : current.eventRoleCode,
      eventRoleCustomText: currentRoleNeedsNewChoice ? "" : current.eventRoleCustomText,
    }));
    setNotice(
      currentRoleNeedsNewChoice
        ? "Тип події змінено. Оберіть роль людини для нової події."
        : "",
    );
  };

  const updateEventRole = (eventRoleCode: ZagulyakaEventRoleCode | "") => {
    setDraft((current) => ({
      ...current,
      eventRoleCode,
      eventRoleCustomText: eventRoleCode === "other" ? current.eventRoleCustomText : "",
    }));
    setNotice("");
  };

  const chooseSavedPlace = (savedPlaceId: string) => {
    setSelectedSavedPlaceId(savedPlaceId);
    const selected = savedPlaces.find((item) => item.id === savedPlaceId);
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      foundPlace: selected.name,
      foundGeo: { ...selected.geo },
    }));
    setNotice("Збережене місце застосовано до цієї чернетки.");
  };

  const saveCurrentFoundPlace = async () => {
    if (!draft.foundPlace.trim() || !draft.foundGeo) {
      setSavedInputsError("Щоб зберегти місце, заповніть «Де знайдено» та позначте точку на карті.");
      return;
    }
    setSavedInputsBusy(true);
    setSavedInputsError("");
    try {
      const saved = await saveMyZagulyakySavedPlace({
        name: draft.foundPlace,
        geo: draft.foundGeo,
      }, account.id);
      setSavedPlaces((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setSelectedSavedPlaceId(saved.id);
      setNotice("Місце збережено у вашому приватному списку.");
    } catch (saveError) {
      setSavedInputsError(savedInputErrorMessage(saveError));
    } finally {
      setSavedInputsBusy(false);
    }
  };

  const removeSelectedSavedPlace = async () => {
    const selected = savedPlaces.find((item) => item.id === selectedSavedPlaceId);
    if (!selected || savedInputsBusy) return;
    if (!window.confirm(`Вилучити «${selected.name}» з мого списку місць? Це не змінить уже створені картки.`)) return;
    setSavedInputsBusy(true);
    setSavedInputsError("");
    try {
      await deleteMyZagulyakySavedPlace(selected.id, account.id);
      setSavedPlaces((current) => current.filter((item) => item.id !== selected.id));
      setSelectedSavedPlaceId("");
      setNotice("Збережене місце вилучено. Створені картки не змінено.");
    } catch (removeError) {
      setSavedInputsError(savedInputErrorMessage(removeError));
    } finally {
      setSavedInputsBusy(false);
    }
  };

  const chooseSavedSourcePreset = (savedSourceId: string) => {
    setSelectedSavedSourcePresetId(savedSourceId);
    const selected = savedSourcePresets.find((item) => item.id === savedSourceId);
    if (!selected) return;
    setDraft((current) => ({
      ...current,
      institutionName: selected.institutionName,
      archiveReference: selected.archiveReference,
      sourceTitle: selected.sourceTitle,
      sourceUrl: selected.sourceUrl,
      // Page/frame differs between records in the same archive file, so it
      // is intentionally left untouched.
    }));
    setNotice("Збережену справу застосовано; сторінку або кадр не змінено.");
  };

  const saveCurrentSourcePreset = async () => {
    setSavedInputsBusy(true);
    setSavedInputsError("");
    try {
      const saved = await saveMyZagulyakySavedSourcePreset({
        institutionName: draft.institutionName,
        archiveReference: draft.archiveReference,
        sourceTitle: draft.sourceTitle,
        sourceUrl: draft.sourceUrl,
      }, account.id);
      setSavedSourcePresets((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setSelectedSavedSourcePresetId(saved.id);
      setNotice("Справу збережено у вашому приватному списку.");
    } catch (saveError) {
      setSavedInputsError(savedInputErrorMessage(saveError));
    } finally {
      setSavedInputsBusy(false);
    }
  };

  const removeSelectedSavedSourcePreset = async () => {
    const selected = savedSourcePresets.find((item) => item.id === selectedSavedSourcePresetId);
    if (!selected || savedInputsBusy) return;
    if (!window.confirm(`Вилучити «${savedSourcePresetLabel(selected)}» з мого списку справ? Це не змінить уже створені картки.`)) return;
    setSavedInputsBusy(true);
    setSavedInputsError("");
    try {
      await deleteMyZagulyakySavedSourcePreset(selected.id, account.id);
      setSavedSourcePresets((current) => current.filter((item) => item.id !== selected.id));
      setSelectedSavedSourcePresetId("");
      setNotice("Збережену справу вилучено. Створені картки не змінено.");
    } catch (removeError) {
      setSavedInputsError(savedInputErrorMessage(removeError));
    } finally {
      setSavedInputsBusy(false);
    }
  };

  const eventRoleOptions = useMemo(
    () => draft.eventType ? zagulyakaEventRoleOptions(draft.eventType) : [],
    [draft.eventType],
  );
  const selectedSavedPlace = useMemo(
    () => savedPlaces.find((item) => item.id === selectedSavedPlaceId) ?? null,
    [savedPlaces, selectedSavedPlaceId],
  );
  const selectedSavedSourcePreset = useMemo(
    () => savedSourcePresets.find((item) => item.id === selectedSavedSourcePresetId) ?? null,
    [savedSourcePresets, selectedSavedSourcePresetId],
  );

  const normalizedDraft = useMemo<ZagulyakaDraftInput>(() => ({
    ...draft,
    recordTypes: recordTypesText.split(",").map((item) => item.trim()).filter(Boolean),
  }), [draft, recordTypesText]);

  // Legacy drafts may already carry a recorded rights confirmation.  The
  // historical-event form no longer asks the author to make that declaration,
  // but editing one of those drafts must not silently erase the existing fact.
  // New drafts keep the server/default value and are sent to moderation as-is.
  const persist = async (): Promise<ZagulyakaDraftHandle> => {
    const validationError = validateDraft(normalizedDraft, false);
    if (validationError) throw new Error(validationError);
    if (!draftHandle) {
      const created = await createZagulyakaDraft(normalizedDraft, account.id, initialRightsConfirmed);
      setDraftHandle(created);
      return created;
    }
    const saved = await saveZagulyakaDraft(draftHandle, normalizedDraft, account.id, initialRightsConfirmed);
    setDraftHandle(saved);
    return saved;
  };

  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await persist();
      setNotice("Чернетку збережено. Її видно лише вам.");
      onSaved?.(false);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const validationError = validateDraft(normalizedDraft, true);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const handle = await persist();
      await submitZagulyakaDraft(handle, account.id);
      setNotice("Запис передано на модерацію. До схвалення він не публічний.");
      onSaved?.(true);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  const uploadAttachment = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const handle = await persist();
      const uploaded = await uploadZagulyakaDraftAttachment(handle, file, account.id);
      setDraftHandle(uploaded.handle);
      setAttachments((current) => [...current, uploaded.attachment]);
      setNotice("Вкладення збережено приватно. Модератор вирішить, чи можна створити його публічну копію.");
      onSaved?.(false);
    } catch (uploadError) {
      setError(errorMessage(uploadError));
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = async (attachment: ZagulyakaDraftAttachment) => {
    if (!draftHandle || busy) return;
    if (!window.confirm(`Вилучити «${attachment.fileName}» з чернетки?`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await deleteZagulyakaDraftAttachment(draftHandle, attachment.id, account.id);
      setDraftHandle(updated);
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      setNotice(
        updated.storageCleanupWakeSucceeded
          ? "Вкладення вилучено з чернетки. Приватний файл очищено."
          : "Вкладення вилучено з чернетки. Приватний файл уже поставлено в безпечну чергу очищення.",
      );
      onSaved?.(false);
    } catch (removeError) {
      setError(errorMessage(removeError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initialHandle ? "Редагувати загуляку" : "Додати загуляку"} className="zagulyaky-draft-modal" viewportBounded onClose={onClose}>
      <form className="zagulyaky-draft-form" onSubmit={submit}>
        <ol className="zagulyaky-form-steps" aria-label="Етапи форми">
          {steps.map((label, index) => (
            <li className={index === step ? "active" : index < step ? "complete" : ""} key={label}>
              <button type="button" onClick={() => setStep(index)} aria-current={index === step ? "step" : undefined}>
                <span>{index + 1}</span>{label}
              </button>
            </li>
          ))}
        </ol>

        {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
        {notice ? <div className="alert" role="status">{notice}</div> : null}

        <div className="zagulyaky-form-content">
          {step === 0 ? (
            <section aria-labelledby="zagulyaky-form-kind">
              <span className="eyebrow">Крок 1</span>
              <h3 id="zagulyaky-form-kind">Що ви знайшли?</h3>
              <div className="zagulyaky-kind-options">
                <button
                  type="button"
                  className={draft.kind === "person" ? "active" : ""}
                  onClick={() => updateKind("person")}
                  disabled={Boolean(initialHandle)}
                >
                  <strong>Запис про людину</strong>
                  <span>Особу знайдено поза очікуваним місцем.</span>
                </button>
                <button
                  type="button"
                  className={draft.kind === "document" ? "active" : ""}
                  onClick={() => updateKind("document")}
                  disabled={Boolean(initialHandle)}
                >
                  <strong>Загублений документ</strong>
                  <span>У справі є записи іншого місця або періоду.</span>
                </button>
              </div>
              <div className="form-grid zagulyaky-form-grid">
                <label className="field-wide">
                  <span>{draft.kind === "person" ? "Коротка назва запису" : "Назва документа"}</span>
                  <input value={draft.title} onChange={(event) => updateTitle(event.target.value)} maxLength={180} placeholder={draft.kind === "person" ? "Наприклад: Іван Каленський — шлюб 1874" : "Наприклад: Метрична книга с. Паволоч"} />
                  {draft.kind === "person" ? (
                    <small className="zagulyaky-title-autofill-hint">
                      {titleAutofillActive
                        ? "Назва автоматично підставляється з нормалізованого ПІБ українською. За потреби доповніть її подією, роком чи іншою деталлю."
                        : "Назву доповнено або змінено вручну — ПІБ її більше не перезаписуватиме."}
                    </small>
                  ) : null}
                </label>
                {draft.kind === "person" ? (
                  <>
                    <label>
                      <span>ПІБ мовою джерела *</span>
                      <input value={draft.originalName} onChange={(event) => update("originalName", event.target.value)} maxLength={240} />
                    </label>
                    <label>
                      <span>Нормалізоване ПІБ українською</span>
                      <input value={draft.normalizedNameUk} onChange={(event) => updateNormalizedNameUk(event.target.value)} maxLength={240} />
                    </label>
                    <label>
                      <span>Стать</span>
                      <select value={draft.gender} onChange={(event) => update("gender", event.target.value as ZagulyakaDraftInput["gender"])}>
                        <option value="unknown">Не визначено</option>
                        <option value="male">Чоловіча</option>
                        <option value="female">Жіноча</option>
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      <span>Тип документа *</span>
                      <input value={draft.documentType} onChange={(event) => update("documentType", event.target.value)} placeholder="Метрична книга, сповідний розпис…" />
                    </label>
                    <label>
                      <span>Типи записів</span>
                      <input value={recordTypesText} onChange={(event) => setRecordTypesText(event.target.value)} placeholder="Народження, шлюби, смерті" />
                    </label>
                  </>
                )}
              </div>
            </section>
          ) : null}

          {step === 1 ? (
            <section aria-labelledby="zagulyaky-form-facts">
              <span className="eyebrow">Крок 2</span>
              <h3 id="zagulyaky-form-facts">Факти та місця</h3>
              <div className="form-grid zagulyaky-form-grid">
                {draft.kind === "person" ? (
                  <>
                    <label>
                      <span>Тип події *</span>
                      <select value={draft.eventType} onChange={(event) => updateEventType(event.target.value as ZagulyakaEventType | "")}>
                        <option value="">Оберіть подію</option>
                        {Object.entries(zagulyakaEventLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>Роль людини в події *</span>
                      <select
                        value={draft.eventRoleCode}
                        onChange={(event) => updateEventRole(event.target.value as ZagulyakaEventRoleCode | "")}
                        disabled={!draft.eventType}
                      >
                        <option value="">
                          {draft.eventType ? "Оберіть роль" : "Спершу оберіть подію"}
                        </option>
                        {eventRoleOptions.map((option) => (
                          <option value={option.code} key={option.code}>{option.label}</option>
                        ))}
                      </select>
                      <small className="zagulyaky-event-role-hint">
                        Вкажіть, ким була ця людина саме в обраній події.
                      </small>
                    </label>
                    {draft.eventRoleCode === "other" ? (
                      <label>
                        <span>Роль як у джерелі *</span>
                        <input
                          value={draft.eventRoleCustomText}
                          onChange={(event) => update("eventRoleCustomText", event.target.value)}
                          maxLength={160}
                          placeholder="Наприклад: поручитель нареченого"
                        />
                      </label>
                    ) : null}
                    <label>
                      <span>Дата так, як у джерелі</span>
                      <input value={draft.eventDateText} onChange={(event) => update("eventDateText", event.target.value)} placeholder="29.05.1874, 1874, бл. 1874…" />
                    </label>
                    <label>
                      <span>Точність дати</span>
                      <select value={draft.datePrecision} onChange={(event) => update("datePrecision", event.target.value as ZagulyakaDatePrecision)}>
                        {Object.entries(zagulyakaDatePrecisionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                      </select>
                    </label>
                  </>
                ) : null}
                <label>
                  <span>Рік від</span>
                  <input type="number" inputMode="numeric" min="1" max="2100" value={draft.eventYearFrom ?? ""} onChange={(event) => update("eventYearFrom", optionalYear(event.target.value))} />
                </label>
                <label>
                  <span>Рік до</span>
                  <input type="number" inputMode="numeric" min="1" max="2100" value={draft.eventYearTo ?? ""} onChange={(event) => update("eventYearTo", optionalYear(event.target.value))} />
                </label>
                {draft.kind === "person" ? (
                  <label>
                    <span>Звідки людина</span>
                    <input value={draft.originPlace} onChange={(event) => update("originPlace", event.target.value)} placeholder="Історична назва місця" />
                  </label>
                ) : (
                  <label>
                    <span>Населений пункт в офіційному описі</span>
                    <input value={draft.officialPlace} onChange={(event) => update("officialPlace", event.target.value)} />
                  </label>
                )}
                <label>
                  <span>{draft.kind === "person" ? "Де знайдено *" : "Додатково знайдений населений пункт *"}</span>
                  <input value={draft.foundPlace} onChange={(event) => updateFoundPlace(event.target.value)} />
                </label>
                <section className="zagulyaky-saved-inputs field-wide" aria-labelledby="zagulyaky-saved-places-title">
                  <div className="zagulyaky-saved-inputs-heading">
                    <div>
                      <span className="eyebrow">Для серійного внесення</span>
                      <h4 id="zagulyaky-saved-places-title">Мої збережені місця</h4>
                      <p>Вибір одразу заповнює поле «Де знайдено» та підтверджену точку. Походження людини не змінюється.</p>
                    </div>
                  </div>
                  <div className="zagulyaky-saved-inputs-controls">
                    <label>
                      <span>Місце з мого списку</span>
                      <select
                        value={selectedSavedPlaceId}
                        onChange={(event) => chooseSavedPlace(event.target.value)}
                        disabled={savedInputsLoading || savedInputsBusy || busy}
                      >
                        <option value="">{savedInputsLoading ? "Завантажуємо місця…" : "Оберіть збережене місце"}</option>
                        {savedPlaces.map((item) => (
                          <option value={item.id} key={item.id}>{item.name}</option>
                        ))}
                      </select>
                    </label>
                    <div className="zagulyaky-saved-inputs-actions">
                      <button type="button" className="button button-secondary" onClick={() => void saveCurrentFoundPlace()} disabled={savedInputsLoading || savedInputsBusy || busy}>
                        Зберегти поточне місце
                      </button>
                      {selectedSavedPlace ? (
                        <button type="button" className="button button-ghost" onClick={() => void removeSelectedSavedPlace()} disabled={savedInputsBusy || busy}>
                          Вилучити зі списку
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {selectedSavedPlace ? (
                    <p className="zagulyaky-saved-inputs-selection">
                      Точка: {formatGeoCoordinates(selectedSavedPlace.geo)}. Зміни тут не змінюють уже створені картки.
                    </p>
                  ) : null}
                  {savedInputsError ? <p className="zagulyaky-saved-inputs-error" role="status">{savedInputsError}</p> : null}
                </section>
                <section className="zagulyaky-map-points field-wide" aria-labelledby="zagulyaky-map-points-title">
                  <div>
                    <span className="eyebrow">Необов’язково</span>
                    <h4 id="zagulyaky-map-points-title">Позначки на карті</h4>
                    <p>Історичний текст вище залишається без змін. Вкажіть точку лише тоді, коли впевнені в її прив’язці.</p>
                  </div>
                  <GeoPlaceField
                    label={draft.kind === "person" ? "Точка: звідки людина" : "Точка: місце документа"}
                    value={draft.originGeo}
                    placeName={draft.originGeo?.displayName ?? (draft.kind === "person" ? draft.originPlace : draft.officialPlace)}
                    onChange={(value) => update("originGeo", value)}
                    allowMarkerColor={false}
                    canonicalSettlement
                  />
                  <GeoPlaceField
                    label="Точка: де знайдено запис"
                    value={draft.foundGeo}
                    placeName={draft.foundGeo?.displayName ?? draft.foundPlace}
                    onChange={updateFoundGeo}
                    allowMarkerColor={false}
                    canonicalSettlement
                  />
                  <ZagulyakaRouteMap
                    origin={draft.originGeo}
                    found={draft.foundGeo}
                    originPlaceLabel={draft.kind === "person" ? draft.originPlace : draft.officialPlace}
                    foundPlaceLabel={draft.foundPlace}
                    originRoleLabel={draft.kind === "person" ? "Звідки людина" : "Місце документа"}
                    title="Попередній перегляд карти"
                    preview
                  />
                </section>
                <label className="field-wide">
                  <span>Чому це загуляка?</span>
                  <textarea value={draft.reason} onChange={(event) => update("reason", event.target.value)} rows={3} placeholder="Поясніть, де зазвичай шукають цю людину або документ." />
                </label>
              </div>
            </section>
          ) : null}

          {step === 2 ? (
            <section aria-labelledby="zagulyaky-form-source">
              <span className="eyebrow">Крок 3</span>
              <h3 id="zagulyaky-form-source">Джерело і транскрипція</h3>
              <section className="zagulyaky-saved-inputs" aria-labelledby="zagulyaky-saved-sources-title">
                <div className="zagulyaky-saved-inputs-heading">
                  <div>
                    <span className="eyebrow">Для серійного внесення</span>
                    <h4 id="zagulyaky-saved-sources-title">Мої збережені справи</h4>
                    <p>Вибір заповнює архів, шифр, назву та посилання. Сторінка або кадр залишаються індивідуальними для цього запису.</p>
                  </div>
                </div>
                <div className="zagulyaky-saved-inputs-controls">
                  <label>
                    <span>Справа або джерело з мого списку</span>
                    <select
                      value={selectedSavedSourcePresetId}
                      onChange={(event) => chooseSavedSourcePreset(event.target.value)}
                      disabled={savedInputsLoading || savedInputsBusy || busy}
                    >
                      <option value="">{savedInputsLoading ? "Завантажуємо справи…" : "Оберіть збережену справу"}</option>
                      {savedSourcePresets.map((item) => (
                        <option value={item.id} key={item.id}>{savedSourcePresetLabel(item)}</option>
                      ))}
                    </select>
                  </label>
                  <div className="zagulyaky-saved-inputs-actions">
                    <button type="button" className="button button-secondary" onClick={() => void saveCurrentSourcePreset()} disabled={savedInputsLoading || savedInputsBusy || busy}>
                      Зберегти цю справу
                    </button>
                    {selectedSavedSourcePreset ? (
                      <button type="button" className="button button-ghost" onClick={() => void removeSelectedSavedSourcePreset()} disabled={savedInputsBusy || busy}>
                        Вилучити зі списку
                      </button>
                    ) : null}
                  </div>
                </div>
                {selectedSavedSourcePreset ? (
                  <p className="zagulyaky-saved-inputs-selection">
                    Застосовано: {savedSourcePresetLabel(selectedSavedSourcePreset)}. Сторінку або кадр не змінено.
                  </p>
                ) : null}
                {savedInputsError ? <p className="zagulyaky-saved-inputs-error" role="status">{savedInputsError}</p> : null}
              </section>
              <div className="form-grid zagulyaky-form-grid">
                <label>
                  <span>Архів або установа</span>
                  <input value={draft.institutionName} onChange={(event) => updateSourcePresetField("institutionName", event.target.value)} placeholder="ДАКО" />
                </label>
                <label>
                  <span>Фонд, опис, справа *</span>
                  <input value={draft.archiveReference} onChange={(event) => updateSourcePresetField("archiveReference", event.target.value)} placeholder="ф. 127, оп. 1012, спр. 305" />
                </label>
                <label>
                  <span>Назва джерела</span>
                  <input value={draft.sourceTitle} onChange={(event) => updateSourcePresetField("sourceTitle", event.target.value)} />
                </label>
                <label>
                  <span>{draft.kind === "person" ? "Сторінка або кадр" : "Діапазон сторінок"}</span>
                  <input value={draft.kind === "person" ? draft.pageLabel : draft.pageRange} onChange={(event) => update(draft.kind === "person" ? "pageLabel" : "pageRange", event.target.value)} placeholder="с. 128 або арк. 128–230" />
                </label>
                <label className="field-wide">
                  <span>Посилання на джерело</span>
                  <input type="url" value={draft.sourceUrl} onChange={(event) => updateSourcePresetField("sourceUrl", event.target.value)} placeholder="https://…" />
                </label>
                <label className="field-wide">
                  <span>Точна транскрипція мовою джерела</span>
                  <textarea value={draft.originalText} onChange={(event) => update("originalText", event.target.value)} rows={5} />
                </label>
                <label className="field-wide">
                  <span>Нормалізований опис українською</span>
                  <textarea value={draft.normalizedTextUk} onChange={(event) => update("normalizedTextUk", event.target.value)} rows={4} />
                </label>
              </div>
              <section className="zagulyaky-attachments" aria-label="Приватні вкладення">
                <div>
                  <strong>Вкладення-докази</strong>
                  <p>JPG, PNG, WebP або PDF до 25 МБ. Оригінал бачите ви та модератор; публічну копію можна створити лише після перевірки прав.</p>
                </div>
                <label className="button button-secondary">
                  <span>{draftHandle ? "Додати приватне вкладення" : "Спершу збережіть чернетку"}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(event) => void uploadAttachment(event)}
                    disabled={!draftHandle || busy}
                  />
                </label>
                {attachments.length ? (
                  <ul className="zagulyaky-draft-attachments">
                    {attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <span><strong>{attachment.fileName}</strong><small>{formatFileSize(attachment.byteSize)} · {attachment.mimeType || "невідомий формат"}</small></span>
                        <button type="button" className="button button-ghost" onClick={() => void removeAttachment(attachment)} disabled={busy}>Вилучити</button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="zagulyaky-attachments-empty">Вкладень ще немає.</p>}
              </section>
            </section>
          ) : null}

          {step === 3 ? (
            <section aria-labelledby="zagulyaky-form-review">
              <span className="eyebrow">Крок 4</span>
              <h3 id="zagulyaky-form-review">Перевірте перед поданням</h3>
              <dl className="zagulyaky-review-facts">
                <ReviewFact label="Тип" value={draft.kind === "person" ? "Запис про людину" : "Загублений документ"} />
                <ReviewFact label="Назва" value={draft.title} />
                {draft.kind === "person" ? <ReviewFact label="Особа" value={draft.normalizedNameUk || draft.originalName} /> : null}
                {draft.kind === "person" ? <ReviewFact label="Роль у події" value={zagulyakaEventRoleLabel(draft.eventRoleCode, draft.eventRoleCustomText)} /> : null}
                <ReviewFact label="Де знайдено" value={draft.foundPlace} />
                <ReviewFact label="Джерело" value={[draft.institutionName, draft.archiveReference, draft.pageLabel || draft.pageRange].filter(Boolean).join(" · ")} />
              </dl>
              <div className="zagulyaky-publication-note" role="note">
                <strong>Запис не з’явиться публічно відразу.</strong>
                <p>Після подання модератор перевірить джерело, можливі дублі та приватність.</p>
              </div>
              <label className="zagulyaky-attribution-choice">
                <input type="checkbox" checked={draft.publicAttribution} onChange={(event) => update("publicAttribution", event.target.checked)} />
                <span>Дозволяю показати моє авторство на публічній картці.</span>
              </label>
              {draft.publicAttribution ? (
                <label className="zagulyaky-attribution-name">
                  <span>Ім’я для публічної атрибуції</span>
                  <input value={draft.publicAttributionName} onChange={(event) => update("publicAttributionName", event.target.value)} maxLength={120} placeholder="Наприклад: Андрій Каленський" />
                </label>
              ) : null}
            </section>
          ) : null}
        </div>

        <footer className="zagulyaky-form-footer">
          <div>
            <button type="button" className="button button-secondary" onClick={() => void save()} disabled={busy}>
              {busy ? "Зберігаємо…" : "Зберегти чернетку"}
            </button>
          </div>
          <div>
            {step > 0 ? <button type="button" className="button button-secondary" onClick={() => setStep((current) => current - 1)} disabled={busy}>← Назад</button> : null}
            {step < steps.length - 1 ? (
              <button type="button" className="button button-primary" onClick={() => setStep((current) => current + 1)} disabled={busy}>Далі →</button>
            ) : (
              <button type="submit" className="button button-primary" disabled={busy}>
                {busy ? "Подаємо…" : "Подати на модерацію"}
              </button>
            )}
          </div>
        </footer>
      </form>
    </Modal>
  );
}

function ReviewFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value.trim() || "Не вказано"}</dd>
    </div>
  );
}

function optionalYear(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function formatFileSize(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatGeoCoordinates(place: ZagulyakaSavedPlace["geo"]): string {
  if (typeof place.latitude !== "number" || typeof place.longitude !== "number") {
    return "координати не вказано";
  }
  return `${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}`;
}

function savedSourcePresetLabel(source: ZagulyakaSavedSourcePreset): string {
  return [
    source.institutionName,
    source.archiveReference,
    source.sourceTitle,
    source.sourceUrl,
  ].map((item) => item.trim()).filter(Boolean).join(" · ") || "Без назви";
}

function savedInputErrorMessage(input: unknown): string {
  const message = input instanceof Error ? input.message : String(input ?? "");
  if (/PGRST202|42883|saved_(?:place|source)/i.test(message)) {
    return "Не вдалося відкрити приватний список. Потрібно застосувати міграцію збережених місць і справ.";
  }
  return errorMessage(input);
}

function validateDraft(draft: ZagulyakaDraftInput, forSubmission: boolean): string {
  if (!draft.title.trim()) return "Вкажіть коротку назву запису.";
  if (draft.sourceUrl.trim() && !sanitizeWebUrl(draft.sourceUrl)) return "Вкажіть коректне http або https посилання на джерело.";
  if (!forSubmission) return "";
  if (draft.kind === "person" && !draft.originalName.trim()) return "Вкажіть ПІБ людини так, як його написано у джерелі.";
  if (draft.kind === "person" && !draft.eventType) return "Оберіть тип події.";
  if (draft.kind === "person" && !draft.eventRoleCode) return "Оберіть роль людини в події.";
  if (draft.kind === "person" && draft.eventRoleCode === "other" && draft.eventRoleCustomText.trim().length < 2) return "Вкажіть роль так, як її подано в джерелі.";
  if (draft.kind === "person" && draft.eventRoleCustomText.trim().length > 160) return "Роль у події не може містити понад 160 символів.";
  if (draft.kind === "document" && !draft.documentType.trim()) return "Вкажіть тип документа.";
  if (!draft.foundPlace.trim()) return "Вкажіть місце, де знайдено людину або документ.";
  if (!draft.reason.trim()) return "Поясніть, чому цей запис є загулякою.";
  if (!draft.archiveReference.trim() && !draft.sourceUrl.trim()) return "Вкажіть архівний шифр або посилання на джерело.";
  if (draft.eventYearFrom !== null && draft.eventYearTo !== null && draft.eventYearFrom > draft.eventYearTo) return "Початковий рік не може бути пізнішим за кінцевий.";
  return "";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/not authenticated|jwt|session/i.test(message)) return "Сесія закінчилася. Увійдіть знову, щоб зберегти чернетку.";
  if (/ZAGULYAKA_VERSION_CONFLICT|40001/i.test(message)) return "Чернетку вже змінено в іншому вікні. Закрийте форму, відкрийте запис знову і повторіть зміни.";
  if (/ZAGULYAKY_DRAFT_RATE_LIMITED/i.test(message)) return "Забагато нових чернеток за короткий час. Спробуйте ще раз пізніше.";
  if (/ZAGULYAKA_NOT_EDITABLE/i.test(message)) return "Цей запис уже передано на модерацію, тому його не можна змінювати.";
  if (/INVALID_EVENT_ROLE_CODE/i.test(message)) return "Оберіть коректну роль людини в події.";
  if (/EVENT_ROLE_CUSTOM_REQUIRED|INVALID_EVENT_ROLE_CUSTOM/i.test(message)) return "Вкажіть роль так, як її подано в джерелі.";
  return message || "Не вдалося зберегти запис.";
}
