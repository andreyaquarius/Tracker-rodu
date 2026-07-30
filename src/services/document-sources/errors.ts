export type DocumentSourceErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SCHEME"
  | "SENSITIVE_URL_NOT_PERSISTABLE"
  | "UNSUPPORTED_PROVIDER"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_NOT_PDF"
  | "ACCESS_DENIED"
  | "OAUTH_REQUIRED"
  | "WIKIMEDIA_FILE_NOT_FOUND"
  | "MULTIPLE_SOURCE_CANDIDATES"
  | "GOOGLE_DRIVE_PERMISSION_DENIED"
  | "GOOGLE_DRIVE_QUOTA_EXCEEDED"
  | "SOURCE_TOO_LARGE_WITHOUT_RANGE"
  | "PDF_PASSWORD_REQUIRED"
  | "PDF_CORRUPT"
  | "SOURCE_CHANGED"
  | "EXPORT_FAILED"
  | "NETWORK_ERROR"
  | "TIMEOUT";

export type DocumentSourceRecoveryAction =
  | "connect_google_drive"
  | "check_link_access"
  | "open_original"
  | "retry"
  | "refresh_source";

export const DOCUMENT_SOURCE_ERROR_MESSAGES_UK: Readonly<Record<DocumentSourceErrorCode, string>> = {
  INVALID_URL: "Посилання має некоректний формат.",
  UNSUPPORTED_SCHEME: "Підтримуються лише захищені HTTPS-посилання.",
  SENSITIVE_URL_NOT_PERSISTABLE: "Посилання містить тимчасовий токен або цифровий підпис. Додайте стабільну сторінку документа без секретних параметрів.",
  UNSUPPORTED_PROVIDER: "Це джерело документів поки не підтримується.",
  SOURCE_NOT_FOUND: "Зовнішній документ не знайдено.",
  SOURCE_NOT_PDF: "Посилання не веде на PDF-документ.",
  ACCESS_DENIED: "Доступ до зовнішнього документа заборонено.",
  OAUTH_REQUIRED: "Для цього документа потрібно підключити обліковий запис постачальника.",
  WIKIMEDIA_FILE_NOT_FOUND: "PDF-файл у Вікісховищі або Вікіджерелах не знайдено.",
  MULTIPLE_SOURCE_CANDIDATES: "На сторінці знайдено кілька PDF. Оберіть один файл зі списку.",
  GOOGLE_DRIVE_PERMISSION_DENIED: "Google Drive не надав доступ до цього файла.",
  GOOGLE_DRIVE_QUOTA_EXCEEDED: "Перевищено квоту Google Drive. Спробуйте пізніше.",
  SOURCE_TOO_LARGE_WITHOUT_RANGE: "Документ завеликий, а джерело не підтримує часткове завантаження.",
  PDF_PASSWORD_REQUIRED: "PDF захищений паролем.",
  PDF_CORRUPT: "PDF пошкоджений або має непідтримуваний формат.",
  SOURCE_CHANGED: "Зовнішній PDF було оновлено. Перевірте пов’язані сторінки та знахідки.",
  EXPORT_FAILED: "Не вдалося підготувати вибрані сторінки.",
  NETWORK_ERROR: "Не вдалося з’єднатися із зовнішнім джерелом.",
  TIMEOUT: "Зовнішнє джерело не відповіло вчасно.",
};

export const DOCUMENT_SOURCE_ERROR_ACTIONS: Readonly<
  Partial<Record<DocumentSourceErrorCode, DocumentSourceRecoveryAction>>
> = {
  SOURCE_NOT_FOUND: "open_original",
  SENSITIVE_URL_NOT_PERSISTABLE: "check_link_access",
  ACCESS_DENIED: "check_link_access",
  OAUTH_REQUIRED: "connect_google_drive",
  WIKIMEDIA_FILE_NOT_FOUND: "open_original",
  GOOGLE_DRIVE_PERMISSION_DENIED: "connect_google_drive",
  GOOGLE_DRIVE_QUOTA_EXCEEDED: "retry",
  SOURCE_CHANGED: "refresh_source",
  NETWORK_ERROR: "retry",
  TIMEOUT: "retry",
};

export interface PublicDocumentSourceError {
  code: DocumentSourceErrorCode;
  message: string;
  action?: DocumentSourceRecoveryAction;
}

export class DocumentSourceError extends Error {
  readonly code: DocumentSourceErrorCode;
  readonly action?: DocumentSourceRecoveryAction;

  constructor(code: DocumentSourceErrorCode, options: { cause?: unknown } = {}) {
    super(DOCUMENT_SOURCE_ERROR_MESSAGES_UK[code], options.cause === undefined
      ? undefined
      : { cause: options.cause });
    this.name = "DocumentSourceError";
    this.code = code;
    this.action = DOCUMENT_SOURCE_ERROR_ACTIONS[code];
  }
}

export function toPublicDocumentSourceError(
  error: unknown,
  fallbackCode: DocumentSourceErrorCode = "NETWORK_ERROR",
): PublicDocumentSourceError {
  const sourceError = error instanceof DocumentSourceError
    ? error
    : new DocumentSourceError(fallbackCode);
  return {
    code: sourceError.code,
    message: sourceError.message,
    ...(sourceError.action ? { action: sourceError.action } : {}),
  };
}
