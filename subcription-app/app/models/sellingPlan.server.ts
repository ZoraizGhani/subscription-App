import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";

export interface SellingPlanTier {
  intervalCount: number;
  discountPercent: number;
  planId: string | null;
  // Bundle-size count shown on the storefront widget (e.g. "90 Count"). A
  // second selling plan option dimension ("Count"), alongside "Delivery
  // every" -- not stored in our own DB, so it round-trips through Shopify's
  // own SellingPlan.options rather than needing a Liquid-inaccessible mirror
  // column (Liquid has no way to query this app's database at render time).
  count: number;
}

export interface ProductSummary {
  id: string;
  title: string;
  imageUrl: string | null;
}

/** Thrown for expected, user-facing validation problems -- callers should show
 * `.message` to the merchant rather than treating it as an unexpected crash. */
export class SellingPlanValidationError extends Error {}

export interface SellingPlanGroupSummary {
  groupId: string;
  productId: string;
  productTitle: string;
  tierCount: number;
}

/** Products that already have a selling plan configured through this screen. */
export async function listSellingPlanGroups(shop: string): Promise<SellingPlanGroupSummary[]> {
  const groups = await db.sellingPlanGroup.findMany({
    where: { shop },
    include: { _count: { select: { plans: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return groups
    .map((group) => {
      const productId = (JSON.parse(group.productIds) as string[])[0];
      if (!productId) return null;
      return {
        groupId: group.shopifyId,
        productId,
        productTitle: group.productTitle ?? "Untitled product",
        tierCount: group._count.plans,
      };
    })
    .filter((g): g is SellingPlanGroupSummary => g !== null);
}

const PRODUCT_SELLING_PLANS_QUERY = `#graphql
  query ProductSellingPlans($id: ID!) {
    product(id: $id) {
      id
      title
      featuredMedia {
        preview {
          image { url }
        }
      }
      sellingPlanGroups(first: 5) {
        nodes {
          id
          name
          merchantCode
          sellingPlans(first: 20) {
            nodes {
              id
              name
              options
              billingPolicy {
                ... on SellingPlanRecurringBillingPolicy {
                  interval
                  intervalCount
                }
              }
              pricingPolicies {
                ... on SellingPlanFixedPricingPolicy {
                  adjustmentType
                  adjustmentValue {
                    ... on SellingPlanPricingPolicyPercentageValue { percentage }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface ProductSellingPlansNode {
  id: string;
  title: string;
  featuredMedia: { preview: { image: { url: string } | null } } | null;
  sellingPlanGroups: {
    nodes: {
      id: string;
      name: string;
      merchantCode: string;
      sellingPlans: {
        nodes: {
          id: string;
          name: string;
          options: string[];
          billingPolicy: { interval?: string; intervalCount?: number };
          pricingPolicies: { adjustmentType?: string; adjustmentValue?: { percentage?: number } }[];
        }[];
      };
    }[];
  };
}

export interface ProductSellingPlanData {
  product: ProductSummary;
  groupId: string | null;
  tiers: SellingPlanTier[];
}

/**
 * Loads a product plus whatever recurring tiers already exist on its first
 * selling plan group. A brand new product comes back with an empty tiers list --
 * the merchant adds their own via "Add another plan".
 *
 * Only the first selling plan group on the product is managed by this screen --
 * a product with plans from another app or created outside this flow keeps
 * those untouched, but this UI won't show or edit them.
 */
export async function getProductSellingPlans({
  graphql,
  productId,
}: {
  graphql: AdminGraphqlClient;
  productId: string;
}): Promise<ProductSellingPlanData | null> {
  const response = await graphql(PRODUCT_SELLING_PLANS_QUERY, {
    variables: { id: productId },
  });
  const body = (await response.json()) as { data?: { product: ProductSellingPlansNode | null } };
  const product = body.data?.product;
  if (!product) {
    return null;
  }

  const group = product.sellingPlanGroups.nodes[0] ?? null;
  const existingPlans = group?.sellingPlans.nodes ?? [];

  const tiers: SellingPlanTier[] = existingPlans
    .filter((plan) => plan.billingPolicy.interval === "DAY" && plan.billingPolicy.intervalCount != null)
    .map((plan) => ({
      intervalCount: plan.billingPolicy.intervalCount as number,
      discountPercent: plan.pricingPolicies[0]?.adjustmentValue?.percentage ?? 0,
      planId: plan.id,
      // options[1] is the "Count" dimension (options[0] is "Delivery every")
      // -- plans saved before this feature existed only have one dimension,
      // so this falls back to the day count rather than showing 0.
      count: Number(plan.options[1] ?? plan.billingPolicy.intervalCount ?? 0),
    }));

  return {
    product: {
      id: product.id,
      title: product.title,
      imageUrl: product.featuredMedia?.preview.image?.url ?? null,
    },
    groupId: group?.id ?? null,
    tiers,
  };
}

function sellingPlanInput(tier: SellingPlanTier) {
  return {
    id: tier.planId ?? undefined,
    name: `Every ${tier.intervalCount} days`,
    category: "SUBSCRIPTION",
    // Required even when updating an existing plan -- must match the group's
    // two option dimensions ("Delivery every", "Count") with this plan's
    // specific values, in the same order.
    options: [`Every ${tier.intervalCount} days`, String(tier.count)],
    billingPolicy: { recurring: { interval: "DAY", intervalCount: tier.intervalCount } },
    deliveryPolicy: { recurring: { interval: "DAY", intervalCount: tier.intervalCount } },
    pricingPolicies: [
      {
        fixed: {
          adjustmentType: "PERCENTAGE",
          adjustmentValue: { percentage: tier.discountPercent },
        },
      },
    ],
  };
}

const SELLING_PLAN_GROUP_CREATE = `#graphql
  mutation CreateSellingPlanGroup($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup {
        id
        name
        merchantCode
        sellingPlans(first: 20) {
          nodes {
            id
            name
            billingPolicy {
              ... on SellingPlanRecurringBillingPolicy { interval intervalCount }
            }
            pricingPolicies {
              ... on SellingPlanFixedPricingPolicy {
                adjustmentType
                adjustmentValue {
                  ... on SellingPlanPricingPolicyPercentageValue { percentage }
                }
              }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const SELLING_PLAN_GROUP_UPDATE = `#graphql
  mutation UpdateSellingPlanGroup($id: ID!, $input: SellingPlanGroupInput!) {
    sellingPlanGroupUpdate(id: $id, input: $input) {
      sellingPlanGroup {
        id
        name
        merchantCode
        sellingPlans(first: 20) {
          nodes {
            id
            name
            billingPolicy {
              ... on SellingPlanRecurringBillingPolicy { interval intervalCount }
            }
            pricingPolicies {
              ... on SellingPlanFixedPricingPolicy {
                adjustmentType
                adjustmentValue {
                  ... on SellingPlanPricingPolicyPercentageValue { percentage }
                }
              }
            }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

interface SavedGroup {
  id: string;
  name: string;
  merchantCode: string;
  sellingPlans: {
    nodes: {
      id: string;
      name: string;
      billingPolicy: { interval?: string; intervalCount?: number };
      pricingPolicies: { adjustmentType?: string; adjustmentValue?: { percentage?: number } }[];
    }[];
  };
}

async function mirrorSellingPlanGroup({
  shop,
  productId,
  productTitle,
  group,
}: {
  shop: string;
  productId: string;
  productTitle: string;
  group: SavedGroup;
}) {
  const localGroup = await db.sellingPlanGroup.upsert({
    where: { shopifyId: group.id },
    update: {
      name: group.name,
      merchantCode: group.merchantCode,
      productIds: JSON.stringify([productId]),
      productTitle,
    },
    create: {
      shop,
      shopifyId: group.id,
      name: group.name,
      merchantCode: group.merchantCode,
      productIds: JSON.stringify([productId]),
      productTitle,
    },
  });

  for (const [index, plan] of group.sellingPlans.nodes.entries()) {
    const percentage = plan.pricingPolicies[0]?.adjustmentValue?.percentage ?? null;
    const fields = {
      name: plan.name,
      billingInterval: plan.billingPolicy.interval ?? "DAY",
      billingIntervalCount: plan.billingPolicy.intervalCount ?? 0,
      deliveryInterval: plan.billingPolicy.interval ?? "DAY",
      deliveryIntervalCount: plan.billingPolicy.intervalCount ?? 0,
      pricingPolicyType: "PERCENTAGE",
      discountValue: percentage,
      position: index,
    };
    await db.sellingPlan.upsert({
      where: { shopifyId: plan.id },
      update: fields,
      create: { shopifyId: plan.id, groupId: localGroup.id, ...fields },
    });
  }
}

/**
 * Creates the product's selling plan group on first save, or updates its
 * existing plans on later saves -- adding new tiers, updating edited ones, and
 * deleting any tier the merchant removed from the form (a planId that existed
 * before the save but isn't present in the submitted tiers list).
 */
export async function saveSellingPlanTiers({
  graphql,
  shop,
  productId,
  productTitle,
  existingGroupId,
  existingPlanIds,
  tiers,
}: {
  graphql: AdminGraphqlClient;
  shop: string;
  productId: string;
  productTitle: string;
  existingGroupId: string | null;
  existingPlanIds: string[];
  tiers: SellingPlanTier[];
}) {
  if (!existingGroupId && tiers.length === 0) {
    throw new SellingPlanValidationError("Add at least one plan before saving.");
  }

  // Shopify rejects two plans in the same group with the same name/options,
  // which is exactly what happens if the merchant adds a tier and doesn't
  // change its default interval before saving.
  const seenIntervals = new Set<number>();
  for (const tier of tiers) {
    if (seenIntervals.has(tier.intervalCount)) {
      throw new SellingPlanValidationError(
        `Two plans are both set to "every ${tier.intervalCount} days" -- give each plan a different number of days.`,
      );
    }
    seenIntervals.add(tier.intervalCount);
  }

  if (existingGroupId) {
    const submittedPlanIds = new Set(tiers.map((t) => t.planId).filter(Boolean));
    const sellingPlansToDelete = existingPlanIds.filter((id) => !submittedPlanIds.has(id));

    const response = await graphql(SELLING_PLAN_GROUP_UPDATE, {
      variables: {
        id: existingGroupId,
        input: {
          name: "Subscribe & Save",
          merchantCode: "subscribe-and-save",
          // Set on every update too, not just on create -- a group saved
          // before the "Count" option existed only has one dimension, and
          // this brings it up to two so its plans' two-value options (see
          // sellingPlanInput) stay valid the next time the merchant saves.
          options: ["Delivery every", "Count"],
          sellingPlansToUpdate: tiers.filter((t) => t.planId).map(sellingPlanInput),
          sellingPlansToCreate: tiers.filter((t) => !t.planId).map(sellingPlanInput),
          sellingPlansToDelete,
        },
      },
    });
    const body = (await response.json()) as {
      data: { sellingPlanGroupUpdate: { sellingPlanGroup: SavedGroup | null; userErrors: unknown[] } };
    };
    const result = body.data.sellingPlanGroupUpdate;
    if (result.userErrors.length || !result.sellingPlanGroup) {
      throw new Error(`sellingPlanGroupUpdate failed: ${JSON.stringify(result.userErrors)}`);
    }
    await mirrorSellingPlanGroup({ shop, productId, productTitle, group: result.sellingPlanGroup });
    return result.sellingPlanGroup.id;
  }

  const response = await graphql(SELLING_PLAN_GROUP_CREATE, {
    variables: {
      input: {
        name: "Subscribe & Save",
        merchantCode: "subscribe-and-save",
        options: ["Delivery every", "Count"],
        sellingPlansToCreate: tiers.map(sellingPlanInput),
      },
      resources: { productIds: [productId] },
    },
  });
  const body = (await response.json()) as {
    data: { sellingPlanGroupCreate: { sellingPlanGroup: SavedGroup | null; userErrors: unknown[] } };
  };
  const result = body.data.sellingPlanGroupCreate;
  if (result.userErrors.length || !result.sellingPlanGroup) {
    throw new Error(`sellingPlanGroupCreate failed: ${JSON.stringify(result.userErrors)}`);
  }
  await mirrorSellingPlanGroup({ shop, productId, productTitle, group: result.sellingPlanGroup });
  return result.sellingPlanGroup.id;
}