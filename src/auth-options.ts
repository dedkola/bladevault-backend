import { betterAuth, type BetterAuthOptions } from "better-auth";
import { deleteUserPrefix } from "./storage";
import { getAllowedOrigins, isHttpsUrl, type Env } from "./env";
import { sendResetPasswordEmail, sendVerificationEmail } from "./email";

type RuntimeEnv = Pick<
  Env,
  | "APP_NAME"
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_URL"
  | "COOKIE_DOMAIN"
  | "CORS_ORIGIN"
  | "FRONTEND_URL"
  | "RESEND_API_KEY"
  | "RESEND_FROM_EMAIL"
> & {
  DB: BetterAuthOptions["database"];
  BUCKET?: R2Bucket;
  cleanupDb?: D1Database;
};

export function buildAuthOptions(env: RuntimeEnv): BetterAuthOptions {
  return {
    appName: env.APP_NAME,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: getAllowedOrigins(env),
    advanced: {
      trustedProxyHeaders: true,
      useSecureCookies: isHttpsUrl(env.BETTER_AUTH_URL),
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
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      autoSignIn: false,
      sendResetPassword: async ({ user, url }) => {
        await sendResetPasswordEmail(env, {
          email: user.email,
          name: user.name,
          url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendVerificationEmail(env, {
          email: user.email,
          name: user.name,
          url,
        });
      },
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
