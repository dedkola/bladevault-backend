export interface Env {
  DB: D1Database;
  APP_NAME: string;
  AUTH_PUBLIC_BASE_URL: string;
  ALLOWED_CLIENT_ORIGINS: string;
  BETTER_AUTH_API_KEY?: string;
  BETTER_AUTH_SECRET: string;
  COOKIE_DOMAIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const LOCAL_DEV_HOSTS = new Set(["localhost", "host.docker.internal", "gateway.docker.internal"]);

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

export function getAuthPublicBaseUrl(env: Pick<Env, "AUTH_PUBLIC_BASE_URL">): string {
  return normalizeBaseUrl(env.AUTH_PUBLIC_BASE_URL);
}

export function getAllowedClientOriginPatterns(env: Pick<Env, "ALLOWED_CLIENT_ORIGINS">): string[] {
  return splitCsv(env.ALLOWED_CLIENT_ORIGINS)
    .map(normalizeBaseUrl)
    .filter((pattern) => pattern !== "*");
}

export function allowsAnyClientOrigin(env: Pick<Env, "ALLOWED_CLIENT_ORIGINS">): boolean {
  return splitCsv(env.ALLOWED_CLIENT_ORIGINS)
    .map(normalizeBaseUrl)
    .includes("*");
}

export function getTrustedOrigins(
  env: Pick<Env, "AUTH_PUBLIC_BASE_URL" | "ALLOWED_CLIENT_ORIGINS">,
): string[] {
  return Array.from(
    new Set([
      getAuthPublicBaseUrl(env),
      ...getAllowedClientOriginPatterns(env),
    ].filter(Boolean)),
  );
}

export function isAllowedClientOrigin(
  origin: string | undefined,
  env: Pick<Env, "AUTH_PUBLIC_BASE_URL" | "ALLOWED_CLIENT_ORIGINS">,
): boolean {
  if (!origin) return false;
  if (allowsAnyClientOrigin(env)) return true;
  return (
    isLocalDevelopmentOrigin(origin) ||
    getTrustedOrigins(env).some((pattern) => matchesOriginPattern(origin, pattern))
  );
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
