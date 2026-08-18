import { invokeEdgeFunction } from "./edgeFunctions";

type DeleteAccountResponse = {
  deleted: boolean;
  removedRows?: number;
  removedStorageProjects?: number;
};

export async function deleteAccount(): Promise<void> {
  const response = await invokeEdgeFunction<DeleteAccountResponse>("delete-account", {});
  if (response?.deleted !== true) {
    throw new Error("Сервер не підтвердив видалення акаунта.");
  }
}
