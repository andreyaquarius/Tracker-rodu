import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 250;
const DEFAULT_MAX_CONCURRENT_EXPORTS = 2;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_QPDF_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_CONCURRENT_STREAMS = 32;
const DEFAULT_MAX_STREAM_RESPONSE_BYTES = 32 * 1024 * 1024;
const SIGNATURE_MAX_AGE_MS = 60_000;
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
const usedNonces = new Map();
let activeExports = 0;
let activeStreams = 0;

export class PdfExportWorkerError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PdfExportWorkerError";
    this.status = status;
    this.code = code;
  }
}

export function parsePageSelection(value, maximumPages = DEFAULT_MAX_PAGES) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumPages) {
    throw new PdfExportWorkerError(400, "PAGES_INVALID", `Select from 1 to ${maximumPages} pages.`);
  }
  const pages = [...new Set(value)];
  if (pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > 1_000_000)) {
    throw new PdfExportWorkerError(400, "PAGES_INVALID", "Page numbers must be positive integers.");
  }
  return pages.sort((left, right) => left - right);
}

export function isPublicIpAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)?.[1];
  if (mapped) return isPublicIpv4(mapped);
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  if (bytes.every((byte) => byte === 0)) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return false; // fc00::/7
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // fe80::/10
  if (bytes[0] === 0xff) return false; // multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  return true;
}

