import type { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { getAuthPublicBaseUrl, isAllowedClientOrigin } from "./env";

// Google Drive backup sign-in.
//
// BladeVault stores a backup in the user's own Google Drive. This service only
// finishes the Google sign-in and refreshes access, because both steps need the
// Google client secret. It keeps nothing: tokens pass straight back to the
// BladeVault server that asked, and backup data never travels through here.

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

type DriveAuthCode = {
  type: "bladevault-drive-auth-code";
  code: string;
  state: string;
};

type DriveAuthError = {
  type: "bladevault-drive-auth-error";
  error: { message: string };
};

type DriveEnv = { Bindings: Env };

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);

const startQuerySchema = z.object({
  client_origin: z.string().url(),
  state: base64Url.min(16).max(256),
  // A SHA-256 PKCE challenge is always 43 base64url characters.
  code_challenge: base64Url.length(43),
});

const tokenBodySchema = z.object({
  code: z.string().min(1).max(4096),
  code_verifier: base64Url.min(43).max(128),
});

const refreshBodySchema = z.object({
  refresh_token: z.string().min(1).max(4096),
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function getRedirectUri(env: Pick<Env, "AUTH_PUBLIC_BASE_URL">): string {
  return new URL("/auth/drive/callback", getAuthPublicBaseUrl(env)).toString();
}

function encodeState(clientOrigin: string, state: string): string {
  return btoa(JSON.stringify({ o: clientOrigin, s: state }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeState(value: string | undefined): { clientOrigin: string; state: string } | null {
  if (!value) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(padded)) as { o?: unknown; s?: unknown };
    if (typeof parsed.o !== "string" || typeof parsed.s !== "string") return null;
    return { clientOrigin: parsed.o, state: parsed.s };
  } catch {
    return null;
  }
}

function escapeForHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// With no trusted origin there is nobody to hand a result to, so the page only
// shows the message.
function renderDrivePopupPage(clientOrigin: string | null, payload: DriveAuthCode | DriveAuthError) {
  const succeeded = payload.type === "bladevault-drive-auth-code";
  const title = succeeded ? "Google Drive connected" : "Google Drive sign-in failed";
  const message = succeeded ? "You can close this window and return to BladeVault." : payload.error.message;
  const serializedOrigin = JSON.stringify(clientOrigin).replace(/</g, "\\u003c");
  const serializedPayload = JSON.stringify(payload).replace(/</g, "\\u003c");

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
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
      // Drop the sign-in code from this window's address and history.
      history.replaceState(null, "", location.pathname);
      if (targetOrigin && window.opener && typeof window.opener.postMessage === "function") {
        window.opener.postMessage(payload, targetOrigin);
        window.setTimeout(() => window.close(), 150);
      }
    </script>
  </body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

async function requestGoogleToken(params: Record<string, string>) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // A missing body is handled through the status code.
  }
  return { ok: response.ok, status: response.status, data };
}

// Google reports a rejected or revoked sign-in as invalid_grant. Everything
// else is treated as a temporary failure so the app keeps its connection.
function googleFailureStatus(result: { status: number; data: Record<string, unknown> }) {
  return result.data.error === "invalid_grant" ? 401 : 502;
}

export function registerDriveRoutes<E extends DriveEnv>(app: Hono<E>) {
  app.get("/auth/drive/start", (c) => {
    const parsed = startQuerySchema.safeParse({
      client_origin: c.req.query("client_origin"),
      state: c.req.query("state"),
      code_challenge: c.req.query("code_challenge"),
    });
    if (!parsed.success) return jsonResponse({ error: "Invalid sign-in request" }, 400);
    if (!isAllowedClientOrigin(parsed.data.client_origin, c.env)) {
      return jsonResponse({ error: "client_origin is not allowed" }, 403);
    }
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
      return jsonResponse({ error: "Google sign-in is not configured" }, 503);
    }

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", getRedirectUri(c.env));
    url.searchParams.set("scope", DRIVE_FILE_SCOPE);
    url.searchParams.set("state", encodeState(new URL(parsed.data.client_origin).origin, parsed.data.state));
    // The BladeVault server that started sign-in keeps the verifier, so the
    // code returned to the browser is useless to anyone else.
    url.searchParams.set("code_challenge", parsed.data.code_challenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Offline access with a fresh consent makes Google return a refresh token.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return c.redirect(url.toString(), 302);
  });

  app.get("/auth/drive/callback", (c) => {
    const state = decodeState(c.req.query("state"));
    if (!state || !isAllowedClientOrigin(state.clientOrigin, c.env)) {
      return renderDrivePopupPage(null, {
        type: "bladevault-drive-auth-error",
        error: { message: "The sign-in request used an invalid client origin." },
      });
    }

    const code = c.req.query("code");
    if (!code) {
      const denied = c.req.query("error") === "access_denied";
      return renderDrivePopupPage(state.clientOrigin, {
        type: "bladevault-drive-auth-error",
        error: {
          message: denied
            ? "Google Drive access was not granted."
            : "Google sign-in did not complete. Please try again.",
        },
      });
    }

    return renderDrivePopupPage(state.clientOrigin, {
      type: "bladevault-drive-auth-code",
      code,
      state: state.state,
    });
  });

  app.post("/auth/drive/token", async (c) => {
    const parsed = tokenBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_request" }, 400);
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
      return jsonResponse({ error: "not_configured" }, 503);
    }

    const result = await requestGoogleToken({
      grant_type: "authorization_code",
      code: parsed.data.code,
      code_verifier: parsed.data.code_verifier,
      redirect_uri: getRedirectUri(c.env),
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
    });
    if (!result.ok || typeof result.data.access_token !== "string") {
      return jsonResponse({ error: "sign_in_failed" }, googleFailureStatus(result) === 401 ? 400 : 502);
    }
    return jsonResponse({
      access_token: result.data.access_token,
      refresh_token: result.data.refresh_token ?? null,
      expires_in: result.data.expires_in ?? null,
      scope: result.data.scope ?? "",
    });
  });

  app.post("/auth/drive/refresh", async (c) => {
    const parsed = refreshBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return jsonResponse({ error: "invalid_request" }, 400);
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
      return jsonResponse({ error: "not_configured" }, 503);
    }

    const result = await requestGoogleToken({
      grant_type: "refresh_token",
      refresh_token: parsed.data.refresh_token,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
    });
    if (!result.ok || typeof result.data.access_token !== "string") {
      return jsonResponse({ error: "refresh_failed" }, googleFailureStatus(result));
    }
    return jsonResponse({
      access_token: result.data.access_token,
      expires_in: result.data.expires_in ?? null,
    });
  });
}
