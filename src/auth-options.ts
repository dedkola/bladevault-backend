import { betterAuth, type BetterAuthOptions } from "better-auth";
import { dash } from "@better-auth/infra";
import { bearer, oauthPopup } from "better-auth/plugins";
import { deleteUserPrefix } from "./storage";
import { getAllowedOriginsForRequest, isHttpsUrl, type Env } from "./env";

type RuntimeEnv = Pick<
  Env,
  | "APP_NAME"
  | "BETTER_AUTH_API_KEY"
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_URL"
  | "COOKIE_DOMAIN"
  | "CORS_ORIGIN"
  | "FRONTEND_URL"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
> & {
  DB: BetterAuthOptions["database"];
  BUCKET?: R2Bucket;
  cleanupDb?: D1Database;
};

export function buildAuthOptions(env: RuntimeEnv): BetterAuthOptions {
  const plugins = env.BETTER_AUTH_API_KEY
    ? [
        dash({
          apiKey: env.BETTER_AUTH_API_KEY,
        }),
        bearer(),
        oauthPopup(),
      ]
    : [bearer(), oauthPopup()];

  return {
    appName: env.APP_NAME,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    plugins,
    trustedOrigins: async (request) => getAllowedOriginsForRequest(env, request),
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : undefined,
    advanced: {
      trustedProxyHeaders: true,
      useSecureCookies: isHttpsUrl(env.BETTER_AUTH_URL),
      defaultCookieAttributes: {
        sameSite: "none",
      },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"],
      },
      crossSubDomainCookies: env.COOKIE_DOMAIN
        ? {
            enabled: true,
            domain: env.COOKIE_DOMAIN,
          }
        : undefined,
    },
    emailAndPassword: {
      enabled: false,
    },
    user: {
      deleteUser: {
        enabled: true,
        afterDelete: async (user) => {
          if (env.cleanupDb) {
            await env.cleanupDb.batch([
              env.cleanupDb.prepare("DELETE FROM compare_list WHERE user_id = ?").bind(user.id),
              env.cleanupDb.prepare("DELETE FROM user_vault_knives WHERE user_id = ?").bind(user.id),
            ]);
          }
          if (!env.BUCKET) return;
          await deleteUserPrefix(env.BUCKET, `users/${user.id}`);
        },
      },
    },
  };
}

export function createRuntimeAuth(env: RuntimeEnv) {
  return betterAuth(buildAuthOptions(env));
}
