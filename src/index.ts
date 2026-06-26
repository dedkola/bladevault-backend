import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createAuth } from "./auth";
import type { Env } from "./env";
import { getAllowedOrigins, isAllowedOrigin } from "./env";
import {
  addCompareId,
  buildSnapshot,
  deleteKnife,
  deleteRemovedManagedImages,
  getKnife,
  listCompareIds,
  listKnives,
  removeCompareId,
  replaceCompareIds,
  upsertKnife,
} from "./data";
import {
  compareMutationSchema,
  imageDeleteSignSchema,
  imageUploadSignSchema,
  knifeInputSchema,
  knifePatchSchema,
  syncPushSchema,
  toKnifeRecord,
} from "./models";
import {
  buildUserPrefix,
  createSignedImageDelete,
  createSignedImageUpload,
  extractManagedKey,
} from "./storage";

type AuthInstance = ReturnType<typeof createAuth>;
type SessionValue = AuthInstance["$Infer"]["Session"]["session"] | null;
type UserValue = AuthInstance["$Infer"]["Session"]["user"] | null;

type AppType = {
  Bindings: Env;
  Variables: {
    auth: AuthInstance;
    session: SessionValue;
    user: UserValue;
  };
};

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseBodyError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join(", ");
  }
  if (error instanceof Error) return error.message;
  return "Invalid request";
}

function createKnifeId() {
  return crypto.randomUUID();
}

function requireAuth(c: Context<AppType>) {
  const existing = c.get("auth");
  if (existing) return existing;

  const auth = createAuth(c.env);
  c.set("auth", auth);
  return auth;
}

async function requireUser(c: Context<AppType>) {
  const user = c.get("user");
  if (!user) throw new Error("Unauthorized");
  return user;
}

const app = new Hono<AppType>();

const googleStartQuerySchema = z.object({
  callbackURL: z.string().url(),
});

const DIRECT_UPLOAD_MESSAGE =
  "Inline image uploads are disabled. Request a signed R2 upload URL, upload directly to R2, then store the returned publicUrl in D1.";

app.use("*", async (c, next) => {
  const allowedOrigins = getAllowedOrigins(c.env);
  return cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0] ?? "";
      return isAllowedOrigin(origin, c.env) ? origin : "";
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    credentials: true,
    maxAge: 86400,
  })(c, next);
});

app.use("/api/auth/*", async (c, next) => {
  requireAuth(c);
  await next();
});

app.use("/api/auth/google/start", async (c, next) => {
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

app.use("/api/v1/*", async (c, next) => {
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
    name: "BladeVault Backend",
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

app.get("/api/auth/google/start", async (c) => {
  const parsed = googleStartQuerySchema.safeParse({
    callbackURL: c.req.query("callbackURL"),
  });

  if (!parsed.success) {
    return c.json({ error: "Valid callbackURL is required" }, 400);
  }

  const auth = c.get("auth");
  const signInRequest = new Request(`${c.env.BETTER_AUTH_URL}/api/auth/sign-in/social`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "google",
      callbackURL: parsed.data.callbackURL,
      newUserCallbackURL: parsed.data.callbackURL,
      errorCallbackURL: parsed.data.callbackURL,
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
    return c.json({ error: "Google sign-in URL was not returned by Better Auth" }, 500);
  }

  const headers = new Headers({
    Location: data.url,
  });
  const setCookie = signInResponse.headers.get("set-cookie");
  if (setCookie) {
    headers.append("set-cookie", setCookie);
  }

  return new Response(null, {
    status: 302,
    headers,
  });
});

app.all("/api/auth/*", (c) => {
  const auth = c.get("auth");
  return auth.handler(c.req.raw);
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  const session = c.get("session");
  if (!user || !session) {
    return c.json({ user: null, session: null }, 401);
  }
  return c.json({ user, session });
});

app.get("/api/v1/knives", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const knives = await listKnives(c.env.DB, user.id);
  return c.json({ knives });
});

app.post("/api/v1/knives", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    const parsed = knifeInputSchema.parse(await c.req.json());
    const knife = toKnifeRecord(parsed, parsed.id ?? createKnifeId());
    const existing = await getKnife(c.env.DB, user.id, knife.id);
    if (existing) {
      await deleteRemovedManagedImages(c.env, existing.images, knife.images);
    }
    await upsertKnife(c.env.DB, user.id, knife);
    return c.json({ knife }, existing ? 200 : 201);
  } catch (error) {
    return c.json({ error: parseBodyError(error) }, 400);
  }
});

app.patch("/api/v1/knives/:id", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const knifeId = c.req.param("id");
  const existing = await getKnife(c.env.DB, user.id, knifeId);
  if (!existing) return c.json({ error: "Knife not found" }, 404);

  try {
    const parsed = knifePatchSchema.parse(await c.req.json());
    const merged = toKnifeRecord(
      {
        ...existing,
        ...parsed,
        specs: {
          ...existing.specs,
          ...parsed.specs,
        },
        images: parsed.images ?? parsed.imageUrls ?? existing.images,
      },
      existing.id,
      { addedAt: existing.addedAt, updatedAt: new Date().toISOString() },
    );
    await deleteRemovedManagedImages(c.env, existing.images, merged.images);
    await upsertKnife(c.env.DB, user.id, merged);
    return c.json({ knife: merged });
  } catch (error) {
    return c.json({ error: parseBodyError(error) }, 400);
  }
});

