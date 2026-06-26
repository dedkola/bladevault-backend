export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_NAME: string;
  BETTER_AUTH_API_KEY?: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  COOKIE_DOMAIN?: string;
  CORS_ORIGIN: string;
  FRONTEND_URL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  R2_PUBLIC_BASE_URL: string;
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

export function isAllowedOrigin(
  origin: string | undefined,
  env: Pick<Env, "BETTER_AUTH_URL" | "CORS_ORIGIN" | "FRONTEND_URL">,
): boolean {
  if (!origin) return false;
  return getAllowedOrigins(env).some((pattern) => matchesOriginPattern(origin, pattern));
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
