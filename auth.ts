import { betterAuth } from "better-auth";
import { DatabaseSync } from "node:sqlite";
import { buildAuthOptions } from "./src/auth-options";

const cliDatabase = new DatabaseSync(":memory:");

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set before loading Better Auth.`);
  }
  return value;
}

export const auth = betterAuth(
  buildAuthOptions({
    APP_NAME: process.env.APP_NAME || "BladeVault",
    AUTH_PUBLIC_BASE_URL: requireEnv("AUTH_PUBLIC_BASE_URL"),
    ALLOWED_CLIENT_ORIGINS: process.env.ALLOWED_CLIENT_ORIGINS || "",
    BETTER_AUTH_API_KEY: process.env.BETTER_AUTH_API_KEY,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET || "development-secret-key-that-is-long-enough",
    COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    DB: cliDatabase,
  }),
);

export default auth;
