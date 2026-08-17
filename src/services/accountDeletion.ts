import { invokeEdgeFunction } from "./edgeFunctions";

type DeleteAccountResponse = {
  deleted: boolean;
  userId?: string;
  removedRows?: number;
};

export async function deleteAccount(): Promise<void> {
  await invokeEdgeFunction<DeleteAccountResponse>("delete-account", {});
}
