export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_NAME: string;
  BETTER_AUTH_API_KEY?: string;
  BETTER_AUTH_URL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  BETTER_AUTH_SECRET: string;
  COOKIE_DOMAIN?: string;
  CORS_ORIGIN: string;
  FRONTEND_URL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_BUCKET_NAME: string;
  R2_PUBLIC_BASE_URL: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_SIGNED_URL_TTL_SECONDS?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
}

export function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

const LOCAL_DEV_HOSTS = new Set(["localhost", "host.docker.internal", "gateway.docker.internal"]);
const REQUEST_URL_FIELDS = [
  "callbackURL",
  "errorCallbackURL",
  "newUserCallbackURL",
  "popupOrigin",
  "redirectTo",
] as const;

export function getAllowedOrigins(env: Pick<Env, "BETTER_AUTH_URL" | "CORS_ORIGIN" | "FRONTEND_URL">): string[] {
  return Array.from(
    new Set([
      normalizeBaseUrl(env.BETTER_AUTH_URL),
      ...splitCsv(env.CORS_ORIGIN).map(normalizeBaseUrl),
      ...splitCsv(env.FRONTEND_URL).map(normalizeBaseUrl),
    ].filter(Boolean)),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isIpv4Address(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isPrivateOrLoopbackIpv4(hostname: string): boolean {
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

function isLoopbackOrPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:");
}

function toNormalizedOrigin(value: string): string | null {
  const url = parseUrl(value);
  if (!url) return null;
  return normalizeBaseUrl(url.origin);
}

function addLocalRequestOrigin(origins: Set<string>, value: unknown) {
  if (typeof value !== "string") return;
  const origin = toNormalizedOrigin(value);
  if (origin && isLocalDevelopmentOrigin(origin)) {
    origins.add(origin);
  }
}

export function matchesOriginPattern(origin: string, pattern: string): boolean {
  const normalizedOrigin = normalizeBaseUrl(origin);
  const normalizedPattern = normalizeBaseUrl(pattern);

  if (!normalizedOrigin || !normalizedPattern) return false;
  if (!normalizedPattern.includes("*") && !normalizedPattern.includes("?")) {
    return normalizedOrigin === normalizedPattern;
  }

  const patternRegex = new RegExp(
    `^${escapeRegExp(normalizedPattern).replaceAll("*", ".*").replaceAll("?", ".")}$`,
  );

  return patternRegex.test(normalizedOrigin);
}

export function isLocalDevelopmentOrigin(value: string): boolean {
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

export function isAllowedOrigin(
  origin: string | undefined,
  env: Pick<Env, "BETTER_AUTH_URL" | "CORS_ORIGIN" | "FRONTEND_URL">,
): boolean {
  if (!origin) return false;
  return isLocalDevelopmentOrigin(origin) || getAllowedOrigins(env).some((pattern) => matchesOriginPattern(origin, pattern));
}

export async function getAllowedOriginsForRequest(
  env: Pick<Env, "BETTER_AUTH_URL" | "CORS_ORIGIN" | "FRONTEND_URL">,
  request?: Request,
): Promise<string[]> {
  const origins = new Set(getAllowedOrigins(env));
  if (!request) return Array.from(origins);

  addLocalRequestOrigin(origins, request.headers.get("origin"));

  const requestUrl = parseUrl(request.url);
  if (requestUrl) {
    for (const field of REQUEST_URL_FIELDS) {
      for (const value of requestUrl.searchParams.getAll(field)) {
        addLocalRequestOrigin(origins, value);
      }
    }
  }

  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return Array.from(origins);
  }

  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.clone().json()) as Record<string, unknown> | null;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        for (const field of REQUEST_URL_FIELDS) {
          addLocalRequestOrigin(origins, body[field]);
        }
      }
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = new URLSearchParams(await request.clone().text());
      for (const field of REQUEST_URL_FIELDS) {
        for (const value of body.getAll(field)) {
          addLocalRequestOrigin(origins, value);
        }
      }
    }
  } catch {
    // Ignore malformed or unreadable bodies and fall back to static origins.
  }

  return Array.from(origins);
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
