import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { findNextUnbilledCycle, type PortalAdmin } from "./portalSubscription.server";
import { syncSubscriptionContract } from "./subscription.server";

const WATCHDOG_CHARGE_MUTATION = `#graphql
  mutation WatchdogCharge($id: ID!, $selector: SubscriptionBillingCycleSelector!) {
    subscriptionBillingCycleCharge(subscriptionContractId: $id, billingCycleSelector: $selector, actor: MERCHANT) {
      subscriptionBillingAttempt { id }
      userErrors { field message }
    }
  }
`;

interface WatchdogResult {
  shop: string;
  contractShopifyId: string;
  outcome: "charged" | "not-due" | "skipped-cycle" | "error";
  detail: string;
}

/**
 * Shopify's own billing scheduler doesn't reliably fire on development
 * stores (confirmed against this app's store during testing), so this job
 * stands in for it: once a day, find every active contract's next unbilled
 * cycle and charge anything due within 24 hours (Shopify's own limit on how
 * far ahead subscriptionBillingCycleCharge can act). Once this store goes
 * live with real payment processing, Shopify's own scheduler takes over and
 * this becomes a pure safety net rather than the only thing doing the work.
 */
export async function runBillingWatchdog(): Promise<WatchdogResult[]> {
  const shops = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });

  const results: WatchdogResult[] = [];

  for (const { shop } of shops) {
    const contracts = await db.subscriptionContract.findMany({
      where: { shop, status: "ACTIVE" },
      select: { shopifyId: true },
    });

    let admin: PortalAdmin;
    try {
      admin = (await unauthenticated.admin(shop)).admin;
    } catch (error) {
      results.push({
        shop,
        contractShopifyId: "-",
        outcome: "error",
        detail: `Could not load admin session: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    for (const contract of contracts) {
      results.push(await processContract(admin, shop, contract.shopifyId));
    }
  }

  return results;
}

async function processContract(
  admin: PortalAdmin,
  shop: string,
  contractShopifyId: string,
): Promise<WatchdogResult> {
  try {
    const nextCycle = await findNextUnbilledCycle(admin, contractShopifyId);
    const hoursUntilDue = (new Date(nextCycle.date).getTime() - Date.now()) / (1000 * 60 * 60);

    if (hoursUntilDue > 24) {
      return {
        shop,
        contractShopifyId,
        outcome: "not-due",
        detail: `Next cycle due ${nextCycle.date}, more than 24h away.`,
      };
    }

    const response = await admin.graphql(WATCHDOG_CHARGE_MUTATION, {
      variables: { id: contractShopifyId, selector: { index: nextCycle.index } },
    });
    const body = (await response.json()) as {
      data?: {
        subscriptionBillingCycleCharge: {
          subscriptionBillingAttempt: { id: string } | null;
          userErrors: { field: string[]; message: string }[];
        };
      };
    };
    const result = body.data?.subscriptionBillingCycleCharge;
    const userErrors = result?.userErrors ?? [];
    if (userErrors.length || !result?.subscriptionBillingAttempt) {
      return {
        shop,
        contractShopifyId,
        outcome: "error",
        detail: `subscriptionBillingCycleCharge failed: ${JSON.stringify(userErrors)}`,
      };
    }

    // The subscription_billing_attempts/success|failure webhooks (already
    // registered) will sync the mirror once Shopify finishes processing --
    // this just refreshes nextBillingDate now so the portal/admin screens
    // don't show a stale date in the meantime.
    await syncSubscriptionContract({ graphql: admin.graphql, shop, contractId: contractShopifyId });

    return {
      shop,
      contractShopifyId,
      outcome: "charged",
      detail: `Billing attempt ${result.subscriptionBillingAttempt.id} submitted for cycle ${nextCycle.index}.`,
    };
  } catch (error) {
    return {
      shop,
      contractShopifyId,
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
