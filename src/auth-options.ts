import { betterAuth, type BetterAuthOptions } from "better-auth";
import { dash } from "@better-auth/infra";
import { bearer } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { getAuthPublicBaseUrl, getTrustedOrigins, isHttpsUrl, type Env } from "./env";

type RuntimeEnv = Pick<
  Env,
  | "APP_NAME"
  | "AUTH_PUBLIC_BASE_URL"
  | "ALLOWED_CLIENT_ORIGINS"
  | "BETTER_AUTH_API_KEY"
  | "BETTER_AUTH_SECRET"
  | "COOKIE_DOMAIN"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
> & {
  DB: BetterAuthOptions["database"];
};

export function buildAuthOptions(env: RuntimeEnv): BetterAuthOptions {
  const plugins = env.BETTER_AUTH_API_KEY
    ? [
        dash({
          apiKey: env.BETTER_AUTH_API_KEY,
        }),
        bearer(),
        jwt({
          jwt: {
            issuer: getAuthPublicBaseUrl(env),
            audience: getAuthPublicBaseUrl(env),
          },
        }),
      ]
    : [
        bearer(),
        jwt({
          jwt: {
            issuer: getAuthPublicBaseUrl(env),
            audience: getAuthPublicBaseUrl(env),
          },
        }),
      ];

  return {
    appName: env.APP_NAME,
    baseURL: getAuthPublicBaseUrl(env),
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    plugins,
    trustedOrigins: getTrustedOrigins(env),
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
      useSecureCookies: isHttpsUrl(getAuthPublicBaseUrl(env)),
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
  };
}

export function createRuntimeAuth(env: RuntimeEnv) {
  return betterAuth(buildAuthOptions(env));
}
