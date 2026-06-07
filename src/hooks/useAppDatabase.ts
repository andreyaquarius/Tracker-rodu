import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppDatabase,
  AppEntity,
  CollectionKey,
  GoogleUser,
  SyncState,
} from "../types";
import { isSameLocalDay, nowIso } from "../utils/dateHelpers";
import { saveLocalCopy, loadLocalCopy } from "../services/localStorageDb";
import {
  fetchGoogleUser,
  getAccessToken,
  getGoogleSession,
  saveGoogleSessionDetails,
  signInWithGoogle,
  signOutFromGoogle,
} from "../services/googleAuth";
import {
  createDatabaseFileInAppDataFolder,
  createAppDataBackup,
  downloadDatabaseFile,
  ensureDatabaseFileName,
  findDatabaseFileInAppDataFolder,
  updateDatabaseFile,
} from "../services/googleDrive";
import { scheduleAutoSave } from "../services/syncService";
import { createActivityEntries } from "../utils/activityLog";

export function useAppDatabase() {
  const initialGoogleSession = useRef(getGoogleSession());
  const [db, setDbState] = useState<AppDatabase>(() => loadLocalCopy());
  const [user, setUser] = useState<GoogleUser | null>(
    () => initialGoogleSession.current?.user ?? null,
  );
  const [sync, setSync] = useState<SyncState>({
    status: navigator.onLine
      ? initialGoogleSession.current?.user
        ? "synced"
        : "local"
      : "offline",
    lastSyncedAt: initialGoogleSession.current?.lastSyncedAt ?? null,
  });
  const [isSigningIn, setIsSigningIn] = useState(false);
  const dbRef = useRef(db);
  const driveFileId = useRef<string | null>(
    initialGoogleSession.current?.driveFileId ?? null,
  );
  const syncing = useRef(false);
  const driveFileNameEnsured = useRef(false);
  const dailyBackupRunning = useRef(false);

  const setDatabase = useCallback((next: AppDatabase | ((current: AppDatabase) => AppDatabase)) => {
    setDbState((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      const stamped = { ...resolved, updatedAt: nowIso() };
      dbRef.current = stamped;
      saveLocalCopy(stamped);
      setSync((state) => ({
        ...state,
        status: navigator.onLine && getAccessToken() ? "pending" : navigator.onLine ? "local" : "offline",
      }));
      return stamped;
    });
  }, []);

  const createDailyBackupIfNeeded = useCallback(async () => {
    const token = getAccessToken();
    if (
      !token ||
      dailyBackupRunning.current ||
      isSameLocalDay(dbRef.current.settings.lastAutomaticBackupAt)
    ) {
      return;
    }
    dailyBackupRunning.current = true;
    try {
      await createAppDataBackup(token, dbRef.current, "automatic");
      const backedUpAt = nowIso();
      setDatabase((current) => ({
        ...current,
        settings: {
          ...current.settings,
          lastAutomaticBackupAt: backedUpAt,
        },
      }));
    } finally {
      dailyBackupRunning.current = false;
    }
  }, [setDatabase]);

  const forceSyncNow = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      setSync((state) => ({ ...state, status: navigator.onLine ? "local" : "offline" }));
      throw new Error("Спочатку увійдіть через Google.");
    }
    if (!navigator.onLine) {
      setSync((state) => ({ ...state, status: "offline" }));
      return;
    }
    if (syncing.current) return;
    syncing.current = true;
    setSync((state) => ({ ...state, status: "pending" }));
    try {
      let fileId = driveFileId.current;
      if (!fileId) {
        const existing = await findDatabaseFileInAppDataFolder(token);
        if (existing) fileId = existing.id;
        else fileId = (await createDatabaseFileInAppDataFolder(token, dbRef.current)).id;
        driveFileId.current = fileId;
      }
      if (!driveFileNameEnsured.current) {
        await ensureDatabaseFileName(token, fileId);
        driveFileNameEnsured.current = true;
      }
      await updateDatabaseFile(token, fileId, dbRef.current);
      const lastSyncedAt = nowIso();
      saveGoogleSessionDetails({ driveFileId: fileId, lastSyncedAt });
      setSync({ status: "synced", lastSyncedAt });
    } catch (error) {
      setSync((state) => ({
        ...state,
        status: navigator.onLine ? "error" : "offline",
        message: error instanceof Error ? error.message : "Невідома помилка синхронізації.",
      }));
      throw error;
    } finally {
      syncing.current = false;
    }
  }, []);

  useEffect(() => {
    if (sync.status !== "pending" || !getAccessToken()) return;
    return scheduleAutoSave(() => {
      void forceSyncNow().catch(() => undefined);
    });
  }, [db.updatedAt, forceSyncNow, sync.status]);

  useEffect(() => {
    if (!user || !getAccessToken()) return;
    void createDailyBackupIfNeeded().catch(() => undefined);
  }, [createDailyBackupIfNeeded, user]);

  useEffect(() => {
    const online = () => {
      setSync((state) => ({ ...state, status: getAccessToken() ? "pending" : "local" }));
      if (getAccessToken()) void forceSyncNow().catch(() => undefined);
    };
    const offline = () => setSync((state) => ({ ...state, status: "offline" }));
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [forceSyncNow]);

  const connectGoogle = useCallback(async () => {
    setIsSigningIn(true);
    try {
      const token = await signInWithGoogle();
      const [profile, driveFile] = await Promise.all([
        fetchGoogleUser(token),
        findDatabaseFileInAppDataFolder(token),
      ]);
      setUser(profile);
      if (!driveFile) {
        const created = await createDatabaseFileInAppDataFolder(token, dbRef.current);
        driveFileId.current = created.id;
        const lastSyncedAt = nowIso();
        saveGoogleSessionDetails({
          user: profile,
          driveFileId: created.id,
          lastSyncedAt,
        });
        setSync({ status: "synced", lastSyncedAt });
        void createDailyBackupIfNeeded().catch(() => undefined);
        return;
      }
      driveFileId.current = driveFile.id;
      const remote = await downloadDatabaseFile(token, driveFile.id);
      const localTime = new Date(dbRef.current.updatedAt).getTime();
      const remoteTime = new Date(remote.updatedAt).getTime();
      if (remoteTime > localTime) {
        const useRemote = window.confirm(
          "Копія на Google Drive новіша за локальну. Завантажити версію з Google Drive?",
        );
        if (useRemote) {
          dbRef.current = remote;
          saveLocalCopy(remote);
          setDbState(remote);
        }
      } else if (localTime > remoteTime) {
        const uploadLocal = window.confirm(
          "Локальна копія новіша за Google Drive. Синхронізувати її з Google Drive?",
        );
        if (uploadLocal) await updateDatabaseFile(token, driveFile.id, dbRef.current);
      }
      const lastSyncedAt = nowIso();
      saveGoogleSessionDetails({
        user: profile,
        driveFileId: driveFile.id,
        lastSyncedAt,
      });
      setSync({ status: "synced", lastSyncedAt });
      void createDailyBackupIfNeeded().catch(() => undefined);
    } catch (error) {
      setSync({
        status: "error",
        lastSyncedAt: null,
        message: error instanceof Error ? error.message : "Не вдалося виконати вхід.",
      });
      throw error;
    } finally {
      setIsSigningIn(false);
    }
  }, [createDailyBackupIfNeeded]);

  const disconnectGoogle = useCallback(() => {
    signOutFromGoogle();
    driveFileId.current = null;
    driveFileNameEnsured.current = false;
    setUser(null);
    setSync({ status: navigator.onLine ? "local" : "offline", lastSyncedAt: null });
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

  const deleteEntity = useCallback(
    (collection: CollectionKey, id: string) => {
      setDatabase((current) => ({
        ...current,
        [collection]: (current[collection] as AppEntity[]).filter((item) => item.id !== id),
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
    user,
    sync,
    isSigningIn,
    connectGoogle,
    disconnectGoogle,
    forceSyncNow,
    saveEntity,
    deleteEntity,
    setDatabase,
    replaceDatabase,
  };
}
