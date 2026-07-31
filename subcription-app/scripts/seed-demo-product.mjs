// One-off seed script: creates a demo product with flavor variants and a
// Subscribe & Save selling plan, matching the CLRTY reference screenshot.
// Reads the offline access token straight out of the local dev database, so it
// only works against a store this app is already installed on.
//
// Usage: node scripts/seed-demo-product.mjs <shop-domain>

import { PrismaClient } from "@prisma/client";

const API_VERSION = "2026-07";
const shop = process.argv[2];

if (!shop) {
  console.error("Usage: node scripts/seed-demo-product.mjs <shop-domain>");
  process.exit(1);
}

const db = new PrismaClient();

async function gql(shop, accessToken, query, variables) {
  const response = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  const body = await response.json();
  if (body.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(body.errors, null, 2)}`);
  }
  return body.data;
}

function assertNoUserErrors(label, userErrors) {
  if (userErrors?.length) {
    throw new Error(`${label} userErrors: ${JSON.stringify(userErrors, null, 2)}`);
  }
}

async function main() {
  const session = await db.session.findFirst({ where: { shop } });
  if (!session) {
    throw new Error(
      `No session found for ${shop}. Install the app on this store first (npm run dev).`,
    );
  }
  const accessToken = session.accessToken;

  console.log(`Creating product on ${shop}...`);

  const productCreateData = await gql(
    shop,
    accessToken,
    `#graphql
      mutation CreateDemoProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  selectedOptions { name value }
                }
              }
            }
          }
          userErrors { field message }
        }
      }`,
    {
      product: {
        title: "Daily Nootropic Gummies",
        vendor: "CLRTY",
        productType: "Cognitive Support",
        status: "ACTIVE",
        descriptionHtml:
          "<p>Daily cognitive support gummies with Lion's Mane, L-Theanine, Alpha-GPC and Bacopa Monnieri.</p>" +
          "<ul><li>Lion's Mane</li><li>L-Theanine</li><li>Alpha-GPC</li><li>Bacopa Monnieri</li></ul>",
        productOptions: [
          {
            name: "Flavor",
            values: [
              { name: "Sour Green Apple" },
              { name: "Blood Orange" },
              { name: "Cherry Lime" },
            ],
          },
        ],
      },
    },
  );

  assertNoUserErrors("productCreate", productCreateData.productCreate.userErrors);
  const product = productCreateData.productCreate.product;
  // productCreate only seeds a variant for the first option value -- the rest of
  // the combinations have to be added with a separate bulk-create call.
  const firstVariant = product.variants.edges[0].node;
  console.log(`Created product ${product.id} (${firstVariant.title})`);

  const flavors = ["Sour Green Apple", "Blood Orange", "Cherry Lime"];
  const remainingFlavors = flavors.filter((f) => f !== firstVariant.title);

  const addVariantsData = await gql(
    shop,
    accessToken,
    `#graphql
      mutation AddFlavorVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
        productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
          productVariants { id title price }
          userErrors { field message }
        }
      }`,
    {
      productId: product.id,
      strategy: "DEFAULT",
      variants: remainingFlavors.map((name) => ({
        price: "49.00",
        optionValues: [{ optionName: "Flavor", name }],
      })),
    },
  );
  assertNoUserErrors(
    "productVariantsBulkCreate",
    addVariantsData.productVariantsBulkCreate.userErrors,
  );
  const newVariants = addVariantsData.productVariantsBulkCreate.productVariants;
  console.log(`Added variants: ${newVariants.map((v) => v.title).join(", ")}`);

  // productCreate seeds the first variant at $0.00 -- set its real price too.
  const priceFixData = await gql(
    shop,
    accessToken,
    `#graphql
      mutation SetFirstVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }`,
    {
      productId: product.id,
      variants: [{ id: firstVariant.id, price: "49.00" }],
    },
  );
  assertNoUserErrors(
    "productVariantsBulkUpdate",
    priceFixData.productVariantsBulkUpdate.userErrors,
  );
  console.log("Set all variant prices to $49.00");

  // Publishing to a sales channel needs read_publications/write_publications,
  // which isn't in our scope list -- skip rather than fail the whole run.
  console.log(
    "Skipped publishing to Online Store: app doesn't have the publications scope. " +
      "Publish manually from the product page, or add read_publications/write_publications " +
      "to shopify.app.toml and redeploy if this should be automatic.",
  );

  // Subscribe & Save: 15% off, delivered every 30 days.
  const sellingPlanData = await gql(
    shop,
    accessToken,
    `#graphql
      mutation CreateSubscribeAndSave($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
        sellingPlanGroupCreate(input: $input, resources: $resources) {
          sellingPlanGroup { id name }
          userErrors { field message }
        }
      }`,
    {
      input: {
        name: "Subscribe & Save",
        merchantCode: "subscribe-and-save",
        options: ["Delivery every"],
        sellingPlansToCreate: [
          {
            name: "Subscribe & Save",
            category: "SUBSCRIPTION",
            options: ["30 days"],
            billingPolicy: { recurring: { interval: "DAY", intervalCount: 30 } },
            deliveryPolicy: { recurring: { interval: "DAY", intervalCount: 30 } },
            pricingPolicies: [
              {
                fixed: { adjustmentType: "PERCENTAGE", adjustmentValue: { percentage: 15 } },
              },
            ],
          },
        ],
      },
      resources: { productIds: [product.id] },
    },
  );
  assertNoUserErrors(
    "sellingPlanGroupCreate",
    sellingPlanData.sellingPlanGroupCreate.userErrors,
  );
  console.log(
    `Created selling plan group: ${sellingPlanData.sellingPlanGroupCreate.sellingPlanGroup.name}`,
  );

  const numericId = product.id.split("/").pop();
  console.log(`\nDone. Admin: https://${shop}/admin/products/${numericId}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());