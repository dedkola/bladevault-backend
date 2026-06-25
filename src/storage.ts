import type { Env } from "./env";

const SAFE_FILENAME = /[^a-zA-Z0-9._-]/g;

function toArrayBuffer(base64: string): ArrayBuffer {
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

  await env.BUCKET.put(key, await file.arrayBuffer(), {
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