export function signWorkerBody(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}\n${body}`, "utf8").digest("hex");
}

export function verifyWorkerSignature({ secret, timestamp, signature, body, now = Date.now() }) {
  const parsedTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(parsedTimestamp) || Math.abs(now - parsedTimestamp) > SIGNATURE_MAX_AGE_MS) {
    throw new PdfExportWorkerError(401, "SIGNATURE_EXPIRED", "The worker request has expired.");
  }
  if (!/^[a-f0-9]{64}$/iu.test(signature)) {
    throw new PdfExportWorkerError(401, "SIGNATURE_INVALID", "The worker signature is invalid.");
  }
  const expected = Buffer.from(signWorkerBody(secret, timestamp, body), "hex");
  const supplied = Buffer.from(signature, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new PdfExportWorkerError(401, "SIGNATURE_INVALID", "The worker signature is invalid.");
  }
}

export function validateExportPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PdfExportWorkerError(400, "REQUEST_INVALID", "A JSON object is required.");
  }
  const nonce = requiredToken(payload.nonce, "nonce", 16, 200);
  const sourceUrl = safeHttpsUrl(payload.sourceUrl, options.allowHttpLoopback === true);
  const pages = parsePageSelection(payload.pages, options.maximumPages ?? DEFAULT_MAX_PAGES);
  const fileName = safeFileName(payload.fileName);
  const allowedRedirectHosts = Array.isArray(payload.allowedRedirectHosts)
    ? payload.allowedRedirectHosts.map(normalizeHost).filter(Boolean)
    : [];
  const authorization = optionalAuthorization(payload.authorization);
  if (authorization && allowedRedirectHosts.length === 0) {
    throw new PdfExportWorkerError(400, "AUTH_REDIRECT_POLICY_REQUIRED", "Authorized downloads need an exact redirect allowlist.");
  }
  if (allowedRedirectHosts.length > 0 && !allowedRedirectHosts.includes(normalizeHost(sourceUrl.hostname))) {
    throw new PdfExportWorkerError(400, "SOURCE_HOST_BLOCKED", "The source host is outside the exact allowlist.");
  }
  return { nonce, sourceUrl, pages, fileName, allowedRedirectHosts, authorization };
}

export function validateStreamPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PdfExportWorkerError(400, "REQUEST_INVALID", "A JSON object is required.");
  }
  const nonce = requiredToken(payload.nonce, "nonce", 16, 200);
  const sourceUrl = safeHttpsUrl(payload.sourceUrl, options.allowHttpLoopback === true);
  const method = payload.method === "GET" || payload.method === "HEAD" ? payload.method : "";
  if (!method) throw new PdfExportWorkerError(400, "METHOD_INVALID", "Only GET and HEAD upstream requests are allowed.");
  const range = optionalRangeHeader(payload.range);
  const ifRange = range ? optionalSafeHeader(payload.ifRange, 512) : "";
  const allowedRedirectHosts = Array.isArray(payload.allowedRedirectHosts)
    ? [...new Set(payload.allowedRedirectHosts.map(normalizeHost).filter(Boolean))]
    : [];
  const authorization = optionalAuthorization(payload.authorization);
  validateRedirectPolicy(sourceUrl, authorization, allowedRedirectHosts);
  return { nonce, sourceUrl, method, range, ifRange, allowedRedirectHosts, authorization };
}

export async function resolveAndPinPublicAddress(hostname, lookup = dns.lookup) {
  const normalized = normalizeHost(hostname);
  if (!normalized || normalized === "localhost") {
    throw new PdfExportWorkerError(403, "SSRF_HOST_BLOCKED", "The source host is not public.");
  }
  const records = await lookup(normalized, { all: true, verbatim: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new PdfExportWorkerError(502, "DNS_RESOLUTION_FAILED", "The source host did not resolve.");
  }
  if (records.some((record) => !isPublicIpAddress(record.address))) {
    throw new PdfExportWorkerError(403, "SSRF_ADDRESS_BLOCKED", "The source host resolved to a non-public address.");
  }
  return records[0];
}

export function createPdfExportWorker(options = {}) {
  const secret = options.secret ?? process.env.PDF_EXPORT_WORKER_SECRET ?? "";
  if (secret.length < 32) throw new Error("PDF_EXPORT_WORKER_SECRET must contain at least 32 characters.");
  const limits = workerLimits(options.env ?? process.env);
  const qpdfBinary = options.qpdfBinary ?? process.env.QPDF_BINARY ?? "qpdf";

  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ok", activeExports, activeStreams }));
      return;
    }
    const isExport = request.method === "POST" && request.url === "/v1/export";
    const isStream = request.method === "POST" && request.url === "/v1/stream";
    if (!isExport && !isStream) {
      sendError(response, new PdfExportWorkerError(404, "ROUTE_NOT_FOUND", "Route not found."));
      return;
    }
    if (isExport && activeExports >= limits.maxConcurrentExports) {
      sendError(response, new PdfExportWorkerError(429, "WORKER_BUSY", "The export worker is busy."));
      return;
    }
    if (isStream && activeStreams >= limits.maxConcurrentStreams) {
      sendError(response, new PdfExportWorkerError(429, "WORKER_BUSY", "The PDF stream worker is busy."));
      return;
    }

    let temporaryDirectory;
    if (isExport) activeExports += 1;
    else activeStreams += 1;
    try {
      const rawBody = await readRequestBody(request, limits.maxBodyBytes);
      verifyWorkerSignature({
        secret,
        timestamp: request.headers["x-tracker-timestamp"] ?? "",
        signature: request.headers["x-tracker-signature"] ?? "",
        body: rawBody,
      });
      const parsedBody = JSON.parse(rawBody);
      const payload = isExport
        ? validateExportPayload(parsedBody, {
          maximumPages: limits.maxPages,
          allowHttpLoopback: limits.allowHttpLoopback,
        })
        : validateStreamPayload(parsedBody, { allowHttpLoopback: limits.allowHttpLoopback });
      reserveNonce(payload.nonce);

      if (isStream) {
        await streamPdfFromSource(payload, response, limits, request);
        return;
      }

      temporaryDirectory = await mkdtemp(join(tmpdir(), "tracker-pdf-export-"));
      const sourcePath = join(temporaryDirectory, "source.pdf");
      const outputPath = join(temporaryDirectory, "result.pdf");
      await downloadPdfToFile(payload, sourcePath, limits, request);
      await runQpdf(qpdfBinary, sourcePath, outputPath, payload.pages, limits.qpdfTimeoutMs);
      const output = await stat(outputPath);
      if (!output.isFile() || output.size < PDF_MAGIC.length) {
        throw new PdfExportWorkerError(502, "EXPORT_EMPTY", "qpdf did not produce a PDF.");
      }

      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": String(output.size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(payload.fileName)}`,
        "Cache-Control": "private, no-store",
      });
      const resultStream = createReadStream(outputPath);
      resultStream.on("error", () => response.destroy());
      resultStream.pipe(response);
      await new Promise((resolveStream) => {
        response.once("finish", resolveStream);
        response.once("close", resolveStream);
      });
    } catch (error) {
      if (!response.headersSent) sendError(response, normalizeWorkerError(error));
      else response.destroy();
    } finally {
      if (isExport) activeExports = Math.max(0, activeExports - 1);
      else activeStreams = Math.max(0, activeStreams - 1);
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      pruneNonces();
    }
  });
}

