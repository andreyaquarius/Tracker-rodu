export type EntitySaveOperationResult<T> = T | null | void;

export type EntitySaveOutcome<T> =
  | { status: "saved"; value: T | void }
  | { status: "failed"; message: string };

const REJECTED_SAVE_MESSAGE =
  "Зміни не збережено. Перевірте доступ, обмеження тарифу або введені дані й спробуйте ще раз.";
const FAILED_SAVE_MESSAGE = "Не вдалося зберегти запис. Спробуйте ще раз.";

/**
 * Normalizes synchronous and asynchronous CRUD handlers for modal forms.
 * Existing handlers that return void remain successful; null explicitly means
 * that the caller rejected or could not persist the record.
 */
export async function settleEntitySave<T>(
  operation: () => EntitySaveOperationResult<T> | Promise<EntitySaveOperationResult<T>>,
): Promise<EntitySaveOutcome<T>> {
  try {
    const value = await operation();
    return value === null
      ? { status: "failed", message: REJECTED_SAVE_MESSAGE }
      : { status: "saved", value };
  } catch (error) {
    const details = error instanceof Error ? error.message.trim() : "";
    return {
      status: "failed",
      message: details ? `Не вдалося зберегти запис. ${details}` : FAILED_SAVE_MESSAGE,
    };
  }
}
