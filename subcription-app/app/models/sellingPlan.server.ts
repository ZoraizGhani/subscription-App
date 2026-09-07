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
  // How many product units subscription-widget.js actually adds to the cart
  // when this plan is selected (a real cart quantity, unlike count above
  // which is purely a display number) -- a third options dimension for the
  // same reason count is one: the storefront can't read our database.
  quantity: number;
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
      // options[1] is "Count", options[2] is "Quantity" (options[0] is
      // "Delivery every") -- plans saved before these existed only have
      // fewer dimensions, so both fall back sensibly rather than showing 0.
      count: Number(plan.options[1] ?? plan.billingPolicy.intervalCount ?? 0),
      quantity: Number(plan.options[2] ?? 1),
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
    // three option dimensions ("Delivery every", "Count", "Quantity") with
    // this plan's specific values, in the same order.
    options: [`Every ${tier.intervalCount} days`, String(tier.count), String(tier.quantity)],
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

// sellingPlanGroupCreate's `resources.productIds` only links whichever
// variants exist on the product at that exact moment -- a flavor variant
// added to the product afterward is never wired up to the group, so Shopify
// silently drops `selling_plan` for it at /cart/add.js (no error, just a
// full-price one-time line item with no subscription). Re-running this on
// every save, not just at creation, keeps newly added variants covered.
const SELLING_PLAN_GROUP_ADD_PRODUCTS = `#graphql
  mutation AddProductsToSellingPlanGroup($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
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

interface SellingPlanUserError {
  field: string[] | null;
  message: string;
}

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
 * Re-associates the group with the product's full current variant set.
 * Best-effort: the plan tiers themselves have already saved successfully by
 * the time this runs, so a failure here is logged rather than thrown -- it
 * shouldn't turn an otherwise-successful tier save into an error the
 * merchant sees.
 */
async function ensureProductVariantsIncluded({
  graphql,
  groupId,
  productId,
}: {
  graphql: AdminGraphqlClient;
  groupId: string;
  productId: string;
}) {
  const response = await graphql(SELLING_PLAN_GROUP_ADD_PRODUCTS, {
    variables: { id: groupId, productIds: [productId] },
  });
  const body = (await response.json()) as {
    data?: { sellingPlanGroupAddProducts: { userErrors: SellingPlanUserError[] } };
    errors?: { message: string }[];
  };
  const userErrors = body.data?.sellingPlanGroupAddProducts.userErrors ?? [];
  if (!body.data || userErrors.length) {
    console.error(
      "sellingPlanGroupAddProducts failed to resync product variants",
      body.errors ?? userErrors,
    );
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
          options: ["Delivery every", "Count", "Quantity"],
          sellingPlansToUpdate: tiers.filter((t) => t.planId).map(sellingPlanInput),
          sellingPlansToCreate: tiers.filter((t) => !t.planId).map(sellingPlanInput),
          sellingPlansToDelete,
        },
      },
    });
    const body = (await response.json()) as {
      data?: {
        sellingPlanGroupUpdate: { sellingPlanGroup: SavedGroup | null; userErrors: SellingPlanUserError[] };
      };
      errors?: { message: string }[];
    };
    // A GraphQL-level error (bad input, permissions, etc.) comes back as a
    // top-level `errors` array with no `data` at all -- distinct from the
    // business-logic `userErrors` below, and would otherwise crash trying
    // to read `.sellingPlanGroupUpdate` off undefined.
    if (!body.data) {
      throw new SellingPlanValidationError(
        body.errors?.map((e) => e.message).join(" ") || "Couldn't save these plans.",
      );
    }
    const result = body.data.sellingPlanGroupUpdate;
    // Shopify rejects some edits outright -- e.g. changing the billing
    // interval of a plan that already has active subscribers -- as a
    // userError rather than a GraphQL-level failure. Surface that as a
    // validation error the merchant sees as a toast, not an unhandled
    // exception that crashes the whole page.
    if (result.userErrors.length) {
      throw new SellingPlanValidationError(result.userErrors.map((e) => e.message).join(" "));
    }
    if (!result.sellingPlanGroup) {
      throw new Error("sellingPlanGroupUpdate failed: no selling plan group returned");
    }
    await mirrorSellingPlanGroup({ shop, productId, productTitle, group: result.sellingPlanGroup });
    await ensureProductVariantsIncluded({ graphql, groupId: result.sellingPlanGroup.id, productId });
    return result.sellingPlanGroup.id;
  }

  const response = await graphql(SELLING_PLAN_GROUP_CREATE, {
    variables: {
      input: {
        name: "Subscribe & Save",
        merchantCode: "subscribe-and-save",
        options: ["Delivery every", "Count", "Quantity"],
        sellingPlansToCreate: tiers.map(sellingPlanInput),
      },
      resources: { productIds: [productId] },
    },
  });
  const body = (await response.json()) as {
    data?: { sellingPlanGroupCreate: { sellingPlanGroup: SavedGroup | null; userErrors: SellingPlanUserError[] } };
    errors?: { message: string }[];
  };
  if (!body.data) {
    throw new SellingPlanValidationError(
      body.errors?.map((e) => e.message).join(" ") || "Couldn't save these plans.",
    );
  }
  const result = body.data.sellingPlanGroupCreate;
  if (result.userErrors.length) {
    throw new SellingPlanValidationError(result.userErrors.map((e) => e.message).join(" "));
  }
  if (!result.sellingPlanGroup) {
    throw new Error("sellingPlanGroupCreate failed: no selling plan group returned");
  }
  await mirrorSellingPlanGroup({ shop, productId, productTitle, group: result.sellingPlanGroup });
  await ensureProductVariantsIncluded({ graphql, groupId: result.sellingPlanGroup.id, productId });
  return result.sellingPlanGroup.id;
}