# Setup — private (custom distribution) subscription app

Everything in the repo is configured for custom distribution: one app, installed on
one merchant store, not listed on the App Store. The steps below are the ones that
have to happen in a browser or a terminal you control — they can't be committed.

## 1. Install and prepare locally

```bash
cd "subcription-app"
npm install
npm run setup          # prisma generate && prisma migrate deploy
```

Node must be `>=20.19 <22 || >=22.12` (see `engines` in package.json).

## 2. Confirm the app is linked

`shopify.app.toml` already carries `client_id = 4df4707f56ec6035d9395e58a3d4b8ce`,
so this project is linked to an existing app. To point it at a different app:

```bash
npm run config:link
```

## 3. Set distribution to Custom in the Dev Dashboard

Open the app in the Shopify Dev Dashboard (or Partner Dashboard) → **Distribution** →
choose **Custom distribution** → enter the store domain that will install it.

This is a one-way choice: an app set to custom distribution cannot later be
converted to a public App Store app. It is also what makes the subscription scopes
below available without an App Store review.

`app/shopify.server.ts` is already set to `AppDistribution.SingleMerchant` to match.

## 4. Approve the protected scopes

The app requests two scopes that Shopify gates:

- `write_own_subscription_contracts`
- `write_customer_payment_methods`

For a custom distribution app these are granted on request. In the Dev Dashboard,
open **API access** and request access to protected customer data if the app shows
as restricted. Without them, `subscriptionContract*` mutations return an access
error even though the OAuth flow succeeds.

## 5. Prepare a store that can actually run subscriptions

Recurring billing needs a payment provider that supports deferred payments:

- A **development store** with Shopify Payments in test mode, or
- The real merchant store with Shopify Payments (or another gateway that supports
  subscriptions) enabled.

Subscriptions will not bill on a store whose only gateway is the Bogus Gateway.

## 6. Run it

```bash
npm run dev
```

The CLI opens a tunnel, rewrites `application_url` / `redirect_urls`, registers the
webhooks in `shopify.app.toml`, and gives you an install link. Install on the store
from step 5 and the embedded app appears in the store admin.

## 7. Deploy config changes

Scope, webhook, and app-name changes in `shopify.app.toml` reach Shopify only on:

```bash
npm run deploy
```

Changing `scopes` forces merchants to re-approve on next load — expected.

## Verifying webhooks

```bash
shopify app webhook trigger --topic subscription_contracts/update
```

Handlers live in `app/routes/webhooks.*.tsx` and are idempotent: each records its
webhook id in `ProcessedWebhook` and returns early on redelivery.

## What is deliberately not set up yet

Following the agreed build order, these come later and each needs its own CLI step:

| Step | Command | Notes |
| --- | --- | --- |
| Selling plan group backend | — | Admin GraphQL logic behind the Settings screen |
| Admin screens | — | Build each from its Figma frame |
| PDP widget | `npm run generate` → Theme app extension | Renders selling plans, adds plan to cart |
| Customer portal | `npm run generate` → Customer account UI extension | Overview / manage / cancel |

Extensions are generated into `extensions/` and are already covered by the npm
workspace config and `.graphqlrc.ts`.