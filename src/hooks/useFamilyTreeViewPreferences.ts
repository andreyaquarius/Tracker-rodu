import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAuthenticatedFamilyTreeViewPreferenceUserId,
  loadFamilyTreeViewPreference,
  saveFamilyTreeViewPreference,
} from "../services/familyTreeViewPreferences.ts";
import {
  DEFAULT_FAMILY_TREE_VIEW_PREFERENCES,
  familyTreeViewPreferencesStorageKey,
  normalizeFamilyTreeViewPreferences,
  readFamilyTreeViewPreferenceCache,
  sameFamilyTreeViewPreferences,
  writeFamilyTreeViewPreferenceCache,
  type FamilyTreeViewPreferences,
} from "../utils/familyTreeViewPreferences.ts";

// Keep write ordering across unmount/remount boundaries. A page closed while a
// save is in flight may be reopened before that request finishes; module-level,
// per-scope serialization guarantees the newer edit remains the final server
// write without making unrelated users/trees wait for one another.
const sharedSaveChainsByScope = new Map<string, Promise<void>>();
let sharedSaveSequence = 0;
const latestSharedSaveByScope = new Map<string, number>();

export type FamilyTreeViewPreferenceSyncState =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "error";

export type FamilyTreeViewPreferenceUpdate =
  | FamilyTreeViewPreferences
  | ((current: FamilyTreeViewPreferences) => FamilyTreeViewPreferences);

export interface FamilyTreeViewPreferenceState {
  preferences: FamilyTreeViewPreferences;
  syncState: FamilyTreeViewPreferenceSyncState;
  /** True after the authenticated user's scoped local cache was hydrated. */
  ready: boolean;
  updatePreferences: (update: FamilyTreeViewPreferenceUpdate) => void;
}

function targetKey(projectId?: string, treeId?: string): string {
  return projectId && treeId ? `${projectId}:${treeId}` : "";
}

/**
 * Cache-first per-user/per-tree preferences with Supabase as the durable store.
 * A failed save remains dirty in localStorage and is replayed on the next open.
 */
