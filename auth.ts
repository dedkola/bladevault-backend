import { betterAuth } from "better-auth";
import { DatabaseSync } from "node:sqlite";
import { buildAuthOptions } from "./src/auth-options";

const cliDatabase = new DatabaseSync(":memory:");

export const auth = betterAuth(
  buildAuthOptions({
    APP_NAME: process.env.APP_NAME || "BladeVault",
    BETTER_AUTH_API_KEY: process.env.BETTER_AUTH_API_KEY,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET || "development-secret-key-that-is-long-enough",
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || "http://localhost:8787",
    COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
    CORS_ORIGIN: process.env.CORS_ORIGIN || "http://localhost:*,http://127.0.0.1:*",
    FRONTEND_URL: process.env.FRONTEND_URL || "http://localhost:*,http://127.0.0.1:*",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    DB: cliDatabase,
  }),
);

export default auth;
