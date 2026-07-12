"use client";

import type { ReactElement } from "react";
import type {
  FamilyContinuation,
  LayoutResult,
  TreePerson,
} from "../types.ts";
import { reconcileFamilyContinuationPresentations } from "./familyContinuationLayout.ts";
import {
  allocateInteractiveMountBudget,
  normalizeRenderedNodeLimit,
} from "./renderLimits.ts";

export interface FamilyTreeSemanticListProps {
  layout: LayoutResult;
  people: ReadonlyMap<string, TreePerson>;
  onOpenPerson?:
    | ((personId: string, occurrenceId: string) => void)
    | undefined;
  onShowAllDescendants?:
    | ((personId: string, occurrenceId: string) => void)
    | undefined;
  branchTogglePersonIds?: ReadonlySet<string> | undefined;
  collapsedBranchPersonIds?: ReadonlySet<string> | undefined;
  onTogglePersonBranches?:
    | ((personId: string, occurrenceId: string) => void)
    | undefined;
  familyContinuations?: readonly FamilyContinuation[] | undefined;
  onToggleFamilyContinuation?:
    | ((
        continuation: FamilyContinuation,
        anchorOccurrenceId?: string,
        ownerPersonId?: string,
      ) => void)
    | undefined;
  maxRenderedNodes?: number | undefined;
}

export function FamilyTreeSemanticList({
  layout,
  people,
  onOpenPerson,
  onShowAllDescendants,
  branchTogglePersonIds,
  collapsedBranchPersonIds,
  onTogglePersonBranches,
  familyContinuations,
  onToggleFamilyContinuation,
  maxRenderedNodes,
}: FamilyTreeSemanticListProps): ReactElement {
  const candidates = layout.nodes.filter(
    node => node.kind === "person" || node.kind === "reference",
  );
  const nodeLimit = normalizeRenderedNodeLimit(maxRenderedNodes);
  const canonicalFamilyContinuations = reconcileFamilyContinuationPresentations(
    familyContinuations ?? [],
  );
  const mountedInteractive = allocateInteractiveMountBudget(
    candidates,
    canonicalFamilyContinuations,
    nodeLimit,
  );
  const listedNodes = mountedInteractive.primary;
  const listedFamilyContinuations = mountedInteractive.secondary;
  const generations = [...new Set(listedNodes.map(node => node.generation))].sort(
    (a, b) => b - a,
  );

  return (
    <div className="ft-semantic-list">
      <h2>Особи у видимій частині дерева</h2>
      {mountedInteractive.omittedCount > 0 ? (
        <p role="status">
          Показано перші {mountedInteractive.mountedCount} із {candidates.length + canonicalFamilyContinuations.length} елементів. Змініть фокус, щоб переглянути іншу гілку.
        </p>
      ) : null}
      {listedFamilyContinuations.length ? (
        <section aria-labelledby="visible-family-branches">
          <h3 id="visible-family-branches">Сімейні гілки</h3>
          <ul>
            {listedFamilyContinuations.map(continuation => {
              const parentNames = continuation.scope.parentIds
                .map(personId => people.get(personId)?.displayName)
                .filter((name): name is string => Boolean(name));
              const expanded = Boolean(continuation.expanded);
              const ownerPersonId = continuation.scope.parentIds.find(personId =>
                layout.nodes.some(node => node.personId === personId),
              );
              const anchorOccurrenceId = layout.nodes.find(
                node => node.personId === ownerPersonId,
              )?.occurrenceId;
              return (
                <li key={continuation.scope.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      onToggleFamilyContinuation?.(
                        continuation,
                        anchorOccurrenceId,
                        ownerPersonId,
                      )
                    }
                  >
                    {expanded ? "Згорнути дітей" : "Показати дітей"}: {parentNames.join(" і ") || "сім’я"}
                    {!expanded && continuation.hiddenCount
                      ? ` (${continuation.hiddenCount})`
                      : ""}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {generations.map(generation => {
        const band = layout.generationBands.find(item => item.generation === generation);
        const nodes = listedNodes.filter(node => node.generation === generation);
        return (
          <section key={generation} aria-labelledby={`generation-${generation}`}>
            <h3 id={`generation-${generation}`}>{band?.label ?? `Покоління ${generation}`}</h3>
            <ul>
              {nodes.map(node => {
                const person = node.personId ? people.get(node.personId) : undefined;
                const personId = node.personId;
                const branchesCollapsible = Boolean(
                  personId && node.kind === "person" && branchTogglePersonIds?.has(personId),
                );
                const branchesCollapsed = Boolean(
                  personId && collapsedBranchPersonIds?.has(personId),
                );
                return (
                  <li key={node.occurrenceId}>
                    <div className="ft-semantic-person-row">
                      <button
                        type="button"
                        onClick={() =>
                          personId && onOpenPerson?.(personId, node.occurrenceId)
                        }
                      >
                        {person?.displayName ?? "Особа"}
                        {node.kind === "reference" ? " (повторне входження)" : ""}
                        {branchesCollapsed ? " (додаткові гілки згорнуто)" : ""}
                      </button>
                      {personId && onShowAllDescendants ? (
                        <button
                          type="button"
                          className="ft-semantic-descendants"
                          aria-label={`Показати всіх нащадків особи ${person?.displayName ?? "Особа"}`}
                          title={`Показати всіх нащадків особи ${person?.displayName ?? "Особа"}`}
                          onClick={() =>
                            onShowAllDescendants(personId, node.occurrenceId)
                          }
                        >
                          <span aria-hidden="true">⇊</span> Усі нащадки
                        </button>
                      ) : null}
                      {personId && branchesCollapsible && onTogglePersonBranches ? (
                        <button
                          type="button"
                          className="ft-semantic-collapse"
                          aria-expanded={!branchesCollapsed}
                          aria-label={`${branchesCollapsed ? "Розгорнути раніше відкриті" : "Згорнути відкриті"} гілки особи ${person?.displayName ?? "Особа"}`}
                          onClick={() =>
                            onTogglePersonBranches(personId, node.occurrenceId)
                          }
                        >
                          {branchesCollapsed ? "Розгорнути гілки" : "Згорнути гілки"}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
