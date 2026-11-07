import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { initSentry, recordAuthRejected, recordBackupTransfer, reportServerError } from "./sentry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadEnvFile(path.join(__dirname, ".env"));

const packageVersion = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8")).version;
await initSentry(process.env, packageVersion);

const HISTORY_RETENTION_COUNT = 10;

const config = loadConfig();
const jwks = createRemoteJWKSet(new URL(config.authJwksUrl));
const server = createServer(handleRequest);

server.listen(config.port, config.host, () => {
  console.log(
    `[bladevault-backup-server] listening on http://${config.host}:${config.port} using storage ${config.backupStorageRoot}`,
  );
});

async function handleRequest(request, response) {
  try {
    const origin = request.headers.origin;
    if (request.method === "OPTIONS") {
      return handlePreflight(request, response, origin);
    }

    applyCorsHeaders(response, origin);

    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/health") {
      if (request.method === "HEAD") {
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.end();
        return;
      }
      return sendJson(response, 200, {
        ok: true,
        service: "bladevault-backup-server",
        now: new Date().toISOString(),
      });
    }

    if (request.method === "GET" && url.pathname === "/backup/meta") {
      const auth = await requireAuth(request);
      const metadata = await readMetadata(auth.userId);
      return sendJson(response, 200, buildMetaResponse(auth, metadata));
    }

    if (request.method === "GET" && url.pathname === "/backup/history") {
      const auth = await requireAuth(request);
      const metadata = await readMetadata(auth.userId);
      return sendJson(response, 200, {
        user: auth.user,
        history: metadata.history,
      });
    }

    if (request.method === "PUT" && url.pathname === "/backup/latest") {
      const auth = await requireAuth(request);
      const declaredContentLength = parseContentLength(request.headers["content-length"]);
      if (
        config.maxBackupSizeBytes !== null &&
        declaredContentLength !== null &&
        declaredContentLength > config.maxBackupSizeBytes
      ) {
        recordBackupTransfer("upload", "too_large");
        return sendJson(response, 413, {
          error: `Backup exceeds ${Math.floor(config.maxBackupSizeBytes / (1024 * 1024))} MB limit.`,
        });
      }

      const { userDir } = await ensureUserDirectories(auth.userId);
      const uploadPath = path.join(userDir, `upload-${Date.now()}-${randomUUID()}.tar.gz.part`);
      const upload = await writeRequestBodyToTempFile(request, uploadPath, config.maxBackupSizeBytes);

      if (upload.size === 0) {
        recordBackupTransfer("upload", "empty");
        return sendJson(response, 400, { error: "Backup file is empty." });
      }

      if (!isTarGzipFile(upload.headerBytes)) {
        await fs.rm(upload.tempPath, { force: true }).catch(() => {});
        recordBackupTransfer("upload", "invalid_archive");
        return sendJson(response, 400, { error: "Backup file is not a valid tar.gz archive." });
      }

      const result = await storeLatestBackup(auth.userId, upload, request.headers["x-backup-filename"]);
      recordBackupTransfer("upload", "ok", upload.size);
      return sendJson(response, 200, {
        ok: true,
        user: auth.user,
        backup: result,
      });
    }

    if (request.method === "GET" && url.pathname === "/backup/latest") {
      const auth = await requireAuth(request);
      const metadata = await readMetadata(auth.userId);
      const latestPath = path.join(getUserDirectory(auth.userId), "latest.tar.gz");

      let stat;
      try {
        stat = await fs.stat(latestPath);
      } catch {
        recordBackupTransfer("download", "not_found");
        return sendJson(response, 404, { error: "No backup found for this account." });
      }

      const file = await fs.readFile(latestPath);
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/octet-stream");
      const fileName = metadata.latest?.fileName || "bladevault-data.tar.gz";
      response.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      response.setHeader("Content-Length", String(stat.size));
      response.setHeader("Cache-Control", "no-store");
      response.end(file);
      recordBackupTransfer("download", "ok", stat.size);
      return;
    }

    return sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Internal server error.";
    if (request.method === "PUT" && (request.url || "").split("?")[0] === "/backup/latest" && status !== 401) {
      recordBackupTransfer("upload", status === 413 ? "too_large" : "error");
    }
    if (status >= 500) {
      reportServerError(error, `${request.method} ${(request.url || "/").split("?")[0]}`);
    }
    if (!response.headersSent) {
      applyCorsHeaders(response, request.headers.origin);
      sendJson(response, status, { error: message });
      return;
    }
    response.destroy();
  }
}

