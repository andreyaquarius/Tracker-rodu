const DRIVE_FILE_ID = /^[a-zA-Z0-9_-]{10,200}$/u;
const DRIVE_API_KEY = /^[a-zA-Z0-9_-]{20,512}$/u;

export type GoogleDrivePublicErrorCode =
  | "REFERENCE_INVALID"
  | "API_KEY_INVALID"
  | "METADATA_INVALID"
  | "SOURCE_NOT_PDF"
  | "DOWNLOAD_FORBIDDEN";

export class GoogleDrivePublicError extends Error {
  readonly code: GoogleDrivePublicErrorCode;

  constructor(code: GoogleDrivePublicErrorCode) {
    super(code);
    this.name = "GoogleDrivePublicError";
    this.code = code;
  }
}

export interface GoogleDrivePublicReference {
  fileId: string;
  canonicalUrl: string;
}

export interface GoogleDrivePublicMetadata {
  id: string;
  name: string;
  mimeType: "application/pdf";
  size?: number;
  modifiedTime?: string;
  md5Checksum?: string;
  headRevisionId?: string;
}

export function parseGoogleDrivePublicReference(value: unknown): GoogleDrivePublicReference {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) {
    throw new GoogleDrivePublicError("REFERENCE_INVALID");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new GoogleDrivePublicError("REFERENCE_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new GoogleDrivePublicError("REFERENCE_INVALID");
  }
  const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
  let fileId = "";
  if (host === "drive.google.com") {
    const pathMatch = /^\/file\/(?:u\/\d+\/)?d\/([^/]+)(?:\/|$)/u.exec(url.pathname);
    fileId = pathMatch?.[1] ? safeDecode(pathMatch[1]) : "";
    if (!fileId && /^\/(?:open|uc)\/?$/u.test(url.pathname)) {
      fileId = url.searchParams.get("id")?.trim() ?? "";
    }
  } else if (host === "docs.google.com") {
    const pathMatch = /^\/(?:document|spreadsheets|presentation|drawings)\/d\/([^/]+)(?:\/|$)/u.exec(
      url.pathname,
    );
    fileId = pathMatch?.[1] ? safeDecode(pathMatch[1]) : "";
  }
  if (!DRIVE_FILE_ID.test(fileId)) {
    throw new GoogleDrivePublicError("REFERENCE_INVALID");
  }
  return {
    fileId,
    canonicalUrl: `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`,
  };
}

export function googleDrivePublicMetadataUrl(fileId: string, apiKey: string): URL {
  const url = googleDriveApiUrl(fileId, apiKey);
  url.searchParams.set(
    "fields",
    "id,name,mimeType,size,modifiedTime,md5Checksum,headRevisionId,capabilities(canDownload),trashed",
  );
  return url;
}

export function googleDrivePublicMediaUrl(fileId: string, apiKey: string): URL {
  const url = googleDriveApiUrl(fileId, apiKey);
  url.searchParams.set("alt", "media");
  return url;
}

export function parseGoogleDrivePublicMetadata(
  payload: unknown,
  expectedFileId: string,
): GoogleDrivePublicMetadata {
  if (!isRecord(payload) || payload.id !== expectedFileId || payload.trashed === true) {
    throw new GoogleDrivePublicError("METADATA_INVALID");
  }
  if (payload.mimeType !== "application/pdf") {
    throw new GoogleDrivePublicError("SOURCE_NOT_PDF");
  }
  if (isRecord(payload.capabilities) && payload.capabilities.canDownload === false) {
    throw new GoogleDrivePublicError("DOWNLOAD_FORBIDDEN");
  }
  const name = boundedString(payload.name, 250) ?? "Google Drive PDF";
  const size = optionalSafeSize(payload.size);
  const modifiedTime = boundedString(payload.modifiedTime, 100);
  const md5Checksum = boundedString(payload.md5Checksum, 200);
  const headRevisionId = boundedString(payload.headRevisionId, 500);
  return {
    id: expectedFileId,
    name,
    mimeType: "application/pdf",
    ...(size === undefined ? {} : { size }),
    ...(modifiedTime ? { modifiedTime } : {}),
    ...(md5Checksum ? { md5Checksum } : {}),
    ...(headRevisionId ? { headRevisionId } : {}),
  };
}

function googleDriveApiUrl(fileId: string, apiKey: string): URL {
  if (!DRIVE_FILE_ID.test(fileId) || !DRIVE_API_KEY.test(apiKey.trim())) {
    throw new GoogleDrivePublicError(
      DRIVE_FILE_ID.test(fileId) ? "API_KEY_INVALID" : "REFERENCE_INVALID",
    );
  }
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
  );
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("key", apiKey.trim());
  return url;
}

function optionalSafeSize(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new GoogleDrivePublicError("METADATA_INVALID");
  }
  return normalized;
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new GoogleDrivePublicError("METADATA_INVALID");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new GoogleDrivePublicError("METADATA_INVALID");
  }
  return normalized;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
