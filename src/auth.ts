import type { Env } from "./env";
import { createRuntimeAuth } from "./auth-options";

export function createAuth(env: Env) {
  return createRuntimeAuth({
    DB: env.DB,
    APP_NAME: env.APP_NAME,
    AUTH_PUBLIC_BASE_URL: env.AUTH_PUBLIC_BASE_URL,
    ALLOWED_CLIENT_ORIGINS: env.ALLOWED_CLIENT_ORIGINS,
    BETTER_AUTH_API_KEY: env.BETTER_AUTH_API_KEY,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    COOKIE_DOMAIN: env.COOKIE_DOMAIN,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
  });
}