function loadConfig() {
  const backupPublicBaseUrl = requireEnv("BACKUP_PUBLIC_BASE_URL");
  const authJwtIssuer = requireEnv("AUTH_JWT_ISSUER");
  const authJwtAudience = process.env.AUTH_JWT_AUDIENCE?.trim() || authJwtIssuer;
  const authJwksUrl = requireEnv("AUTH_JWKS_URL");
  const backupStorageRoot = requireEnv("BACKUP_STORAGE_ROOT");
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const port = parseInteger(process.env.PORT, 8080, "PORT");
  const maxBackupSizeMb = parseOptionalLimitMb(process.env.MAX_BACKUP_SIZE_MB, 50, "MAX_BACKUP_SIZE_MB");
  const allowedClientOrigins = splitCsv(process.env.ALLOWED_CLIENT_ORIGINS);

  return {
    backupPublicBaseUrl: normalizeBaseUrl(backupPublicBaseUrl),
    authJwtIssuer: normalizeBaseUrl(authJwtIssuer),
    authJwtAudience,
    authJwksUrl,
    backupStorageRoot: path.resolve(backupStorageRoot),
    host,
    port,
    allowAnyOrigin: allowedClientOrigins.includes("*"),
    maxBackupSizeBytes: maxBackupSizeMb === null ? null : maxBackupSizeMb * 1024 * 1024,
    allowedClientOrigins,
  };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseInteger(value, fallback, name) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalLimitMb(value, fallback, name) {
  if (value === undefined) return fallback;

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "0" || normalized === "off" || normalized === "none" || normalized === "unlimited") {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be 0 for unlimited or a positive integer.`);
  }
  if (parsed === 0) {
    return null;
  }
  return parsed;
}

function splitCsv(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function loadEnvFile(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] = stripQuotes(rawValue);
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function applyCorsHeaders(response, origin) {
  const allowedOrigin = getAllowedOrigin(origin);
  if (!allowedOrigin) return;
  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "false");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Backup-Filename");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  response.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Disposition");
  response.setHeader("Vary", "Origin");
}

function handlePreflight(request, response, origin) {
  const allowedOrigin = getAllowedOrigin(origin);
  if (!allowedOrigin) {
    return sendJson(response, 403, { error: "Origin is not allowed." });
  }

  applyCorsHeaders(response, origin);
  response.statusCode = 204;
  response.end();
}

function getAllowedOrigin(origin) {
  if (config.allowAnyOrigin) {
    return "*";
  }
  if (!origin) return null;
  return isLocalDevelopmentOrigin(origin) || config.allowedClientOrigins.some((pattern) => matchesOriginPattern(origin, pattern))
    ? origin
    : null;
}

function matchesOriginPattern(origin, pattern) {
  const normalizedOrigin = normalizeBaseUrl(origin);
  const normalizedPattern = normalizeBaseUrl(pattern);
  if (!normalizedOrigin || !normalizedPattern) return false;
  if (!normalizedPattern.includes("*") && !normalizedPattern.includes("?")) {
    return normalizedOrigin === normalizedPattern;
  }

  const escaped = normalizedPattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`);
  return regex.test(normalizedOrigin);
}