export function useFamilyTreeViewPreferences(
  projectId?: string,
  treeId?: string,
): FamilyTreeViewPreferenceState {
  const [preferences, setPreferences] = useState<FamilyTreeViewPreferences>(() =>
    normalizeFamilyTreeViewPreferences(DEFAULT_FAMILY_TREE_VIEW_PREFERENCES)
  );
  const [syncState, setSyncState] =
    useState<FamilyTreeViewPreferenceSyncState>("idle");
  const [ready, setReady] = useState(false);
  const preferencesRef = useRef(preferences);
  const mountedRef = useRef(true);
  const activeTargetRef = useRef(targetKey(projectId, treeId));
  const activeUserIdRef = useRef("");
  const loadSequenceRef = useRef(0);
  const editSequenceRef = useRef(0);

  preferencesRef.current = preferences;
  activeTargetRef.current = targetKey(projectId, treeId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const queueRemoteSave = useCallback((
    userId: string,
    targetProjectId: string,
    targetTreeId: string,
    value: FamilyTreeViewPreferences,
  ) => {
    const normalized = normalizeFamilyTreeViewPreferences(value);
    const scopeKey = familyTreeViewPreferencesStorageKey(
      userId,
      targetProjectId,
      targetTreeId,
    );
    const saveSequence = ++sharedSaveSequence;
    latestSharedSaveByScope.set(scopeKey, saveSequence);
    if (
      mountedRef.current &&
      activeUserIdRef.current === userId &&
      activeTargetRef.current === targetKey(targetProjectId, targetTreeId)
    ) {
      setSyncState("saving");
    }

    const previousSave = sharedSaveChainsByScope.get(scopeKey) ?? Promise.resolve();
    const operation = previousSave
      .catch(() => undefined)
      .then(async () => {
        const stored = await saveFamilyTreeViewPreference(
          targetProjectId,
          targetTreeId,
          normalized,
          userId,
        );
        const isLatest = latestSharedSaveByScope.get(scopeKey) === saveSequence;
        const currentCache = readFamilyTreeViewPreferenceCache(
          userId,
          targetProjectId,
          targetTreeId,
        );
        const cacheMatchesSavedValue =
          currentCache.found &&
          sameFamilyTreeViewPreferences(
            currentCache.preferences,
            stored.preferences,
          );
        const acknowledgesCurrentDirtyValue =
          cacheMatchesSavedValue &&
          currentCache.dirty &&
          sameFamilyTreeViewPreferences(stored.preferences, normalized);
        if (isLatest && acknowledgesCurrentDirtyValue) {
          writeFamilyTreeViewPreferenceCache(
            userId,
            targetProjectId,
            targetTreeId,
            stored.preferences,
            false,
          );
        }
        const canApplyAcknowledgement = !currentCache.found || cacheMatchesSavedValue;
        if (
          isLatest &&
          canApplyAcknowledgement &&
          mountedRef.current &&
          activeUserIdRef.current === userId &&
          activeTargetRef.current === targetKey(targetProjectId, targetTreeId)
        ) {
          preferencesRef.current = stored.preferences;
          setPreferences(stored.preferences);
          setSyncState("saved");
        } else if (
          isLatest &&
          currentCache.found &&
          !cacheMatchesSavedValue &&
          mountedRef.current &&
          activeUserIdRef.current === userId &&
          activeTargetRef.current === targetKey(targetProjectId, targetTreeId)
        ) {
          // Another browser tab has a newer cached value. Preserve that value
          // as dirty for retry instead of letting this stale acknowledgement
          // replace live state or claim that the current choice was saved.
          writeFamilyTreeViewPreferenceCache(
            userId,
            targetProjectId,
            targetTreeId,
            currentCache.preferences,
            true,
          );
          setSyncState("error");
        }
      });

    const settledOperation = operation.then(() => undefined, () => undefined);
    sharedSaveChainsByScope.set(scopeKey, settledOperation);
    void settledOperation.then(() => {
      if (sharedSaveChainsByScope.get(scopeKey) === settledOperation) {
        sharedSaveChainsByScope.delete(scopeKey);
        if (latestSharedSaveByScope.get(scopeKey) === saveSequence) {
          latestSharedSaveByScope.delete(scopeKey);
        }
      }
    });
    void operation.catch(() => {
      if (
        latestSharedSaveByScope.get(scopeKey) === saveSequence &&
        mountedRef.current &&
        activeUserIdRef.current === userId &&
        activeTargetRef.current === targetKey(targetProjectId, targetTreeId)
      ) {
        setSyncState("error");
      }
    });
  }, []);

  useEffect(() => {
    const loadSequence = ++loadSequenceRef.current;
    const currentTarget = targetKey(projectId, treeId);
    const startingEditSequence = editSequenceRef.current;
    activeUserIdRef.current = "";
    setReady(false);

    if (!projectId || !treeId) {
      const defaults = normalizeFamilyTreeViewPreferences(
        DEFAULT_FAMILY_TREE_VIEW_PREFERENCES,
      );
      preferencesRef.current = defaults;
      setPreferences(defaults);
      setSyncState("idle");
      return;
    }

    // Clear the previous scope before auth resolves: another account's cache is
    // never rendered, even briefly, on a shared browser.
    const defaults = normalizeFamilyTreeViewPreferences(
      DEFAULT_FAMILY_TREE_VIEW_PREFERENCES,
    );
    preferencesRef.current = defaults;
    setPreferences(defaults);
    setSyncState("loading");

    void getAuthenticatedFamilyTreeViewPreferenceUserId()
      .then(async (userId) => {
        if (
          !mountedRef.current ||
          loadSequenceRef.current !== loadSequence ||
          activeTargetRef.current !== currentTarget
        ) {
          return;
        }
        activeUserIdRef.current = userId;

        // A user may edit while auth is resolving. Preserve that edit instead
        // of replacing it with an older cache/server value.
        if (editSequenceRef.current !== startingEditSequence) {
          const edited = preferencesRef.current;
          writeFamilyTreeViewPreferenceCache(
            userId,
            projectId,
            treeId,
            edited,
            true,
          );
          setReady(true);
          queueRemoteSave(userId, projectId, treeId, edited);
          return;
        }

        const cached = readFamilyTreeViewPreferenceCache(
          userId,
          projectId,
          treeId,
        );
        preferencesRef.current = cached.preferences;
        setPreferences(cached.preferences);

        // A previous failed/aborted save is newer than the server by
        // definition. Replay it and keep the dirty marker until acknowledgement.
        if (cached.dirty) {
          setReady(true);
          queueRemoteSave(userId, projectId, treeId, cached.preferences);
          return;
        }

        const editSequenceBeforeLoad = editSequenceRef.current;
        const stored = await loadFamilyTreeViewPreference(
          projectId,
          treeId,
          userId,
        );
        if (
          !mountedRef.current ||
          loadSequenceRef.current !== loadSequence ||
          activeTargetRef.current !== currentTarget ||
          activeUserIdRef.current !== userId ||
          editSequenceRef.current !== editSequenceBeforeLoad
        ) {
          return;
        }

        if (stored) {
          preferencesRef.current = stored.preferences;
          setPreferences(stored.preferences);
          writeFamilyTreeViewPreferenceCache(
            userId,
            projectId,
            treeId,
            stored.preferences,
            false,
          );
          setReady(true);
          setSyncState("saved");
          return;
        }

        // First open after the additive migration: promote the scoped browser
        // value (or safe defaults) into the user's durable row.
        writeFamilyTreeViewPreferenceCache(
          userId,
          projectId,
          treeId,
          cached.preferences,
          true,
        );
        setReady(true);
        queueRemoteSave(userId, projectId, treeId, cached.preferences);
      })
      .catch(() => {
        if (
          mountedRef.current &&
          loadSequenceRef.current === loadSequence &&
          activeTargetRef.current === currentTarget
        ) {
          setReady(Boolean(activeUserIdRef.current));
          setSyncState("error");
        }
      });
  }, [projectId, queueRemoteSave, treeId]);

  const updatePreferences = useCallback((update: FamilyTreeViewPreferenceUpdate) => {
    const next = normalizeFamilyTreeViewPreferences(
      typeof update === "function" ? update(preferencesRef.current) : update,
    );
    editSequenceRef.current += 1;
    preferencesRef.current = next;
    setPreferences(next);

    const userId = activeUserIdRef.current;
    if (!projectId || !treeId || !userId) {
      // The auth-hydration effect will persist this in-memory edit as soon as
      // it can bind it to an authenticated user id.
      setSyncState(projectId && treeId ? "loading" : "idle");
      return;
    }

    writeFamilyTreeViewPreferenceCache(
      userId,
      projectId,
      treeId,
      next,
      true,
    );
    queueRemoteSave(userId, projectId, treeId, next);
  }, [projectId, queueRemoteSave, treeId]);

  return { preferences, syncState, ready, updatePreferences };
}
