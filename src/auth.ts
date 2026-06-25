import type { Env } from "./env";
import { createRuntimeAuth } from "./auth-options";

export function createAuth(env: Env) {
  return createRuntimeAuth({
    ...env,
    cleanupDb: env.DB,
  });
}
