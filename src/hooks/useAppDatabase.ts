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
import {
  deleteMigratedLocalFiles,
  migrateLocalAttachmentsToDrive,
} from "../services/scanStorage";

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
  const attachmentWarningShown = useRef(false);

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
      const remote = await downloadDatabaseFile(token, fileId);
      if (isDatabaseEmpty(dbRef.current) && !isDatabaseEmpty(remote)) {
        dbRef.current = remote;
        saveLocalCopy(remote);
        setDbState(remote);
        const migration = await migrateLocalAttachmentsToDrive(remote);
        if (migration.migrated.length) {
          dbRef.current = migration.db;
          saveLocalCopy(migration.db);
          setDbState(migration.db);
          await updateDatabaseFile(token, fileId, migration.db);
          await deleteMigratedLocalFiles(migration.migrated);
        }
        reportUnavailableAttachments(migration.unavailable);
        const lastSyncedAt = nowIso();
        saveGoogleSessionDetails({ driveFileId: fileId, lastSyncedAt });
        setSync({ status: "synced", lastSyncedAt });
        return;
      }
      const migration = await migrateLocalAttachmentsToDrive(dbRef.current);
      if (migration.migrated.length) {
        dbRef.current = migration.db;
        saveLocalCopy(migration.db);
        setDbState(migration.db);
      }
      reportUnavailableAttachments(migration.unavailable);
      await updateDatabaseFile(token, fileId, dbRef.current);
      if (migration.migrated.length) {
        await deleteMigratedLocalFiles(migration.migrated);
      }
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
      if (!driveFile) {
        const migration = await migrateLocalAttachmentsToDrive(dbRef.current);
        if (migration.migrated.length) replaceLocalDatabase(migration.db);
        reportUnavailableAttachments(migration.unavailable);
        const created = await createDatabaseFileInAppDataFolder(token, dbRef.current);
        if (migration.migrated.length) {
          await deleteMigratedLocalFiles(migration.migrated);
        }
        driveFileId.current = created.id;
        const lastSyncedAt = nowIso();
        saveGoogleSessionDetails({
          user: profile,
          driveFileId: created.id,
          lastSyncedAt,
        });
        setUser(profile);
        setSync({ status: "synced", lastSyncedAt });
        void createDailyBackupIfNeeded().catch(() => undefined);
        return;
      }
      driveFileId.current = driveFile.id;
      const remote = await downloadDatabaseFile(token, driveFile.id);
      const localTime = new Date(dbRef.current.updatedAt).getTime();
      const remoteTime = new Date(remote.updatedAt).getTime();
      const localEmpty = isDatabaseEmpty(dbRef.current);
      const remoteEmpty = isDatabaseEmpty(remote);
      if (localEmpty && !remoteEmpty) {
        replaceLocalDatabase(remote);
      } else if (!localEmpty && remoteEmpty) {
        const uploadLocal = window.confirm(
          "На цьому пристрої є дані, а база на Google Drive порожня. Завантажити локальні дані на Google Drive?",
        );
        if (uploadLocal) {
          await updateDatabaseFile(token, driveFile.id, dbRef.current);
        } else {
          throw new Error("Синхронізацію скасовано, щоб не втратити локальні дані.");
        }
      } else if (remoteTime > localTime) {
        const useRemote = window.confirm(
          "Копія на Google Drive новіша за локальну. Завантажити версію з Google Drive?",
        );
        if (useRemote) {
          replaceLocalDatabase(remote);
        } else {
          const uploadLocal = window.confirm(
            "Залишити локальну версію та замінити нею базу на Google Drive?",
          );
          if (uploadLocal) {
            await createAppDataBackup(token, remote, "manual");
            await updateDatabaseFile(token, driveFile.id, dbRef.current);
          } else {
            throw new Error("Синхронізацію скасовано. Обидві версії залишено без змін.");
          }
        }
      } else if (localTime > remoteTime) {
        const uploadLocal = window.confirm(
          "Локальна копія новіша за Google Drive. Синхронізувати її з Google Drive?",
        );
        if (uploadLocal) {
          await createAppDataBackup(token, remote, "manual");
          await updateDatabaseFile(token, driveFile.id, dbRef.current);
        } else {
          const useRemote = window.confirm(
            "Тоді завантажити версію з Google Drive замість локальної?",
          );
          if (useRemote) {
            replaceLocalDatabase(remote);
          } else {
            throw new Error("Синхронізацію скасовано. Обидві версії залишено без змін.");
          }
        }
      }
      const migration = await migrateLocalAttachmentsToDrive(dbRef.current);
      if (migration.migrated.length) {
        replaceLocalDatabase(migration.db);
        await updateDatabaseFile(token, driveFile.id, dbRef.current);
        await deleteMigratedLocalFiles(migration.migrated);
      }
      reportUnavailableAttachments(migration.unavailable);
      const lastSyncedAt = nowIso();
      saveGoogleSessionDetails({
        user: profile,
        driveFileId: driveFile.id,
        lastSyncedAt,
      });
      setUser(profile);
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

  function replaceLocalDatabase(next: AppDatabase): void {
    dbRef.current = next;
    saveLocalCopy(next);
    setDbState(next);
  }

  function reportUnavailableAttachments(names: string[]): void {
    if (!names.length || attachmentWarningShown.current) return;
    attachmentWarningShown.current = true;
    const preview = names.slice(0, 3).join(", ");
    const rest = names.length > 3 ? ` та ще ${names.length - 3}` : "";
    window.alert(
      `Не вдалося перенести ${names.length} локальних вкладень: ${preview}${rest}. ` +
      "Їх немає у сховищі цього сайту. Відкрийте застосунок на пристрої та за адресою, де файли додавалися, або прикріпіть їх повторно.",
    );
  }
}

function isDatabaseEmpty(db: AppDatabase): boolean {
  return (
    db.researches.length === 0 &&
    db.documents.length === 0 &&
    db.yearMatrix.length === 0 &&
    db.tasks.length === 0 &&
    db.findings.length === 0 &&
    db.hypotheses.length === 0 &&
    db.archiveRequests.length === 0 &&
    db.persons.length === 0 &&
    db.personRelations.length === 0
  );
}