async function downloadPdfToFile(payload, destination, limits, clientRequest) {
  let currentUrl = payload.sourceUrl;
  for (let redirect = 0; redirect <= limits.maxRedirects; redirect += 1) {
    const pinned = await resolveAndPinPublicAddress(currentUrl.hostname);
    const upstream = await pinnedRequest(currentUrl, pinned, {
      method: "GET",
      authorization: payload.authorization,
      timeoutMs: limits.downloadTimeoutMs,
      clientRequest,
    });
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode ?? 0)) {
      const location = upstream.headers.location;
      upstream.resume();
      if (!location || redirect === limits.maxRedirects) {
        throw new PdfExportWorkerError(502, "REDIRECT_LIMIT", "The source redirected too many times.");
      }
      const nextUrl = safeHttpsUrl(new URL(location, currentUrl).href, limits.allowHttpLoopback);
      if (payload.allowedRedirectHosts.length > 0 && !payload.allowedRedirectHosts.includes(normalizeHost(nextUrl.hostname))) {
        throw new PdfExportWorkerError(502, "REDIRECT_HOST_BLOCKED", "The source redirected to an untrusted host.");
      }
      currentUrl = nextUrl;
      continue;
    }
    if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
      upstream.resume();
      throw new PdfExportWorkerError(502, "UPSTREAM_FAILED", "The source did not return a PDF.");
    }
    const declared = Number(upstream.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limits.maxSourceBytes) {
      upstream.destroy();
      throw new PdfExportWorkerError(413, "SOURCE_TOO_LARGE", "The source exceeds the configured temporary-file limit.");
    }
    await streamPdfResponseToFile(upstream, destination, limits.maxSourceBytes);
    return;
  }
  throw new PdfExportWorkerError(502, "REDIRECT_LIMIT", "The source redirected too many times.");
}

