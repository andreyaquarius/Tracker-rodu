import { useCallback, useState } from "react";
import type { AppDatabase, AppEntity, CollectionKey } from "../types";
import { nowIso } from "../utils/dateHelpers";
import { createActivityEntries } from "../utils/activityLog";
import { createEmptyDatabase } from "../utils/database";

/**
 * Keeps the assembled project view in memory.
 * Persistent records are read from and written to the remote store in App.tsx.
 */
export function useAppDatabase() {
  const [db, setDbState] = useState<AppDatabase>(() => createEmptyDatabase());

  const setDatabase = useCallback((
    next: AppDatabase | ((current: AppDatabase) => AppDatabase),
  ) => {
    setDbState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      return { ...resolved, updatedAt: nowIso() };
    });
  }, []);

  const saveEntity = useCallback(
    (collection: CollectionKey, entity: AppEntity) => {
      setDatabase((current) => {
        const items = current[collection] as AppEntity[];
        const previous = items.find((item) => item.id === entity.id);
        const nextItems = previous
          ? items.map((item) => (item.id === entity.id ? entity : item))
          : [entity, ...items];
        const activityEntries = createActivityEntries(collection, previous, entity);
        return {
          ...current,
          [collection]: nextItems,
          activityLog: [...activityEntries, ...current.activityLog],
        } as AppDatabase;
      });
    },
    [setDatabase],
  );

  const saveEntities = useCallback(
    (collection: CollectionKey, entities: AppEntity[]) => {
      setDatabase((current) => {
        const importedIds = new Set(entities.map((entity) => entity.id));
        const existing = (current[collection] as AppEntity[]).filter(
          (entity) => !importedIds.has(entity.id),
        );
        const activityEntries = entities.flatMap((entity) =>
          createActivityEntries(collection, undefined, entity)
        );
        return {
          ...current,
          [collection]: [...entities, ...existing],
          activityLog: [...activityEntries, ...current.activityLog],
        } as AppDatabase;
      });
    },
    [setDatabase],
  );

  const deleteEntity = useCallback(
    (collection: CollectionKey, id: string) => {
      setDatabase((current) => ({
        ...current,
        [collection]: (current[collection] as AppEntity[]).filter(
          (item) => item.id !== id,
        ),
      }) as AppDatabase);
    },
    [setDatabase],
  );

  const replaceDatabase = useCallback(
    (next: AppDatabase) => {
      setDatabase(next);
    },
    [setDatabase],
  );

  return {
    db,
    saveEntity,
    saveEntities,
    deleteEntity,
    setDatabase,
    replaceDatabase,
  };
}
