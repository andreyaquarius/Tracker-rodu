import { useCallback, useEffect, useState } from "react";
import type { PersonName } from "../types/index.ts";
import { listProjectPersonCatalogNames } from "../services/projectPersonNames.ts";

const EMPTY_NAMES: readonly PersonName[] = [];

/** One paginated projection per account/project, not an N+1 fetch per visible person. */
export function usePersonCatalogNames(projectId: string | undefined, cacheScope: string, enabled: boolean) {
  const key = JSON.stringify([projectId ?? "", cacheScope]);
  const [snapshot, setSnapshot] = useState<{ key: string; names: readonly PersonName[]; error: string }>();
  const loadedKey = snapshot?.key;
  useEffect(() => {
    if (!enabled || !projectId || loadedKey === key) return;
    const controller = new AbortController();
    void listProjectPersonCatalogNames(projectId, controller.signal).then(names => {
      if (!controller.signal.aborted) setSnapshot({ key, names, error: "" });
    }).catch(() => {
      if (!controller.signal.aborted) setSnapshot({ key, names: [], error: "Не вдалося завантажити додаткові варіанти імен. Показано відомі поля карток; оновіть сторінку, щоб повторити завантаження." });
    });
    return () => controller.abort();
  }, [enabled, key, loadedKey, projectId]);

  const replacePersonNames = useCallback((personId: string, names: readonly PersonName[]) => {
    setSnapshot(current => current?.key === key ? {
      ...current,
      names: [...current.names.filter(name => name.personId !== personId), ...names.filter(name => name.personId === personId)],
    } : current);
  }, [key]);
  return {
    names: snapshot?.key === key ? snapshot.names : EMPTY_NAMES,
    error: snapshot?.key === key ? snapshot.error : "",
    replacePersonNames,
  };
}
