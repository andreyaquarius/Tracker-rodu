import type { DocumentRecord, Finding, ScanAttachment } from "../types";
import { invokeEdgeFunction } from "./edgeFunctions";
import { getScanBlob } from "./scanStorage";

export const AI_FINDING_INDEXING_META_KEY = "__trackerRoduAiFindingIndexing";

export interface AiFindingPersonName {
  fullNameOriginal: string | null;
  fullNameNormalized: string | null;
  surnameOriginal: string | null;
  surnameNormalized: string | null;
  givenNamesOriginal: string | null;
  givenNamesNormalized: string[];
  patronymicOriginal: string | null;
  patronymicNormalized: string | null;
  gender: "male" | "female" | "unknown";
}

export interface AiFindingParticipantFacts {
  ageOriginal: string | null;
  birthDateOriginal: string | null;
  residenceOriginal: string | null;
  originPlaceOriginal: string | null;
  occupationOriginal: string | null;
  socialStatusOriginal: string | null;
  religionOriginal: string | null;
  notes: string | null;
}

export interface AiFindingParticipantCandidate {
  tempId: string;
  role: string;
  roleLabel: string;
  roleOriginalText: string | null;
  person: AiFindingPersonName;
  facts: AiFindingParticipantFacts;
  confidence: number;
  warnings: string[];
}

export interface AiFindingIndexingResult {
  schemaVersion: string;
  documentUnderstanding: {
    detectedRecordType: string;
    detectedLanguages: string[];
    handwritingOrPrint: "handwritten" | "printed" | "mixed" | "unknown";
    overallReadability: "high" | "medium" | "low" | "very_low";
    summary: string | null;
  };
  transcription: {
    originalText: string | null;
    normalizedText: string | null;
    translationToUkrainian: string | null;
    uncertainFragments: string[];
    unreadableFragments: string[];
  };
  event: {
    eventType: string;
    eventDateOriginal: string | null;
    eventDateNormalized: string | null;
    eventPlaceOriginal: string | null;
    eventPlaceNormalized: string | null;
    registrationDateOriginal: string | null;
    registrationDateNormalized: string | null;
    recordNumber: string | null;
    sourcePage: string | null;
    confidence: number;
  };
  participants: AiFindingParticipantCandidate[];
  warnings: string[];
  needsHumanReview: boolean;
}

export interface AiFindingIndexingResponse {
  jobId: string;
  createdAt: string;
  model: string;
  provider: "google_gemini";
  keySource: "platform" | "user";
  promptVersion: string;
  schemaVersion: string;
  inputSummary: {
    findingId: string;
    draft: boolean;
    attachmentId: string;
    projectId: string;
    imageMimeType: string;
    imageBytesApprox: number;
    imageSha256: string;
  };
  result: AiFindingIndexingResult;
}

export async function analyzeFindingFragmentWithAi(input: {
  finding: Partial<Finding> & { id?: string };
  documents: DocumentRecord[];
  consent: boolean;
}): Promise<AiFindingIndexingResponse> {
  const findingId = String(input.finding.id ?? "").trim();
  const scan = firstImageScan(input.finding.scans ?? []);
  if (!scan) {
    throw new Error("Для AI-розпізнавання прикріпіть до знахідки фрагмент у форматі PNG, JPEG або WebP.");
  }

  const blob = await getScanBlob(scan);
  const mimeType = normalizedImageMimeType(blob.type || scan.mimeType, scan.name);
  if (!mimeType) {
    throw new Error("Для AI-розпізнавання потрібен прикріплений фрагмент-зображення PNG, JPEG або WebP.");
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const [base64, sha256] = await Promise.all([
    bytesToBase64(bytes),
    sha256Hex(bytes),
  ]);
  const document = input.documents.find((item) => item.id === input.finding.documentId);
  const data = await invokeFindingAiFunction<AiFindingIndexingResponse>("index-finding-fragment", {
    findingId: findingId || null,
    draft: !findingId,
    attachmentId: scan.id,
    consent: input.consent,
    image: {
      mimeType,
      base64,
      sha256,
    },
    context: {
      findingType: input.finding.findingType,
      eventDate: input.finding.eventDate,
      place: input.finding.place,
      archive: input.finding.archive,
      fund: input.finding.fund,
      description: input.finding.description,
      file: input.finding.file,
      page: input.finding.page,
      summary: input.finding.summary,
      transcription: input.finding.transcription,
      documentId: input.finding.documentId,
      documentTitle: document?.title,
      documentType: document?.documentType,
      documentArchive: document?.archive,
      documentFund: document?.fund,
      documentDescription: document?.description,
      documentFile: document?.file,
      documentPlace: document?.place,
      documentYearFrom: document?.yearFrom,
      documentYearTo: document?.yearTo,
      languageHint: ["uk", "ru", "pl", "la"],
    },
  });
  return normalizeAiResponse(data);
}

function firstImageScan(scans: ScanAttachment[]): ScanAttachment | null {
  return scans.find((scan) => Boolean(normalizedImageMimeType(scan.mimeType, scan.name))) ?? null;
}

function normalizedImageMimeType(mimeType: string, fileName: string): string | null {
  const normalized = mimeType.toLocaleLowerCase();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") {
    return normalized;
  }
  const extension = fileName.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return null;
}

async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function invokeFindingAiFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T> {
  return invokeEdgeFunction<T>(name, body, {
    connectionErrorMessage:
      "Не вдалося підключитися до серверної функції AI. Перевірте, що Edge Function index-finding-fragment передеплоєно або локально запущено.",
  });
}

function normalizeAiResponse(value: AiFindingIndexingResponse): AiFindingIndexingResponse {
  return {
    ...value,
    result: {
      ...value.result,
      participants: Array.isArray(value.result?.participants)
        ? value.result.participants
        : [],
      warnings: Array.isArray(value.result?.warnings) ? value.result.warnings : [],
    },
  };
}
