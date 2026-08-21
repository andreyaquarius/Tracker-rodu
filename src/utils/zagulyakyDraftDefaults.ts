import {
  emptyZagulyakaDraft,
  type ZagulyakaDraftInput,
  type ZagulyakaKind,
} from "../types/zagulyaky.ts";

/**
 * Start a new draft with the authenticated author's display name prepared for
 * optional public attribution. Existing drafts are always copied verbatim: a
 * later profile-name change must not silently change a stored attribution.
 */
export function initialZagulyakaDraftForAuthor(
  kind: ZagulyakaKind,
  authorName: string,
  existingDraft?: ZagulyakaDraftInput,
): ZagulyakaDraftInput {
  if (existingDraft) return { ...existingDraft };

  return {
    ...emptyZagulyakaDraft(kind),
    publicAttributionName: authorName.trim(),
  };
}
