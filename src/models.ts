import { z } from "zod";

export const knifeSpecsSchema = z
  .object({
    weight: z.string().optional(),
    overallLength: z.string().optional(),
    bladeLength: z.string().optional(),
    bladeThickness: z.string().optional(),
    bladeCoating: z.string().optional(),
    bladeMaterial: z.string().optional(),
    lockingMechanism: z.string().optional(),
    designer: z.string().optional(),
    modelNumber: z.string().optional(),
    handleLength: z.string().optional(),
    hardness: z.string().optional(),
    country: z.string().optional(),
  })
  .default({});

export const knifeInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  brand: z.string().optional(),
  steel: z.string().optional(),
  bladeStyle: z.string().optional(),
  handleMaterial: z.string().optional(),
  images: z.array(z.string()).optional(),
  imageUrls: z.array(z.string()).optional(),
  specs: knifeSpecsSchema.optional(),
  description: z.string().optional(),
  addedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  sourceUrl: z.string().optional(),
  pinned: z.boolean().optional(),
});

export const knifePatchSchema = z.object({
  name: z.string().min(1).optional(),
  brand: z.string().optional(),
  steel: z.string().optional(),
  bladeStyle: z.string().optional(),
  handleMaterial: z.string().optional(),
  images: z.array(z.string()).optional(),
  imageUrls: z.array(z.string()).optional(),
  specs: knifeSpecsSchema.optional(),
  description: z.string().optional(),
  sourceUrl: z.string().optional(),
  pinned: z.boolean().optional(),
});

export const compareMutationSchema = z.object({
  id: z.string().min(1),
});

export const syncPushSchema = z.object({
  knives: z.array(knifeInputSchema).default([]),
  compareIds: z.array(z.string().min(1)).optional(),
  replaceAll: z.boolean().default(false),
});

export const imageDataUrlSchema = z.object({
  dataUrl: z.string().startsWith("data:image/"),
  knifeId: z.string().min(1).optional(),
  filename: z.string().min(1).optional(),
});

export interface KnifeSpecs {
  weight: string;
  overallLength: string;
  bladeLength: string;
  bladeThickness: string;
  bladeCoating: string;
  bladeMaterial: string;
  lockingMechanism: string;
  designer: string;
  modelNumber: string;
  handleLength: string;
  hardness: string;
  country: string;
}

export interface KnifeRecord {
  id: string;
  name: string;
  brand: string;
  steel: string;
  bladeStyle: string;
  handleMaterial: string;
  images: string[];
  specs: KnifeSpecs;
  description: string;
  addedAt: string;
  updatedAt: string;
  sourceUrl: string;
  pinned: boolean;
}

export interface VaultSnapshot {
  knives: KnifeRecord[];
  compareIds: string[];
  syncedAt: string;
}

export function normalizeSpecs(input?: Partial<KnifeSpecs>): KnifeSpecs {
  return {
    weight: input?.weight ?? "",
    overallLength: input?.overallLength ?? "",
    bladeLength: input?.bladeLength ?? "",
    bladeThickness: input?.bladeThickness ?? "",
    bladeCoating: input?.bladeCoating ?? "",
    bladeMaterial: input?.bladeMaterial ?? "",
    lockingMechanism: input?.lockingMechanism ?? "",
    designer: input?.designer ?? "",
    modelNumber: input?.modelNumber ?? "",
    handleLength: input?.handleLength ?? "",
    hardness: input?.hardness ?? "",
    country: input?.country ?? "",
  };
}

export function toKnifeRecord(
  input: z.infer<typeof knifeInputSchema> | z.infer<typeof knifePatchSchema>,
  fallbackId: string,
  timestamps?: { addedAt?: string; updatedAt?: string },
): KnifeRecord {
  const now = new Date().toISOString();
  return {
    id: "id" in input && input.id ? input.id : fallbackId,
    name: input.name ?? "",
    brand: input.brand ?? "",
    steel: input.steel ?? "",
    bladeStyle: input.bladeStyle ?? "",
    handleMaterial: input.handleMaterial ?? "",
    images: input.images ?? input.imageUrls ?? [],
    specs: normalizeSpecs(input.specs),
    description: input.description ?? "",
    addedAt: ("addedAt" in input && input.addedAt) || timestamps?.addedAt || now,
    updatedAt: ("updatedAt" in input && input.updatedAt) || timestamps?.updatedAt || now,
    sourceUrl: input.sourceUrl ?? "",
    pinned: input.pinned ?? false,
  };
}
