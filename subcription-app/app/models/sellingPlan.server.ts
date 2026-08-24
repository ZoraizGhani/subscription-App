import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";

export interface SellingPlanTier {
  intervalCount: number;
  discountPercent: number;
  planId: string | null;
  // Bundle image shown for this plan on the storefront widget. Ours alone --
  // Shopify's SellingPlan has no image field, so this only ever lives in our
  // own SellingPlan.imageUrl mirror column, matched up by planId/shopifyId.
  imageUrl: string | null;
}

export interface ProductSummary {
  id: string;
  title: string;
  imageUrl: string | null;
}

/** Thrown for expected, user-facing validation problems -- callers should show
 * `.message` to the merchant rather than treating it as an unexpected crash. */
export class SellingPlanValidationError extends Error {}

const STAGED_UPLOADS_CREATE = `#graphql
  mutation PlanImageStagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Step 1 of uploading a plan's bundle image: asks Shopify for a pre-signed
 * upload URL. The browser then POSTs the raw file straight to that URL
 * (never through our server) -- see confirmPlanImageUpload for step 2.
 */
export async function requestPlanImageUpload({
  graphql,
  filename,
  mimeType,
  fileSize,
}: {
  graphql: AdminGraphqlClient;
  filename: string;
  mimeType: string;
  fileSize: number;
}) {
  const response = await graphql(STAGED_UPLOADS_CREATE, {
    variables: {
      input: [{ resource: "IMAGE", filename, mimeType, fileSize: String(fileSize), httpMethod: "POST" }],
    },
  });
  const body = (await response.json()) as {
    data?: {
      stagedUploadsCreate: {
        stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[];
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const result = body.data?.stagedUploadsCreate;
  const target = result?.stagedTargets[0];
  if (result?.userErrors.length || !target) {
    throw new Error(`stagedUploadsCreate failed: ${JSON.stringify(result?.userErrors)}`);
  }
  return target;
}

const FILE_CREATE = `#graphql
  mutation PlanImageFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        ... on MediaImage {
          fileStatus
          image { url }
        }
      }
      userErrors { field message }
    }
  }
`;

const FILE_STATUS_QUERY = `#graphql
  query PlanImageFileStatus($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        fileStatus
        image { url }
      }
    }
  }
`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Step 2: once the browser has uploaded the raw file to the staged URL from
 * requestPlanImageUpload, this registers it as a real Shopify File and waits
 * for image processing to finish so a ready CDN url can be stored right away.
 * MediaImage processing is normally sub-second for a small product photo, so
 * a handful of short-interval polls is enough without a background job.
 */
export async function confirmPlanImageUpload({
  graphql,
  resourceUrl,
  filename,
}: {
  graphql: AdminGraphqlClient;
  resourceUrl: string;
  filename: string;
}) {
  const response = await graphql(FILE_CREATE, {
    variables: {
      files: [{ originalSource: resourceUrl, filename, contentType: "IMAGE", alt: filename }],
    },
  });
  const body = (await response.json()) as {
    data?: {
      fileCreate: {
        files: { id: string; fileStatus?: string; image?: { url: string } }[];
        userErrors: { field: string[]; message: string }[];
      };
    };
  };
  const result = body.data?.fileCreate;
  const file = result?.files[0];
  if (result?.userErrors.length || !file) {
    throw new Error(`fileCreate failed: ${JSON.stringify(result?.userErrors)}`);
  }

  let imageUrl = file.image?.url ?? null;
  for (let attempt = 0; !imageUrl && attempt < 6; attempt++) {
    await sleep(500);
    const statusResponse = await graphql(FILE_STATUS_QUERY, { variables: { id: file.id } });
    const statusBody = (await statusResponse.json()) as {
      data?: { node: { fileStatus?: string; image?: { url: string } } | null };
    };
    imageUrl = statusBody.data?.node?.image?.url ?? null;
  }

  if (!imageUrl) {
    throw new Error("Image uploaded but Shopify is still processing it -- try saving again in a moment.");
  }

  return imageUrl;
}

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

  const imageByPlanId = new Map(
    (
      await db.sellingPlan.findMany({
        where: { shopifyId: { in: existingPlans.map((plan) => plan.id) } },
        select: { shopifyId: true, imageUrl: true },
      })
    ).map((plan) => [plan.shopifyId, plan.imageUrl]),
  );

  const tiers: SellingPlanTier[] = existingPlans
    .filter((plan) => plan.billingPolicy.interval === "DAY" && plan.billingPolicy.intervalCount != null)
    .map((plan) => ({
      intervalCount: plan.billingPolicy.intervalCount as number,
      discountPercent: plan.pricingPolicies[0]?.adjustmentValue?.percentage ?? 0,
      planId: plan.id,
      imageUrl: imageByPlanId.get(plan.id) ?? null,
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
    // "Delivery every" option with this plan's specific value.
    options: [`Every ${tier.intervalCount} days`],
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
  tiers,
}: {
  shop: string;
  productId: string;
  productTitle: string;
  group: SavedGroup;
  tiers: SellingPlanTier[];
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

  // Matched by intervalCount, not array position -- sellingPlanGroupUpdate
  // submits updated/created plans as two separate arrays, so Shopify's
  // returned node order has no guaranteed relationship to the submitted
  // tiers' order. intervalCount is safe to key on because saveSellingPlanTiers
  // already rejects two tiers sharing the same interval before this runs.
  const imageByIntervalCount = new Map(tiers.map((t) => [t.intervalCount, t.imageUrl]));

  for (const [index, plan] of group.sellingPlans.nodes.entries()) {
    const percentage = plan.pricingPolicies[0]?.adjustmentValue?.percentage ?? null;
    const fields = {
      name: plan.name,
      billingInterval: plan.billingPolicy.interval ?? "DAY",
      billingIntervalCount: plan.billingPolicy.intervalCount ?? 0,
      deliveryInterval: plan.billingPolicy.interval ?? "DAY",
      imageUrl: imageByIntervalCount.get(plan.billingPolicy.intervalCount ?? -1) ?? null,
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
    await mirrorSellingPlanGroup({ shop, productId, productTitle, group: result.sellingPlanGroup, tiers });
    return result.sellingPlanGroup.id;
  }

  const response = await graphql(SELLING_PLAN_GROUP_CREATE, {
    variables: {
      input: {
        name: "Subscribe & Save",
        merchantCode: "subscribe-and-save",
        options: ["Delivery every"],
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
  await mirrorSellingPlanGroup({ shop, productId, productTitle, group: result.sellingPlanGroup, tiers });
  return result.sellingPlanGroup.id;
}