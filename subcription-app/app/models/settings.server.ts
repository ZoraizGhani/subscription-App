import type { Prisma } from "@prisma/client";

import db from "../db.server";

export type ShopSettingsInput = Omit<
  Prisma.ShopSettingsCreateInput,
  "shop" | "id" | "createdAt" | "updatedAt"
>;

/**
 * Settings for a shop, creating the row with schema defaults on first read so
 * callers never have to deal with a missing record.
 */
export async function getShopSettings(shop: string) {
  return db.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

export async function updateShopSettings(shop: string, data: ShopSettingsInput) {
  return db.shopSettings.upsert({
    where: { shop },
    update: data,
    create: { shop, ...data },
  });
}