import type { AppDatabase, BackupType, DriveBackupFile } from "../../types";

export interface StoredFile {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
}

export interface StorageProvider {
  findDatabase(token: string): Promise<StoredFile | null>;
  createDatabase(token: string, db: AppDatabase): Promise<StoredFile>;
  downloadDatabase(token: string, fileId: string): Promise<AppDatabase>;
  updateDatabase(token: string, fileId: string, db: AppDatabase): Promise<StoredFile>;
  ensureDatabaseName(token: string, fileId: string): Promise<void>;
  createVisibleBackup(token: string, db: AppDatabase): Promise<StoredFile>;
  createBackup(
    token: string,
    db: AppDatabase,
    type: BackupType,
  ): Promise<DriveBackupFile>;
  listBackups(token: string): Promise<DriveBackupFile[]>;
  downloadBackup(token: string, fileId: string): Promise<AppDatabase>;
  deleteBackup(token: string, fileId: string): Promise<void>;
  uploadAttachment(
    token: string,
    file: File,
    attachmentId: string,
  ): Promise<string>;
  downloadAttachment(token: string, fileId: string): Promise<Blob>;
  deleteAttachment(token: string, fileId: string): Promise<void>;
}
