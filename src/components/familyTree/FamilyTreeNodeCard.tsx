import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { FamilyTreeLayoutNode } from "../../utils/familyTreeViewerLayout";

export const FamilyTreeNodeCard = memo(function FamilyTreeNodeCard({
  node,
  selected,
  highlighted,
  relationshipLabel,
  density = "normal",
  offsetX = 0,
  offsetY = 0,
  visualScale = 1,
  onSelect,
  onExpandHiddenRelatives,
  onMovePointerDown,
  onMovePointerMove,
  onMovePointerUp,
  shouldSuppressSelect,
}: {
  node: FamilyTreeLayoutNode;
  selected: boolean;
  highlighted: boolean;
  relationshipLabel?: string;
  density?: "normal" | "compact" | "mini";
  offsetX?: number;
  offsetY?: number;
  visualScale?: number;
  onSelect: (occurrenceId: string) => void;
  onExpandHiddenRelatives?: (direction: "up" | "down" | "side", occurrenceId: string) => void;
  onMovePointerDown?: (event: ReactPointerEvent<HTMLDivElement>, node: FamilyTreeLayoutNode) => void;
  onMovePointerMove?: (event: ReactPointerEvent<HTMLDivElement>, node: FamilyTreeLayoutNode) => void;
  onMovePointerUp?: (event: ReactPointerEvent<HTMLDivElement>, node: FamilyTreeLayoutNode) => void;
  shouldSuppressSelect?: () => boolean;
}) {
  const years = lifeYears(node.person);
  const hiddenParentsCount = node.occurrence.hiddenParentsCount ?? 0;
  const hiddenChildrenCount = node.occurrence.hiddenChildrenCount ?? 0;
  const hiddenSideBranchesCount = node.occurrence.hiddenSideBranchesCount ?? 0;
  const sideBranchesExpanded = Boolean(node.occurrence.sideBranchesExpanded);
  const badges = visibleBadges(node);
  const repeatedBranchesCount = Math.max(2, node.person.occurrenceIds.length);
  const scaledWidth = node.width * visualScale;
  const scaledHeight = node.height * visualScale;
  const style: CSSProperties = {
    left: node.x + offsetX - (scaledWidth - node.width) / 2,
    top: node.y + offsetY - (scaledHeight - node.height) / 2,
    width: scaledWidth,
    height: scaledHeight,
    "--tree-card-scale": visualScale,
  } as CSSProperties;

  return (
    <div
      data-no-pan
      role="button"
      tabIndex={0}
      title={node.person.displayName}
      className={[
        "family-tree-node-card",
        `family-tree-node-card-${density}`,
        genderCardClass(node.person.gender),
        node.badges.includes("root") ? "family-tree-node-card-root" : "",
        selected ? "selected" : "",
        highlighted ? "highlighted" : "",
      ].filter(Boolean).join(" ")}
      style={style}
      onPointerDown={(event) => onMovePointerDown?.(event, node)}
      onPointerMove={(event) => onMovePointerMove?.(event, node)}
      onPointerUp={(event) => onMovePointerUp?.(event, node)}
      onPointerCancel={(event) => onMovePointerUp?.(event, node)}
      onClick={() => {
        if (shouldSuppressSelect?.()) return;
        onSelect(node.occurrence.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node.occurrence.id);
        }
      }}
    >
      {onExpandHiddenRelatives && hiddenParentsCount > 0 ? (
        <button
          type="button"
          className="family-tree-node-expand family-tree-node-expand-up"
          title={`Показати старші покоління: ${hiddenParentsCount}`}
          aria-label={`Показати старші покоління: ${hiddenParentsCount}`}
          onClick={(event) => {
            event.stopPropagation();
            onExpandHiddenRelatives("up", node.occurrence.id);
          }}
        >
          ↑ {hiddenParentsCount}
        </button>
      ) : null}
      {onExpandHiddenRelatives && hiddenChildrenCount > 0 ? (
        <button
          type="button"
          className="family-tree-node-expand family-tree-node-expand-down"
          title={`Показати молодші покоління: ${hiddenChildrenCount}`}
          aria-label={`Показати молодші покоління: ${hiddenChildrenCount}`}
          onClick={(event) => {
            event.stopPropagation();
            onExpandHiddenRelatives("down", node.occurrence.id);
          }}
        >
          ↓ {hiddenChildrenCount}
        </button>
      ) : null}
      {onExpandHiddenRelatives && (hiddenSideBranchesCount > 0 || sideBranchesExpanded) ? (
        <button
          type="button"
          className={[
            "family-tree-node-expand",
            "family-tree-node-expand-side",
            sideBranchesExpanded ? "family-tree-node-expand-active" : "",
          ].filter(Boolean).join(" ")}
          title={sideBranchesExpanded ? "Згорнути бічну гілку" : `Показати бічну гілку: ${hiddenSideBranchesCount}`}
          aria-label={sideBranchesExpanded ? "Згорнути бічну гілку" : `Показати бічну гілку: ${hiddenSideBranchesCount}`}
          onClick={(event) => {
            event.stopPropagation();
            onExpandHiddenRelatives("side", node.occurrence.id);
          }}
        >
          {sideBranchesExpanded ? "−" : `↔ ${hiddenSideBranchesCount}`}
        </button>
      ) : null}
      <span className="family-tree-node-avatar" aria-hidden="true">
        {initials(node.person.displayName)}
      </span>
      <span className="family-tree-node-body">
        <strong>{node.person.displayName}</strong>
        {relationshipLabel ? <span className="family-tree-node-kinship">{relationshipLabel}</span> : null}
        <small>{years || (node.person.redacted ? "приватна особа" : "дати не вказані")}</small>
        <span className="family-tree-node-meta">
          {node.person.gender || "стать не вказана"}
          {node.occurrence.isRepeated ? ` · зустрічається у ${repeatedBranchesCount} гілках` : ""}
        </span>
      </span>
      {badges.length ? (
        <span className="family-tree-node-badges">
          {badges.map((badge) => (
            <span key={badge} className={`family-tree-node-badge-${badge}`}>
              {nodeBadgeLabel(badge)}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
});

function visibleBadges(node: FamilyTreeLayoutNode): string[] {
  const preferredOrder = [
    "needsReview",
    "potentialDuplicate",
    "multipleOccurrences",
    "importedFromGedcom",
  ];
  return preferredOrder.filter((badge) => node.badges.includes(badge as FamilyTreeLayoutNode["badges"][number]));
}

function genderCardClass(gender: string | undefined): string {
  const value = (gender ?? "").trim().toLocaleLowerCase("uk");
  if (["чоловік", "чоловіча", "male", "m", "man"].includes(value)) return "family-tree-node-card-male";
  if (["жінка", "жіноча", "female", "f", "woman"].includes(value)) return "family-tree-node-card-female";
  return "family-tree-node-card-unknown-gender";
}

function nodeBadgeLabel(badge: string): string {
  if (badge === "needsReview") return "перевірити";
  if (badge === "potentialDuplicate") return "можливий дубль";
  if (badge === "multipleOccurrences") return "кілька гілок";
  if (badge === "importedFromGedcom") return "GEDCOM";
  return badge;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]).join("");
  return letters.toLocaleUpperCase("uk") || "?";
}

function lifeYears(person: FamilyTreeLayoutNode["person"]): string {
  const birth = person.events.find((event) => ["birth", "baptism", "christening"].includes(event.eventType));
  const death = person.events.find((event) => ["death", "burial"].includes(event.eventType));
  const birthYear = yearFromEvent(birth);
  const deathYear = yearFromEvent(death);
  if (birthYear && deathYear) return `${birthYear}–${deathYear}`;
  if (birthYear) return `нар. ${birthYear}`;
  if (deathYear) return `пом. ${deathYear}`;
  return "";
}

function yearFromEvent(event: FamilyTreeLayoutNode["person"]["events"][number] | undefined): string {
  if (!event) return "";
  const text = [event.eventDate, event.dateFrom, event.dateText].find(Boolean) ?? "";
  const match = text.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return match?.[1] ?? "";
}
