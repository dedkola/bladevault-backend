export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_NAME: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  COOKIE_DOMAIN?: string;
  CORS_ORIGIN: string;
  FRONTEND_URL: string;
  R2_PUBLIC_BASE_URL: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
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

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