async function streamPdfFromSource(payload, response, limits, clientRequest) {
  let currentUrl = payload.sourceUrl;
  for (let redirect = 0; redirect <= limits.maxRedirects; redirect += 1) {
    const pinned = await resolveAndPinPublicAddress(currentUrl.hostname);
    const upstream = await pinnedRequest(currentUrl, pinned, {
      method: payload.method,
      authorization: payload.authorization,
      range: payload.range,
      ifRange: payload.ifRange,
      timeoutMs: limits.downloadTimeoutMs,
      clientRequest,
    });
    if ([301, 302, 303, 307, 308].includes(upstream.statusCode ?? 0)) {
      const location = upstream.headers.location;
      upstream.resume();
      if (!location || redirect === limits.maxRedirects) {
        throw new PdfExportWorkerError(502, "REDIRECT_LIMIT", "The source redirected too many times.");
      }
      const nextUrl = safeHttpsUrl(new URL(location, currentUrl).href, limits.allowHttpLoopback);
      if (payload.allowedRedirectHosts.length > 0 && !payload.allowedRedirectHosts.includes(normalizeHost(nextUrl.hostname))) {
        throw new PdfExportWorkerError(502, "REDIRECT_HOST_BLOCKED", "The source redirected to an untrusted host.");
      }
      currentUrl = nextUrl;
      continue;
    }

    const status = upstream.statusCode ?? 502;
    if (![200, 206, 401, 403, 416].includes(status)) {
      upstream.resume();
      throw new PdfExportWorkerError(502, "UPSTREAM_FAILED", "The source did not return a supported PDF response.");
    }
    const headers = safeStreamResponseHeaders(upstream.headers);
    if (payload.method === "HEAD" || status === 401 || status === 403 || status === 416) {
      upstream.resume();
      response.writeHead(status, headers);
      response.end();
      return;
    }
    const declared = Number(upstream.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limits.maxStreamResponseBytes) {
      upstream.destroy();
      throw new PdfExportWorkerError(413, "STREAM_RESPONSE_TOO_LARGE", "The streamed PDF response exceeds the configured limit.");
    }
    response.writeHead(status, headers);
    await pipeline(upstream, boundedStreamGuard(limits.maxStreamResponseBytes), response);
    return;
  }
  throw new PdfExportWorkerError(502, "REDIRECT_LIMIT", "The source redirected too many times.");
}

async function pinnedRequest(url, pinned, options) {
  return new Promise((resolveRequest, rejectRequest) => {
    const upstreamRequest = https.request(url, {
      method: options.method,
      headers: {
        Accept: "application/pdf,application/octet-stream;q=0.9",
        "Accept-Encoding": "identity",
        "User-Agent": "TrackerRodu-PdfExportWorker/1.0",
        ...(options.range ? { Range: options.range } : {}),
        ...(options.range && options.ifRange ? { "If-Range": options.ifRange } : {}),
        ...(options.authorization ? { Authorization: options.authorization } : {}),
      },
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      servername: url.hostname,
    }, resolveRequest);
    const abort = () => upstreamRequest.destroy(new PdfExportWorkerError(499, "CLIENT_ABORTED", "The client cancelled the export."));
    options.clientRequest.once("aborted", abort);
    upstreamRequest.setTimeout(options.timeoutMs, () => {
      upstreamRequest.destroy(new PdfExportWorkerError(504, "UPSTREAM_TIMEOUT", "The source download timed out."));
    });
    upstreamRequest.once("error", rejectRequest);
    upstreamRequest.once("close", () => options.clientRequest.off("aborted", abort));
    upstreamRequest.end();
  });
}

function safeStreamResponseHeaders(upstreamHeaders) {
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
  for (const name of ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const value = upstreamHeaders[name];
    if (typeof value === "string" && value.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(value)) {
      headers[name] = value;
    }
  }
  return headers;
}

function boundedStreamGuard(maximumBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maximumBytes) {
        callback(new PdfExportWorkerError(413, "STREAM_RESPONSE_TOO_LARGE", "The streamed PDF response exceeds the configured limit."));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function streamPdfResponseToFile(upstream, destination, maximumBytes) {
  const target = await open(destination, "wx", 0o600);
  let total = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const value of upstream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > maximumBytes) {
        upstream.destroy();
        throw new PdfExportWorkerError(413, "SOURCE_TOO_LARGE", "The source exceeds the configured temporary-file limit.");
      }
      if (prefix.length < PDF_MAGIC.length) {
        prefix = Buffer.concat([prefix, chunk.subarray(0, PDF_MAGIC.length - prefix.length)]);
        if (prefix.length === PDF_MAGIC.length && !prefix.equals(PDF_MAGIC)) {
          upstream.destroy();
          throw new PdfExportWorkerError(415, "SOURCE_NOT_PDF", "The source does not contain PDF magic bytes.");
        }
      }
      await target.write(chunk);
    }
    if (total < PDF_MAGIC.length || !prefix.equals(PDF_MAGIC)) {
      throw new PdfExportWorkerError(415, "SOURCE_NOT_PDF", "The source does not contain PDF magic bytes.");
    }
  } finally {
    await target.close();
  }
}

