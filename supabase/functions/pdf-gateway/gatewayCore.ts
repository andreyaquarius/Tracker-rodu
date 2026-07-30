import type { PdfGatewayLimits } from "./config.ts";
import {
  assertSameAddressSet,
  isRedirectStatus,
  parseSingleByteRange,
  resolvePublicHostAddresses,
  resolveValidatedRedirect,
  type HostAddressResolver,
  type ParsedByteRange,
  validatePublicPdfUrl,
} from "./security.ts";

export type PdfGatewayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PublicPdfFetchOptions = {
  url: string | URL;
  method: "GET" | "HEAD";
  range?: ParsedByteRange | null;
  ifRange?: string | null;
  resolver: HostAddressResolver;
  limits: PdfGatewayLimits;
  fetcher?: PdfGatewayFetch;
  clientSignal?: AbortSignal;
  /** Ephemeral upstream credential. It is attached only to the exact hosts
   * listed here and is never copied to a redirect outside that allowlist. */
  authorization?: {
    bearerToken: string;
    allowedHosts: readonly string[];
  };
};

export type PublicPdfFetchResult = {
  response: Response;
  finalUrl: URL;
  abort: (reason?: unknown) => void;
  dispose: () => void;
};

export type PdfGatewayUpstreamErrorCode =
  | "REDIRECT_LIMIT"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILED"
  | "SOURCE_NOT_PDF"
  | "SOURCE_TOO_LARGE_WITHOUT_RANGE"
  | "RANGE_RESPONSE_TOO_LARGE"
  | "RANGE_RESPONSE_INVALID"
  | "UPSTREAM_AUTH_REDIRECT_BLOCKED"
  | "EMPTY_RESPONSE";

export class PdfGatewayUpstreamError extends Error {
  readonly code: PdfGatewayUpstreamErrorCode;

  constructor(code: PdfGatewayUpstreamErrorCode) {
    super(code);
    this.name = "PdfGatewayUpstreamError";
    this.code = code;
  }
}

