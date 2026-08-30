import type { Person } from "../../types";
import type { ResearchGraphTargetOption } from "../../types/contextGraph.ts";
import type { PersonContextView } from "../persons-v2/contracts.ts";
import { PersonDocumentaryGraphV1 } from "./PersonDocumentaryGraphV1.tsx";
import { PersonChurchRoleNetworkV1 } from "./PersonChurchRoleNetworkV1.tsx";
import { PersonResearchGraphV1 } from "./PersonResearchGraphV1.tsx";
import { PersonSocialCircleV1 } from "./PersonSocialCircleV1.tsx";
import "./PersonContextWorkspaceV1.css";

export interface PersonContextWorkspaceV1Props {
  projectId: string;
  center: Person;
  persons: readonly Person[];
  researchTargets?: readonly ResearchGraphTargetOption[];
  contextView: PersonContextView;
  canEdit?: boolean;
  readOnly?: boolean;
  canManageShareLinks?: boolean;
  onBack: () => void;
  onChangeView: (view: PersonContextView) => void;
  onFocusPerson: (personId: string) => void;
  onOpenPerson: (personId: string) => void;
  onOpenDocument: (documentId: string) => void;
  onOpenFinding: (findingId: string) => void;
  onOpenPlace?: (placeId: string) => void;
  onOpenHypothesis?: (hypothesisId: string) => void;
}

/**
 * Keeps the everyday person-centred flows easy to discover while preserving
 * the routed specialist projections independently from the family tree.
 */
export function PersonContextWorkspaceV1({
  projectId,
  center,
  persons,
  researchTargets = [],
  contextView,
  canEdit = false,
  readOnly = false,
  canManageShareLinks = false,
  onBack,
  onChangeView,
  onFocusPerson,
  onOpenPerson,
  onOpenDocument,
  onOpenFinding,
  onOpenPlace,
  onOpenHypothesis,
}: PersonContextWorkspaceV1Props) {
  return (
    <section className="person-context-workspace-v1" aria-labelledby="person-context-workspace-title">
      <div className="person-context-workspace-v1__shell">
        <div className="person-context-workspace-v1__toolbar">
          <button
            type="button"
            className="person-context-workspace-v1__back"
            onClick={onBack}
            aria-label="Повернутися до картки особи"
          >
            ← Назад
          </button>

          <div className="person-context-workspace-v1__heading">
            <h1 id="person-context-workspace-title">Зв’язки та оточення</h1>
            <span title={center.fullName}>{center.fullName}</span>
          </div>

          <nav className="person-context-workspace-v1__views" aria-label="Основні розділи зв’язків">
            <button
              type="button"
              className={contextView === "social" ? "is-active" : ""}
              aria-current={contextView === "social" ? "page" : undefined}
              title="Соціальні зв’язки, сусіди та спільні згадки"
              onClick={() => onChangeView("social")}
            >
              Люди
            </button>
            <button
              type="button"
              className={contextView === "ritual" ? "is-active" : ""}
              aria-current={contextView === "ritual" ? "page" : undefined}
              title="Хрещені й поручителі, весільні свідки та зв’язки між родами"
              onClick={() => onChangeView("ritual")}
            >
              Роди
            </button>
            <button
              type="button"
              className={contextView === "documentary" ? "is-active" : ""}
              aria-current={contextView === "documentary" ? "page" : undefined}
              title="Документальний контекст і докази кожного зв’язку"
              onClick={() => onChangeView("documentary")}
            >
              Документи
            </button>
          </nav>

          <details
            className="person-context-workspace-v1__advanced"
            open={contextView === "research"}
          >
            <summary title="Інструменти для досвідчених дослідників">
              <strong>Розширені</strong>
              {contextView === "research" ? <em>Відкрито</em> : null}
            </summary>
            <div className="person-context-workspace-v1__advanced-content">
              <span>Дослідницький граф: фільтри, гіпотези й часові зрізи.</span>
              <button
                type="button"
                className={`person-context-workspace-v1__research-button${contextView === "research" ? " is-active" : ""}`}
                aria-current={contextView === "research" ? "page" : undefined}
                onClick={() => onChangeView("research")}
              >
                {contextView === "research" ? "Дослідницький граф відкрито" : "Відкрити"}
              </button>
            </div>
          </details>
        </div>
      </div>

      {contextView === "documentary" ? (
        <PersonDocumentaryGraphV1
          projectId={projectId}
          center={center}
          onFocusPerson={onFocusPerson}
          onOpenPerson={onOpenPerson}
          onOpenDocument={onOpenDocument}
          onOpenFinding={onOpenFinding}
          onOpenPlace={onOpenPlace}
        />
      ) : contextView === "research" ? (
        <PersonResearchGraphV1
          projectId={projectId}
          center={center}
          targetOptions={researchTargets}
          canEdit={canEdit}
          readOnly={readOnly}
          canManageShareLinks={canManageShareLinks}
          onFocusPerson={onFocusPerson}
          onOpenPerson={onOpenPerson}
          onOpenDocument={onOpenDocument}
          onOpenFinding={onOpenFinding}
          onOpenPlace={onOpenPlace}
          onOpenHypothesis={onOpenHypothesis}
        />
      ) : contextView === "ritual" ? (
        <PersonChurchRoleNetworkV1
          projectId={projectId}
          center={center}
          onFocusPerson={onFocusPerson}
          onOpenPerson={onOpenPerson}
          onOpenDocument={onOpenDocument}
          onOpenFinding={onOpenFinding}
        />
      ) : (
        <PersonSocialCircleV1
          projectId={projectId}
          center={center}
          persons={persons}
          canEdit={canEdit}
          readOnly={readOnly}
          onFocusPerson={(person) => onFocusPerson(person.id)}
          onOpenPerson={(person) => onOpenPerson(person.id)}
          onFocusPersonById={onFocusPerson}
          onOpenPersonById={onOpenPerson}
          onOpenDocument={onOpenDocument}
          onOpenFinding={onOpenFinding}
        />
      )}
    </section>
  );
}