const LOCAL_DEV_HOSTS = new Set(["localhost", "host.docker.internal", "gateway.docker.internal"]);

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isIpv4Address(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isPrivateOrLoopbackIpv4(hostname) {
  if (!isIpv4Address(hostname)) return false;

  const [first, second] = hostname.split(".").map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isLoopbackOrPrivateIpv6(hostname) {
  if (!hostname.includes(":")) return false;
  return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
}

function isLocalDevelopmentOrigin(value) {
  const url = parseUrl(value);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return false;

  return (
    LOCAL_DEV_HOSTS.has(hostname) ||
    hostname.endsWith(".localhost") ||
    isPrivateOrLoopbackIpv4(hostname) ||
    isLoopbackOrPrivateIpv6(hostname)
  );
}

async function requireAuth(request) {
  const token = readBearerToken(request.headers.authorization);
  if (!token) {
    throw httpError(401, "Missing bearer token.");
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.authJwtIssuer,
      audience: config.authJwtAudience,
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("Token subject is missing.");
    }

    return {
      userId: payload.sub,
      user: {
        id: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
        name: typeof payload.name === "string" ? payload.name : null,
        image: typeof payload.image === "string" ? payload.image : null,
      },
      payload,
    };
  } catch (error) {
    console.error("[bladevault-backup-server] auth error", error);
    recordAuthRejected();
    throw httpError(401, "Invalid or expired bearer token.");
  }
}

function readBearerToken(value) {
  if (!value) return null;
  const [scheme, token] = value.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return null;
  return token.trim();
}

function parseContentLength(value) {
  if (Array.isArray(value)) {
    return parseContentLength(value[0]);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isTarGzipFile(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

async function readRequestBody(request, maxBytes) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let finished = false;

    const finishWithError = (error) => {
      if (finished) return;
      finished = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      reject(error);
    };

    const onData = (chunk) => {
      if (finished) return;

      size += chunk.length;
      if (size > maxBytes) {
        finishWithError(httpError(413, `Backup exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    };

    const onError = (error) => finishWithError(error);
    const onAborted = () => finishWithError(httpError(499, "Request was aborted."));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

async function writeRequestBodyToTempFile(request, filePath, maxBytes) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    let headerBytes = Buffer.alloc(0);
    const hash = createHash("sha256");
    const output = createWriteStream(filePath, { flags: "w" });

    const detachListeners = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      output.removeListener("error", onError);
    };

    const rejectWithCleanup = (error) => {
      if (finished) return;
      finished = true;
      detachListeners();
      output.destroy();
      request.resume();
      void fs.rm(filePath, { force: true }).catch(() => {});
      reject(error);
    };

    const onData = (chunk) => {
      if (finished) return;

      size += chunk.length;
      if (maxBytes !== null && size > maxBytes) {
        rejectWithCleanup(httpError(413, `Backup exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`));
        return;
      }

      if (headerBytes.length < 2) {
        const needed = 2 - headerBytes.length;
        const nextBytes = chunk.subarray(0, Math.min(needed, chunk.length));
        headerBytes = headerBytes.length === 0 ? Buffer.from(nextBytes) : Buffer.concat([headerBytes, nextBytes]);
      }

      hash.update(chunk);

      if (!output.write(chunk)) {
        request.pause();
        output.once("drain", () => request.resume());
      }
    };

    const onEnd = () => {
      if (finished) return;
      finished = true;
      detachListeners();
      output.end(() => {
        resolve({
          tempPath: filePath,
          size,
          sha256: hash.digest("hex"),
          headerBytes,
        });
      });
    };

    const onError = (error) => rejectWithCleanup(error);
    const onAborted = () => rejectWithCleanup(httpError(499, "Request was aborted."));

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
    output.on("error", onError);
  });
}

function getUserDirectory(userId) {
  return path.join(config.backupStorageRoot, encodeURIComponent(userId));
}

async function ensureUserDirectories(userId) {
  const userDir = getUserDirectory(userId);
  const historyDir = path.join(userDir, "history");
  await fs.mkdir(historyDir, { recursive: true });
  return { userDir, historyDir };
}

async function storeLatestBackup(userId, upload, requestedFileName) {
  const { userDir, historyDir } = await ensureUserDirectories(userId);
  const latestPath = path.join(userDir, "latest.tar.gz");
  const now = new Date();
  const timestamp = createTimestamp(now);
  const historyPath = path.join(historyDir, `${timestamp}.tar.gz`);
  const metadataPath = path.join(userDir, "metadata.json");

  const previousMetadata = await readMetadata(userId);

  try {
    await fs.access(latestPath);
    await fs.copyFile(latestPath, historyPath);
  } catch {
    // No previous latest backup yet.
  }

  await fs.rm(latestPath, { force: true });
  await fs.rename(upload.tempPath, latestPath);

  const nextEntry = {
    fileName: sanitizeFileName(requestedFileName),
    storedAt: now.toISOString(),
    sizeBytes: upload.size,
    sha256: upload.sha256,
  };
  const nextMetadata = {
    userId,
    updatedAt: nextEntry.storedAt,
    latest: nextEntry,
    history: dedupeHistoryEntries([previousMetadata.latest, ...previousMetadata.history]).slice(
      0,
      HISTORY_RETENTION_COUNT,
    ),
  };

  await fs.writeFile(metadataPath, `${JSON.stringify(nextMetadata, null, 2)}\n`, "utf8");

  return {
    ...nextEntry,
    historyCount: nextMetadata.history.length,
    latestUrl: `${config.backupPublicBaseUrl}/backup/latest`,
  };
}

function sanitizeFileName(value) {
  if (Array.isArray(value)) {
    return sanitizeFileName(value[0]);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return "bladevault-data.tar.gz";
  }
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "bladevault-data.tar.gz";
}

async function readMetadata(userId) {
  const userDir = getUserDirectory(userId);
  const metadataPath = path.join(userDir, "metadata.json");
  const latestPath = path.join(userDir, "latest.tar.gz");

  const base = {
    userId,
    updatedAt: null,
    latest: null,
    history: [],
  };

  try {
    const text = await fs.readFile(metadataPath, "utf8");
    const parsed = JSON.parse(text);
    return {
      ...base,
      ...parsed,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      console.error("[bladevault-backup-server] metadata read error", error);
    }
  }

  try {
    const stat = await fs.stat(latestPath);
    return {
      ...base,
      updatedAt: stat.mtime.toISOString(),
      latest: {
        fileName: "bladevault-data.tar.gz",
        storedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
        sha256: null,
      },
      history: [],
    };
  } catch {
    return base;
  }
}

function buildMetaResponse(auth, metadata) {
  return {
    user: auth.user,
    backup: {
      exists: Boolean(metadata.latest),
      updatedAt: metadata.updatedAt,
      latest: metadata.latest,
      historyCount: metadata.history.length,
    },
  };
}

function createTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function dedupeHistoryEntries(entries) {
  const seen = new Set();
  const result = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const key = JSON.stringify([
      entry.storedAt ?? null,
      entry.sha256 ?? null,
      entry.sizeBytes ?? null,
      entry.fileName ?? null,
    ]);

    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(`${JSON.stringify(payload)}\n`);
}