export async function fetchPublicPdfWithRedirects(
  options: PublicPdfFetchOptions,
): Promise<PublicPdfFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const abortController = new AbortController();
  const abortFromClient = () => abortController.abort(options.clientSignal?.reason);
  options.clientSignal?.addEventListener("abort", abortFromClient, { once: true });
  if (options.clientSignal?.aborted) abortFromClient();

  let currentUrl = validatePublicPdfUrl(options.url.toString());
  let redirectCount = 0;
  try {
    while (true) {
      const addressesBefore = await resolvePublicHostAddresses(
        currentUrl.hostname,
        options.resolver,
      );
      const timeoutId = setTimeout(
        () => abortController.abort("connect-timeout"),
        options.limits.connectTimeoutMs,
      );
      let response: Response;
      try {
        const headers = upstreamRequestHeaders(
          options.range,
          options.ifRange,
          currentUrl,
          options.authorization,
        );
        response = await fetcher(currentUrl, {
          method: options.method,
          redirect: "manual",
          signal: abortController.signal,
          headers,
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new PdfGatewayUpstreamError("UPSTREAM_TIMEOUT");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }

      const addressesAfter = await resolvePublicHostAddresses(
        currentUrl.hostname,
        options.resolver,
      );
      try {
        assertSameAddressSet(addressesBefore, addressesAfter);
      } catch (error) {
        await response.body?.cancel("dns-address-changed").catch(() => undefined);
        abortController.abort("dns-address-changed");
        throw error;
      }

      if (!isRedirectStatus(response.status)) {
        return {
          response,
          finalUrl: currentUrl,
          abort: (reason?: unknown) => abortController.abort(reason),
          dispose: () => options.clientSignal?.removeEventListener("abort", abortFromClient),
        };
      }

      if (redirectCount >= options.limits.maxRedirects) {
        await response.body?.cancel("redirect-limit").catch(() => undefined);
        throw new PdfGatewayUpstreamError("REDIRECT_LIMIT");
      }
      const location = response.headers.get("location") ?? "";
      await response.body?.cancel("redirect").catch(() => undefined);
      currentUrl = resolveValidatedRedirect(currentUrl, location);
      redirectCount += 1;
    }
  } catch (error) {
    options.clientSignal?.removeEventListener("abort", abortFromClient);
    abortController.abort("gateway-error");
    if (error instanceof PdfGatewayUpstreamError) throw error;
    throw error;
  }
}

function upstreamRequestHeaders(
  range: ParsedByteRange | null | undefined,
  ifRange: string | null | undefined,
  currentUrl?: URL,
  authorization?: PublicPdfFetchOptions["authorization"],
): Headers {
  const headers = new Headers({
    "Accept": "application/pdf, application/octet-stream;q=0.8",
    "Accept-Encoding": "identity",
    "User-Agent": "TrackerRodu-PdfGateway/1.0",
  });
  if (range) headers.set("Range", range.header);
  if (range && ifRange?.trim()) {
    const normalized = ifRange.trim();
    if (normalized.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(normalized)) {
      headers.set("If-Range", normalized);
    }
  }
  if (authorization) {
    const host = currentUrl?.hostname.toLocaleLowerCase("en-US") ?? "";
    const allowed = authorization.allowedHosts.some(
      (candidate) => candidate.toLocaleLowerCase("en-US") === host,
    );
    if (!allowed) {
      throw new PdfGatewayUpstreamError("UPSTREAM_AUTH_REDIRECT_BLOCKED");
    }
    headers.set("Authorization", `Bearer ${authorization.bearerToken}`);
  }
  return headers;
}

export type ValidatedPdfResponse = {
  status: 200 | 206;
  headers: Headers;
  maximumBodyBytes: number;
  verifyMagicPrefix: boolean;
};

type ParsedContentRange = {
  start: number;
  end: number;
  total?: number;
};

export function validatePdfUpstreamResponse(
  response: Response,
  requestRange: ParsedByteRange | null,
  limits: PdfGatewayLimits,
): ValidatedPdfResponse {
  if (response.status !== 200 && response.status !== 206) {
    throw new PdfGatewayUpstreamError("UPSTREAM_FAILED");
  }

  const contentEncoding = response.headers.get("content-encoding")?.trim().toLocaleLowerCase("en-US") ?? "";
  if (contentEncoding && contentEncoding !== "identity") {
    throw new PdfGatewayUpstreamError("RANGE_RESPONSE_INVALID");
  }

  const mediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase("en-US") ?? "";
  if (mediaType && mediaType !== "application/pdf" && mediaType !== "application/octet-stream") {
    throw new PdfGatewayUpstreamError("SOURCE_NOT_PDF");
  }

  const declaredLength = parseNonNegativeInteger(response.headers.get("content-length"));
  const contentRange = response.status === 206
    ? parseContentRange(response.headers.get("content-range"))
    : null;

  let maximumBodyBytes = limits.fallbackMaxBytesWithoutRange;
  let verifyMagicPrefix = response.status === 200;
  if (response.status === 206) {
    if (!requestRange || !contentRange) {
      throw new PdfGatewayUpstreamError("RANGE_RESPONSE_INVALID");
    }
    const rangeLength = contentRange.end - contentRange.start + 1;
    if (
      (requestRange.start !== undefined && contentRange.start !== requestRange.start)
      || (requestRange.end !== undefined && contentRange.end > requestRange.end)
      || (requestRange.suffixLength !== undefined && rangeLength > requestRange.suffixLength)
      || (declaredLength !== undefined && declaredLength !== rangeLength)
    ) {
      throw new PdfGatewayUpstreamError("RANGE_RESPONSE_INVALID");
    }
    if (rangeLength > limits.maxRangeResponseBytes) {
      throw new PdfGatewayUpstreamError("RANGE_RESPONSE_TOO_LARGE");
    }
    maximumBodyBytes = rangeLength;
    verifyMagicPrefix = contentRange.start === 0;
  } else if (declaredLength !== undefined && declaredLength > maximumBodyBytes) {
    throw new PdfGatewayUpstreamError("SOURCE_TOO_LARGE_WITHOUT_RANGE");
  }

  const headers = safePdfResponseHeaders(response.headers);
  headers.set("Content-Type", "application/pdf");
  return {
    status: response.status,
    headers,
    maximumBodyBytes,
    verifyMagicPrefix,
  };
}

export function safePdfResponseHeaders(upstream: Headers): Headers {
  const result = new Headers();
  for (const name of [
    "accept-ranges",
    "content-range",
    "content-length",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.get(name);
    if (value) result.set(name, value);
  }
  return result;
}

export function validatePdfHeadResponse(response: Response): Headers {
  if (response.status !== 200 && response.status !== 206) {
    throw new PdfGatewayUpstreamError("UPSTREAM_FAILED");
  }
  const mediaType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase("en-US") ?? "";
  if (mediaType && mediaType !== "application/pdf" && mediaType !== "application/octet-stream") {
    throw new PdfGatewayUpstreamError("SOURCE_NOT_PDF");
  }
  const headers = safePdfResponseHeaders(response.headers);
  headers.set("Content-Type", "application/pdf");
  return headers;
}

export function createBoundedPdfStream(
  upstream: ReadableStream<Uint8Array> | null,
  options: {
    maximumBytes: number;
    verifyMagicPrefix: boolean;
    idleTimeoutMs: number;
    abort: (reason?: unknown) => void;
    dispose?: () => void;
    onFinalize?: (result: {
      transferredBytes: number;
      outcome: "completed" | "cancelled" | "failed";
      errorCode?: PdfGatewayUpstreamErrorCode | "UPSTREAM_FAILED";
    }) => void;
  },
): ReadableStream<Uint8Array> {
  if (!upstream) throw new PdfGatewayUpstreamError("EMPTY_RESPONSE");
  const reader = upstream.getReader();
  let transferred = 0;
  let finished = false;

  const close = (
    outcome: "completed" | "cancelled" | "failed",
    errorCode?: PdfGatewayUpstreamErrorCode | "UPSTREAM_FAILED",
  ) => {
    if (finished) return;
    finished = true;
    options.dispose?.();
    try {
      options.onFinalize?.({
        transferredBytes: transferred,
        outcome,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Observability callbacks must never affect the PDF byte stream.
    }
  };
  const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, error: unknown) => {
    options.abort(error);
    await reader.cancel(error).catch(() => undefined);
    close(
      "failed",
      error instanceof PdfGatewayUpstreamError ? error.code : "UPSTREAM_FAILED",
    );
    controller.error(error);
  };
  const acceptChunk = (chunk: Uint8Array) => {
    transferred += chunk.byteLength;
    if (transferred > options.maximumBytes) {
      throw new PdfGatewayUpstreamError("RANGE_RESPONSE_TOO_LARGE");
    }
  };
  const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new PdfGatewayUpstreamError("UPSTREAM_TIMEOUT"));
    }, options.idleTimeoutMs);
    void reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (!options.verifyMagicPrefix) return;
      const buffered: Uint8Array[] = [];
      let prefix = new Uint8Array(0);
      try {
        while (prefix.byteLength < 5) {
          const { done, value } = await readChunk();
          if (done) throw new PdfGatewayUpstreamError("SOURCE_NOT_PDF");
          if (!value?.byteLength) continue;
          acceptChunk(value);
          buffered.push(value);
          prefix = concatenatePrefix(buffered, 5);
        }
        if (new TextDecoder("ascii").decode(prefix) !== "%PDF-") {
          throw new PdfGatewayUpstreamError("SOURCE_NOT_PDF");
        }
        for (const chunk of buffered) controller.enqueue(chunk);
      } catch (error) {
        await fail(controller, error);
      }
    },
    async pull(controller) {
      if (finished) return;
      try {
        const { done, value } = await readChunk();
        if (done) {
          close("completed");
          controller.close();
          return;
        }
        if (!value?.byteLength) return;
        acceptChunk(value);
        controller.enqueue(value);
      } catch (error) {
        await fail(controller, error);
      }
    },
    async cancel(reason) {
      options.abort(reason);
      await reader.cancel(reason).catch(() => undefined);
      close("cancelled");
    },
  });
}

function concatenatePrefix(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, length - offset);
    result.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset === length) break;
  }
  return result.subarray(0, offset);
}

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/u.test(value.trim())) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function parseContentRange(value: string | null): ParsedContentRange | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/iu.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
    || (total !== undefined && (!Number.isSafeInteger(total) || total <= end))
  ) return null;
  return { start, end, ...(total === undefined ? {} : { total }) };
}

export function rangeFromRequest(request: Request): ParsedByteRange | null {
  return parseSingleByteRange(request.headers.get("range"));
}
