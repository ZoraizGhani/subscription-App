# Project conventions

Shopify subscription app, **custom distribution** (single merchant, not App Store).
Read `docs/SETUP.md` for the install/deploy steps.

## Stack facts that are easy to get wrong

- **React Router 7**, not Remix. Imports come from `react-router`, loaders and
  actions use `LoaderFunctionArgs` / `ActionFunctionArgs`.
- **Polaris web components** (`<s-page>`, `<s-section>`, `<s-button>`, `<s-stack>`,
  `<s-box>`, `<s-text>`, `<s-link>`), **not** `@shopify/polaris` React components.
  That package is not installed — do not import `Card`, `Page`, `DataTable`, etc.
- Routes are **flat file routes**: `app.settings.tsx` → `/app/settings`,
  `webhooks.orders.create.tsx` → `/webhooks/orders/create`.
- Admin API version is **2026-07** (`ApiVersion.July26`), matching
  `webhooks.api_version` in `shopify.app.toml`. Keep the two in step.
- Server-only modules end in `.server.ts`.

## Layout

```
app/
  routes/app.*.tsx        embedded admin screens (authenticate.admin)
  routes/webhooks.*.tsx   webhook handlers (authenticate.webhook)
  models/*.server.ts      Admin API calls + Prisma access
  shopify.server.ts       app config; don't edit casually
  db.server.ts            Prisma singleton
prisma/schema.prisma      Session + our mirror tables
docs/SETUP.md             manual setup steps
```

## Data model rule

**Shopify is the source of truth.** `SellingPlanGroup`, `SellingPlan`,
`SubscriptionContract`, `BillingAttempt` and `SubscriptionOrder` are read-model
mirrors that exist so admin screens can list and filter without paging the Admin
API on every render. Never treat a mirror row as authoritative for billing.
Mutations go to Shopify first, then update the mirror.

`ShopSettings` is the exception: it is ours alone and has no Shopify counterpart.

## Webhook handler shape

Every handler follows the same order:

1. `const { shop, topic, webhookId, payload, admin } = await authenticate.webhook(request)`
2. `if (await isDuplicateWebhook({ webhookId, shop, topic })) return new Response()`
3. Guard on `admin` being undefined — it is missing after an uninstall.
4. Do the work, then `return new Response()` (always 200; a non-200 makes Shopify
   retry and eventually drop the subscription).

Subscription payloads carry ids only, so handlers re-read the contract from the
Admin API via `syncSubscriptionContract` rather than trusting payload fields.

`orders/create` fires for *every* order. Use `findOrderContractId` to check for a
line item with a `contract` before recording anything.

## GraphQL

Inline documents tagged `#graphql` on the first line, so codegen and editor
tooling pick them up:

```ts
const response = await admin.graphql(
  `#graphql
    query Something($id: ID!) { ... }`,
  { variables: { id } },
);
```

Run `npm run graphql-codegen` after adding documents. When unsure whether a field
exists, check it against the schema instead of guessing:

```bash
curl -s https://shopify.dev/admin-graphql-direct-proxy/2026-07 -X POST \
  -H "Content-Type: application/json" \
  --data '{"query":"{ __type(name: \"SubscriptionContract\") { fields { name } } }"}'
```

## Commands

```bash
npm run dev          # tunnel + install link + webhook registration
npm run typecheck    # react-router typegen && tsc --noEmit
npm run lint
npm run deploy       # push shopify.app.toml changes (scopes, webhooks) to Shopify
npx prisma migrate dev --name <name>
```

## Build order

1. ~~Setup: config, scopes, distribution, schema, webhooks~~ (done)
2. Selling plan group backend — `sellingPlanGroupCreate` / `Update` / `Delete` in
   `app/models/sellingPlan.server.ts`, mirrored into `SellingPlanGroup`
3. Admin screens — Dashboard, Subscriptions, Customers, Settings. One screen per
   session, driven by its Figma frame. Placeholders exist for all four.
4. PDP widget — theme app extension
5. Customer portal — customer account UI extension

Work one screen at a time and commit after each one.