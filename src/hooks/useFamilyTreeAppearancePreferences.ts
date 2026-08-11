import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadFamilyTreeAppearancePreference,
  saveFamilyTreeAppearancePreference,
} from "../services/familyTreeAppearancePreferences.ts";
import {
  DEFAULT_FAMILY_TREE_APPEARANCE,
  normalizeFamilyTreeAppearance,
  readFamilyTreeAppearance,
  writeFamilyTreeAppearance,
  type FamilyTreeAppearancePreferences,
} from "../utils/familyTreeAppearance.ts";

export type FamilyTreeAppearanceSyncState =
  | "idle"
  | "loading"
  | "saving"
  | "saved"
  | "error";

export interface FamilyTreeAppearancePreferenceState {
  appearance: FamilyTreeAppearancePreferences;
  syncState: FamilyTreeAppearanceSyncState;
  updateAppearance: (value: FamilyTreeAppearancePreferences) => void;
}

function preferenceKey(projectId?: string, treeId?: string): string {
  return projectId && treeId ? `${projectId}:${treeId}` : "";
}

/**
 * Keeps the server-side per-user preference authoritative while retaining
 * localStorage as an instant/offline cache. Writes are serialized so rapid
 * colour changes cannot arrive at Supabase out of order.
 */
export function useFamilyTreeAppearancePreferences(
  projectId?: string,
  treeId?: string,
): FamilyTreeAppearancePreferenceState {
  const [appearance, setAppearance] = useState<FamilyTreeAppearancePreferences>({
    ...DEFAULT_FAMILY_TREE_APPEARANCE,
  });
  const [syncState, setSyncState] = useState<FamilyTreeAppearanceSyncState>("idle");
  const activeKey = preferenceKey(projectId, treeId);
  const activeKeyRef = useRef(activeKey);
  const mountedRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const editSequenceRef = useRef(0);
  const saveSequenceRef = useRef(0);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  activeKeyRef.current = activeKey;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const queueRemoteSave = useCallback((
    targetProjectId: string,
    targetTreeId: string,
    value: FamilyTreeAppearancePreferences,
  ) => {
    const targetKey = preferenceKey(targetProjectId, targetTreeId);
    const saveSequence = ++saveSequenceRef.current;
    if (mountedRef.current && activeKeyRef.current === targetKey) {
      setSyncState("saving");
    }

    const operation = saveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const stored = await saveFamilyTreeAppearancePreference(
          targetProjectId,
          targetTreeId,
          value,
        );
        writeFamilyTreeAppearance(targetProjectId, targetTreeId, stored.appearance);
        if (
          mountedRef.current &&
          activeKeyRef.current === targetKey &&
          saveSequenceRef.current === saveSequence
        ) {
          setSyncState("saved");
        }
      });

    saveChainRef.current = operation.then(() => undefined, () => undefined);
    void operation.catch(() => {
      if (
        mountedRef.current &&
        activeKeyRef.current === targetKey &&
        saveSequenceRef.current === saveSequence
      ) {
        setSyncState("error");
      }
    });
  }, []);

  useEffect(() => {
    const loadSequence = ++loadSequenceRef.current;
    const startingEditSequence = editSequenceRef.current;

    if (!projectId || !treeId) {
      setAppearance({ ...DEFAULT_FAMILY_TREE_APPEARANCE });
      setSyncState("idle");
      return;
    }

    const cached = readFamilyTreeAppearance(projectId, treeId);
    setAppearance(cached);
    setSyncState("loading");

    void loadFamilyTreeAppearancePreference(projectId, treeId)
      .then((stored) => {
        if (
          !mountedRef.current ||
          loadSequenceRef.current !== loadSequence ||
          activeKeyRef.current !== preferenceKey(projectId, treeId) ||
          editSequenceRef.current !== startingEditSequence
        ) {
          return;
        }

        if (stored) {
          setAppearance(stored.appearance);
          writeFamilyTreeAppearance(projectId, treeId, stored.appearance);
          setSyncState("saved");
          return;
        }

        // First launch after the migration: promote the existing browser value
        // (including earlier colour choices) into the user's cloud preference.
        queueRemoteSave(projectId, treeId, cached);
      })
      .catch(() => {
        if (
          mountedRef.current &&
          loadSequenceRef.current === loadSequence &&
          activeKeyRef.current === preferenceKey(projectId, treeId) &&
          editSequenceRef.current === startingEditSequence
        ) {
          setSyncState("error");
        }
      });
  }, [projectId, queueRemoteSave, treeId]);

  const updateAppearance = useCallback((
    value: FamilyTreeAppearancePreferences,
  ) => {
    const normalized = normalizeFamilyTreeAppearance(value);
    editSequenceRef.current += 1;
    setAppearance(normalized);

    if (!projectId || !treeId) {
      setSyncState("idle");
      return;
    }

    // Cache immediately for a responsive tree, then persist to the account.
    writeFamilyTreeAppearance(projectId, treeId, normalized);
    queueRemoteSave(projectId, treeId, normalized);
  }, [projectId, queueRemoteSave, treeId]);

  return { appearance, syncState, updateAppearance };
}