async function runQpdf(binary, sourcePath, outputPath, pages, timeoutMs) {
  await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(binary, [
      "--warning-exit-0",
      "--empty",
      "--pages",
      sourcePath,
      pages.join(","),
      "--",
      outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += String(chunk).slice(0, 4_096 - stderr.length);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectProcess(new PdfExportWorkerError(503, "QPDF_UNAVAILABLE", error.code === "ENOENT"
        ? "qpdf is not installed in the export worker."
        : "qpdf could not start."));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveProcess();
      else rejectProcess(new PdfExportWorkerError(422, "PDF_EXPORT_FAILED", signal
        ? "qpdf timed out while preparing the selected pages."
        : `qpdf rejected the source PDF${stderr ? ": " + safeDiagnostic(stderr) : "."}`));
    });
  });
}

function workerLimits(env) {
  return {
    maxBodyBytes: positiveInteger(env.PDF_EXPORT_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
    maxSourceBytes: positiveInteger(env.PDF_EXPORT_MAX_SOURCE_BYTES, DEFAULT_MAX_SOURCE_BYTES),
    maxPages: positiveInteger(env.PDF_EXPORT_MAX_PAGES, DEFAULT_MAX_PAGES),
    maxConcurrentExports: positiveInteger(env.PDF_EXPORT_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_EXPORTS),
    maxConcurrentStreams: positiveInteger(env.PDF_STREAM_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT_STREAMS),
    maxStreamResponseBytes: positiveInteger(env.PDF_STREAM_MAX_RESPONSE_BYTES, DEFAULT_MAX_STREAM_RESPONSE_BYTES),
    downloadTimeoutMs: positiveInteger(env.PDF_EXPORT_DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS),
    qpdfTimeoutMs: positiveInteger(env.PDF_EXPORT_QPDF_TIMEOUT_MS, DEFAULT_QPDF_TIMEOUT_MS),
    maxRedirects: positiveInteger(env.PDF_EXPORT_MAX_REDIRECTS, DEFAULT_MAX_REDIRECTS),
    allowHttpLoopback: env.PDF_EXPORT_ALLOW_HTTP_LOOPBACK === "true",
  };
}

function safeHttpsUrl(value, allowHttpLoopback) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new PdfExportWorkerError(400, "SOURCE_URL_INVALID", "The source URL is invalid.");
  }
  const host = normalizeHost(url.hostname);
  const isLoopbackDev = allowHttpLoopback && url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1");
  if ((!isLoopbackDev && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw new PdfExportWorkerError(400, "SOURCE_URL_INVALID", "Only clean HTTPS source URLs are accepted.");
  }
  if (!isLoopbackDev && url.port && url.port !== "443") {
    throw new PdfExportWorkerError(400, "SOURCE_PORT_BLOCKED", "Only the HTTPS default port is accepted.");
  }
  return url;
}

function isPublicIpv4(address) {
  const bytes = address.split(".").map(Number);
  if (bytes.length !== 4 || bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = bytes;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Bytes(address) {
  const normalized = address.split("%")[0].toLocaleLowerCase("en-US");
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/u.test(group))) return null;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

async function readRequestBody(request, maximumBytes) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new PdfExportWorkerError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
  }
  const chunks = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maximumBytes) throw new PdfExportWorkerError(413, "REQUEST_TOO_LARGE", "The request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reserveNonce(nonce) {
  pruneNonces();
  if (usedNonces.has(nonce)) throw new PdfExportWorkerError(409, "REQUEST_REPLAYED", "This export request was already used.");
  usedNonces.set(nonce, Date.now() + SIGNATURE_MAX_AGE_MS * 2);
}

function pruneNonces(now = Date.now()) {
  for (const [nonce, expiresAt] of usedNonces) if (expiresAt <= now) usedNonces.delete(nonce);
}

