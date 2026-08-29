import L from "leaflet";
import type { GeoJsonObject } from "geojson";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createProjectPlace,
  getHistoricalPlaceProfile,
  listHistoricalPlaceArchives,
  listHistoricalPlaceDocumentOptions,
  listHistoricalPlaceDocuments,
  listHistoricalPlaceEvents,
  getHistoricalPlaceMapContext,
  listHistoricalPlaceHierarchyHistory,
  listHistoricalPlaceNames,
  listHistoricalPlaceParishes,
  listHistoricalPlacePeople,
  listHistoricalPlaceRelated,
  mergeHistoricalPlaces,
  previewHistoricalPlaceMerge,
  searchHistoricalPlaces,
  patchHistoricalPlace,
  addHistoricalPlaceName,
  updateHistoricalPlaceName,
  addHistoricalPlaceHierarchy,
  addHistoricalPlaceParish,
  createAndLinkHistoricalPlaceArchive,
  addHistoricalDocumentPlaceLink,
  listHistoricalPlaceAudit,
  addHistoricalPlaceRelated,
  addHistoricalPlaceBoundary,
  HistoricalPlacesServiceError,
} from "../services/historicalPlacesService";
import type {
  HistoricalPlaceProfile,
  HistoricalPlaceArchive,
  HistoricalArchiveResource,
  HistoricalPlaceDocument,
  HistoricalPlaceDocumentOption,
  HistoricalPlaceEvent,
  HistoricalPlaceMergePreview,
  HistoricalPlaceMergeSnapshot,
  HistoricalPlaceParish,
  HistoricalPlacePerson,
  HistoricalPlaceRelated,
  PlaceHierarchyHistoryEntry,
  PlaceName,
  PlaceSummary,
  HistoricalPlaceAuditEntry,
  HistoricalPlaceFieldValue,
  HistoricalPlaceBoundary,
  PlaceNameDatePrecision,
  PlaceNameType,
  PlaceStatus,
  PlaceVerificationStatus,
} from "../types/historicalPlaces";
import { HistoricalPlaceField } from "../components/HistoricalPlaceField";
import {
  historicalPlaceAdministrativeLabel,
  historicalPlaceProfileMatchesDate,
  isCurrentHistoricalPlaceRequest,
  historicalPlaceTypeLabel,
} from "../utils/historicalPlaceField";
import "./HistoricalPlacesPage.css";

export type HistoricalPlacesPageMode = "list" | "new" | "profile" | "edit";

interface HistoricalPlacesPageProps {
  mode: HistoricalPlacesPageMode;
  projectId: string;
  projectName: string;
  placeId?: string;
  readOnly: boolean;
  onOpenPlace: (placeId: string) => void;
  onCreatePlace: () => void;
  onBackToList: () => void;
  onOpenPerson?: (personId: string) => void;
  onOpenDocument?: (documentId: string) => void;
  onEditPlace?: (placeId: string) => void;
  documents?: HistoricalPlaceDocumentOption[];
}

const PLACE_TYPE_OPTIONS = [
  "settlement", "hamlet", "small_settlement", "village", "town", "city", "sloboda",
  "colony", "folwark", "estate", "manor", "parish", "volost", "county",
  "governorate", "okrug", "district", "region", "community", "country",
  "cemetery", "church", "monastery", "military_unit", "other",
] as const;

const LANGUAGE_OPTIONS = [
  ["uk", "Українська"], ["ru", "Російська"], ["pl", "Польська"],
  ["la", "Латинська"], ["be", "Білоруська"], ["de", "Німецька"],
  ["yi", "Їдиш"], ["he", "Іврит"], ["", "Не визначено"],
] as const;

const NAME_TYPE_OPTIONS: Array<[PlaceNameType, string]> = [
  ["canonical", "Основна"], ["modern", "Сучасна"], ["historical", "Історична"],
  ["official", "Офіційна"], ["unofficial", "Неофіційна"], ["local", "Місцева"],
  ["pre_reform", "Дореформена"], ["soviet", "Радянська"],
  ["source_error", "Помилка в джерелі"], ["variant", "Варіант написання"],
  ["other", "Інша"],
];

const DATE_PRECISION_OPTIONS: Array<[PlaceNameDatePrecision, string]> = [
  ["day", "Точний день"], ["month", "Місяць"], ["year", "Рік"],
  ["range", "Проміжок"], ["circa", "Приблизно"], ["before", "До"],
  ["after", "Після"], ["unknown", "Не визначено"],
];

const NAME_TYPE_LABELS: Record<string, string> = {
  canonical: "Основна",
  modern: "Сучасна",
  historical: "Історична",
  official: "Офіційна",
  unofficial: "Неофіційна",
  local: "Місцева",
  pre_reform: "Дореформена",
  soviet: "Радянська",
  source_error: "Помилка в джерелі",
  variant: "Варіант написання",
  other: "Інша",
};

const PLACE_PROFILE_PAGE_SIZE = 100;

export function HistoricalPlacesPage(props: HistoricalPlacesPageProps) {
  const [documentOptions, setDocumentOptions] = useState<HistoricalPlaceDocumentOption[]>(props.documents ?? []);
  const incomingDocumentCount = props.documents?.length ?? 0;

  useEffect(() => {
    if (props.mode === "list") return;
    if (incomingDocumentCount > 0) {
      setDocumentOptions(props.documents ?? []);
      return;
    }
    const controller = new AbortController();
    void listHistoricalPlaceDocumentOptions(props.projectId, undefined, controller.signal)
      .then(setDocumentOptions)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) console.warn("Не вдалося завантажити документи-джерела для історичного місця", cause);
      });
    return () => controller.abort();
  }, [incomingDocumentCount, props.mode, props.projectId]);

  const pageProps = { ...props, documents: documentOptions };
  if (props.mode === "list") return <PlacesCatalogue {...pageProps} />;
  if (props.mode === "new") return <NewPlaceForm {...pageProps} />;
  if (!props.placeId) {
    return (
      <section className="panel empty-state">
        <strong>Історичне місце не вибрано.</strong>
        <button type="button" className="button button-primary" onClick={props.onBackToList}>
          До каталогу
        </button>
      </section>
    );
  }
  // A route change must not keep the previous profile's tabs, forms or merge
  // preview visible while the next place is loading.
  return <PlaceProfile key={props.placeId} {...pageProps} placeId={props.placeId} />;
}

