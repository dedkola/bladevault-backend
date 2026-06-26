import { AwsClient } from "aws4fetch";
import type { Env } from "./env";

const SAFE_FILENAME = /[^a-zA-Z0-9._-]/g;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;

function toArrayBuffer(base64: string): ArrayBuffer {
  const nativeFromBase64 = (Uint8Array as Uint8ArrayConstructor & {
    fromBase64?: (input: string) => Uint8Array;
  }).fromBase64;
  if (typeof nativeFromBase64 === "function") {
    return Uint8Array.from(nativeFromBase64(base64)).buffer;
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function inferExtensionFromMimeType(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (normalized) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

function inferContentTypeFromExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "avif":
      return "image/avif";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function inferExtensionFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
  if (!match) return "bin";
  const subtype = match[1].toLowerCase();
  if (subtype === "jpeg") return "jpg";
  return subtype;
}

function cleanFilePart(value: string): string {
  return value.replace(SAFE_FILENAME, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function encodeObjectKeyForPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getSignedUrlTtlSeconds(env: Pick<Env, "R2_SIGNED_URL_TTL_SECONDS">): number {
  const parsed = Number.parseInt(env.R2_SIGNED_URL_TTL_SECONDS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SIGNED_URL_TTL_SECONDS;
  return Math.min(parsed, MAX_SIGNED_URL_TTL_SECONDS);
}

function createR2AwsClient(
  env: Pick<Env, "R2_ACCESS_KEY_ID" | "R2_SECRET_ACCESS_KEY">,
): AwsClient {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 signed URL support is not configured");
  }

  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    retries: 0,
  });
}

function buildR2S3ObjectUrl(
  env: Pick<Env, "CLOUDFLARE_ACCOUNT_ID" | "R2_BUCKET_NAME">,
  key: string,
): URL {
  return new URL(
    `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${encodeObjectKeyForPath(key)}`,
  );
}

export function buildPublicUrl(env: Pick<Env, "R2_PUBLIC_BASE_URL">, key: string): string {
  return `${env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${key}`;
}

export function extractManagedKey(env: Pick<Env, "R2_PUBLIC_BASE_URL">, publicUrl: string): string | null {
  const baseUrl = env.R2_PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (!publicUrl.startsWith(`${baseUrl}/`)) return null;
  return publicUrl.slice(baseUrl.length + 1);
}

export function buildUserPrefix(userId: string): string {
  return `users/${userId}`;
}

function buildKnifeKey(userId: string, knifeId: string, filename: string): string {
  return `${buildUserPrefix(userId)}/knives/${knifeId}/${filename}`;
}

function randomFilename(prefix: string, extension: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
}

export function buildManagedImageKey(
  userId: string,
  knifeId: string,
  contentType: string,
  filename?: string,
): string {
  const extension = inferExtensionFromMimeType(contentType);
  const nextFilename = filename
    ? cleanFilePart(filename)
    : randomFilename("image", extension);
  const resolvedFilename = nextFilename.includes(".") ? nextFilename : `${nextFilename}.${extension}`;
  return buildKnifeKey(userId, knifeId, resolvedFilename);
}

export async function createSignedImageUpload(
  env: Pick<
    Env,
    | "CLOUDFLARE_ACCOUNT_ID"
    | "R2_ACCESS_KEY_ID"
    | "R2_BUCKET_NAME"
    | "R2_PUBLIC_BASE_URL"
    | "R2_SECRET_ACCESS_KEY"
    | "R2_SIGNED_URL_TTL_SECONDS"
  >,
  userId: string,
  knifeId: string,
  contentType: string,
  filename?: string,
): Promise<{
  expiresAt: string;
  headers: Record<string, string>;
  key: string;
  method: "PUT";
  publicUrl: string;
  uploadUrl: string;
}> {
  const key = buildManagedImageKey(userId, knifeId, contentType, filename);
  const ttlSeconds = getSignedUrlTtlSeconds(env);
  const uploadUrl = buildR2S3ObjectUrl(env, key);
  uploadUrl.searchParams.set("X-Amz-Expires", String(ttlSeconds));

  const signedRequest = await createR2AwsClient(env).sign(uploadUrl.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
    },
    aws: {
      signQuery: true,
    },
  });

  return {
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    headers: {
      "Content-Type": contentType,
    },
    key,
    method: "PUT",
    publicUrl: buildPublicUrl(env, key),
    uploadUrl: signedRequest.url,
  };
}

export async function createSignedImageDelete(
  env: Pick<
    Env,
    | "CLOUDFLARE_ACCOUNT_ID"
    | "R2_ACCESS_KEY_ID"
    | "R2_BUCKET_NAME"
    | "R2_SECRET_ACCESS_KEY"
    | "R2_SIGNED_URL_TTL_SECONDS"
  >,
  key: string,
): Promise<{
  deleteUrl: string;
  expiresAt: string;
  method: "DELETE";
}> {
  const ttlSeconds = getSignedUrlTtlSeconds(env);
  const deleteUrl = buildR2S3ObjectUrl(env, key);
  deleteUrl.searchParams.set("X-Amz-Expires", String(ttlSeconds));

  const signedRequest = await createR2AwsClient(env).sign(deleteUrl.toString(), {
    method: "DELETE",
    aws: {
      signQuery: true,
    },
  });

  return {
    deleteUrl: signedRequest.url,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    method: "DELETE",
  };
}

export async function uploadImageFromDataUrl(
  env: Pick<Env, "BUCKET" | "R2_PUBLIC_BASE_URL">,
  userId: string,
  knifeId: string,
  dataUrl: string,
  filename?: string,
): Promise<string> {
  const prefixMatch = dataUrl.match(/^data:([^;]+);base64,/);
  if (!prefixMatch) {
    throw new Error("Invalid image data URL");
  }

  const contentType = prefixMatch[1];
  const base64 = dataUrl.slice(prefixMatch[0].length);
  const extension = inferExtensionFromDataUrl(dataUrl) || inferExtensionFromMimeType(contentType);
  const nextFilename = filename
    ? cleanFilePart(filename)
    : randomFilename("image", extension);
  const resolvedFilename = nextFilename.includes(".") ? nextFilename : `${nextFilename}.${extension}`;
  const key = buildKnifeKey(userId, knifeId, resolvedFilename);

  await env.BUCKET.put(key, toArrayBuffer(base64), {
    httpMetadata: { contentType },
  });

  return buildPublicUrl(env, key);
}

export async function uploadImageFromFile(
  env: Pick<Env, "BUCKET" | "R2_PUBLIC_BASE_URL">,
  userId: string,
  knifeId: string,
  file: File,
  filename?: string,
): Promise<string> {
  const extension = inferExtensionFromMimeType(file.type || "application/octet-stream");
  const nextFilename = filename
    ? cleanFilePart(filename)
    : cleanFilePart(file.name || randomFilename("image", extension));
  const resolvedFilename = nextFilename.includes(".") ? nextFilename : `${nextFilename}.${extension}`;
  const key = buildKnifeKey(userId, knifeId, resolvedFilename);
  const body = typeof file.stream === "function" ? file.stream() : file;

  await env.BUCKET.put(key, body, {
    httpMetadata: {
      contentType: file.type || inferContentTypeFromExtension(extension),
    },
  });

  return buildPublicUrl(env, key);
}

export async function deleteKeys(bucket: R2Bucket, keys: string[]) {
  if (keys.length === 0) return;
  await bucket.delete(keys);
}

export async function deleteUserPrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;

  for (;;) {
    const page = await bucket.list({ prefix, cursor });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
}
