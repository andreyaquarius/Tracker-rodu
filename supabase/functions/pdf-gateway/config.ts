export type PdfGatewayLimits = {
  sessionTtlSeconds: number;
  maxRedirects: number;
  connectTimeoutMs: number;
  streamIdleTimeoutMs: number;
  fallbackMaxBytesWithoutRange: number;
  maxRangeResponseBytes: number;
  maxRequestsPerSession: number;
  maxActiveSessionsPerUserProject: number;
  probeRequestsPerWindow: number;
  probeWindowSeconds: number;
  telemetryRequestsPerWindow: number;
  telemetryWindowSeconds: number;
  telemetrySuccessSamplePercent: number;
  maxRequestBodyBytes: number;
};

export type PdfGatewayEnvironment = Record<string, string | null | undefined>;

function boundedInteger(
  value: string | null | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function pdfGatewayLimitsFromEnvironment(
  environment: PdfGatewayEnvironment,
): PdfGatewayLimits {
  return {
    sessionTtlSeconds: boundedInteger(
      environment.PDF_PROXY_TOKEN_TTL_SECONDS,
      600,
      30,
      3_600,
    ),
    maxRedirects: boundedInteger(
      environment.PDF_PROXY_MAX_REDIRECTS,
      4,
      0,
      10,
    ),
    connectTimeoutMs: boundedInteger(
      environment.PDF_PROXY_CONNECT_TIMEOUT_MS,
      15_000,
      1_000,
      60_000,
    ),
    streamIdleTimeoutMs: boundedInteger(
      environment.PDF_PROXY_STREAM_IDLE_TIMEOUT_MS,
      30_000,
      1_000,
      120_000,
    ),
    fallbackMaxBytesWithoutRange: boundedInteger(
      environment.PDF_FALLBACK_MAX_BYTES_WITHOUT_RANGE,
      32 * 1024 * 1024,
      1024 * 1024,
      512 * 1024 * 1024,
    ),
    maxRangeResponseBytes: boundedInteger(
      environment.PDF_PROXY_MAX_RANGE_RESPONSE_BYTES,
      8 * 1024 * 1024,
      64 * 1024,
      64 * 1024 * 1024,
    ),
    maxRequestsPerSession: boundedInteger(
      environment.PDF_PROXY_MAX_REQUESTS_PER_SESSION,
      512,
      16,
      4_096,
    ),
    maxActiveSessionsPerUserProject: boundedInteger(
      environment.PDF_PROXY_MAX_ACTIVE_SESSIONS_PER_USER_PROJECT,
      8,
      1,
      64,
    ),
    probeRequestsPerWindow: boundedInteger(
      environment.PDF_PROBE_MAX_REQUESTS_PER_WINDOW,
      30,
      1,
      1_000,
    ),
    probeWindowSeconds: boundedInteger(
      environment.PDF_PROBE_WINDOW_SECONDS,
      60,
      10,
      3_600,
    ),
    telemetryRequestsPerWindow: boundedInteger(
      environment.PDF_TELEMETRY_MAX_EVENTS_PER_WINDOW,
      120,
      10,
      2_000,
    ),
    telemetryWindowSeconds: boundedInteger(
      environment.PDF_TELEMETRY_WINDOW_SECONDS,
      60,
      10,
      3_600,
    ),
    telemetrySuccessSamplePercent: boundedInteger(
      environment.PDF_TELEMETRY_SUCCESS_SAMPLE_PERCENT,
      10,
      0,
      100,
    ),
    maxRequestBodyBytes: boundedInteger(
      environment.PDF_PROXY_MAX_REQUEST_BODY_BYTES,
      8 * 1024,
      1024,
      64 * 1024,
    ),
  };
}