function PlacesCatalogue(props: HistoricalPlacesPageProps) {
  const [query, setQuery] = useState("");
  const [atDate, setAtDate] = useState("");
  const [atYear, setAtYear] = useState("");
  const [ancestorPlace, setAncestorPlace] = useState<HistoricalPlaceFieldValue>({ placeId: null, place: null, originalText: "" });
  const [searchLatitude, setSearchLatitude] = useState("");
  const [searchLongitude, setSearchLongitude] = useState("");
  const [searchRadiusKm, setSearchRadiusKm] = useState("");
  const [items, setItems] = useState<PlaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const temporalContext = useMemo(() => yearTemporalContext(atYear), [atYear]);
  const coordinateFilterError = validateCoordinateSearch(searchLatitude, searchLongitude, searchRadiusKm);
  const coordinateFilterReady = Boolean(searchLatitude.trim() && searchLongitude.trim() && searchRadiusKm.trim() && !coordinateFilterError);

  useEffect(() => {
    const normalized = query.trim();
    const hasCriterion = normalized.length >= 2 || Boolean(ancestorPlace.placeId) || coordinateFilterReady;
    if (coordinateFilterError) {
      setItems([]);
      setLoading(false);
      setError(coordinateFilterError);
      setSearched(false);
      return;
    }
    if (!hasCriterion) {
      setItems([]);
      setLoading(false);
      setError("");
      setSearched(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void searchHistoricalPlaces({
        query: normalized,
        projectId: props.projectId,
        atDate: atDate || null,
        temporalContext,
        ancestorPlaceId: ancestorPlace.placeId,
        latitude: coordinateFilterReady ? Number(searchLatitude) : null,
        longitude: coordinateFilterReady ? Number(searchLongitude) : null,
        radiusKm: coordinateFilterReady ? Number(searchRadiusKm) : null,
        limit: 50,
      }, controller.signal).then((results) => {
        setItems(results);
        setSearched(true);
      }).catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setItems([]);
        setSearched(true);
        setError(errorMessage(cause));
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ancestorPlace.placeId, atDate, coordinateFilterError, coordinateFilterReady, props.projectId, query, searchLatitude, searchLongitude, searchRadiusKm, temporalContext]);

  return (
    <div className="historical-places-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Географія проєкту</span>
          <h1>Історичні місця</h1>
          <p>
            Знаходьте населений пункт за сучасною або історичною назвою та
            перевіряйте адміністративну належність на потрібну дату.
          </p>
        </div>
        <div className="page-heading-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={props.readOnly}
            onClick={props.onCreatePlace}
          >
            Створити місце
          </button>
        </div>
      </header>

      <section className="panel historical-place-search-panel">
        <div className="historical-place-search-grid">
          <label>
            <span>Назва або варіант написання</span>
            <input
              type="search"
              value={query}
              placeholder="Наприклад: Трубіївка або Трубіевка"
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            <span>На точну дату</span>
            <input type="date" value={atDate} onChange={(event) => { setAtDate(event.target.value); if (event.target.value) setAtYear(""); }} />
          </label>
          <label>
            <span>Або лише рік</span>
            <input type="number" min="1" max="9999" inputMode="numeric" placeholder="1862" value={atYear} onChange={(event) => { setAtYear(event.target.value.replace(/\D/g, "").slice(0, 4)); if (event.target.value) setAtDate(""); }} />
          </label>
        </div>
        <small className="field-hint">
          Дата впливає на назву та адміністративну ієрархію у результатах.
        </small>
        <details className="historical-place-search-advanced">
          <summary>Розширений пошук за адміністративною одиницею або координатами</summary>
          <div className="historical-place-search-filter-grid">
            <HistoricalPlaceField
              value={ancestorPlace}
              onChange={setAncestorPlace}
              projectId={props.projectId}
              atDate={atDate || null}
              temporalContext={temporalContext}
              label="У складі адміністративної одиниці"
              placeholder="Оберіть губернію, повіт, громаду…"
              allowInlineCreate={false}
              helpText="Показує місця, що належали до вибраної одиниці у вказаний час."
            />
            <label><span>Широта центру</span><input type="number" min={-90} max={90} step="any" value={searchLatitude} onChange={(event) => setSearchLatitude(event.target.value)} /></label>
            <label><span>Довгота центру</span><input type="number" min={-180} max={180} step="any" value={searchLongitude} onChange={(event) => setSearchLongitude(event.target.value)} /></label>
            <label><span>Радіус, км</span><input type="number" min="0.01" max="500" step="any" value={searchRadiusKm} onChange={(event) => setSearchRadiusKm(event.target.value)} /></label>
          </div>
          <small className="field-hint">Для пошуку поруч заповніть усі три поля: широту, довготу та радіус до 500 км.</small>
        </details>
      </section>

      {loading ? <PlaceCardsSkeleton /> : null}
      {!loading && error ? <section className="panel historical-place-error">{error}</section> : null}
      {!loading && !error && !searched ? (
        <section className="panel historical-place-welcome">
          <strong>Почніть вводити назву</strong>
          <p>Пошук враховує сучасні, історичні та альтернативні написання.</p>
        </section>
      ) : null}
      {!loading && !error && searched && items.length === 0 ? (
        <section className="panel empty-state">
          <strong>Місць за цим запитом не знайдено.</strong>
          {!props.readOnly ? (
            <button type="button" className="button button-primary" onClick={props.onCreatePlace}>
              Створити нове місце
            </button>
          ) : null}
        </section>
      ) : null}
      {!loading && items.length > 0 ? (
        <section className="historical-place-results" aria-label="Результати пошуку місць">
          {items.map((place) => (
            <button type="button" className="historical-place-card" key={place.id} onClick={() => props.onOpenPlace(place.id)}>
              <div className="historical-place-card-heading">
                <div>
                  <strong>{place.displayName || place.canonicalName}</strong>
                  <span>{placeTypeLabel(place.placeType)}</span>
                </div>
                <span className={`historical-place-status ${place.status}`}>{statusLabel(place.status)}</span>
              </div>
              {place.matchedName && place.matchedName !== place.canonicalName ? (
                <p>Знайдено за написанням: <b>{place.matchedName}</b></p>
              ) : null}
              <p>{historicalPlaceAdministrativeLabel(place) || "Адміністративний опис ще не додано"}</p>
              {place.distanceKm !== null && place.distanceKm !== undefined ? <small>Відстань: {place.distanceKm.toLocaleString("uk-UA", { maximumFractionDigits: 2 })} км</small> : null}
              {place.names.length > 0 ? (
                <small>Варіанти: {place.names.slice(0, 4).map((name) => name.originalText).join(", ")}</small>
              ) : null}
            </button>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function NewPlaceForm(props: HistoricalPlacesPageProps) {
  const [canonicalName, setCanonicalName] = useState("");
  const [modernName, setModernName] = useState("");
  const [originalText, setOriginalText] = useState("");
  const [languageCode, setLanguageCode] = useState("uk");
  const [sourceNameType, setSourceNameType] = useState<PlaceNameType>("historical");
  const [sourceNameValidFrom, setSourceNameValidFrom] = useState("");
  const [sourceNameValidTo, setSourceNameValidTo] = useState("");
  const [sourceNameValidFromText, setSourceNameValidFromText] = useState("");
  const [sourceNameValidToText, setSourceNameValidToText] = useState("");
  const [sourceNamePrecision, setSourceNamePrecision] = useState<PlaceNameDatePrecision>("unknown");
  const [sourceNameDocumentId, setSourceNameDocumentId] = useState("");
  const [sourceNameReference, setSourceNameReference] = useState("");
  const [sourceNameConfidence, setSourceNameConfidence] = useState("70");
  const [sourceNameNote, setSourceNameNote] = useState("");
  const [placeType, setPlaceType] = useState("settlement");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [description, setDescription] = useState("");
  const [needsIdentification, setNeedsIdentification] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<PlaceVerificationStatus>("unverified");
  const [status, setStatus] = useState<PlaceStatus>("active");
  const [wikidataId, setWikidataId] = useState("");
  const [geonamesId, setGeonamesId] = useState("");
  const [externalIdsText, setExternalIdsText] = useState("{}");
  const [parentPlace, setParentPlace] = useState<HistoricalPlaceFieldValue>({ placeId: null, place: null, originalText: "" });
  const [parentValidFrom, setParentValidFrom] = useState("");
  const [parentValidTo, setParentValidTo] = useState("");
  const [parentValidFromText, setParentValidFromText] = useState("");
  const [parentValidToText, setParentValidToText] = useState("");
  const [parentDatePrecision, setParentDatePrecision] = useState<PlaceNameDatePrecision>("unknown");
  const [parentSourceDocumentId, setParentSourceDocumentId] = useState("");
  const [parentSource, setParentSource] = useState("");
  const [parentConfidence, setParentConfidence] = useState("80");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const coordinateError = validateCoordinates(latitude, longitude);
  const externalIdsResult = parseExternalIdsInput(externalIdsText);
  const parentDateError = dateRangeError(parentValidFrom, parentValidTo);
  const sourceNameDateError = dateRangeError(sourceNameValidFrom, sourceNameValidTo);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || props.readOnly) return;
    if (coordinateError || externalIdsResult.error || parentDateError || sourceNameDateError) {
      setError(coordinateError || externalIdsResult.error || parentDateError || sourceNameDateError);
      return;
    }
    setSaving(true);
    setError("");
    const names = originalText.trim() ? [{
      // Keep the literal source wording immutable, but use the canonical value
      // for display/search normalization. Otherwise a source phrase such as
      // "деревни Новая Слобода" replaces the user-entered place title.
      name: canonicalName.trim(),
      originalText,
      languageCode,
      nameType: sourceNameType,
      validFrom: sourceNameValidFrom || null,
      validTo: sourceNameValidTo || null,
      validFromText: sourceNameValidFromText || null,
      validToText: sourceNameValidToText || null,
      datePrecision: sourceNamePrecision,
      sourceDocumentId: sourceNameDocumentId || null,
      sourceReference: sourceNameReference || null,
      confidence: clampConfidence(sourceNameConfidence),
      note: sourceNameNote,
      isPrimary: false,
    }] : [];
    void (async () => {
      const place = await createProjectPlace({
        projectId: props.projectId,
        canonicalName,
        modernName,
        description,
        languageCode,
        placeType,
        latitude: latitude.trim() ? Number(latitude.trim()) : null,
        longitude: longitude.trim() ? Number(longitude.trim()) : null,
        needsIdentification,
        verificationStatus,
        status: needsIdentification ? "needs_review" : status,
        wikidataId: wikidataId.trim() || null,
        geonamesId: geonamesId.trim() || null,
        externalIds: externalIdsResult.value,
        currentAdmin: parentPlace.place?.displayName || parentPlace.placeDisplayName || "",
        currentCountry: parentPlace.place?.placeType === "country" ? parentPlace.place.displayName : "",
        names,
        parentRelation: parentPlace.placeId ? {
          parentPlaceId: parentPlace.placeId,
          relationType: "administrative_parent",
          validFrom: parentValidFrom || null,
          validTo: parentValidTo || null,
          validFromText: parentValidFromText || null,
          validToText: parentValidToText || null,
          validFromPrecision: parentDatePrecision,
          validToPrecision: parentDatePrecision,
          sourceDocumentId: parentSourceDocumentId || null,
          sourceReference: parentSource,
          confidence: clampConfidence(parentConfidence),
        } : undefined,
      });
      props.onOpenPlace(place.id);
    })().catch((cause: unknown) => {
      setError(errorMessage(cause));
    }).finally(() => setSaving(false));
  };

  return (
    <div className="historical-places-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Каталог місць</span>
          <h1>Нове історичне місце</h1>
          <p>Місце буде приватним для проєкту «{props.projectName}».</p>
        </div>
        <button type="button" className="button button-secondary" onClick={props.onBackToList}>До каталогу</button>
      </header>
      <form className="panel historical-place-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            <span>Основна назва *</span>
            <input required maxLength={500} value={canonicalName} onChange={(event) => setCanonicalName(event.target.value)} />
          </label>
          <label>
            <span>Сучасна назва</span>
            <input maxLength={500} value={modernName} onChange={(event) => setModernName(event.target.value)} />
          </label>
          <label>
            <span>Тип місця *</span>
            <select required value={placeType} onChange={(event) => setPlaceType(event.target.value)}>
              {PLACE_TYPE_OPTIONS.map((value) => <option key={value} value={value}>{historicalPlaceTypeLabel(value)}</option>)}
            </select>
          </label>
          <label>
            <span>Точне написання в джерелі</span>
            <input value={originalText} onChange={(event) => setOriginalText(event.target.value)} />
            <small className="field-hint">Зберігається дослівно й не замінюється основною назвою.</small>
          </label>
          <label>
            <span>Мова написання</span>
            <select value={languageCode} onChange={(event) => setLanguageCode(event.target.value)}>{LANGUAGE_OPTIONS.map(([value, label]) => <option key={value || "unknown"} value={value}>{label}</option>)}</select>
          </label>
          {originalText.trim() ? <fieldset className="historical-place-context-fieldset field-wide"><legend>Відомості про написання в джерелі</legend><div className="historical-place-inline-grid"><label><span>Тип назви</span><select value={sourceNameType} onChange={(event) => setSourceNameType(event.target.value as PlaceNameType)}>{NAME_TYPE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>Від</span><input type="date" value={sourceNameValidFrom} onChange={(event) => setSourceNameValidFrom(event.target.value)} /></label><label><span>До</span><input type="date" value={sourceNameValidTo} onChange={(event) => setSourceNameValidTo(event.target.value)} /></label><label><span>Текст дати від</span><input value={sourceNameValidFromText} onChange={(event) => setSourceNameValidFromText(event.target.value)} /></label><label><span>Текст дати до</span><input value={sourceNameValidToText} onChange={(event) => setSourceNameValidToText(event.target.value)} /></label><label><span>Точність</span><select value={sourceNamePrecision} onChange={(event) => setSourceNamePrecision(event.target.value as PlaceNameDatePrecision)}>{DATE_PRECISION_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>Достовірність, %</span><input type="number" min="0" max="100" value={sourceNameConfidence} onChange={(event) => setSourceNameConfidence(event.target.value)} /></label><label><span>Документ-джерело</span><select value={sourceNameDocumentId} onChange={(event) => setSourceNameDocumentId(event.target.value)}><option value="">Не прив’язано</option>{(props.documents ?? []).map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label></div><label><span>Джерело / цитата</span><input value={sourceNameReference} onChange={(event) => setSourceNameReference(event.target.value)} /></label><label><span>Примітка</span><textarea rows={2} value={sourceNameNote} onChange={(event) => setSourceNameNote(event.target.value)} /></label></fieldset> : null}
          <label>
            <span>Широта</span>
            <input type="number" min={-90} max={90} step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} />
          </label>
          <label>
            <span>Довгота</span>
            <input type="number" min={-180} max={180} step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} />
          </label>
          <label className="field-wide">
            <span>Короткий опис</span>
            <textarea rows={5} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label>
            <span>Стан перевірки</span>
            <select value={verificationStatus} onChange={(event) => setVerificationStatus(event.target.value as PlaceVerificationStatus)}>
              <option value="unverified">Не перевірено</option><option value="plausible">Ймовірне</option><option value="verified">Перевірено</option><option value="disputed">Спірне</option>
            </select>
          </label>
          <label>
            <span>Статус</span>
            <select value={needsIdentification ? "needs_review" : status} disabled={needsIdentification} onChange={(event) => setStatus(event.target.value as PlaceStatus)}>
              <option value="active">Активне</option><option value="needs_review">Потребує перевірки</option><option value="archived">Архівне</option>
            </select>
          </label>
          <label><span>Wikidata ID</span><input placeholder="Q12345" value={wikidataId} onChange={(event) => setWikidataId(event.target.value)} /></label>
          <label><span>GeoNames ID</span><input inputMode="numeric" value={geonamesId} onChange={(event) => setGeonamesId(event.target.value)} /></label>
          <label className="field-wide"><span>Інші зовнішні ідентифікатори (JSON)</span><textarea rows={3} value={externalIdsText} onChange={(event) => setExternalIdsText(event.target.value)} /><small className="field-hint">Наприклад: {`{"osm":"relation/123","viaf":"456"}`}</small></label>
          <label className="checkbox-field field-wide">
            <input type="checkbox" checked={needsIdentification} onChange={(event) => setNeedsIdentification(event.target.checked)} />
            <span>Місце ще потребує точної ідентифікації</span>
          </label>
          <fieldset className="historical-place-context-fieldset field-wide">
            <legend>Адміністративний контекст</legend>
            <p className="field-hint">Сучасна та історична належність зберігається як датований зв’язок із відповідною адміністративною одиницею.</p>
            <HistoricalPlaceField value={parentPlace} onChange={setParentPlace} projectId={props.projectId} label="Адміністративна одиниця" />
            <div className="historical-place-inline-grid"><label><span>Від</span><input type="date" value={parentValidFrom} onChange={(event) => setParentValidFrom(event.target.value)} /></label><label><span>До</span><input type="date" value={parentValidTo} onChange={(event) => setParentValidTo(event.target.value)} /></label><label><span>Достовірність, %</span><input type="number" min="0" max="100" value={parentConfidence} onChange={(event) => setParentConfidence(event.target.value)} /></label></div>
            <div className="historical-place-inline-grid"><label><span>Текст дати від</span><input value={parentValidFromText} onChange={(event) => setParentValidFromText(event.target.value)} /></label><label><span>Текст дати до</span><input value={parentValidToText} onChange={(event) => setParentValidToText(event.target.value)} /></label><label><span>Точність дат</span><select value={parentDatePrecision} onChange={(event) => setParentDatePrecision(event.target.value as PlaceNameDatePrecision)}>{DATE_PRECISION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            <label><span>Документ-джерело</span><select value={parentSourceDocumentId} onChange={(event) => setParentSourceDocumentId(event.target.value)}><option value="">Не прив’язано</option>{(props.documents ?? []).map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>
            <label><span>Джерело / цитата</span><input value={parentSource} onChange={(event) => setParentSource(event.target.value)} /></label>
          </fieldset>
        </div>
        {coordinateError || externalIdsResult.error || parentDateError || sourceNameDateError || error ? (
          <div className="historical-place-error" role="alert">{coordinateError || externalIdsResult.error || parentDateError || sourceNameDateError || error}</div>
        ) : null}
        <div className="historical-place-form-actions">
          <button type="button" className="button button-secondary" onClick={props.onBackToList}>Скасувати</button>
          <button type="submit" className="button button-primary" disabled={saving || props.readOnly || Boolean(coordinateError || externalIdsResult.error || parentDateError || sourceNameDateError) || !canonicalName.trim()}>
            {saving ? "Зберігаємо…" : "Створити місце"}
          </button>
        </div>
      </form>
    </div>
  );
}

function PlaceProfile(props: HistoricalPlacesPageProps & { placeId: string }) {
  const [atDate, setAtDate] = useState("");
  const [atYear, setAtYear] = useState("");
  const temporalContext = useMemo(() => yearTemporalContext(atYear), [atYear]);
  const activeTemporalContext = useMemo(() => temporalContext ?? (atDate ? {
    exactDate: atDate,
    originalText: atDate,
    precision: "day" as const,
  } : null), [atDate, temporalContext]);
  const [profile, setProfile] = useState<HistoricalPlaceProfile | null>(null);
  const [names, setNames] = useState<PlaceName[]>([]);
  const [history, setHistory] = useState<PlaceHierarchyHistoryEntry[]>([]);
  const [related, setRelated] = useState<HistoricalPlaceRelated[]>([]);
  const [parishes, setParishes] = useState<HistoricalPlaceParish[]>([]);
  const [archives, setArchives] = useState<HistoricalPlaceArchive[]>([]);
  const [documents, setDocuments] = useState<HistoricalPlaceDocument[]>([]);
  const [people, setPeople] = useState<HistoricalPlacePerson[]>([]);
  const [events, setEvents] = useState<HistoricalPlaceEvent[]>([]);
  const [peopleHasMore, setPeopleHasMore] = useState(false);
  const [documentsHaveMore, setDocumentsHaveMore] = useState(false);
  const [eventsHaveMore, setEventsHaveMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"" | "people" | "documents" | "events">("");
  const [boundaries, setBoundaries] = useState<HistoricalPlaceBoundary[]>([]);
  const [mapPlace, setMapPlace] = useState<PlaceSummary | null>(null);
  const [audit, setAudit] = useState<HistoricalPlaceAuditEntry[]>([]);
  const [revision, setRevision] = useState(0);
  const [activeTab, setActiveTab] = useState<
    "overview" | "names" | "history" | "boundaries" | "related" | "parishes" | "archives" | "documents" | "people" | "events" | "audit"
  >("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const profileRequestRef = useRef(0);
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex < 0 || tabs.length === 0) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  };

  useEffect(() => {
    const requestId = ++profileRequestRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getHistoricalPlaceProfile(props.placeId, atDate || null, controller.signal, activeTemporalContext)
      .then((nextProfile) => {
        if (isCurrentHistoricalPlaceRequest(
          profileRequestRef.current,
          requestId,
          controller.signal.aborted,
        )) {
          const redirectTarget = nextProfile.place.redirect?.finalTargetPlaceId;
          if (redirectTarget && redirectTarget !== props.placeId) {
            props.onOpenPlace(redirectTarget);
            return;
          }
          setProfile(nextProfile);
        }
      })
      .catch((cause: unknown) => {
        if (isCurrentHistoricalPlaceRequest(
          profileRequestRef.current,
          requestId,
          controller.signal.aborted,
        )) {
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (isCurrentHistoricalPlaceRequest(
          profileRequestRef.current,
          requestId,
          controller.signal.aborted,
        )) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [activeTemporalContext, atDate, props.placeId, revision]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      listHistoricalPlaceNames(props.placeId, controller.signal),
      listHistoricalPlaceHierarchyHistory(props.placeId, controller.signal),
      listHistoricalPlacePeople(props.placeId, PLACE_PROFILE_PAGE_SIZE, 0, controller.signal),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      const [loadedNames, loadedHistory, loadedPeople] = results;
      if (loadedNames.status === "fulfilled") setNames(loadedNames.value);
      if (loadedHistory.status === "fulfilled") setHistory(loadedHistory.value);
      if (loadedPeople.status === "fulfilled") {
        setPeople(loadedPeople.value);
        setPeopleHasMore(loadedPeople.value.length === PLACE_PROFILE_PAGE_SIZE);
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") setError(errorMessage(failed.reason));
    });
    return () => controller.abort();
  }, [props.placeId, revision]);

  useEffect(() => {
    // Global catalogue profiles intentionally have no project-private audit
    // feed. Calling the audit RPC for them returns 42501 and used to paint an
    // otherwise valid global profile as an error.
    if (profile?.place.scope !== "project") {
      setAudit([]);
      return;
    }
    const controller = new AbortController();
    void listHistoricalPlaceAudit(props.placeId, 50)
      .then((items) => {
        if (!controller.signal.aborted) setAudit(items);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [profile?.place.scope, props.placeId, revision]);

  useEffect(() => {
    const controller = new AbortController();
    setMapPlace(null);
    void Promise.allSettled([
      listHistoricalPlaceRelated(props.placeId, atDate || null, controller.signal),
      listHistoricalPlaceParishes(props.placeId, atDate || null, controller.signal),
      listHistoricalPlaceArchives(props.placeId, atDate || null, controller.signal),
      getHistoricalPlaceMapContext(props.placeId, activeTemporalContext, PLACE_PROFILE_PAGE_SIZE, controller.signal),
    ]).then((results) => {
      if (controller.signal.aborted) return;
      const [loadedRelated, loadedParishes, loadedArchives, loadedMap] = results;
      if (loadedRelated.status === "fulfilled") setRelated(loadedRelated.value);
      if (loadedParishes.status === "fulfilled") setParishes(loadedParishes.value);
      if (loadedArchives.status === "fulfilled") setArchives(loadedArchives.value);
      if (loadedMap.status === "fulfilled") {
        setMapPlace(loadedMap.value.place);
        setBoundaries(loadedMap.value.boundaries);
        setDocuments(loadedMap.value.documents);
        setEvents(loadedMap.value.events);
        setDocumentsHaveMore(loadedMap.value.documents.length === PLACE_PROFILE_PAGE_SIZE);
        setEventsHaveMore(loadedMap.value.events.length === PLACE_PROFILE_PAGE_SIZE);
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") setError(errorMessage(failed.reason));
    });
    return () => controller.abort();
  }, [activeTemporalContext, atDate, props.placeId, revision]);

  const loadMorePeople = async () => {
    if (loadingMore || !peopleHasMore) return;
    setLoadingMore("people");
    try {
      const next = await listHistoricalPlacePeople(
        props.placeId,
        PLACE_PROFILE_PAGE_SIZE,
        people.length,
      );
      setPeople((current) => appendUnique(current, next, (item) => item.personId));
      setPeopleHasMore(next.length === PLACE_PROFILE_PAGE_SIZE);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore("");
    }
  };

  const loadMoreDocuments = async () => {
    if (loadingMore || !documentsHaveMore) return;
    setLoadingMore("documents");
    try {
      const next = await listHistoricalPlaceDocuments(
        props.placeId,
        PLACE_PROFILE_PAGE_SIZE,
        documents.length,
        undefined,
        activeTemporalContext,
      );
      setDocuments((current) => appendUnique(current, next, (item) => item.linkId));
      setDocumentsHaveMore(next.length === PLACE_PROFILE_PAGE_SIZE);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore("");
    }
  };

  const loadMoreEvents = async () => {
    if (loadingMore || !eventsHaveMore) return;
    setLoadingMore("events");
    try {
      const next = await listHistoricalPlaceEvents(
        props.placeId,
        PLACE_PROFILE_PAGE_SIZE,
        events.length,
        undefined,
        activeTemporalContext,
      );
      setEvents((current) => appendUnique(current, next, (item) => item.eventId));
      setEventsHaveMore(next.length === PLACE_PROFILE_PAGE_SIZE);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore("");
    }
  };

  if (loading && !profile) return <PlaceProfileSkeleton />;
  if (!profile) {
    return (
      <section className="panel empty-state">
        <strong>{error || "Профіль місця не вдалося завантажити."}</strong>
        <button type="button" className="button button-primary" onClick={props.onBackToList}>До каталогу</button>
      </section>
    );
  }
  const place = mapPlace ? {
    ...profile.place,
    displayName: mapPlace.displayName || profile.place.displayName,
    placeType: mapPlace.placeType || profile.place.placeType,
    currentCountry: mapPlace.currentCountry || profile.place.currentCountry,
    currentAdmin: mapPlace.currentAdmin || profile.place.currentAdmin,
    hierarchy: mapPlace.hierarchy.length > 0 ? mapPlace.hierarchy : profile.place.hierarchy,
    latitude: mapPlace.latitude ?? profile.place.latitude,
    longitude: mapPlace.longitude ?? profile.place.longitude,
  } : profile.place;
  const displayProfile = place === profile.place ? profile : { ...profile, place };
  const canOfferMerge = !props.readOnly
    && place.scope === "project"
    && place.projectId === props.projectId
    && !["merged", "archived"].includes(place.status);
  const canEditPrivate = canOfferMerge;
  const profileDateIsCurrent = atYear ? !loading : historicalPlaceProfileMatchesDate(profile.atDate, atDate);
  // The legacy relation/archive/boundary RPCs understand an exact date only.
  // For a year-only query we deliberately load the complete timeline and
  // filter overlapping evidence in the client instead of inventing a day.
  const datedContext = atDate || atYear;
  const visibleBoundaries = boundaries.filter((item) => datedEvidenceMatchesDate(item, datedContext));
  const visibleRelated = related.filter((item) => datedEvidenceMatchesDate(item, datedContext));
  const visibleParishes = parishes.filter((item) => datedEvidenceMatchesDate(item, datedContext));
  const visibleArchives = archives.filter((item) => datedEvidenceMatchesDate(item, datedContext));
  return (
    <div className="historical-places-page historical-place-profile">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Профіль історичного місця</span>
          <h1>{place.displayName || place.canonicalName}</h1>
          <p>{[placeTypeLabel(place.placeType), historicalPlaceAdministrativeLabel(place)].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="page-heading-actions">
          <button type="button" className="button button-secondary" onClick={props.onBackToList}>До каталогу</button>
          {canOfferMerge ? (
            <button type="button" className="button button-secondary" onClick={() => setMergeOpen((current) => !current)}>
              {mergeOpen ? "Закрити об’єднання" : "Об’єднати дубль"}
            </button>
          ) : null}
          {canEditPrivate && props.mode !== "edit" && props.onEditPlace ? <button type="button" className="button button-primary" onClick={() => props.onEditPlace?.(place.id)}>Редагувати</button> : null}
        </div>
      </header>

      {props.mode === "edit" && canEditPrivate ? (
        <HistoricalPlaceWritePanel
          key={`${place.id}:${place.lockVersion}`}
          place={place}
          names={names}
          projectId={props.projectId}
          documents={props.documents ?? []}
          onSaved={() => setRevision((value) => value + 1)}
          onReload={() => {
            setLoading(true);
            setProfile(null);
            setRevision((value) => value + 1);
          }}
        />
      ) : null}
      {props.mode === "edit" && !canEditPrivate ? <section className="panel historical-place-capability-notice"><strong>Це місце доступне лише для перегляду.</strong><p>{place.scope === "global" ? "Зміни глобального каталогу проходять окремий контрольований процес." : "Ваша роль не дозволяє редагувати це місце."}</p></section> : null}
      {error ? <section className="historical-place-error" role="alert">{error}</section> : null}
      {mergeOpen && canOfferMerge ? (
        <HistoricalPlaceMergePanel
          source={place}
          projectId={props.projectId}
          onCancel={() => setMergeOpen(false)}
          onMerged={(targetPlaceId) => props.onOpenPlace(targetPlaceId)}
        />
      ) : null}

      <section className="panel historical-place-date-context">
        <label>
          <span>Показати стан на точну дату</span>
          <input type="date" value={atDate} onChange={(event) => { setAtDate(event.target.value); if (event.target.value) setAtYear(""); }} />
        </label>
        <label>
          <span>Або за роком без вигаданої дати</span>
          <input type="number" min="1" max="9999" inputMode="numeric" placeholder="1862" value={atYear} onChange={(event) => { setAtYear(event.target.value.replace(/\D/g, "").slice(0, 4)); if (event.target.value) setAtDate(""); }} />
          <small className="field-hint">Рік передається як період із точністю «рік», а не як умовне 1 січня.</small>
        </label>
        <p aria-live="polite">
          {profileDateIsCurrent
            ? hierarchySummary(displayProfile)
            : "Оновлюємо адміністративну належність для вибраної дати…"}
        </p>
      </section>

      <nav className="historical-place-tabs" aria-label="Розділи профілю місця" role="tablist" onKeyDown={handleTabKeyDown}>
        <button id="historical-place-tab-overview" aria-controls="historical-place-active-panel" tabIndex={activeTab === "overview" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "overview"} className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Огляд</button>
        <button id="historical-place-tab-names" aria-controls="historical-place-active-panel" tabIndex={activeTab === "names" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "names"} className={activeTab === "names" ? "active" : ""} onClick={() => setActiveTab("names")}>Історичні назви <span>{names.length}</span></button>
        <button id="historical-place-tab-history" aria-controls="historical-place-active-panel" tabIndex={activeTab === "history" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "history"} className={activeTab === "history" ? "active" : ""} onClick={() => setActiveTab("history")}>Адміністративна історія <span>{history.length}</span></button>
        <button id="historical-place-tab-boundaries" aria-controls="historical-place-active-panel" tabIndex={activeTab === "boundaries" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "boundaries"} className={activeTab === "boundaries" ? "active" : ""} onClick={() => setActiveTab("boundaries")}>Історичні межі <span>{visibleBoundaries.length}</span></button>
        <button id="historical-place-tab-related" aria-controls="historical-place-active-panel" tabIndex={activeTab === "related" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "related"} className={activeTab === "related" ? "active" : ""} onClick={() => setActiveTab("related")}>Пов’язані місця <span>{visibleRelated.length}</span></button>
        <button id="historical-place-tab-parishes" aria-controls="historical-place-active-panel" tabIndex={activeTab === "parishes" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "parishes"} className={activeTab === "parishes" ? "active" : ""} onClick={() => setActiveTab("parishes")}>Парафії <span>{visibleParishes.length}</span></button>
        <button id="historical-place-tab-archives" aria-controls="historical-place-active-panel" tabIndex={activeTab === "archives" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "archives"} className={activeTab === "archives" ? "active" : ""} onClick={() => setActiveTab("archives")}>Архіви <span>{visibleArchives.length}</span></button>
        <button id="historical-place-tab-documents" aria-controls="historical-place-active-panel" tabIndex={activeTab === "documents" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "documents"} className={activeTab === "documents" ? "active" : ""} onClick={() => setActiveTab("documents")}>Документи <span>{documents.length}</span></button>
        <button id="historical-place-tab-people" aria-controls="historical-place-active-panel" tabIndex={activeTab === "people" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "people"} className={activeTab === "people" ? "active" : ""} onClick={() => setActiveTab("people")}>Люди <span>{people.length}</span></button>
        <button id="historical-place-tab-events" aria-controls="historical-place-active-panel" tabIndex={activeTab === "events" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "events"} className={activeTab === "events" ? "active" : ""} onClick={() => setActiveTab("events")}>Події <span>{events.length}</span></button>
        {place.scope === "project" ? <button id="historical-place-tab-audit" aria-controls="historical-place-active-panel" tabIndex={activeTab === "audit" ? 0 : -1} type="button" role="tab" aria-selected={activeTab === "audit"} className={activeTab === "audit" ? "active" : ""} onClick={() => setActiveTab("audit")}>Історія змін <span>{audit.length}</span></button> : null}
      </nav>

      <div id="historical-place-active-panel" role="tabpanel" aria-labelledby={`historical-place-tab-${activeTab}`} tabIndex={0}>
        {activeTab === "overview" ? <PlaceOverview profile={displayProfile} boundaries={visibleBoundaries} documents={documents} events={events} atDate={datedContext} /> : null}
        {activeTab === "names" ? <PlaceNames names={names} /> : null}
        {activeTab === "history" ? <PlaceHistory history={history} /> : null}
        {activeTab === "boundaries" ? <PlaceBoundaries items={visibleBoundaries} /> : null}
        {activeTab === "related" ? <PlaceRelations items={visibleRelated} onOpenPlace={props.onOpenPlace} /> : null}
        {activeTab === "parishes" ? <PlaceParishes items={visibleParishes} onOpenPlace={props.onOpenPlace} /> : null}
        {activeTab === "archives" ? <PlaceArchives items={visibleArchives} /> : null}
        {activeTab === "documents" ? <PlaceDocuments items={documents} onOpenDocument={props.onOpenDocument} hasMore={documentsHaveMore} loadingMore={loadingMore === "documents"} onLoadMore={() => void loadMoreDocuments()} /> : null}
        {activeTab === "people" ? <PlacePeople items={people} onOpenPerson={props.onOpenPerson} hasMore={peopleHasMore} loadingMore={loadingMore === "people"} onLoadMore={() => void loadMorePeople()} /> : null}
        {activeTab === "events" ? <PlaceEvents items={events} onOpenPerson={props.onOpenPerson} hasMore={eventsHaveMore} loadingMore={loadingMore === "events"} onLoadMore={() => void loadMoreEvents()} /> : null}
        {activeTab === "audit" ? <PlaceAudit items={audit} /> : null}
      </div>
    </div>
  );
}

function PlaceOverview({
  profile,
  boundaries,
  documents,
  events,
  atDate,
}: {
  profile: HistoricalPlaceProfile;
  boundaries: HistoricalPlaceBoundary[];
  documents: HistoricalPlaceDocument[];
  events: HistoricalPlaceEvent[];
  atDate: string;
}) {
  const place = profile.place;
  const contextDocuments = documents.filter((item) => documentMatchesDate(item, atDate));
  const contextEvents = events.filter((item) => eventMatchesDate(item, atDate));
  return (
    <div className="historical-place-overview-grid">
      <section className="panel historical-place-facts">
        <h2>Основні відомості</h2>
        <dl>
          <div><dt>Основна назва</dt><dd>{place.canonicalName}</dd></div>
          <div><dt>Сучасна назва</dt><dd>{place.modernName || "Не вказано"}</dd></div>
          <div><dt>Тип</dt><dd>{placeTypeLabel(place.placeType)}</dd></div>
          <div><dt>Сучасна належність</dt><dd>{place.currentAdmin || place.currentCountry || "Не вказано"}</dd></div>
          <div><dt>Координати</dt><dd>{formatCoordinates(place)}</dd></div>
          <div><dt>Перевірка</dt><dd>{verificationLabel(place.verificationStatus)}</dd></div>
        </dl>
        {place.description ? <p className="historical-place-description">{place.description}</p> : null}
      </section>
      <section className="panel historical-place-map-panel">
        <h2>Карта</h2>
        {(place.latitude !== null && place.longitude !== null) || boundaries.length > 0 ? (
          <HistoricalPlaceMap
            latitude={place.latitude}
            longitude={place.longitude}
            label={place.displayName}
            boundaries={boundaries}
            contextDocuments={contextDocuments}
            contextEvents={contextEvents}
            atDate={atDate}
          />
        ) : <div className="historical-place-map-empty">Координати ще не додано.</div>}
        <div className="historical-place-map-context" aria-live="polite">
          <strong>{atDate ? `Контекст на ${atDate}` : "Увесь часовий контекст"}</strong>
          <span>{boundaries.length} меж · {contextDocuments.length} документів · {contextEvents.length} подій</span>
          {contextEvents.slice(0, 3).map((item) => <small key={item.eventId}>{eventDateLabel(item)} — {item.title || readableCode(item.eventType)}</small>)}
          {contextDocuments.slice(0, 3).map((item) => <small key={item.linkId}>{yearRange(item.yearFrom, item.yearTo)} — {item.title}</small>)}
        </div>
      </section>
    </div>
  );
}

function PlaceBoundaries({ items }: { items: HistoricalPlaceBoundary[] }) {
  if (!items.length) return <EmptyPlaceTab text="Історичних меж для вибраної дати не знайдено." />;
  return <section className="panel historical-place-resource-list">{items.map((item) => (
    <article key={item.id}>
      <div><strong>{readableCode(item.boundaryType)}</strong><small>{item.geometryType || "GeoJSON"} · SRID {item.srid} · достовірність {item.confidence}%</small></div>
      <span>{periodLabel(item.validFromText || item.validFrom, item.validToText || item.validTo)}</span>
      {item.sourceReference || item.originalText ? <p>{item.sourceReference || item.originalText}</p> : null}
    </article>
  ))}</section>;
}

function PlaceNames({ names }: { names: PlaceName[] }) {
  const ordered = useMemo(() => [...names].sort((a, b) => (a.validFrom ?? "9999").localeCompare(b.validFrom ?? "9999")), [names]);
  if (!ordered.length) return <section className="panel empty-state"><strong>Історичні назви ще не додано.</strong></section>;
  return (
    <section className="panel historical-place-timeline">
      {ordered.map((name) => (
        <article key={name.id}>
          <div className="historical-place-period">{periodLabel(name.validFromText || name.validFrom, name.validToText || name.validTo)}</div>
          <div>
            <h3>{name.originalText}</h3>
            {name.name !== name.originalText ? <p>Нормалізовано: {name.name}</p> : null}
            <small>{[NAME_TYPE_LABELS[name.nameType] ?? name.nameType, languageLabel(name.languageCode), `достовірність ${name.confidence}%`].filter(Boolean).join(" · ")}</small>
            {name.note ? <p>{name.note}</p> : null}
          </div>
        </article>
      ))}
    </section>
  );
}

function PlaceHistory({ history }: { history: PlaceHierarchyHistoryEntry[] }) {
  if (!history.length) return <section className="panel empty-state"><strong>Адміністративну історію ще не додано.</strong></section>;
  return (
    <section className="panel historical-place-timeline">
      {history.map((entry) => (
        <article key={entry.id}>
          <div className="historical-place-period">{periodLabel(entry.validFromText || entry.validFrom, entry.validToText || entry.validTo)}</div>
          <div>
            <h3>{entry.hierarchy.map((node) => node.place.displayName).join(" → ")}</h3>
            <small>Достовірність {entry.confidence}%</small>
            {entry.note ? <p>{entry.note}</p> : null}
          </div>
        </article>
      ))}
    </section>
  );
}

function PlaceRelations({ items, onOpenPlace }: { items: HistoricalPlaceRelated[]; onOpenPlace: (id: string) => void }) {
  if (!items.length) return <EmptyPlaceTab text="Пов’язаних місць для вибраної дати не знайдено." />;
  return (
    <section className="panel historical-place-resource-list">
      {items.map((item) => (
        <button type="button" key={item.id} onClick={() => onOpenPlace(item.place.id)}>
          <div><strong>{item.place.displayName}</strong><small>{relationLabel(item.relationType)} · {item.direction === "incoming" ? "зворотний зв’язок" : "прямий зв’язок"}</small></div>
          <span>{periodLabel(item.validFromText || item.validFrom, item.validToText || item.validTo)}</span>
          {item.originalText ? <p>У джерелі: {item.originalText}</p> : null}
        </button>
      ))}
    </section>
  );
}

function PlaceParishes({ items, onOpenPlace }: { items: HistoricalPlaceParish[]; onOpenPlace: (id: string) => void }) {
  if (!items.length) return <EmptyPlaceTab text="Парафіяльних зв’язків для вибраної дати не знайдено." />;
  return (
    <section className="panel historical-place-resource-list">
      {items.map((item) => (
        <button type="button" key={item.id} onClick={() => onOpenPlace(item.place.id)}>
          <div><strong>{item.place.displayName}</strong><small>{item.religion || "Віросповідання не вказано"}</small></div>
          <span>{periodLabel(item.validFromText || item.validFrom, item.validToText || item.validTo)}</span>
          {item.originalText ? <p>У джерелі: {item.originalText}</p> : null}
        </button>
      ))}
    </section>
  );
}

function PlaceArchives({ items }: { items: HistoricalPlaceArchive[] }) {
  if (!items.length) return <EmptyPlaceTab text="Архівних ресурсів для вибраної дати не знайдено." />;
  return (
    <section className="historical-place-resource-grid">
      {items.map((item) => (
        <article className="panel" key={item.id}>
          <span className="eyebrow">{archiveResourceTypeLabel(item.resource.resourceType)}</span>
          <h3>{item.resource.title}</h3>
          <p>{[item.resource.archiveName, item.resource.fund && `Фонд ${item.resource.fund}`, item.resource.inventory && `Опис ${item.resource.inventory}`, item.resource.fileReference && `Справа ${item.resource.fileReference}`].filter(Boolean).join(" · ")}</p>
          {item.resource.description ? <p>{item.resource.description}</p> : null}
          <small>{periodLabel(item.validFromText || item.validFrom, item.validToText || item.validTo)}</small>
          {item.resource.url ? <a href={item.resource.url} target="_blank" rel="noreferrer">Відкрити ресурс</a> : null}
        </article>
      ))}
    </section>
  );
}

function PlaceDocuments({ items, onOpenDocument, hasMore, loadingMore, onLoadMore }: { items: HistoricalPlaceDocument[]; onOpenDocument?: (id: string) => void; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  if (!items.length) return <EmptyPlaceTab text="Документів, прив’язаних до цього місця, ще немає." />;
  return (
    <>
      <section className="panel historical-place-resource-list">
        {items.map((item) => {
          const content = (
            <>
              <div><strong>{item.title}</strong><small>{[item.documentType, item.archive, item.fund].filter(Boolean).join(" · ")}</small></div>
              <span>{yearRange(item.yearFrom, item.yearTo)}</span>
              {item.originalText ? <p>У документі: {item.originalText}</p> : null}
            </>
          );
          return onOpenDocument ? <button type="button" key={item.linkId} onClick={() => onOpenDocument(item.documentId)}>{content}</button> : <article key={item.linkId}>{content}</article>;
        })}
      </section>
      <PlaceLoadMore visible={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}

function PlacePeople({ items, onOpenPerson, hasMore, loadingMore, onLoadMore }: { items: HistoricalPlacePerson[]; onOpenPerson?: (id: string) => void; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  if (!items.length) return <EmptyPlaceTab text="Осіб із підтвердженими подіями в цьому місці ще немає." />;
  return (
    <>
      <section className="panel historical-place-resource-list">
        {items.map((item) => {
          const content = <><div><strong>{item.fullName}</strong><small>{item.eventTypes.map(readableCode).join(", ") || "Типи подій не вказано"}</small></div><span>{item.eventCount} подій</span></>;
          return onOpenPerson ? <button type="button" key={item.personId} onClick={() => onOpenPerson(item.personId)}>{content}</button> : <article key={item.personId}>{content}</article>;
        })}
      </section>
      <PlaceLoadMore visible={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}

function PlaceEvents({ items, onOpenPerson, hasMore, loadingMore, onLoadMore }: { items: HistoricalPlaceEvent[]; onOpenPerson?: (id: string) => void; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  if (!items.length) return <EmptyPlaceTab text="Подій, прив’язаних до цього місця, ще немає." />;
  return (
    <>
      <section className="panel historical-place-resource-list">
        {items.map((item) => {
          const content = (
            <>
              <div><strong>{item.title || readableCode(item.eventType)}</strong><small>{item.personName} · {eventDateLabel(item)}</small></div>
              <span>{item.confidence}%</span>
              {item.placeOriginalText ? <p>Місце в джерелі: {item.placeOriginalText}</p> : null}
            </>
          );
          return onOpenPerson ? <button type="button" key={item.eventId} onClick={() => onOpenPerson(item.personId)}>{content}</button> : <article key={item.eventId}>{content}</article>;
        })}
      </section>
      <PlaceLoadMore visible={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </>
  );
}

function PlaceLoadMore({ visible, loading, onLoadMore }: { visible: boolean; loading: boolean; onLoadMore: () => void }) {
  if (!visible) return null;
  return <button type="button" className="button button-secondary historical-place-load-more" disabled={loading} onClick={onLoadMore}>{loading ? "Завантажуємо…" : "Показати ще"}</button>;
}

function appendUnique<T>(current: T[], next: T[], key: (item: T) => string): T[] {
  const seen = new Set(current.map(key));
  const additions = next.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return additions.length > 0 ? [...current, ...additions] : current;
}

function HistoricalPlaceWritePanel({ place, names, projectId, documents, onSaved, onReload }: { place: PlaceSummary; names: PlaceName[]; projectId: string; documents: HistoricalPlaceDocumentOption[]; onSaved: () => void; onReload: () => void }) {
  const [canonicalName, setCanonicalName] = useState(place.canonicalName);
  const [modernName, setModernName] = useState(place.modernName);
  const [placeType, setPlaceType] = useState(place.placeType || "settlement");
  const [description, setDescription] = useState(place.description);
  const [latitude, setLatitude] = useState(place.latitude?.toString() ?? "");
  const [longitude, setLongitude] = useState(place.longitude?.toString() ?? "");
  const [nameText, setNameText] = useState("");
  const [nameNormalized, setNameNormalized] = useState("");
  const [nameLanguage, setNameLanguage] = useState("uk");
  const [nameType, setNameType] = useState<PlaceNameType>("historical");
  const [nameValidFrom, setNameValidFrom] = useState("");
  const [nameValidTo, setNameValidTo] = useState("");
  const [nameValidFromText, setNameValidFromText] = useState("");
  const [nameValidToText, setNameValidToText] = useState("");
  const [namePrecision, setNamePrecision] = useState<PlaceNameDatePrecision>("unknown");
  const [nameSourceDocumentId, setNameSourceDocumentId] = useState("");
  const [nameSourceReference, setNameSourceReference] = useState("");
  const [nameConfidence, setNameConfidence] = useState("80");
  const [namePrimary, setNamePrimary] = useState(false);
  const [nameNote, setNameNote] = useState("");
  const [editingNameId, setEditingNameId] = useState("");
  const [relationKind, setRelationKind] = useState<"hierarchy" | "parish" | "related">("hierarchy");
  const [relationType, setRelationType] = useState("administrative_parent");
  const [relatedPlace, setRelatedPlace] = useState<HistoricalPlaceFieldValue>({ placeId: null, place: null, originalText: "" });
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [relationValidFromText, setRelationValidFromText] = useState("");
  const [relationValidToText, setRelationValidToText] = useState("");
  const [relationDatePrecision, setRelationDatePrecision] = useState<PlaceNameDatePrecision>("unknown");
  const [relationSourceDocumentId, setRelationSourceDocumentId] = useState("");
  const [religion, setReligion] = useState("");
  const [relationOriginal, setRelationOriginal] = useState("");
  const [relationSource, setRelationSource] = useState("");
  const [relationConfidence, setRelationConfidence] = useState("80");
  const [relationNote, setRelationNote] = useState("");
  const [status, setStatus] = useState<PlaceStatus>(place.status);
  const [verificationStatus, setVerificationStatus] = useState<PlaceVerificationStatus>(place.verificationStatus);
  const [wikidataId, setWikidataId] = useState(place.wikidataId ?? "");
  const [geonamesId, setGeonamesId] = useState(place.geonamesId ?? "");
  const [externalIdsText, setExternalIdsText] = useState(JSON.stringify(additionalExternalIds(place.externalIds), null, 2));
  const [archiveType, setArchiveType] = useState<HistoricalArchiveResource["resourceType"]>("archive");
  const [archiveTitle, setArchiveTitle] = useState("");
  const [archiveName, setArchiveName] = useState("");
  const [archiveFund, setArchiveFund] = useState("");
  const [archiveInventory, setArchiveInventory] = useState("");
  const [archiveFile, setArchiveFile] = useState("");
  const [archiveCatalogue, setArchiveCatalogue] = useState("");
  const [archiveUrl, setArchiveUrl] = useState("");
  const [archiveDescription, setArchiveDescription] = useState("");
  const [archiveSource, setArchiveSource] = useState("");
  const [archiveOriginal, setArchiveOriginal] = useState("");
  const [archiveValidFrom, setArchiveValidFrom] = useState("");
  const [archiveValidTo, setArchiveValidTo] = useState("");
  const [archiveValidFromText, setArchiveValidFromText] = useState("");
  const [archiveValidToText, setArchiveValidToText] = useState("");
  const [archiveDatePrecision, setArchiveDatePrecision] = useState<PlaceNameDatePrecision>("unknown");
  const [archiveSourceDocumentId, setArchiveSourceDocumentId] = useState("");
  const [archiveConfidence, setArchiveConfidence] = useState("80");
  const [archiveNote, setArchiveNote] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [documentOriginal, setDocumentOriginal] = useState("");
  const [boundaryType, setBoundaryType] = useState("historical_boundary");
  const [boundaryGeojson, setBoundaryGeojson] = useState("");
  const [boundaryValidFrom, setBoundaryValidFrom] = useState("");
  const [boundaryValidTo, setBoundaryValidTo] = useState("");
  const [boundaryValidFromText, setBoundaryValidFromText] = useState("");
  const [boundaryValidToText, setBoundaryValidToText] = useState("");
  const [boundaryDatePrecision, setBoundaryDatePrecision] = useState<PlaceNameDatePrecision>("unknown");
  const [boundarySourceDocumentId, setBoundarySourceDocumentId] = useState("");
  const [boundarySource, setBoundarySource] = useState("");
  const [boundaryOriginal, setBoundaryOriginal] = useState("");
  const [boundaryConfidence, setBoundaryConfidence] = useState("70");
  const [boundaryNote, setBoundaryNote] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [needsReload, setNeedsReload] = useState(false);

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (needsReload) return;
    setBusy(key); setMessage("");
    try { await action(); setNeedsReload(false); setMessage("Зміни збережено."); onSaved(); }
    catch (cause) {
      setNeedsReload(cause instanceof HistoricalPlacesServiceError && cause.code === "40001");
      setMessage(errorMessage(cause));
    }
    finally { setBusy(""); }
  };
  const dateError = validFrom && validTo && validFrom > validTo ? "Дата початку не може бути пізнішою за дату завершення." : "";
  const nameDateError = dateRangeError(nameValidFrom, nameValidTo);
  const boundaryDateError = dateRangeError(boundaryValidFrom, boundaryValidTo);
  const archiveDateError = dateRangeError(archiveValidFrom, archiveValidTo);
  const coordinateError = validateCoordinates(latitude, longitude);
  const externalIdsResult = parseExternalIdsInput(externalIdsText);
  const boundaryResult = parseGeojsonInput(boundaryGeojson);
  const editingName = names.find((item) => item.id === editingNameId);

  return <section className="panel historical-place-write" aria-labelledby="historical-place-edit-title">
    <h2 id="historical-place-edit-title">Редагування приватного місця</h2>
    <p className="field-hint">Зміни захищені версією запису. Якщо місце вже змінив інший користувач, сервер попросить оновити профіль.</p>
    {message ? (
      <div className={`${message === "Зміни збережено." ? "historical-place-success" : "historical-place-error"}${needsReload ? " historical-place-conflict" : ""}`} role={needsReload ? "alert" : "status"}>
        <span>{message}</span>
        {needsReload ? <button type="button" className="button button-secondary" onClick={onReload}>Оновити дані</button> : null}
      </div>
    ) : null}
    <form className="historical-place-write-grid" onSubmit={(event) => { event.preventDefault(); if (coordinateError || externalIdsResult.error) return; void run("place", () => patchHistoricalPlace({ placeId: place.id, expectedLockVersion: place.lockVersion, patch: { canonicalName, modernName, placeType, description, latitude: latitude.trim() ? Number(latitude.trim()) : null, longitude: longitude.trim() ? Number(longitude.trim()) : null, status, verificationStatus, wikidataId: wikidataId.trim() || null, geonamesId: geonamesId.trim() || null, externalIds: externalIdsResult.value } })); }}>
      <label><span>Основна назва</span><input required value={canonicalName} onChange={(e) => setCanonicalName(e.target.value)} /></label>
      <label><span>Сучасна назва</span><input value={modernName} onChange={(e) => setModernName(e.target.value)} /></label>
      <label><span>Тип місця</span><select value={placeType} onChange={(e) => setPlaceType(e.target.value)}>{PLACE_TYPE_OPTIONS.map((value) => <option value={value} key={value}>{historicalPlaceTypeLabel(value)}</option>)}</select></label>
      <label><span>Статус</span><select value={status} onChange={(e) => setStatus(e.target.value as PlaceStatus)}><option value="active">Активне</option><option value="needs_review">Потребує перевірки</option><option value="archived">Архівне</option></select></label>
      <label><span>Стан перевірки</span><select value={verificationStatus} onChange={(e) => setVerificationStatus(e.target.value as PlaceVerificationStatus)}><option value="unverified">Не перевірено</option><option value="plausible">Ймовірне</option><option value="verified">Перевірено</option><option value="disputed">Спірне</option></select></label>
      <label><span>Широта</span><input inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} /></label>
      <label><span>Довгота</span><input inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} /></label>
      <label><span>Wikidata ID</span><input value={wikidataId} onChange={(e) => setWikidataId(e.target.value)} /></label>
      <label><span>GeoNames ID</span><input value={geonamesId} onChange={(e) => setGeonamesId(e.target.value)} /></label>
      <label className="wide"><span>Інші зовнішні ID (JSON)</span><textarea rows={3} value={externalIdsText} onChange={(e) => setExternalIdsText(e.target.value)} /></label>
      <label className="wide"><span>Опис</span><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      {coordinateError || externalIdsResult.error ? <div className="historical-place-error wide" role="alert">{coordinateError || externalIdsResult.error}</div> : null}
      <button className="button button-primary" disabled={busy !== "" || needsReload || Boolean(coordinateError || externalIdsResult.error) || !canonicalName.trim()}>Зберегти профіль</button>
    </form>

    <details><summary>Історична назва</summary><form className="historical-place-write-grid" onSubmit={(event) => { event.preventDefault(); if (nameDateError) return; void run("name", async () => { const payload = { name: nameNormalized || editingName?.name || nameText, languageCode: nameLanguage, nameType, validFrom: nameValidFrom || null, validTo: nameValidTo || null, validFromText: nameValidFromText || null, validToText: nameValidToText || null, validFromPrecision: namePrecision, validToPrecision: namePrecision, datePrecision: namePrecision, sourceDocumentId: nameSourceDocumentId || null, sourceReference: nameSourceReference || null, confidence: clampConfidence(nameConfidence), isPrimary: namePrimary, note: nameNote }; if (editingName) await updateHistoricalPlaceName({ nameId: editingName.id, expectedLockVersion: editingName.lockVersion, patch: payload }); else await addHistoricalPlaceName({ placeId: place.id, originalText: nameText, ...payload }); setNameText(""); setNameNormalized(""); setEditingNameId(""); setNameNote(""); }); }}>
      <label><span>Редагувати наявну</span><select value={editingNameId} onChange={(e) => { const item = names.find((name) => name.id === e.target.value); setEditingNameId(e.target.value); setNameText(item?.originalText ?? ""); setNameNormalized(item?.name ?? ""); setNameLanguage(item?.languageCode ?? "uk"); setNameType(item?.nameType ?? "historical"); setNameValidFrom(item?.validFrom ?? ""); setNameValidTo(item?.validTo ?? ""); setNameValidFromText(item?.validFromText ?? ""); setNameValidToText(item?.validToText ?? ""); setNamePrecision(item?.datePrecision ?? "unknown"); setNameSourceDocumentId(item?.sourceDocumentId ?? ""); setNameSourceReference(item?.sourceReference ?? ""); setNameConfidence(String(item?.confidence ?? 80)); setNamePrimary(item?.isPrimary ?? false); setNameNote(item?.note ?? ""); }}><option value="">Додати нову</option>{names.map((name) => <option key={name.id} value={name.id}>{name.originalText}</option>)}</select></label>
      <label><span>Точний текст із джерела</span><input required readOnly={Boolean(editingName)} value={nameText} onChange={(e) => setNameText(e.target.value)} /><small className="field-hint">Після створення це поле незмінне.</small></label>
      <label><span>Нормалізована назва</span><input required value={nameNormalized} onChange={(e) => setNameNormalized(e.target.value)} /></label>
      <label><span>Мова</span><select value={nameLanguage} onChange={(e) => setNameLanguage(e.target.value)}>{LANGUAGE_OPTIONS.map(([value, label]) => <option key={value || "unknown"} value={value}>{label}</option>)}</select></label>
      <label><span>Тип назви</span><select value={nameType} onChange={(e) => setNameType(e.target.value as PlaceNameType)}>{NAME_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>Від</span><input type="date" value={nameValidFrom} onChange={(e) => setNameValidFrom(e.target.value)} /></label><label><span>До</span><input type="date" value={nameValidTo} onChange={(e) => setNameValidTo(e.target.value)} /></label>
      <label><span>Текст дати від</span><input placeholder="близько 1862" value={nameValidFromText} onChange={(e) => setNameValidFromText(e.target.value)} /></label><label><span>Текст дати до</span><input value={nameValidToText} onChange={(e) => setNameValidToText(e.target.value)} /></label>
      <label><span>Точність дат</span><select value={namePrecision} onChange={(e) => setNamePrecision(e.target.value as PlaceNameDatePrecision)}>{DATE_PRECISION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>Документ-джерело</span><select value={nameSourceDocumentId} onChange={(e) => setNameSourceDocumentId(e.target.value)}><option value="">Не прив’язано</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>
      <label className="wide"><span>Джерело / цитата</span><input value={nameSourceReference} onChange={(e) => setNameSourceReference(e.target.value)} /></label>
      <label><span>Достовірність, %</span><input type="number" min="0" max="100" value={nameConfidence} onChange={(e) => setNameConfidence(e.target.value)} /></label>
      <label className="checkbox-field"><input type="checkbox" checked={namePrimary} onChange={(e) => setNamePrimary(e.target.checked)} /><span>Основна назва для цього періоду</span></label>
      <label className="wide"><span>Примітка</span><textarea rows={2} value={nameNote} onChange={(e) => setNameNote(e.target.value)} /></label>
      {nameDateError ? <div className="historical-place-error wide" role="alert">{nameDateError}</div> : null}
      <button className="button button-primary" disabled={busy !== "" || needsReload || Boolean(nameDateError) || !nameText.trim() || !nameNormalized.trim()}>{editingName ? "Оновити назву" : "Додати назву"}</button>
    </form></details>

    <details><summary>Адміністративний, парафіяльний або інший зв’язок</summary><form className="historical-place-write-grid" onSubmit={(event) => { event.preventDefault(); if (!relatedPlace.placeId || dateError || (relationKind !== "hierarchy" && !relationOriginal.trim())) return; const input = { placeId: place.id, relatedPlaceId: relatedPlace.placeId, relationType, religion, originalText: relationOriginal || relatedPlace.originalText, sourceReference: relationSource, sourceDocumentId: relationSourceDocumentId || null, confidence: clampConfidence(relationConfidence), note: relationNote, validFrom: validFrom || null, validTo: validTo || null, validFromText: relationValidFromText || null, validToText: relationValidToText || null, validFromPrecision: relationDatePrecision, validToPrecision: relationDatePrecision }; void run("relation", () => relationKind === "hierarchy" ? addHistoricalPlaceHierarchy(input) : relationKind === "parish" ? addHistoricalPlaceParish(input) : addHistoricalPlaceRelated(input)); }}>
      <label><span>Група зв’язку</span><select value={relationKind} onChange={(e) => { const next = e.target.value as "hierarchy" | "parish" | "related"; setRelationKind(next); setRelationType(next === "hierarchy" ? "administrative_parent" : next === "parish" ? "belongs_to_parish" : "related"); }}><option value="hierarchy">Адміністративна належність</option><option value="parish">Парафія</option><option value="related">Пов’язане місце</option></select></label>
      <label><span>Тип зв’язку</span><select value={relationType} onChange={(e) => setRelationType(e.target.value)}>{relationKind === "hierarchy" ? <><option value="administrative_parent">Адміністративний центр</option><option value="part_of">Є частиною</option></> : relationKind === "parish" ? <><option value="belongs_to_parish">Належить до парафії</option><option value="served_by">Обслуговується парафією</option></> : <><option value="related">Пов’язане</option><option value="neighboring">Сусіднє</option><option value="predecessor">Попередник</option><option value="successor">Наступник</option><option value="contains">Містить</option><option value="part_of">Є частиною</option></>}</select></label>
      <div className="wide"><HistoricalPlaceField value={relatedPlace} onChange={(value) => { setRelatedPlace(value); setRelationOriginal(value.originalText); }} projectId={projectId} label={relationKind === "parish" ? "Парафія" : relationKind === "hierarchy" ? "Адміністративний центр" : "Пов’язане місце"} /></div>
      {relationKind === "parish" ? <label><span>Віросповідання</span><input value={religion} onChange={(e) => setReligion(e.target.value)} /></label> : null}
      <label><span>Від</span><input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></label><label><span>До</span><input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} /></label>
      <label><span>Текст дати від</span><input placeholder="близько 1862" value={relationValidFromText} onChange={(e) => setRelationValidFromText(e.target.value)} /></label><label><span>Текст дати до</span><input value={relationValidToText} onChange={(e) => setRelationValidToText(e.target.value)} /></label>
      <label><span>Точність дат</span><select value={relationDatePrecision} onChange={(e) => setRelationDatePrecision(e.target.value as PlaceNameDatePrecision)}>{DATE_PRECISION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>Документ-джерело</span><select value={relationSourceDocumentId} onChange={(e) => setRelationSourceDocumentId(e.target.value)}><option value="">Не прив’язано</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>
      <label><span>Достовірність, %</span><input type="number" min="0" max="100" value={relationConfidence} onChange={(e) => setRelationConfidence(e.target.value)} /></label>
      {relationKind !== "hierarchy" ? <label className="wide"><span>Точний текст у джерелі</span><input required value={relationOriginal} onChange={(e) => setRelationOriginal(e.target.value)} placeholder={relatedPlace.originalText || "Написання або опис зв’язку в джерелі"} /></label> : null}
      <label className="wide"><span>Джерело / цитата</span><input value={relationSource} onChange={(e) => setRelationSource(e.target.value)} /></label>
      <label className="wide"><span>Примітка</span><textarea rows={2} value={relationNote} onChange={(e) => setRelationNote(e.target.value)} /></label>
      {dateError ? <div className="historical-place-error wide" role="alert">{dateError}</div> : null}<button className="button button-primary" disabled={busy !== "" || needsReload || !relatedPlace.placeId || (relationKind !== "hierarchy" && !relationOriginal.trim()) || Boolean(dateError)}>Додати зв’язок</button>
    </form></details>

    <details><summary>Архівний ресурс</summary><form className="historical-place-write-grid" onSubmit={(event) => { event.preventDefault(); if (archiveDateError) return; void run("archive", async () => { await createAndLinkHistoricalPlaceArchive(place.id, { projectId, resourceType: archiveType, title: archiveTitle, archiveName, fund: archiveFund, inventory: archiveInventory, fileReference: archiveFile, catalogueReference: archiveCatalogue, url: archiveUrl || null, description: archiveDescription, sourceReference: archiveSource || null, originalText: archiveOriginal }, { originalText: archiveOriginal, sourceReference: archiveSource, sourceDocumentId: archiveSourceDocumentId || null, validFrom: archiveValidFrom || null, validTo: archiveValidTo || null, validFromText: archiveValidFromText || null, validToText: archiveValidToText || null, validFromPrecision: archiveDatePrecision, validToPrecision: archiveDatePrecision, confidence: clampConfidence(archiveConfidence), note: archiveNote }); setArchiveTitle(""); setArchiveOriginal(""); }); }}>
      <label><span>Тип ресурсу</span><select value={archiveType} onChange={(e) => setArchiveType(e.target.value as HistoricalArchiveResource["resourceType"])}><option value="archive">Архів</option><option value="fund">Фонд</option><option value="inventory">Опис</option><option value="file">Справа</option><option value="catalogue">Каталог</option><option value="external_resource">Зовнішній ресурс</option></select></label>
      <label><span>Назва ресурсу</span><input required value={archiveTitle} onChange={(e) => setArchiveTitle(e.target.value)} /></label><label><span>Архів</span><input value={archiveName} onChange={(e) => setArchiveName(e.target.value)} /></label>
      <label><span>Фонд</span><input value={archiveFund} onChange={(e) => setArchiveFund(e.target.value)} /></label><label><span>Опис</span><input value={archiveInventory} onChange={(e) => setArchiveInventory(e.target.value)} /></label><label><span>Справа</span><input value={archiveFile} onChange={(e) => setArchiveFile(e.target.value)} /></label><label><span>Каталожний шифр</span><input value={archiveCatalogue} onChange={(e) => setArchiveCatalogue(e.target.value)} /></label>
      <label className="wide"><span>URL</span><input type="url" value={archiveUrl} onChange={(e) => setArchiveUrl(e.target.value)} /></label><label className="wide"><span>Опис ресурсу</span><textarea rows={2} value={archiveDescription} onChange={(e) => setArchiveDescription(e.target.value)} /></label>
      <label><span>Від</span><input type="date" value={archiveValidFrom} onChange={(e) => setArchiveValidFrom(e.target.value)} /></label><label><span>До</span><input type="date" value={archiveValidTo} onChange={(e) => setArchiveValidTo(e.target.value)} /></label><label><span>Достовірність, %</span><input type="number" min="0" max="100" value={archiveConfidence} onChange={(e) => setArchiveConfidence(e.target.value)} /></label>
      <label><span>Текст дати від</span><input value={archiveValidFromText} onChange={(e) => setArchiveValidFromText(e.target.value)} /></label><label><span>Текст дати до</span><input value={archiveValidToText} onChange={(e) => setArchiveValidToText(e.target.value)} /></label><label><span>Точність дат</span><select value={archiveDatePrecision} onChange={(e) => setArchiveDatePrecision(e.target.value as PlaceNameDatePrecision)}>{DATE_PRECISION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>Документ-джерело</span><select value={archiveSourceDocumentId} onChange={(e) => setArchiveSourceDocumentId(e.target.value)}><option value="">Не прив’язано</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>
      <label className="wide"><span>Джерело / цитата</span><input value={archiveSource} onChange={(e) => setArchiveSource(e.target.value)} /></label><label className="wide"><span>Точний текст у джерелі</span><input required value={archiveOriginal} onChange={(e) => setArchiveOriginal(e.target.value)} /></label><label className="wide"><span>Примітка</span><textarea rows={2} value={archiveNote} onChange={(e) => setArchiveNote(e.target.value)} /></label>
      {archiveDateError ? <div className="historical-place-error wide" role="alert">{archiveDateError}</div> : null}<button className="button button-primary" disabled={busy !== "" || needsReload || !archiveTitle.trim() || !archiveOriginal.trim() || Boolean(archiveDateError)}>Створити й прив’язати</button>
    </form></details>

    <details><summary>Історична межа</summary><form className="historical-place-write-grid" onSubmit={(event) => { event.preventDefault(); if (boundaryResult.error || boundaryDateError) return; void run("boundary", async () => { await addHistoricalPlaceBoundary({ placeId: place.id, boundaryType, geometryGeojson: boundaryResult.value, validFrom: boundaryValidFrom || null, validTo: boundaryValidTo || null, validFromText: boundaryValidFromText || null, validToText: boundaryValidToText || null, validFromPrecision: boundaryDatePrecision, validToPrecision: boundaryDatePrecision, sourceDocumentId: boundarySourceDocumentId || null, sourceReference: boundarySource, originalText: boundaryOriginal, confidence: clampConfidence(boundaryConfidence), note: boundaryNote }); setBoundaryGeojson(""); setBoundaryOriginal(""); }); }}>
      <label><span>Тип межі</span><select value={boundaryType} onChange={(e) => setBoundaryType(e.target.value)}><option value="historical_boundary">Історична межа</option><option value="administrative_boundary">Адміністративна межа</option><option value="parish_boundary">Межа парафії</option><option value="estate_boundary">Межа маєтку</option></select></label>
      <label><span>Достовірність, %</span><input type="number" min="0" max="100" value={boundaryConfidence} onChange={(e) => setBoundaryConfidence(e.target.value)} /></label>
      <label><span>Від</span><input type="date" value={boundaryValidFrom} onChange={(e) => setBoundaryValidFrom(e.target.value)} /></label><label><span>До</span><input type="date" value={boundaryValidTo} onChange={(e) => setBoundaryValidTo(e.target.value)} /></label>
      <label><span>Текст дати від</span><input value={boundaryValidFromText} onChange={(e) => setBoundaryValidFromText(e.target.value)} /></label><label><span>Текст дати до</span><input value={boundaryValidToText} onChange={(e) => setBoundaryValidToText(e.target.value)} /></label><label><span>Точність дат</span><select value={boundaryDatePrecision} onChange={(e) => setBoundaryDatePrecision(e.target.value as PlaceNameDatePrecision)}>{DATE_PRECISION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>Документ-джерело</span><select value={boundarySourceDocumentId} onChange={(e) => setBoundarySourceDocumentId(e.target.value)}><option value="">Не прив’язано</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>
      <label className="wide"><span>GeoJSON Polygon або MultiPolygon</span><textarea rows={8} required value={boundaryGeojson} onChange={(e) => setBoundaryGeojson(e.target.value)} placeholder={'{"type":"Polygon","coordinates":[...]}'}/><small className="field-hint">Координати GeoJSON задаються у порядку довгота, широта (WGS84 / EPSG:4326).</small></label>
      <label className="wide"><span>Походження / точний опис межі</span><input required value={boundaryOriginal} onChange={(e) => setBoundaryOriginal(e.target.value)} /></label><label className="wide"><span>Джерело / цитата</span><input value={boundarySource} onChange={(e) => setBoundarySource(e.target.value)} /></label><label className="wide"><span>Примітка</span><textarea rows={2} value={boundaryNote} onChange={(e) => setBoundaryNote(e.target.value)} /></label>
      {boundaryResult.error || boundaryDateError ? <div className="historical-place-error wide" role="alert">{boundaryResult.error || boundaryDateError}</div> : null}<button className="button button-primary" disabled={busy !== "" || needsReload || !boundaryGeojson.trim() || !boundaryOriginal.trim() || Boolean(boundaryResult.error || boundaryDateError)}>Додати межу</button>
    </form></details>

    <details><summary>Документ</summary><form className="historical-place-write-grid" onSubmit={(event) => { event.preventDefault(); void run("document", () => addHistoricalDocumentPlaceLink({ documentId, placeId: place.id, originalText: documentOriginal })); }}>
      <label><span>Документ проєкту</span><select required value={documentId} onChange={(e) => setDocumentId(e.target.value)}><option value="">Оберіть документ</option>{documents.map((document) => <option key={document.id} value={document.id}>{document.title}</option>)}</select></label>
      <label className="wide"><span>Точний текст місця в документі</span><input required value={documentOriginal} onChange={(e) => setDocumentOriginal(e.target.value)} /></label><button className="button button-primary" disabled={busy !== "" || needsReload || !documentId}>Прив’язати документ</button>
    </form></details>
  </section>;
}

function PlaceAudit({ items }: { items: HistoricalPlaceAuditEntry[] }) {
  if (!items.length) return <EmptyPlaceTab text="Історія змін поки порожня." />;
  return <section className="panel historical-place-timeline historical-place-audit">{items.map((item) => {
    const changes = auditChanges(item.before, item.after);
    return <article key={item.id}><div className="historical-place-period">{formatAuditDate(item.createdAt)}</div><div><h3>{auditActionLabel(item.action)}</h3><small>{readableCode(item.entityTable)} · {item.actorId ? `користувач ${item.actorId}` : "системна дія"}</small>{changes.length ? <dl>{changes.map((change) => <div key={change.key}><dt>{readableCode(change.key)}</dt><dd><span>{formatAuditValue(change.before)}</span><b aria-hidden="true">→</b><span>{formatAuditValue(change.after)}</span></dd></div>)}</dl> : <p>Деталізація «було / стало» для цього запису відсутня.</p>}</div></article>;
  })}</section>;
}

export function validateCoordinates(latitude: string, longitude: string): string {
  if (Boolean(latitude.trim()) !== Boolean(longitude.trim())) return "Широту й довготу потрібно вказувати разом.";
  if (!latitude.trim()) return "";
  const lat = Number(latitude); const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "Координати мають бути числами.";
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return "Координати виходять за допустимі межі.";
  return "";
}

function validateCoordinateSearch(latitude: string, longitude: string, radiusKm: string): string {
  const supplied = [latitude, longitude, radiusKm].filter((value) => value.trim()).length;
  if (supplied === 0) return "";
  if (supplied < 3) return "Для пошуку поруч вкажіть широту, довготу та радіус.";
  const coordinatesError = validateCoordinates(latitude, longitude);
  if (coordinatesError) return coordinatesError;
  const radius = Number(radiusKm);
  return Number.isFinite(radius) && radius >= 0.01 && radius <= 500
    ? ""
    : "Радіус пошуку має бути від 0,01 до 500 км.";
}

function formatAuditDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("uk-UA"); }
function auditActionLabel(value: string) { return ({ insert: "Створено", update: "Оновлено", merge: "Об’єднано" } as Record<string, string>)[value] ?? readableCode(value); }

function EmptyPlaceTab({ text }: { text: string }) {
  return <section className="panel empty-state"><strong>{text}</strong></section>;
}

const MERGE_EVIDENCE_PAGE_SIZE = 250;

async function hydrateHistoricalPlaceMergePreview(
  preview: HistoricalPlaceMergePreview,
): Promise<{ preview: HistoricalPlaceMergePreview; issues: string[] }> {
  const [source, target] = await Promise.all([
    hydrateHistoricalPlaceMergeSnapshot(preview.source, "місця-дубля"),
    hydrateHistoricalPlaceMergeSnapshot(preview.target, "основного місця"),
  ]);
  return {
    preview: { ...preview, source: source.snapshot, target: target.snapshot },
    issues: [...source.issues, ...target.issues],
  };
}

function mergeReviewSignature(preview: HistoricalPlaceMergePreview): string {
  const snapshotSignature = (snapshot: HistoricalPlaceMergeSnapshot) => {
    const adminNodes = snapshot.adminContext
      ? [
          ...snapshot.adminContext.currentHierarchy.hierarchy,
          ...snapshot.adminContext.ancestors,
          ...snapshot.adminContext.history.flatMap((entry) => entry.hierarchy),
        ]
      : [];
    return {
      placeId: snapshot.place.id,
      lockVersion: snapshot.place.lockVersion,
      counts: Object.entries(snapshot.counts).sort(([left], [right]) => left.localeCompare(right)),
      nameIds: sortedMergeReviewIds(snapshot.names.map((name) => name.id)),
      personIds: sortedMergeReviewIds(snapshot.people.map((person) => person.personId)),
      documentLinkIds: sortedMergeReviewIds(snapshot.documents.map((document) => document.linkId)),
      documentIds: sortedMergeReviewIds(snapshot.documents.map((document) => document.documentId)),
      hierarchyRelationIds: sortedMergeReviewIds(snapshot.hierarchy?.map((node) => node.relationId) ?? []),
      hierarchyPlaceIds: sortedMergeReviewIds(snapshot.hierarchy?.map((node) => node.place.id) ?? []),
      adminRelationIds: sortedMergeReviewIds([
        ...adminNodes.map((node) => node.relationId),
        ...(snapshot.adminContext?.history.map((entry) => entry.id) ?? []),
      ]),
      adminPlaceIds: sortedMergeReviewIds(adminNodes.map((node) => node.place.id)),
    };
  };
  return JSON.stringify([
    snapshotSignature(preview.source),
    snapshotSignature(preview.target),
    preview.canMerge,
    preview.requiresChangeRequest,
  ]);
}

function sortedMergeReviewIds(values: readonly (string | null | undefined)[]): string[] {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => left.localeCompare(right));
}

async function hydrateHistoricalPlaceMergeSnapshot(
  snapshot: HistoricalPlaceMergeSnapshot,
  label: string,
): Promise<{ snapshot: HistoricalPlaceMergeSnapshot; issues: string[] }> {
  const results = await Promise.allSettled([
    listHistoricalPlaceNames(snapshot.place.id),
    listAllMergeEvidencePages(
      snapshot.counts.visiblePeople,
      (limit, offset) => listHistoricalPlacePeople(snapshot.place.id, limit, offset),
      (person) => person.personId,
    ),
    listAllMergeEvidencePages(
      snapshot.counts.visibleDocuments,
      (limit, offset) => listHistoricalPlaceDocuments(snapshot.place.id, limit, offset),
      (document) => document.linkId,
    ),
  ] as const);
  const issues: string[] = [];
  const names = results[0].status === "fulfilled" ? results[0].value : snapshot.names;
  const people = results[1].status === "fulfilled" ? results[1].value : snapshot.people;
  const documents = results[2].status === "fulfilled" ? results[2].value : snapshot.documents;

  if (results[0].status === "rejected") issues.push(`Не вдалося завантажити всі назви ${label}.`);
  if (results[1].status === "rejected") issues.push(`Не вдалося завантажити всіх пов’язаних людей ${label}.`);
  if (results[2].status === "rejected") issues.push(`Не вдалося завантажити всі документи ${label}.`);
  if (names.length !== snapshot.counts.names) {
    issues.push(`Кількість назв ${label} змінилася: у preview ${snapshot.counts.names}, доступно ${names.length}.`);
  }
  if (people.length !== snapshot.counts.visiblePeople) {
    issues.push(`Кількість людей ${label} змінилася: у preview ${snapshot.counts.visiblePeople}, доступно ${people.length}.`);
  }
  if (documents.length !== snapshot.counts.visibleDocuments) {
    issues.push(`Кількість документів ${label} змінилася: у preview ${snapshot.counts.visibleDocuments}, доступно ${documents.length}.`);
  }
  return {
    snapshot: { ...snapshot, names, people, documents },
    issues,
  };
}

async function listAllMergeEvidencePages<T>(
  expectedCount: number,
  loadPage: (limit: number, offset: number) => Promise<T[]>,
  key: (item: T) => string,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += MERGE_EVIDENCE_PAGE_SIZE) {
    const page = await loadPage(MERGE_EVIDENCE_PAGE_SIZE, offset);
    let added = 0;
    for (const item of page) {
      const itemKey = key(item);
      if (seen.has(itemKey)) continue;
      seen.add(itemKey);
      items.push(item);
      added += 1;
    }
    if (page.length < MERGE_EVIDENCE_PAGE_SIZE || added === 0 || items.length > expectedCount) break;
  }
  return items;
}

function HistoricalPlaceMergePanel({
  source,
  projectId,
  onCancel,
  onMerged,
}: {
  source: PlaceSummary;
  projectId: string;
  onCancel: () => void;
  onMerged: (targetPlaceId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<PlaceSummary[]>([]);
  const [target, setTarget] = useState<PlaceSummary | null>(null);
  const [preview, setPreview] = useState<HistoricalPlaceMergePreview | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState("");
  const [evidenceIssues, setEvidenceIssues] = useState<string[]>([]);
  const [reviewNotice, setReviewNotice] = useState("");
  const previewRequestRef = useRef(0);

  useEffect(() => {
    if (target || query.trim().length < 2) {
      setCandidates([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchHistoricalPlaces({ query, projectId, limit: 20 }, controller.signal)
        .then((items) => setCandidates(items.filter((item) =>
          item.id !== source.id
          && item.scope === "project"
          && item.projectId === source.projectId
          && !["merged", "archived"].includes(item.status)
        )))
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(cause));
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, query, source.id, source.projectId, target]);

  const chooseTarget = (place: PlaceSummary) => {
    const requestId = ++previewRequestRef.current;
    setTarget(place);
    setQuery(place.displayName);
    setCandidates([]);
    setPreview(null);
    setConfirmed(false);
    setError("");
    setEvidenceIssues([]);
    setReviewNotice("");
    setLoading(true);
    void previewHistoricalPlaceMerge(source.id, place.id)
      .then(async (value) => {
        const hydrated = await hydrateHistoricalPlaceMergePreview(value);
        if (previewRequestRef.current === requestId) {
          setPreview(hydrated.preview);
          setEvidenceIssues(hydrated.issues);
        }
      })
      .catch((cause: unknown) => {
        if (previewRequestRef.current === requestId) setError(errorMessage(cause));
      })
      .finally(() => {
        if (previewRequestRef.current === requestId) setLoading(false);
      });
  };

  const confirmMerge = async () => {
    if (!preview?.canMerge || evidenceIssues.length > 0 || !confirmed || merging) return;
    const requestId = ++previewRequestRef.current;
    setMerging(true);
    setError("");
    setReviewNotice("");
    try {
      const freshRawPreview = await previewHistoricalPlaceMerge(
        preview.source.place.id,
        preview.target.place.id,
      );
      const fresh = await hydrateHistoricalPlaceMergePreview(freshRawPreview);
      if (previewRequestRef.current !== requestId) return;
      setPreview(fresh.preview);
      setEvidenceIssues(fresh.issues);
      if (fresh.issues.length > 0) {
        setConfirmed(false);
        return;
      }
      if (mergeReviewSignature(fresh.preview) !== mergeReviewSignature(preview)) {
        setConfirmed(false);
        setReviewNotice("Дані місць змінилися після попереднього перегляду. Перевірте оновлені списки та підтвердьте об’єднання ще раз.");
        return;
      }
      const result = await mergeHistoricalPlaces({
        sourcePlaceId: fresh.preview.source.place.id,
        targetPlaceId: fresh.preview.target.place.id,
        expectedSourceLockVersion: fresh.preview.source.place.lockVersion,
        expectedTargetLockVersion: fresh.preview.target.place.lockVersion,
        reason,
      });
      if (previewRequestRef.current !== requestId) return;
      onMerged(result.targetPlaceId);
    } catch (cause: unknown) {
      setConfirmed(false);
      setPreview(null);
      setTarget(null);
      setError(errorMessage(cause));
    } finally {
      setMerging(false);
    }
  };

  return (
    <section className="panel historical-place-merge" aria-labelledby="historical-place-merge-title">
      <div className="historical-place-merge-heading">
        <div><span className="eyebrow">Безпечне об’єднання</span><h2 id="historical-place-merge-title">Знайти місце, яке залишиться</h2></div>
        <button type="button" className="button button-secondary" disabled={merging} onClick={onCancel}>Скасувати</button>
      </div>
      <label>
        <span>Цільове місце</span>
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={!target && candidates.length > 0}
          aria-controls="historical-place-merge-options"
          disabled={merging}
          value={query}
          placeholder="Введіть назву дубля"
          onChange={(event) => {
            previewRequestRef.current += 1;
            setQuery(event.target.value);
            setTarget(null);
            setPreview(null);
            setConfirmed(false);
            setEvidenceIssues([]);
            setReviewNotice("");
            setLoading(false);
          }}
        />
      </label>
      {!target && candidates.length > 0 ? (
        <div id="historical-place-merge-options" role="listbox" className="historical-place-merge-options">
          {candidates.map((item) => <button type="button" role="option" aria-selected="false" key={item.id} onClick={() => chooseTarget(item)}><strong>{item.displayName}</strong><span>{item.currentAdmin || formatCoordinates(item)}</span></button>)}
        </div>
      ) : null}
      {loading ? <p>Готуємо попередній перегляд…</p> : null}
      {error ? <div className="historical-place-error" role="alert">{error}</div> : null}
      {reviewNotice ? <div className="historical-place-merge-warning" role="status">{reviewNotice}</div> : null}
      {preview ? (
        <>
          <div className="historical-place-merge-compare">
            <MergeSnapshotCard title="Буде перенесено і приховано" snapshot={preview.source} />
            <MergeSnapshotCard title="Залишиться основним" snapshot={preview.target} />
          </div>
          <p className="historical-place-merge-warning">
            Імена, події, документи та зв’язки буде перенесено. Початкове місце стане перенаправленням на цільове.
            {sumPreservedLinks(preview) > 0 ? ` ${sumPreservedLinks(preview)} зв’язки, які стали б посиланнями на себе, сервер збереже в історії merge.` : ""}
          </p>
          {evidenceIssues.length > 0 ? (
            <div className="historical-place-error" role="alert">
              <strong>Попередній перегляд неповний, тому об’єднання заблоковано.</strong>
              <ul>{evidenceIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
              {target ? <button type="button" className="button button-secondary" disabled={loading || merging} onClick={() => chooseTarget(target)}>Оновити попередній перегляд</button> : null}
            </div>
          ) : null}
          {!preview.canMerge ? (
            <div className="historical-place-error" role="status">
              {preview.requiresChangeRequest ? "Ці місця можна об’єднати лише через запит на зміну глобального каталогу." : "Ваша роль не має права об’єднувати ці місця."}
            </div>
          ) : (
            <>
              <label>
                <span>Причина об’єднання</span>
                <textarea rows={3} maxLength={10000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Наприклад: це різні варіанти написання одного села" />
              </label>
              <label className="checkbox-field historical-place-merge-confirm">
                <input type="checkbox" checked={confirmed} disabled={evidenceIssues.length > 0} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>Підтверджую, що перевірив координати, назви, людей і документи обох місць.</span>
              </label>
              <button type="button" className="button button-primary" disabled={!confirmed || evidenceIssues.length > 0 || merging} onClick={() => void confirmMerge()}>{merging ? "Перевіряємо й об’єднуємо…" : "Підтвердити об’єднання"}</button>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

function MergeSnapshotCard({ title, snapshot }: { title: string; snapshot: HistoricalPlaceMergePreview["source"] }) {
  const counts = snapshot.counts;
  const currentHierarchy = snapshot.adminContext?.currentHierarchy.hierarchy ?? [];
  const ancestorContext = snapshot.adminContext?.ancestors ?? [];
  const hierarchyHistory = snapshot.adminContext?.history ?? [];
  return (
    <article>
      <small>{title}</small>
      <h3>{snapshot.place.displayName}</h3>
      <p>{[historicalPlaceTypeLabel(snapshot.place.placeType), snapshot.place.currentAdmin || snapshot.place.currentCountry, formatCoordinates(snapshot.place)].filter(Boolean).join(" · ")}</p>
      <dl>
        <div><dt>Назви</dt><dd>{counts.names}</dd></div>
        <div><dt>Люди</dt><dd>{counts.visiblePeople}</dd></div>
        <div><dt>Події</dt><dd>{counts.visibleEvents}</dd></div>
        <div><dt>Документи</dt><dd>{counts.visibleDocuments}</dd></div>
        <div><dt>Ієрархія</dt><dd>{counts.hierarchyAsChild + counts.hierarchyAsParent}</dd></div>
        <div><dt>Зв’язки</dt><dd>{counts.relatedIncoming + counts.relatedOutgoing + counts.parishAsParish + counts.parishAsSettlement}</dd></div>
      </dl>
      {snapshot.names.length ? <details><summary>Показати всі назви ({snapshot.names.length})</summary><ul>{snapshot.names.map((name) => <li key={name.id}>{name.originalText}{name.name !== name.originalText ? ` — ${name.name}` : ""}</li>)}</ul></details> : null}
      {currentHierarchy.length ? <p><strong>Сучасна адміністративна належність:</strong> {currentHierarchy.map((node) => node.place.displayName).join(" → ")}</p> : null}
      {!currentHierarchy.length && ancestorContext.length ? <p><strong>Адміністративний контекст:</strong> {ancestorContext.map((node) => node.place.displayName).join(" · ")}</p> : null}
      {hierarchyHistory.length ? <details><summary>Показати повну адміністративну історію ({hierarchyHistory.length})</summary><ul>{hierarchyHistory.map((entry) => <li key={entry.id}>{periodLabel(entry.validFromText || entry.validFrom, entry.validToText || entry.validTo)} — {entry.hierarchy.map((node) => node.place.displayName).join(" → ")}</li>)}</ul></details> : null}
      {!snapshot.adminContext && snapshot.hierarchy?.length ? <p><strong>Ієрархія:</strong> {snapshot.hierarchy.map((node) => node.place.displayName).join(" → ")}</p> : null}
      {snapshot.people.length ? <details><summary>Показати всіх пов’язаних людей ({snapshot.people.length})</summary><ul>{snapshot.people.map((person) => <li key={person.personId}>{person.fullName} — {person.eventTypes.map(readableCode).join(", ")}</li>)}</ul></details> : null}
      {snapshot.documents.length ? <details><summary>Показати всі документи ({snapshot.documents.length})</summary><ul>{snapshot.documents.map((document) => <li key={document.linkId}>{document.title} — {yearRange(document.yearFrom, document.yearTo)}</li>)}</ul></details> : null}
    </article>
  );
}

function HistoricalPlaceMap({
  latitude,
  longitude,
  label,
  boundaries,
  contextDocuments,
  contextEvents,
  atDate,
}: {
  latitude: number | null;
  longitude: number | null;
  label: string;
  boundaries: HistoricalPlaceBoundary[];
  contextDocuments: HistoricalPlaceDocument[];
  contextEvents: HistoricalPlaceEvent[];
  atDate: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    const map = L.map(ref.current, {
      // A draggable map traps vertical page gestures on a phone. Mobile users
      // can still use the zoom controls; desktop keeps wheel and drag control.
      dragging: !coarsePointer,
      scrollWheelZoom: !coarsePointer,
      keyboard: true,
    }).setView(latitude !== null && longitude !== null ? [latitude, longitude] : [49, 31], latitude !== null ? 11 : 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    if (latitude !== null && longitude !== null) {
      const context = [
        `<strong>${escapeHtml(label)}</strong>`,
        atDate ? `Стан на ${escapeHtml(atDate)}` : "Увесь часовий контекст",
        `${contextEvents.length} подій · ${contextDocuments.length} документів`,
      ].join("<br>");
      L.marker([latitude, longitude]).addTo(map).bindPopup(context);
    }
    const boundaryGroup = L.featureGroup();
    for (const boundary of boundaries) {
      try {
        const layer = L.geoJSON(boundary.geometryGeojson as unknown as GeoJsonObject, {
          style: {
            color: "#8a5a0a",
            fillColor: "#d6a93f",
            fillOpacity: 0.18,
            weight: 2,
          },
        }).bindPopup(`${escapeHtml(readableCode(boundary.boundaryType))}<br>${escapeHtml(periodLabel(boundary.validFromText || boundary.validFrom, boundary.validToText || boundary.validTo))}`);
        boundaryGroup.addLayer(layer);
      } catch {
        // Invalid legacy geometry must not prevent the rest of the profile map.
      }
    }
    if (boundaryGroup.getLayers().length) {
      boundaryGroup.addTo(map);
      const bounds = boundaryGroup.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 13, animate: false });
    }
    const invalidateTimer = window.setTimeout(() => {
      if (ref.current && map.getContainer().isConnected) map.invalidateSize({ animate: false });
    }, 0);
    return () => {
      window.clearTimeout(invalidateTimer);
      map.stop();
      map.off();
      map.remove();
    };
  }, [atDate, boundaries, contextDocuments.length, contextEvents.length, label, latitude, longitude]);
  return <div className="historical-place-map" ref={ref} role="region" aria-label={`Інтерактивна карта місця ${label}. На телефоні використовуйте кнопки масштабу.`} />;
}

function PlaceCardsSkeleton() {
  return <section className="historical-place-results" aria-label="Завантаження місць">{[1, 2, 3].map((id) => <div className="historical-place-card skeleton" key={id} />)}</section>;
}

function PlaceProfileSkeleton() {
  return <section className="panel historical-place-profile-skeleton"><div /><div /><div /></section>;
}

function hierarchySummary(profile: HistoricalPlaceProfile): string {
  if (profile.hierarchy.status === "resolved") {
    const path = profile.hierarchy.hierarchy.map((node) => node.place.displayName).join(" → ");
    return path || "Для цієї дати батьківську адміністративну структуру не вказано.";
  }
  return profile.hierarchy.message || "Для цієї дати адміністративну належність ще не визначено.";
}

function periodLabel(from: string | null, to: string | null): string {
  if (from && to) return `${from} — ${to}`;
  if (from) return `від ${from}`;
  if (to) return `до ${to}`;
  return "Період не вказано";
}

function relationLabel(value: string): string {
  const labels: Record<string, string> = {
    neighbouring: "Сусіднє місце",
    neighbor: "Сусіднє місце",
    predecessor: "Попередник",
    successor: "Наступник",
    contains: "Містить",
    part_of: "Є частиною",
    related: "Пов’язане місце",
  };
  return labels[value] ?? readableCode(value);
}

function archiveResourceTypeLabel(value: HistoricalArchiveResource["resourceType"]): string {
  return ({
    archive: "Архів",
    fund: "Фонд",
    inventory: "Опис",
    file: "Справа",
    catalogue: "Каталог",
    external_resource: "Зовнішній ресурс",
  })[value];
}

function yearRange(from: number | null, to: number | null): string {
  if (from !== null && to !== null) return from === to ? String(from) : `${from}–${to}`;
  if (from !== null) return `від ${from}`;
  if (to !== null) return `до ${to}`;
  return "Рік не вказано";
}

function readableCode(value: string): string {
  if (!value) return "Не вказано";
  const normalized = value.replaceAll("_", " ").replaceAll("-", " ");
  return normalized.charAt(0).toLocaleUpperCase("uk-UA") + normalized.slice(1);
}

function eventDateLabel(item: HistoricalPlaceEvent): string {
  return item.dateText || item.eventDate || periodLabel(item.dateFrom, item.dateTo);
}

function sumPreservedLinks(preview: HistoricalPlaceMergePreview): number {
  const value = preview.preservationPreview;
  return value.hierarchySelfLinks + value.genericSelfLinks + value.parishSelfLinks;
}

function placeTypeLabel(value: string): string {
  return historicalPlaceTypeLabel(value);
}

function statusLabel(value: PlaceSummary["status"]): string {
  return ({ active: "Активне", needs_review: "Потребує перевірки", merged: "Об’єднане", archived: "Архівне" })[value];
}

function verificationLabel(value: PlaceSummary["verificationStatus"]): string {
  return ({ unverified: "Не перевірено", plausible: "Ймовірне", verified: "Перевірено", disputed: "Спірне" })[value];
}

function languageLabel(value: string): string {
  return ({ uk: "українська", ru: "російська", pl: "польська", la: "латинська", be: "білоруська", de: "німецька" } as Record<string, string>)[value] ?? value;
}

function formatCoordinates(place: PlaceSummary): string {
  return place.latitude !== null && place.longitude !== null
    ? `${place.latitude.toFixed(6)}, ${place.longitude.toFixed(6)}`
    : "Не вказано";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Не вдалося виконати дію з історичним місцем.";
}

function dateRangeError(from: string, to: string): string {
  return from && to && from > to ? "Дата початку не може бути пізнішою за дату завершення." : "";
}

function datedEvidenceMatchesDate(
  item: {
    validFrom: string | null;
    validTo: string | null;
    validFromText: string | null;
    validToText: string | null;
  },
  dateOrYear: string,
): boolean {
  const context = dateOrYear.trim();
  if (!context) return true;
  const yearOnly = /^\d{1,4}$/.test(context);
  const contextYear = yearOnly ? context.padStart(4, "0") : "";
  const contextFrom = yearOnly ? `${contextYear}-01-01` : context;
  const contextTo = yearOnly ? `${contextYear}-12-31` : context;
  const itemFrom = item.validFrom || historicalDateBound(item.validFromText, "from");
  const itemTo = item.validTo || historicalDateBound(item.validToText, "to");
  return (!itemFrom || itemFrom <= contextTo) && (!itemTo || itemTo >= contextFrom);
}

function historicalDateBound(value: string | null, edge: "from" | "to"): string {
  if (!value) return "";
  const exact = value.match(/\b(\d{1,4})-(\d{2})-(\d{2})\b/);
  if (exact) return `${exact[1].padStart(4, "0")}-${exact[2]}-${exact[3]}`;
  const year = value.match(/\b(\d{3,4})\b/);
  if (!year) return "";
  return `${year[1].padStart(4, "0")}-${edge === "from" ? "01-01" : "12-31"}`;
}

function yearTemporalContext(yearInput: string) {
  const digits = yearInput.replace(/\D/g, "");
  if (!digits || digits.length > 4) return null;
  const year = digits.padStart(4, "0");
  return {
    periodFrom: `${year}-01-01`,
    periodTo: `${year}-12-31`,
    originalText: digits,
    precision: "year" as const,
  };
}

function clampConfidence(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 50;
}

function parseExternalIdsInput(input: string): { value: Record<string, string>; error: string } {
  if (!input.trim()) return { value: {}, error: "" };
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    const value = Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .map(([key, item]) => [key.trim(), typeof item === "string" ? item.trim() : String(item)] as const)
      .filter(([key, item]) => Boolean(key && item)));
    return { value, error: "" };
  } catch {
    return { value: {}, error: "Зовнішні ідентифікатори мають бути коректним JSON-об’єктом." };
  }
}

function additionalExternalIds(value: Record<string, string> | null | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(
      ([provider]) => !["wikidata", "geonames"].includes(provider.toLocaleLowerCase("uk-UA")),
    ),
  );
}

function parseGeojsonInput(input: string): { value: Record<string, unknown>; error: string } {
  if (!input.trim()) return { value: {}, error: "" };
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    const geometry = type === "Feature" && parsed.geometry && typeof parsed.geometry === "object"
      ? parsed.geometry as Record<string, unknown>
      : parsed;
    const geometryType = typeof geometry.type === "string" ? geometry.type : "";
    if (!["Polygon", "MultiPolygon"].includes(geometryType)) {
      return { value: {}, error: "Межа має бути GeoJSON Polygon, MultiPolygon або Feature з такою геометрією." };
    }
    if (!Array.isArray(geometry.coordinates)) {
      return { value: {}, error: "У GeoJSON відсутній масив coordinates." };
    }
    return { value: geometry, error: "" };
  } catch {
    return { value: {}, error: "GeoJSON містить синтаксичну помилку." };
  }
}

function documentMatchesDate(item: HistoricalPlaceDocument, atDate: string): boolean {
  if (!atDate) return true;
  const year = Number(atDate.slice(0, 4));
  if (!Number.isFinite(year)) return true;
  return (item.yearFrom === null || item.yearFrom <= year) && (item.yearTo === null || item.yearTo >= year);
}

function eventMatchesDate(item: HistoricalPlaceEvent, atDate: string): boolean {
  if (!atDate) return true;
  const yearOnly = /^\d{1,4}$/.test(atDate);
  const comparableDate = yearOnly ? atDate.padStart(4, "0") : atDate;
  if (item.eventDate) return yearOnly ? item.eventDate.startsWith(`${comparableDate}-`) : item.eventDate === atDate;
  if (item.dateFrom || item.dateTo) {
    if (yearOnly) {
      const fromYear = item.dateFrom?.slice(0, 4) ?? "0000";
      const toYear = item.dateTo?.slice(0, 4) ?? "9999";
      return comparableDate >= fromYear && comparableDate <= toYear;
    }
    return (!item.dateFrom || item.dateFrom <= atDate) && (!item.dateTo || item.dateTo >= atDate);
  }
  const requestedYear = comparableDate.slice(0, 4);
  const years = item.dateText.match(/\d{4}/g) ?? [];
  if (!years.length) return true;
  const firstYear = years[0]!;
  return requestedYear >= firstYear && requestedYear <= (years[1] ?? firstYear);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character);
}

function auditChanges(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const previous = before ?? {};
  const next = after ?? {};
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .map((key) => ({ key, before: previous[key], after: next[key] }));
}

function formatAuditValue(value: unknown): string {
  if (value === undefined) return "не було";
  if (value === null || value === "") return "порожньо";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return "складне значення"; }
}
