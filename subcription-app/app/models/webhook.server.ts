import { Prisma } from "@prisma/client";

import db from "../db.server";

/**
 * Shopify delivers each webhook at least once, so the same event can arrive
 * twice. Record the webhook id and report whether we have already handled it.
 *
 * The insert itself is the lock: a duplicate id hits the primary key and throws
 * P2002, which is cheaper and race-free compared to a read-then-write check.
 */
export async function isDuplicateWebhook({
  webhookId,
  shop,
  topic,
}: {
  webhookId: string;
  shop: string;
  topic: string;
}): Promise<boolean> {
  if (!webhookId) {
    return false;
  }

  try {
    await db.processedWebhook.create({ data: { webhookId, shop, topic } });
    return false;
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return true;
    }
    throw error;
  }
}

/** Housekeeping for the dedupe table. Safe to call from a scheduled job. */
export async function pruneProcessedWebhooks(olderThanDays = 14) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const { count } = await db.processedWebhook.deleteMany({
    where: { receivedAt: { lt: cutoff } },
  });

  return count;
}