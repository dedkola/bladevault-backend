import type { Env } from "./env";
import type { KnifeRecord, VaultSnapshot } from "./models";
import { extractManagedKey, deleteKeys } from "./storage";

interface KnifeRow {
  id: string;
  name: string;
  brand: string;
  steel: string;
  blade_style: string;
  handle_material: string;
  images: string;
  specs: string;
  description: string;
  added_at: string;
  updated_at: string;
  source_url: string;
  pinned: number;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends Record<string, unknown>>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return { ...fallback, ...parsed } as T;
    }
  } catch {
    // ignore malformed rows
  }
  return fallback;
}

function rowToKnife(row: KnifeRow): KnifeRecord {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    steel: row.steel,
    bladeStyle: row.blade_style,
    handleMaterial: row.handle_material,
    images: parseJsonArray(row.images),
    specs: parseJsonObject(row.specs, {
      weight: "",
      overallLength: "",
      bladeLength: "",
      bladeThickness: "",
      bladeCoating: "",
      bladeMaterial: "",
      lockingMechanism: "",
      designer: "",
      modelNumber: "",
      handleLength: "",
      hardness: "",
      country: "",
    }),
    description: row.description,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    sourceUrl: row.source_url,
    pinned: Boolean(row.pinned),
  };
}

export async function listKnives(db: D1Database, userId: string): Promise<KnifeRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM user_vault_knives
       WHERE user_id = ?
       ORDER BY pinned DESC, updated_at DESC, added_at DESC`,
    )
    .bind(userId)
    .all<KnifeRow>();

  return (result.results ?? []).map(rowToKnife);
}

export async function getKnife(db: D1Database, userId: string, knifeId: string): Promise<KnifeRecord | null> {
  const result = await db
    .prepare(
      `SELECT * FROM user_vault_knives
       WHERE user_id = ? AND id = ?
       LIMIT 1`,
    )
    .bind(userId, knifeId)
    .first<KnifeRow>();

  return result ? rowToKnife(result) : null;
}

export async function upsertKnife(db: D1Database, userId: string, knife: KnifeRecord) {
  await db
    .prepare(
      `INSERT INTO user_vault_knives (
        user_id, id, name, brand, steel, blade_style, handle_material,
        images, specs, description, added_at, updated_at, source_url, pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET
        name = excluded.name,
        brand = excluded.brand,
        steel = excluded.steel,
        blade_style = excluded.blade_style,
        handle_material = excluded.handle_material,
        images = excluded.images,
        specs = excluded.specs,
        description = excluded.description,
        added_at = excluded.added_at,
        updated_at = excluded.updated_at,
        source_url = excluded.source_url,
        pinned = excluded.pinned`,
    )
    .bind(
      userId,
      knife.id,
      knife.name,
      knife.brand,
      knife.steel,
      knife.bladeStyle,
      knife.handleMaterial,
      JSON.stringify(knife.images),
      JSON.stringify(knife.specs),
      knife.description,
      knife.addedAt,
      knife.updatedAt,
      knife.sourceUrl,
      knife.pinned ? 1 : 0,
    )
    .run();
}

export async function deleteKnife(db: D1Database, userId: string, knifeId: string) {
  await db.prepare("DELETE FROM compare_list WHERE user_id = ? AND knife_id = ?").bind(userId, knifeId).run();
  await db.prepare("DELETE FROM user_vault_knives WHERE user_id = ? AND id = ?").bind(userId, knifeId).run();
}

export async function listCompareIds(db: D1Database, userId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT knife_id
       FROM compare_list
       WHERE user_id = ?
       ORDER BY added_at DESC`,
    )
    .bind(userId)
    .all<{ knife_id: string }>();

  return (result.results ?? []).map((row) => row.knife_id);
}

export async function addCompareId(db: D1Database, userId: string, knifeId: string) {
  await db
    .prepare(
      `INSERT INTO compare_list (user_id, knife_id, added_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, knife_id) DO NOTHING`,
    )
    .bind(userId, knifeId, new Date().toISOString())
    .run();
}

export async function removeCompareId(db: D1Database, userId: string, knifeId: string) {
  await db.prepare("DELETE FROM compare_list WHERE user_id = ? AND knife_id = ?").bind(userId, knifeId).run();
}

export async function replaceCompareIds(db: D1Database, userId: string, compareIds: string[]) {
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM compare_list WHERE user_id = ?").bind(userId),
  ];

  for (const knifeId of compareIds) {
    statements.push(
      db
        .prepare(
          `INSERT INTO compare_list (user_id, knife_id, added_at)
           VALUES (?, ?, ?)`,
        )
        .bind(userId, knifeId, new Date().toISOString()),
    );
  }

  await db.batch(statements);
}

export async function buildSnapshot(db: D1Database, userId: string): Promise<VaultSnapshot> {
  const [knives, compareIds] = await Promise.all([listKnives(db, userId), listCompareIds(db, userId)]);

  return {
    knives,
    compareIds,
    syncedAt: new Date().toISOString(),
  };
}

export async function deleteRemovedManagedImages(env: Pick<Env, "BUCKET" | "R2_PUBLIC_BASE_URL">, previous: string[], next: string[]) {
  const nextKeys = new Set(next.map((image) => extractManagedKey(env, image)).filter((key): key is string => Boolean(key)));
  const staleKeys = previous
    .map((image) => extractManagedKey(env, image))
    .filter((key): key is string => Boolean(key))
    .filter((key) => !nextKeys.has(key));

  await deleteKeys(env.BUCKET, staleKeys);
}
