import type { DocumentRecord, Finding, PersonName } from "../../types";
import { personNameLanguageLabel } from "../../utils/personNameMetadataOptions";
import { displayPersonName, nameTypeLabel } from "./PersonNamesEditorV2";
import "./personNamesV2.css";

export interface PersonNamesProfileSectionV2Props {
  names: readonly PersonName[];
  loading?: boolean;
  loadError?: string;
  documents?: readonly DocumentRecord[];
  findings?: readonly Finding[];
  onOpenDocument?: (document: DocumentRecord) => void;
  onOpenFinding?: (finding: Finding) => void;
}

export function PersonNamesProfileSectionV2({
  names,
  loading = false,
  loadError = "",
  documents = [],
  findings = [],
  onOpenDocument,
  onOpenFinding,
}: PersonNamesProfileSectionV2Props) {
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
  const sortedNames = [...names].sort(comparePersonNames);

  if (loading) return <p role="status">Завантажуємо варіанти імен…</p>;
  if (loadError && !sortedNames.length) {
    return <p className="persons-v2-detail-notice is-error" role="alert">{loadError}</p>;
  }
  if (!sortedNames.length) {
    return <p>Додаткових структурованих варіантів імен ще немає.</p>;
  }

  return (
    <div className="person-names-v2-profile__list" data-person-names-profile>
      {loadError ? <p className="persons-v2-detail-notice is-error" role="alert">{loadError}</p> : null}
      {sortedNames.map((name) => {
        const genericSourceType = name.sourceType.trim().toLocaleLowerCase("uk-UA");
        const effectiveDocumentId = name.sourceDocumentId
          || (genericSourceType === "document" ? name.sourceId : null);
        const effectiveFindingId = name.sourceFindingId
          || (genericSourceType === "finding" ? name.sourceId : null);
        const document = effectiveDocumentId ? documentsById.get(effectiveDocumentId) : undefined;
        const finding = effectiveFindingId ? findingsById.get(effectiveFindingId) : undefined;
        const openSource = finding && onOpenFinding
          ? () => onOpenFinding(finding)
          : document && onOpenDocument
            ? () => onOpenDocument(document)
            : null;
        const content = (
          <>
            <span className="person-names-v2-profile__copy">
              <span className="person-names-v2__badges">
                {name.isPrimary ? <span className="status-pill">Основне</span> : null}
                <span className="status-pill">{nameTypeLabel(name.nameType)}</span>
                {name.languageCode ? <span className="status-pill">{personNameLanguageLabel(name.languageCode)}</span> : null}
              </span>
              <strong>{displayPersonName(name)}</strong>
              {name.originalText && name.originalText !== (name.fullNormalized || name.fullName) ? (
                <span className="person-names-v2__original">Оригінал: {name.originalText}</span>
              ) : null}
              <small>{sourceLabel(name, document, finding)}</small>
            </span>
            {openSource ? <span aria-hidden="true">Відкрити джерело →</span> : null}
          </>
        );
        return openSource ? (
          <button
            type="button"
            className="person-names-v2-profile__record"
            key={name.id}
            onClick={openSource}
          >
            {content}
          </button>
        ) : (
          <div className="person-names-v2-profile__record" key={name.id}>{content}</div>
        );
      })}
    </div>
  );
}

function sourceLabel(
  name: PersonName,
  document: DocumentRecord | undefined,
  finding: Finding | undefined,
): string {
  const period = name.validFrom || name.validTo
    ? `${name.validFrom || "…"} — ${name.validTo || "…"}`
    : "";
  const source = finding
    ? `Знахідка: ${finding.summary || finding.people || "без назви"}`
    : document
      ? `Документ: ${document.title || "без назви"}`
      : name.sourceFindingId || name.sourceDocumentId
        ? "Джерело недоступне"
        : name.sourceId || name.sourceType && name.sourceType !== "manual"
          ? `Інше збережене джерело${name.sourceType ? `: ${name.sourceType}` : ""}`
        : "Без прив’язаного джерела";
  return [
    period,
    name.orthography,
    source,
    name.citationId ? "є цитата" : "",
    name.documentFragmentId ? "є фрагмент документа" : "",
  ].filter(Boolean).join(" · ");
}

function comparePersonNames(left: PersonName, right: PersonName): number {
  return Number(right.isPrimary) - Number(left.isPrimary)
    || Number(right.isPreferred) - Number(left.isPreferred)
    || right.updatedAt.localeCompare(left.updatedAt);
}
