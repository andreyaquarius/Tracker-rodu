import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadFamilyTreeAppearancePreference,
  saveFamilyTreeAppearancePreference,
} from "../services/familyTreeAppearancePreferences.ts";
import {
  DEFAULT_FAMILY_TREE_APPEARANCE,
  FAMILY_TREE_APPEARANCE_CHANGED_EVENT,
  familyTreeAppearanceStorageKey,
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
  options: { readOnly?: boolean; cacheScope?: string } = {},
): FamilyTreeAppearancePreferenceState {
  const { readOnly = false, cacheScope = "" } = options;
  const activeKey = `${preferenceKey(projectId, treeId)}:${cacheScope}`;
  const [appearance, setAppearance] = useState<FamilyTreeAppearancePreferences>(() => (
    readFamilyTreeAppearance(projectId ?? "", treeId ?? "")
  ));
  const [appearanceKey, setAppearanceKey] = useState(activeKey);
  const [syncState, setSyncState] = useState<FamilyTreeAppearanceSyncState>("idle");
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
    const targetKey = `${preferenceKey(targetProjectId, targetTreeId)}:${cacheScope}`;
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
  }, [cacheScope]);

  useEffect(() => {
    const loadSequence = ++loadSequenceRef.current;
    const startingEditSequence = editSequenceRef.current;
    setAppearanceKey(activeKey);

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
          activeKeyRef.current !== activeKey ||
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
        if (readOnly) setSyncState("idle");
        else queueRemoteSave(projectId, treeId, cached);
      })
      .catch(() => {
        if (
          mountedRef.current &&
          loadSequenceRef.current === loadSequence &&
          activeKeyRef.current === activeKey &&
          editSequenceRef.current === startingEditSequence
        ) {
          setSyncState("error");
        }
      });
  }, [activeKey, projectId, queueRemoteSave, readOnly, treeId]);

  useEffect(() => {
    if (!readOnly || !projectId || !treeId || typeof window === "undefined") return;
    const refreshCached = () => {
      // A newer live tree choice must win over an older in-flight server load.
      editSequenceRef.current += 1;
      setAppearance(readFamilyTreeAppearance(projectId, treeId));
      setAppearanceKey(activeKey);
    };
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; treeId: string }>).detail;
      if (detail?.projectId === projectId && detail.treeId === treeId) refreshCached();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === familyTreeAppearanceStorageKey(projectId, treeId) || event.key === null) refreshCached();
    };
    window.addEventListener(FAMILY_TREE_APPEARANCE_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(FAMILY_TREE_APPEARANCE_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [activeKey, projectId, readOnly, treeId]);

  const updateAppearance = useCallback((
    value: FamilyTreeAppearancePreferences,
  ) => {
    if (readOnly) return;
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
  }, [projectId, queueRemoteSave, readOnly, treeId]);

  return {
    appearance: appearanceKey === activeKey
      ? appearance
      : readFamilyTreeAppearance(projectId ?? "", treeId ?? ""),
    syncState,
    updateAppearance,
  };
}
