import type { FamilyTreeGraphDto } from "../../types/familyTree";
import type { FamilyTreeLayoutNode } from "../../utils/familyTreeViewerLayout";
import type { FamilyTreeBuilderAction } from "../../services/familyTreeMutationService";
import type { FamilyTreeAttachAction } from "./FamilyTreeAttachPersonDialog";
import { familyTreeIssueDisplay } from "../../utils/familyTreeIssueLabels";
import {
  availableFamilyTreeActionsForPerson,
  familyTreeRelationFlagsByPerson,
} from "../../utils/familyTreeActions";
import { familyTreeKinshipLabel } from "../../utils/familyTreeKinship";
import { personStatusLabel } from "../../utils/familyTreeLabels";

export function FamilyTreeSidePanel({
  graph,
  selected,
  onSelectOccurrence,
  onAction,
  onAttach,
  onDetach,
  onOpenPerson,
}: {
  graph: FamilyTreeGraphDto;
  selected: FamilyTreeLayoutNode | null;
  onSelectOccurrence: (occurrenceId: string) => void;
  onAction?: (action: FamilyTreeBuilderAction, personId: string) => void;
  onAttach?: (action: FamilyTreeAttachAction, personId: string) => void;
  onDetach?: (input: FamilyTreeDetachInput) => void;
  onOpenPerson?: (personId: string) => void;
}) {
  if (!selected) {
    return (
      <aside className="panel family-tree-side-panel">
        <span className="eyebrow">Вибрана особа</span>
        <h2>Оберіть вузол</h2>
        <p>Натисніть на картку особи в дереві, щоб переглянути її появу, зв'язки та попередження.</p>
      </aside>
    );
  }

  const relatedIssues = graph.issues.filter((issue) =>
    issue.personIds.includes(selected.person.personId) ||
    issue.occurrenceIds.includes(selected.occurrence.id),
  );
  const otherOccurrences = graph.occurrences.filter(
    (occurrence) => occurrence.personId === selected.person.personId && occurrence.id !== selected.occurrence.id,
  );
  const relationshipSummary = buildRelationshipSummary(graph, selected.person.personId);
  const kinshipLabel = familyTreeKinshipLabel(graph, selected.occurrence, selected.person);
  const relationFlags = familyTreeRelationFlagsByPerson(graph).get(selected.person.personId);
  const availableActions = onAction
    ? availableFamilyTreeActionsForPerson(graph, selected.person.personId)
    : [];

  return (
    <aside className="panel family-tree-side-panel">
      <span className="eyebrow">Вибрана особа</span>
      <h2>{selected.person.displayName}</h2>
      <div className="family-tree-side-primary-actions">
        {onOpenPerson ? (
          <button type="button" onClick={() => onOpenPerson(selected.person.personId)}>
            Відкрити в розділі Особи
          </button>
        ) : null}
      </div>
      {onAction ? (
        <div className="family-tree-side-actions">
          {availableActions.map((item) => (
            <button key={item.action} type="button" onClick={() => onAction(item.action, selected.person.personId)}>
              {sidePanelActionLabel(item.action, relationFlags?.partners ?? 0)}
            </button>
          ))}
        </div>
      ) : null}
      {onAttach ? (
        <div className="family-tree-side-actions">
          <button type="button" onClick={() => onAttach("attach_parent", selected.person.personId)}>
            Прив’язати існуючого батька або матір
          </button>
          <button type="button" onClick={() => onAttach("attach_partner", selected.person.personId)}>
            Прив’язати існуючого партнера
          </button>
          <button type="button" onClick={() => onAttach("attach_child", selected.person.personId)}>
            Прив’язати існуючу дитину
          </button>
        </div>
      ) : null}
      <dl className="family-tree-details">
        <div>
          <dt>Ким є для центру</dt>
          <dd>{kinshipLabel}</dd>
        </div>
        <div>
          <dt>Покоління</dt>
          <dd>{selected.occurrence.generation}</dd>
        </div>
        <div>
          <dt>Статус</dt>
          <dd>{personStatusLabel(selected.person.status)}</dd>
        </div>
      </dl>

      <section>
        <h3>Батьки</h3>
        {relationshipSummary.parents.length ? (
          <div className="family-tree-side-list">
            {relationshipSummary.parents.map((person) => (
              <RelatedPersonRow key={person.key} person={person} onOpenPerson={onOpenPerson} onDetach={onDetach} />
            ))}
          </div>
        ) : (
          <p className="family-tree-muted">Батьків для цієї особи поки не додано.</p>
        )}
      </section>

      <section>
        <h3>Партнери</h3>
        {relationshipSummary.partners.length ? (
          <div className="family-tree-side-list">
            {relationshipSummary.partners.map((person) => (
              <RelatedPersonRow key={person.key} person={person} onOpenPerson={onOpenPerson} onDetach={onDetach} />
            ))}
          </div>
        ) : (
          <p className="family-tree-muted">Партнерських зв'язків поки не додано.</p>
        )}
      </section>

      <section>
        <h3>Діти</h3>
        {relationshipSummary.children.length ? (
          <div className="family-tree-side-list">
            {relationshipSummary.children.map((person) => (
              <RelatedPersonRow key={person.key} person={person} onOpenPerson={onOpenPerson} onDetach={onDetach} />
            ))}
          </div>
        ) : (
          <p className="family-tree-muted">Дітей для цієї особи поки не додано.</p>
        )}
      </section>

      <section>
        <h3>Імена</h3>
        {selected.person.names.length ? (
          <div className="family-tree-side-list">
            {selected.person.names.slice(0, 5).map((name) => (
              <div key={name.id}>
                <strong>{name.fullName || name.originalText}</strong>
                <small>{personNameTypeLabel(name.nameType)} · {evidenceStatusLabel(name.evidenceStatus)}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="family-tree-muted">Імена приховані або не заповнені.</p>
        )}
      </section>

      <section>
        <h3>Події</h3>
        {selected.person.events.length ? (
          <div className="family-tree-side-list">
            {selected.person.events.slice(0, 6).map((event) => (
              <div key={event.id}>
                <strong>{event.title || eventTypeLabel(event.eventType)}</strong>
                <small>{[event.eventDate || event.dateText, event.placeName].filter(Boolean).join(" · ")}</small>
              </div>
            ))}
          </div>
        ) : (
          <p className="family-tree-muted">Подій для цієї особи поки не додано.</p>
        )}
      </section>

      {otherOccurrences.length ? (
        <section>
          <h3>Інші появи цієї особи</h3>
          <div className="family-tree-side-list">
            {otherOccurrences.map((occurrence) => (
              <button key={occurrence.id} type="button" onClick={() => onSelectOccurrence(occurrence.id)}>
                <strong>Покоління {occurrence.generation}</strong>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h3>Попередження</h3>
        {relatedIssues.length ? (
          <div className="family-tree-side-list">
            {relatedIssues.map((issue, index) => {
              const display = familyTreeIssueDisplay(issue);
              return (
                <div key={`${issue.code}-${index}`}>
                  <strong>{display.title}</strong>
                  <small>{display.description}</small>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="family-tree-muted">Пов'язаних проблем не знайдено.</p>
        )}
      </section>
    </aside>
  );
}

function sidePanelActionLabel(action: FamilyTreeBuilderAction, partnersCount: number): string {
  if (action === "add_father") return "+ Батько";
  if (action === "add_mother") return "+ Мати";
  if (action === "add_partner") return partnersCount > 0 ? "+ Ще партнер" : "+ Партнер";
  if (action === "add_child") return "+ Дитина";
  if (action === "add_sibling") return "+ Брат/сестра";
  return "+";
}

type RelatedPersonSummary = {
  key: string;
  kind: "parent_child" | "partner";
  relationshipId: string;
  personId: string;
  label: string;
  detail: string;
};

export type FamilyTreeDetachInput = {
  kind: "parent_child" | "partner";
  relationshipId: string;
  label: string;
};

function RelatedPersonRow({
  person,
  onOpenPerson,
  onDetach,
}: {
  person: RelatedPersonSummary;
  onOpenPerson?: (personId: string) => void;
  onDetach?: (input: FamilyTreeDetachInput) => void;
}) {
  const content = (
    <>
      <strong>{person.label}</strong>
      <small>{person.detail}</small>
    </>
  );
  return (
    <div className="family-tree-side-relation-row">
      {onOpenPerson ? (
        <button type="button" onClick={() => onOpenPerson(person.personId)}>
          {content}
        </button>
      ) : (
        <div>{content}</div>
      )}
      {onDetach ? (
        <button
          type="button"
          className="family-tree-detach-button"
          title="Від’єднати цей зв’язок без видалення особи"
          aria-label={`Від’єднати зв’язок з ${person.label}`}
          onClick={() => onDetach({
            kind: person.kind,
            relationshipId: person.relationshipId,
            label: person.label,
          })}
        >
          Від’єднати
        </button>
      ) : null}
    </div>
  );
}

function buildRelationshipSummary(graph: FamilyTreeGraphDto, personId: string): {
  parents: RelatedPersonSummary[];
  partners: RelatedPersonSummary[];
  children: RelatedPersonSummary[];
} {
  const seen = new Set<string>();
  const edgeKey = (scope: string, relationshipId: string, relatedPersonId: string) =>
    [scope, relationshipId, relatedPersonId].join(":");
  const addOnce = (
    scope: "parents" | "partners" | "children",
    relationshipId: string,
    relatedPersonId: string,
    detail: string,
    result: RelatedPersonSummary[],
  ) => {
    const key = edgeKey(scope, relationshipId, relatedPersonId);
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      key,
      kind: scope === "partners" ? "partner" : "parent_child",
      relationshipId,
      personId: relatedPersonId,
      label: personDisplayName(graph, relatedPersonId),
      detail,
    });
  };

  const parents: RelatedPersonSummary[] = [];
  const partners: RelatedPersonSummary[] = [];
  const children: RelatedPersonSummary[] = [];
  for (const edge of graph.edges) {
    if (edge.kind === "parent_child" && edge.toPersonId === personId) {
      addOnce("parents", edge.relationshipId, edge.fromPersonId, parentRelationshipLabel(edge.relationshipType, edge.evidenceStatus), parents);
    } else if (edge.kind === "parent_child" && edge.fromPersonId === personId) {
      addOnce("children", edge.relationshipId, edge.toPersonId, parentRelationshipLabel(edge.relationshipType, edge.evidenceStatus), children);
    } else if (edge.kind === "partner" && (edge.fromPersonId === personId || edge.toPersonId === personId)) {
      const relatedPersonId = edge.fromPersonId === personId ? edge.toPersonId : edge.fromPersonId;
      addOnce("partners", edge.relationshipId, relatedPersonId, partnerRelationshipLabel(edge.relationshipType, edge.evidenceStatus), partners);
    }
  }

  return {
    parents: sortRelatedPeople(parents),
    partners: sortRelatedPeople(partners),
    children: sortRelatedPeople(children),
  };
}

function sortRelatedPeople(items: RelatedPersonSummary[]): RelatedPersonSummary[] {
  return [...items].sort((left, right) => left.label.localeCompare(right.label, "uk"));
}

function personDisplayName(graph: FamilyTreeGraphDto, personId: string): string {
  return graph.nodes.find((node) => node.personId === personId)?.displayName ??
    graph.availablePersons.find((node) => node.personId === personId)?.displayName ??
    "Особа без імені";
}

function personNameTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    primary: "Основне ім’я",
    birth: "Ім’я при народженні",
    married: "Шлюбне ім’я",
    alias: "Інше ім’я",
    original: "Оригінальний запис",
    transliteration: "Транслітерація",
    religious: "Релігійне ім’я",
    patronymic_variant: "Варіант по батькові",
    surname_variant: "Варіант прізвища",
    other: "Інший варіант імені",
  };
  return labels[value] ?? "Ім’я";
}

function eventTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    birth: "Народження",
    baptism: "Хрещення",
    christening: "Хрещення",
    marriage: "Шлюб",
    divorce: "Розлучення",
    residence: "Проживання",
    census: "Перепис",
    revision_list: "Ревізька казка",
    confession_list: "Сповідний розпис",
    household_register: "Погосподарська книга",
    immigration: "Імміграція",
    emigration: "Еміграція",
    military: "Військова служба",
    occupation: "Заняття",
    education: "Освіта",
    nationality: "Національність",
    death: "Смерть",
    burial: "Поховання",
    cremation: "Кремація",
    probate: "Спадкова справа",
    mention: "Згадка в джерелі",
    other: "Подія",
  };
  return labels[value] ?? "Подія";
}

function parentRelationshipLabel(relationshipType: string, evidenceStatus: string): string {
  return [parentRelationshipTypeLabel(relationshipType), evidenceStatusLabel(evidenceStatus)].filter(Boolean).join(" · ");
}

function partnerRelationshipLabel(relationshipType: string, evidenceStatus: string): string {
  return [partnerRelationshipTypeLabel(relationshipType), evidenceStatusLabel(evidenceStatus)].filter(Boolean).join(" · ");
}

function parentRelationshipTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    biological: "Біологічний зв’язок",
    birth_parent: "Батько/мати за народженням",
    genetic_father: "Генетичний батько",
    genetic_mother: "Генетична мати",
    gestational_parent: "Гестаційний зв’язок",
    adoptive: "Прийомний зв’язок",
    foster: "Виховний зв’язок",
    step: "Нерідний зв’язок",
    guardian: "Опіка",
    social_parent: "Соціальний зв’язок",
    legal_parent: "Юридичний зв’язок",
    donor: "Донор",
    surrogate: "Сурогатне батьківство",
    presumed: "Ймовірний зв’язок",
    unknown: "Невідомий зв’язок",
    other: "Родинний зв’язок",
  };
  if (labels[value]) return labels[value];
  switch (value) {
    case "biological":
    case "birth_parent":
    case "genetic_father":
    case "genetic_mother":
      return "Біологічний зв'язок";
    case "adoptive":
      return "Усиновлення";
    case "foster":
      return "Виховання";
    case "step":
      return "Нерідний зв'язок";
    case "guardian":
      return "Опіка";
    case "social_parent":
      return "Соціальний зв'язок";
    case "legal_parent":
      return "Юридичний зв'язок";
    default:
      return "Родинний зв'язок";
  }
}

function partnerRelationshipTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    marriage: "Шлюб",
    civil_partnership: "Цивільний союз",
    cohabitation: "Спільне проживання",
    engagement: "Заручини",
    dating: "Стосунки",
    temporary_relationship: "Тимчасовий зв’язок",
    divorced: "Розлучення",
    separated: "Окремо",
    annulled: "Шлюб скасовано",
    widowhood: "Вдівство",
    unknown: "Партнерство",
    other: "Партнерство",
  };
  if (labels[value]) return labels[value];
  switch (value) {
    case "marriage":
      return "Шлюб";
    case "civil_partnership":
      return "Цивільний союз";
    case "cohabitation":
      return "Спільне проживання";
    case "engagement":
      return "Заручини";
    case "divorced":
      return "Розлучення";
    case "separated":
      return "Окремо";
    case "widowhood":
      return "Вдівство";
    default:
      return "Партнерство";
  }
}

function evidenceStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    proven: "доведено",
    likely: "імовірно",
    disputed: "сумнівно",
    disproven: "спростовано",
    unknown: "не визначено",
  };
  if (labels[value]) return labels[value];
  switch (value) {
    case "proven":
      return "доведено";
    case "likely":
      return "імовірно";
    case "disputed":
      return "сумнівно";
    case "disproven":
      return "спростовано";
    default:
      return "не визначено";
  }
}
