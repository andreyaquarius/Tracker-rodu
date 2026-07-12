import { memo, useMemo } from "react";
import type {
  FamilyTreeLayoutEdge,
  FamilyTreeLayoutFamilyUnit,
  FamilyTreeLayoutPlaceholder,
} from "../../utils/familyTreeViewerLayout";
import { edgeCssClass, visibleStandaloneFamilyTreeEdges } from "../../utils/familyTreeViewerLayout";

type FamilyTreeEdgeLayerProps = {
  edges: FamilyTreeLayoutEdge[];
  familyUnits: FamilyTreeLayoutFamilyUnit[];
  placeholders?: FamilyTreeLayoutPlaceholder[];
  highlightedRelationshipId: string;
  offsetX: number;
  offsetY: number;
  viewportX?: number;
  viewportY?: number;
  viewportScale?: number;
};

export const FamilyTreeEdgeLayer = memo(function FamilyTreeEdgeLayer({
  edges,
  familyUnits,
  placeholders = [],
  highlightedRelationshipId,
  offsetX,
  offsetY,
  viewportX = 0,
  viewportY = 0,
  viewportScale = 1,
}: FamilyTreeEdgeLayerProps) {
  const standaloneEdges = useMemo(() => visibleStandaloneFamilyTreeEdges(edges), [edges]);

  return (
    <svg className="family-tree-edge-layer" aria-hidden="true">
      <g transform={`translate(${viewportX} ${viewportY}) scale(${viewportScale}) translate(${offsetX} ${offsetY})`}>
        {placeholders
          .filter((placeholder) => placeholder.connectionPath)
          .map((placeholder) => (
            <PlaceholderPath key={placeholder.id} placeholder={placeholder} />
          ))}
        {familyUnits.map((unit) => (
          <FamilyUnitPath
            key={unit.key}
            unit={unit}
            highlightedRelationshipId={highlightedRelationshipId}
          />
        ))}
        {standaloneEdges.map((edge) => (
          <RelationshipPath
            key={edge.edge.id}
            edge={edge}
            highlighted={highlightedRelationshipId === edge.edge.relationshipId}
          />
        ))}
      </g>
    </svg>
  );
});

const PlaceholderPath = memo(function PlaceholderPath({
  placeholder,
}: {
  placeholder: FamilyTreeLayoutPlaceholder;
}) {
  if (!placeholder.connectionPath) return null;
  return (
    <path
      className="family-tree-placeholder-edge"
      d={placeholder.connectionPath}
      strokeDasharray={placeholder.dashArray ?? "6 6"}
    />
  );
});

const FamilyUnitPath = memo(function FamilyUnitPath({
  unit,
  highlightedRelationshipId,
}: {
  unit: FamilyTreeLayoutFamilyUnit;
  highlightedRelationshipId: string;
}) {
  const representative = unit.edges[0];
  if (!representative) return null;
  return (
    <path
      className={[
        edgeCssClass(representative.edge),
        unit.edges.some((edge) => highlightedRelationshipId === edge.edge.relationshipId) ? "highlighted" : "",
      ].filter(Boolean).join(" ")}
      d={unit.path}
      strokeDasharray={unit.dashArray}
      opacity={unit.opacity}
    />
  );
});

const RelationshipPath = memo(function RelationshipPath({
  edge,
  highlighted,
}: {
  edge: FamilyTreeLayoutEdge;
  highlighted: boolean;
}) {
  return (
    <path
      className={[
        edgeCssClass(edge.edge),
        highlighted ? "highlighted" : "",
      ].filter(Boolean).join(" ")}
      d={standaloneEdgePath(edge)}
      strokeDasharray={edge.dashArray}
      opacity={edge.opacity}
    />
  );
});

function standaloneEdgePath(edge: FamilyTreeLayoutEdge): string {
  const from = nodeRect(edge.from);
  const to = nodeRect(edge.to);

  if (edge.edge.kind === "partner") {
    const fromLeft = from.centerX <= to.centerX;
    const startX = fromLeft ? from.x + from.width : from.x;
    const endX = fromLeft ? to.x : to.x + to.width;
    const midY = (from.centerY + to.centerY) / 2;
    return from.centerY === to.centerY
      ? `M ${startX} ${from.centerY} H ${endX}`
      : `M ${startX} ${from.centerY} V ${midY} H ${endX} V ${to.centerY}`;
  }

  if (edge.edge.kind === "association") {
    const controlY = Math.min(from.centerY, to.centerY) - 55;
    return `M ${from.centerX} ${from.centerY} Q ${(from.centerX + to.centerX) / 2} ${controlY} ${to.centerX} ${to.centerY}`;
  }

  const startY = from.y < to.y ? from.y + from.height : from.y;
  const endY = from.y < to.y ? to.y : to.y + to.height;
  const midY = (startY + endY) / 2;
  return `M ${from.centerX} ${startY} V ${midY} H ${to.centerX} V ${endY}`;
}

function nodeRect(
  node: FamilyTreeLayoutEdge["from"],
): { x: number; y: number; width: number; height: number; centerX: number; centerY: number } {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    centerX: node.x + node.width / 2,
    centerY: node.y + node.height / 2,
  };
}
