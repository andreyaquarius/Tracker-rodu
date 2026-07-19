"use client";

import { useEffect, useState, type ReactElement } from "react";
import type { LayoutNode, TreePerson } from "../types.ts";
import { formatDateForDisplay } from "../../../utils/dateHelpers.ts";
import { branchControlPresentation } from "./branchControlPresentation.ts";
import { BranchControlIcon } from "./BranchControlIcon.tsx";
import { PersonCardActionIcon } from "./PersonCardActionIcon.tsx";
import {
  leaseTreePersonPhotoSource,
  type TreePersonPhotoSourceResolver,
} from "./personPhotoSourceCache.ts";

export interface PersonCardProps {
  node: LayoutNode;
  person?: TreePerson | undefined;
  duplicateCount: number;
  compact: boolean;
  selected: boolean;
  focused: boolean;
  branchesCollapsible?: boolean;
  branchesCollapsed?: boolean;
  onOpen?: ((personId: string, occurrenceId: string) => void) | undefined;
  onFocus?: ((personId: string) => void) | undefined;
  onShowAllDescendants?:
    | ((personId: string, occurrenceId: string) => void)
    | undefined;
  onAddRelative?: ((personId: string) => void) | undefined;
  onToggleBranches?:
    | ((personId: string, occurrenceId: string) => void)
    | undefined;
  onExpandContinuation?:
    | ((token: string, node: LayoutNode) => void)
    | undefined;
  resolvePhotoSource?: TreePersonPhotoSourceResolver | undefined;
}

function years(person: TreePerson | undefined): string {
  if (!person) return "";
  const birth = formatDateForDisplay(person.birth?.display ?? person.birth?.sort);
  const death = formatDateForDisplay(person.death?.display ?? person.death?.sort);
  if (birth && death) return `${birth} — ${death}`;
  if (birth) return `нар. ${birth}`;
  if (death) return `пом. ${death}`;
  return "Дати не вказані";
}

