import { googleDriveStorageProvider } from "./googleDriveStorageProvider";
import type { StorageProvider } from "./storageProvider";

class StorageService {
  private provider: StorageProvider = googleDriveStorageProvider;

  setProvider(provider: StorageProvider): void {
    this.provider = provider;
  }

  findDatabase(...args: Parameters<StorageProvider["findDatabase"]>) {
    return this.provider.findDatabase(...args);
  }

  createDatabase(...args: Parameters<StorageProvider["createDatabase"]>) {
    return this.provider.createDatabase(...args);
  }

  downloadDatabase(...args: Parameters<StorageProvider["downloadDatabase"]>) {
    return this.provider.downloadDatabase(...args);
  }

  updateDatabase(...args: Parameters<StorageProvider["updateDatabase"]>) {
    return this.provider.updateDatabase(...args);
  }

  ensureDatabaseName(...args: Parameters<StorageProvider["ensureDatabaseName"]>) {
    return this.provider.ensureDatabaseName(...args);
  }

  createVisibleBackup(...args: Parameters<StorageProvider["createVisibleBackup"]>) {
    return this.provider.createVisibleBackup(...args);
  }

  createBackup(...args: Parameters<StorageProvider["createBackup"]>) {
    return this.provider.createBackup(...args);
  }

  listBackups(...args: Parameters<StorageProvider["listBackups"]>) {
    return this.provider.listBackups(...args);
  }

  downloadBackup(...args: Parameters<StorageProvider["downloadBackup"]>) {
    return this.provider.downloadBackup(...args);
  }

  deleteBackup(...args: Parameters<StorageProvider["deleteBackup"]>) {
    return this.provider.deleteBackup(...args);
  }

  uploadAttachment(...args: Parameters<StorageProvider["uploadAttachment"]>) {
    return this.provider.uploadAttachment(...args);
  }

  downloadAttachment(...args: Parameters<StorageProvider["downloadAttachment"]>) {
    return this.provider.downloadAttachment(...args);
  }

  deleteAttachment(...args: Parameters<StorageProvider["deleteAttachment"]>) {
    return this.provider.deleteAttachment(...args);
  }
}

export const storageService = new StorageService();