function requiredToken(value, field, minimumLength, maximumLength) {
  const token = typeof value === "string" ? value.trim() : "";
  if (token.length < minimumLength || token.length > maximumLength || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new PdfExportWorkerError(400, "REQUEST_INVALID", `${field} is invalid.`);
  }
  return token;
}

function optionalAuthorization(value) {
  if (value === undefined || value === null || value === "") return "";
  const authorization = typeof value === "string" ? value.trim() : "";
  if (!/^Bearer [^\s\u0000-\u001f\u007f]{20,4096}$/u.test(authorization)) {
    throw new PdfExportWorkerError(400, "AUTHORIZATION_INVALID", "The upstream authorization is invalid.");
  }
  return authorization;
}

function optionalRangeHeader(value) {
  if (value === undefined || value === null || value === "") return "";
  const range = typeof value === "string" ? value.trim() : "";
  if (!/^bytes=(?:\d+-\d*|-\d+)$/u.test(range) || range.length > 100) {
    throw new PdfExportWorkerError(400, "RANGE_INVALID", "The byte range is invalid.");
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  const start = match?.[1] ? Number(match[1]) : undefined;
  const end = match?.[2] ? Number(match[2]) : undefined;
  if (
    (start !== undefined && !Number.isSafeInteger(start))
    || (end !== undefined && (!Number.isSafeInteger(end) || end < 0))
    || (start !== undefined && end !== undefined && start > end)
    || (start === undefined && (!end || end < 1))
  ) {
    throw new PdfExportWorkerError(400, "RANGE_INVALID", "The byte range is invalid.");
  }
  return range;
}

function optionalSafeHeader(value, maximumLength) {
  if (value === undefined || value === null || value === "") return "";
  const header = typeof value === "string" ? value.trim() : "";
  if (!header || header.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(header)) {
    throw new PdfExportWorkerError(400, "HEADER_INVALID", "The conditional request header is invalid.");
  }
  return header;
}

function validateRedirectPolicy(sourceUrl, authorization, allowedRedirectHosts) {
  if (authorization && allowedRedirectHosts.length === 0) {
    throw new PdfExportWorkerError(400, "AUTH_REDIRECT_POLICY_REQUIRED", "Authorized downloads need an exact redirect allowlist.");
  }
  if (allowedRedirectHosts.length > 0 && !allowedRedirectHosts.includes(normalizeHost(sourceUrl.hostname))) {
    throw new PdfExportWorkerError(400, "SOURCE_HOST_BLOCKED", "The source host is outside the exact allowlist.");
  }
}

function safeFileName(value) {
  const normalized = typeof value === "string" ? value.normalize("NFKC") : "";
  const safe = normalized.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-").replace(/\s+/gu, " ").trim().slice(0, 180);
  return (safe || "document-pages.pdf").replace(/\.pdf$/iu, "") + ".pdf";
}

function normalizeHost(value) {
  return typeof value === "string"
    ? value.trim().replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLocaleLowerCase("en-US")
    : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeDiagnostic(value) {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/https?:\/\/\S+/giu, "[redacted-url]").slice(0, 500);
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function normalizeWorkerError(error) {
  if (error instanceof PdfExportWorkerError) return error;
  if (error instanceof SyntaxError) return new PdfExportWorkerError(400, "REQUEST_INVALID", "The JSON request is invalid.");
  return new PdfExportWorkerError(500, "EXPORT_WORKER_FAILED", "The export worker could not prepare the selected pages.");
}

function sendError(response, error) {
  response.writeHead(error.status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: error.code, message: error.message }));
}

export function startPdfExportWorker(options = {}) {
  const server = createPdfExportWorker(options);
  const port = positiveInteger(options.port ?? process.env.PORT, 8080);
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`PDF export worker listening on port ${port}\n`);
  });
  return server;
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (executedPath === import.meta.url) startPdfExportWorker();