export function PersonCard({
  node,
  person,
  duplicateCount,
  compact,
  selected,
  focused,
  branchesCollapsible = false,
  branchesCollapsed = false,
  onOpen,
  onFocus,
  onShowAllDescendants,
  onAddRelative,
  onToggleBranches,
  onExpandContinuation,
  resolvePhotoSource,
}: PersonCardProps): ReactElement {
  if (node.kind === "continuation") {
    const presentation = branchControlPresentation(node.continuation);
    const direction = node.continuation?.direction ?? "children";
    return (
      <button
        type="button"
        className="ft-continuation"
        data-direction={direction}
        data-has-count={presentation.count ? "true" : "false"}
        data-tooltip={presentation.ariaLabel}
        aria-label={presentation.ariaLabel}
        aria-expanded={presentation.expanded}
        onClick={() =>
          node.continuation &&
          onExpandContinuation?.(node.continuation.token, node)
        }
      >
        <span className="ft-branch-control-icon" aria-hidden="true">
          <BranchControlIcon
            direction={direction}
            expanded={presentation.expanded}
          />
        </span>
        {presentation.count ? (
          <span className="ft-branch-control-count" aria-hidden="true">
            {presentation.count}
          </span>
        ) : null}
      </button>
    );
  }

  if (node.kind === "placeholder") {
    return (
      <button
        type="button"
        className="ft-placeholder"
        title={node.placeholderLabel}
        aria-label={node.placeholderLabel}
        onClick={() => node.actionPersonId && onAddRelative?.(node.actionPersonId)}
      >
        <span aria-hidden="true">＋</span>
        <small>{node.placeholderLabel}</small>
      </button>
    );
  }

  if (node.kind === "convergence") {
    const targetPersonId = node.actionPersonId;
    const targetName = person?.displayName ?? "особи";
    return (
      <button
        type="button"
        className="ft-convergence-portal"
        aria-label={`Перейти до вже показаної картки особи ${targetName}`}
        title={`Родовід сходиться повторно. Перейти до картки: ${targetName}`}
        onClick={() =>
          targetPersonId &&
          onOpen?.(
            targetPersonId,
            node.referenceToOccurrenceId ?? node.occurrenceId,
          )
        }
      >
        <span aria-hidden="true">↗</span>
      </button>
    );
  }

  const personId = node.personId!;
  const name = person?.displayName ?? "Особа";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join("");
  const life = years(person);
  const lineageDescription = node.lineageRole === "direct-ancestor"
    ? ", прямий предок"
    : node.lineageRole === "focus"
      ? ", коренева особа"
      : "";

  return (
    <article
      className="ft-person-card"
      data-sex={person?.sex ?? "unknown"}
      data-reference={node.kind === "reference" ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-collapsed={branchesCollapsed ? "true" : "false"}
      data-lineage={node.lineageRole ?? "collateral"}
      data-lineage-group={node.lineageGroup}
      aria-label={`${name}, ${life}${lineageDescription}${branchesCollapsed ? ", відкриті додаткові гілки згорнуто" : ""}`}
    >
      <button
        type="button"
        className="ft-card-main"
        onClick={() => onOpen?.(personId, node.occurrenceId)}
      >
        <PersonAvatar
          person={person}
          initials={initials || "?"}
          compact={compact}
          resolvePhotoSource={resolvePhotoSource}
        />
        <span className="ft-card-copy">
          <strong title={name}>{name}</strong>
          {!compact ? <small title={life}>{life}</small> : null}
        </span>
      </button>

      {!compact ? (
        <span className="ft-card-actions">
          <button
            type="button"
            className="ft-card-action"
            data-action="focus"
            data-tooltip={`Показати дерево від ${name}`}
            aria-pressed={focused}
            aria-label={`Зробити ${name} фокусною особою`}
            onClick={() => onFocus?.(personId)}
          >
            <PersonCardActionIcon kind="focus" />
          </button>
          {onShowAllDescendants ? (
            <button
              type="button"
              className="ft-card-action"
              data-action="descendants"
              data-tooltip={`Показати всіх нащадків особи ${name}`}
              aria-label={`Показати всіх нащадків особи ${name}`}
              onClick={() =>
                onShowAllDescendants(personId, node.occurrenceId)
              }
            >
              <PersonCardActionIcon kind="descendants" />
            </button>
          ) : null}
          {branchesCollapsible && onToggleBranches && node.kind === "person" ? (
            <button
              type="button"
              className="ft-card-action"
              data-action="toggle-branches"
              data-tooltip={branchesCollapsed ? "Розгорнути раніше відкриті гілки" : "Згорнути відкриті гілки"}
              aria-expanded={!branchesCollapsed}
              aria-label={`${branchesCollapsed ? "Розгорнути раніше відкриті" : "Згорнути відкриті"} гілки особи ${name}`}
              onClick={() => onToggleBranches(personId, node.occurrenceId)}
            >
              <PersonCardActionIcon
                kind={branchesCollapsed ? "expand-branches" : "collapse-branches"}
              />
            </button>
          ) : null}
          <button
            type="button"
            className="ft-card-action ft-card-action--add"
            data-action="add-relative"
            data-tooltip="Додати родича"
            aria-label={`Додати родича для ${name}`}
            onClick={() => onAddRelative?.(personId)}
          >
            <span className="ft-card-add-glyph" aria-hidden="true">＋</span>
          </button>
        </span>
      ) : null}

      {duplicateCount > 1 ? (
        <span className="ft-repeat-badge" title="Особа повторно входить у схему">
          ×{duplicateCount}
        </span>
      ) : null}
      {node.kind === "reference" ? (
        <span className="ft-reference-label">повтор</span>
      ) : null}
    </article>
  );
}

function PersonAvatar({
  person,
  initials,
  compact,
  resolvePhotoSource,
}: {
  person: TreePerson | undefined;
  initials: string;
  compact: boolean;
  resolvePhotoSource: TreePersonPhotoSourceResolver | undefined;
}): ReactElement {
  const directUrl = !compact ? person?.photoUrl?.trim() ?? "" : "";
  const photo = !compact ? person?.photo : undefined;
  const [resolvedUrl, setResolvedUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const photoIdentity = photo
    ? `${photo.storage}:${photo.storagePath}:${photo.driveRevisionId ?? photo.driveMd5Checksum ?? photo.driveModifiedTime ?? photo.createdAt}`
    : "";

  useEffect(() => {
    setResolvedUrl("");
    setFailed(false);
    if (directUrl || !photo || !resolvePhotoSource) return undefined;

    let active = true;
    const lease = leaseTreePersonPhotoSource(photo, resolvePhotoSource);
    void lease.source.then((source) => {
      if (!active) return;
      if (source?.url) setResolvedUrl(source.url);
      else setFailed(true);
    });
    return () => {
      active = false;
      lease.release();
    };
  }, [directUrl, photoIdentity, resolvePhotoSource]);

  const source = failed ? "" : directUrl || resolvedUrl;
  return (
    <span className="ft-avatar" aria-hidden="true">
      {source ? (
        <img
          src={source}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
