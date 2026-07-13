"use client";

import { useEffect, useState, type ReactElement } from "react";
import type { LayoutNode, TreePerson } from "../types.ts";
import { formatDateForDisplay } from "../../../utils/dateHelpers.ts";
import { branchControlPresentation } from "./branchControlPresentation.ts";
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
    return (
      <button
        type="button"
        className="ft-continuation"
        title={presentation.title}
        aria-label={presentation.ariaLabel}
        aria-expanded={presentation.expanded}
        onClick={() =>
          node.continuation &&
          onExpandContinuation?.(node.continuation.token, node)
        }
      >
        <span aria-hidden="true">{presentation.icon}</span>
        {presentation.count ? (
          <small>{presentation.count}</small>
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

  return (
    <article
      className="ft-person-card"
      data-sex={person?.sex ?? "unknown"}
      data-reference={node.kind === "reference" ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-collapsed={branchesCollapsed ? "true" : "false"}
      aria-label={`${name}, ${life}${branchesCollapsed ? ", відкриті додаткові гілки згорнуто" : ""}`}
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
            aria-label={`Зробити ${name} фокусною особою`}
            title="Показати дерево від цієї особи"
            onClick={() => onFocus?.(personId)}
          >
            ◎
          </button>
          {onShowAllDescendants ? (
            <button
              type="button"
              aria-label={`Показати всіх нащадків особи ${name}`}
              title={`Показати всіх нащадків особи ${name}`}
              onClick={() =>
                onShowAllDescendants(personId, node.occurrenceId)
              }
            >
              <span aria-hidden="true">⇊</span>
            </button>
          ) : null}
          {branchesCollapsible && onToggleBranches && node.kind === "person" ? (
            <button
              type="button"
              aria-expanded={!branchesCollapsed}
              aria-label={`${branchesCollapsed ? "Розгорнути раніше відкриті" : "Згорнути відкриті"} гілки особи ${name}`}
              title={branchesCollapsed ? "Розгорнути раніше відкриті гілки" : "Згорнути відкриті гілки"}
              onClick={() => onToggleBranches(personId, node.occurrenceId)}
            >
              <span aria-hidden="true">{branchesCollapsed ? "▸" : "▾"}</span>
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Додати родича для ${name}`}
            title="Додати родича"
            onClick={() => onAddRelative?.(personId)}
          >
            ＋
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
