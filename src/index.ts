import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createAuth } from "./auth";
import type { Env } from "./env";
import { getAuthPublicBaseUrl, getTrustedOrigins, isAllowedClientOrigin } from "./env";

type AuthInstance = ReturnType<typeof createAuth>;
type SessionValue = AuthInstance["$Infer"]["Session"]["session"] | null;
type UserValue = AuthInstance["$Infer"]["Session"]["user"] | null;

type PopupAuthSuccess = {
  type: "bladevault-auth-success";
  accessToken: string;
  sessionToken: string;
  expiresAt: string;
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
};

type PopupAuthError = {
  type: "bladevault-auth-error";
  error: {
    message: string;
  };
};

type AppType = {
  Bindings: Env;
  Variables: {
    auth: AuthInstance;
    session: SessionValue;
    user: UserValue;
  };
};

const popupStartQuerySchema = z.object({
  client_origin: z.string().url(),
});

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireAuth(c: Context<AppType>) {
  const existing = c.get("auth");
  if (existing) return existing;

  const auth = createAuth(c.env);
  c.set("auth", auth);
  return auth;
}

function buildPopupCompleteUrl(env: Pick<Env, "AUTH_PUBLIC_BASE_URL">, clientOrigin: string): string {
  const url = new URL("/auth/popup/complete", getAuthPublicBaseUrl(env));
  url.searchParams.set("client_origin", clientOrigin);
  return url.toString();
}

function escapeForHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPopupPage(clientOrigin: string, payload: PopupAuthSuccess | PopupAuthError) {
  const serializedOrigin = JSON.stringify(clientOrigin).replace(/</g, "\\u003c");
  const serializedPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  const title = payload.type === "bladevault-auth-success" ? "BladeVault sign-in complete" : "BladeVault sign-in failed";
  const message =
    payload.type === "bladevault-auth-success"
      ? "You can close this window and return to BladeVault."
      : payload.error.message;

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeForHtml(title)}</title>
  </head>
  <body style="font-family: Arial, sans-serif; margin: 0; background: #0f1115; color: #f3f4f6;">
    <main style="max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem;">
      <section style="background: #171b22; border: 1px solid #2b3139; border-radius: 1rem; padding: 1.5rem;">
        <h1 style="margin: 0 0 1rem; font-size: 1.25rem;">${escapeForHtml(title)}</h1>
        <p style="margin: 0; line-height: 1.6;">${escapeForHtml(message)}</p>
      </section>
    </main>
    <script>
      const targetOrigin = ${serializedOrigin};
      const payload = ${serializedPayload};
      if (window.opener && typeof window.opener.postMessage === "function") {
        window.opener.postMessage(payload, targetOrigin);
      }
      window.setTimeout(() => window.close(), 150);
    </script>
  </body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

async function readJwtToken(c: Context<AppType>): Promise<string | null> {
  const auth = c.get("auth");
  const response = await auth.handler(
    new Request(`${getAuthPublicBaseUrl(c.env)}/api/auth/token`, {
      method: "GET",
      headers: c.req.raw.headers,
    }),
  );

  if (!response.ok) return null;

  const data = (await response.json()) as { token?: string };
  return typeof data.token === "string" && data.token.length > 0 ? data.token : null;
}

const app = new Hono<AppType>();

app.use("*", async (c, next) => {
  const allowedOrigins = getTrustedOrigins(c.env);
  return cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0] ?? "";
      return isAllowedClientOrigin(origin, c.env) ? origin : "";
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    credentials: true,
    maxAge: 86400,
  })(c, next);
});

app.use("/api/auth/*", async (c, next) => {
  requireAuth(c);
  await next();
});

app.use("/api/me", async (c, next) => {
  const auth = requireAuth(c);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  c.set("session", session?.session ?? null);
  c.set("user", session?.user ?? null);
  await next();
});

app.get("/", (c) =>
  c.json({
    name: "BladeVault Auth Backend",
    ok: true,
    now: new Date().toISOString(),
  }),
);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    now: new Date().toISOString(),
  }),
);

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const session = c.get("session");
  if (!user || !session) {
    return c.json({ user: null, session: null }, 401);
  }

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image ?? null,
    },
    session: {
      id: session.id,
      expiresAt: session.expiresAt,
      token: session.token,
    },
  });
});

app.get("/auth/popup/start", async (c) => {
  const parsed = popupStartQuerySchema.safeParse({
    client_origin: c.req.query("client_origin"),
  });

  if (!parsed.success) {
    return jsonError("Valid client_origin is required", 400);
  }

  if (!isAllowedClientOrigin(parsed.data.client_origin, c.env)) {
    return jsonError("client_origin is not allowed", 403);
  }

  const auth = requireAuth(c);
  const callbackURL = buildPopupCompleteUrl(c.env, parsed.data.client_origin);
  const signInRequest = new Request(`${getAuthPublicBaseUrl(c.env)}/api/auth/sign-in/social`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "google",
      callbackURL,
      newUserCallbackURL: callbackURL,
      errorCallbackURL: callbackURL,
      disableRedirect: true,
    }),
  });

  const signInResponse = await auth.handler(signInRequest);
  if (!signInResponse.ok) {
    const body = await signInResponse.text();
    return new Response(body, {
      status: signInResponse.status,
      headers: signInResponse.headers,
    });
  }

  const data = (await signInResponse.json()) as { url?: string };
  if (!data.url) {
    return jsonError("Google sign-in URL was not returned by Better Auth", 500);
  }

  const headers = new Headers(signInResponse.headers);
  headers.set("Location", data.url);
  return new Response(null, {
    status: 302,
    headers,
  });
});

app.get("/auth/popup/complete", async (c) => {
  const parsed = popupStartQuerySchema.safeParse({
    client_origin: c.req.query("client_origin"),
  });

  if (!parsed.success || !isAllowedClientOrigin(parsed.data.client_origin, c.env)) {
    return renderPopupPage(parsed.success ? parsed.data.client_origin : "*", {
      type: "bladevault-auth-error",
      error: {
        message: "The login request used an invalid client origin.",
      },
    });
  }

  const auth = requireAuth(c);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session?.session || !session.user) {
    return renderPopupPage(parsed.data.client_origin, {
      type: "bladevault-auth-error",
      error: {
        message: "Sign-in did not create a session. Please try again.",
      },
    });
  }

  c.set("session", session.session);
  c.set("user", session.user);

  const accessToken = await readJwtToken(c);
  if (!accessToken) {
    return renderPopupPage(parsed.data.client_origin, {
      type: "bladevault-auth-error",
      error: {
        message: "Sign-in succeeded, but the backup access token could not be created.",
      },
    });
  }

  return renderPopupPage(parsed.data.client_origin, {
    type: "bladevault-auth-success",
    accessToken,
    sessionToken: session.session.token,
    expiresAt: session.session.expiresAt.toISOString(),
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? null,
    },
  });
});

app.all("/api/auth/*", (c) => {
  const auth = c.get("auth");
  return auth.handler(c.req.raw);
});

app.notFound(() => jsonError("Not found", 404));
app.onError((error) => jsonError(error.message || "Internal server error", 500));

export default app;