app.delete("/api/v1/knives/:id", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const knifeId = c.req.param("id");
  const existing = await getKnife(c.env.DB, user.id, knifeId);
  if (!existing) return c.json({ error: "Knife not found" }, 404);

  await deleteRemovedManagedImages(c.env, existing.images, []);
  await deleteKnife(c.env.DB, user.id, knifeId);
  return c.json({ ok: true });
});

app.get("/api/v1/compare", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const compareIds = await listCompareIds(c.env.DB, user.id);
  return c.json({ compareIds });
});

app.post("/api/v1/compare", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    const parsed = compareMutationSchema.parse(await c.req.json());
    const knife = await getKnife(c.env.DB, user.id, parsed.id);
    if (!knife) return c.json({ error: "Knife not found" }, 404);
    await addCompareId(c.env.DB, user.id, parsed.id);
    return c.json({ compareIds: await listCompareIds(c.env.DB, user.id) });
  } catch (error) {
    return c.json({ error: parseBodyError(error) }, 400);
  }
});

app.delete("/api/v1/compare", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    const parsed = compareMutationSchema.parse(await c.req.json());
    await removeCompareId(c.env.DB, user.id, parsed.id);
    return c.json({ compareIds: await listCompareIds(c.env.DB, user.id) });
  } catch (error) {
    return c.json({ error: parseBodyError(error) }, 400);
  }
});

app.get("/api/v1/sync/pull", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await buildSnapshot(c.env.DB, user.id));
});

app.post("/api/v1/sync/push", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    const parsed = syncPushSchema.parse(await c.req.json());
    const existingKnives = await listKnives(c.env.DB, user.id);
    const existingMap = new Map(existingKnives.map((knife) => [knife.id, knife]));
    const seenIds = new Set<string>();

    for (const item of parsed.knives) {
      const knifeId = item.id ?? createKnifeId();
      const previous = existingMap.get(knifeId);
      const knife = toKnifeRecord(item, knifeId, {
        addedAt: item.addedAt ?? previous?.addedAt,
        updatedAt: item.updatedAt ?? new Date().toISOString(),
      });

      await deleteRemovedManagedImages(c.env, previous?.images ?? [], knife.images);
      await upsertKnife(c.env.DB, user.id, knife);
      seenIds.add(knifeId);
    }

    if (parsed.replaceAll) {
      for (const knife of existingKnives) {
        if (seenIds.has(knife.id)) continue;
        await deleteRemovedManagedImages(c.env, knife.images, []);
        await deleteKnife(c.env.DB, user.id, knife.id);
      }
    }

    if (parsed.compareIds) {
      await replaceCompareIds(c.env.DB, user.id, parsed.compareIds);
    }
    return c.json(await buildSnapshot(c.env.DB, user.id));
  } catch (error) {
    return c.json({ error: parseBodyError(error) }, 400);
  }
});

app.post("/api/v1/images/sign-upload", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    const parsed = imageUploadSignSchema.parse(await c.req.json());
    const knifeId = parsed.knifeId ?? createKnifeId();
    const signedUpload = await createSignedImageUpload(
      c.env,
      user.id,
      knifeId,
      parsed.contentType,
      parsed.filename,
    );

    return c.json({ ...signedUpload, knifeId }, 200);
  } catch (error) {
    return c.json({ error: parseBodyError(error) }, 400);
  }
});

app.post("/api/v1/images/sign-delete", async (c) => {
  const user = await requireUser(c).catch(() => null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    const parsed = imageDeleteSignSchema.parse(await c.req.json());
    const key = extractManagedKey(c.env, parsed.publicUrl);
    if (!key) {
      return c.json({ error: "publicUrl must point to the configured R2 public base URL" }, 400);
    }
    if (!key.startsWith(`${buildUserPrefix(user.id)}/`)) {
      return c.json({ error: "You can only delete your own objects" }, 403);
    }

    const signedDelete = await createSignedImageDelete(c.env, key);
    return c.json({ ...signedDelete, key }, 200);
  } catch (error) {
    return c.json({ error: parseBodyError(error) }, 400);
  }
});

app.post("/api/v1/images/upload", (c) => c.json({ error: DIRECT_UPLOAD_MESSAGE }, 410));

app.post("/api/v1/images/data-url", (c) => c.json({ error: DIRECT_UPLOAD_MESSAGE }, 410));

app.notFound(() => jsonError("Not found", 404));
app.onError((error) => jsonError(error.message || "Internal server error", 500));

export default app;
