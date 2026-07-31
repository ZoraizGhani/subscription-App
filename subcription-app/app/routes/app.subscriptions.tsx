import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { listSubscriptionContracts } from "../models/subscriptionList.server";

const STATUS_TABS: { key: string; label: string; countKey: "all" | "active" | "paused" | "cancelled" | "failed" }[] = [
  { key: "", label: "All", countKey: "all" },
  { key: "ACTIVE", label: "Active", countKey: "active" },
  { key: "PAUSED", label: "Paused", countKey: "paused" },
  { key: "CANCELLED", label: "Cancelled", countKey: "cancelled" },
  { key: "FAILED", label: "Payment failed", countKey: "failed" },
];

const STATUS_TONE: Record<string, "success" | "warning" | "critical" | "neutral"> = {
  ACTIVE: "success",
  PAUSED: "warning",
  CANCELLED: "critical",
  FAILED: "critical",
  EXPIRED: "neutral",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("q") ?? "";
  const status = url.searchParams.get("status") ?? "";

  const [{ rows, counts }, shopResponse] = await Promise.all([
    listSubscriptionContracts({ shop: session.shop, search: search || undefined, status: status || undefined }),
    admin.graphql(`#graphql
      query ShopCurrency {
        shop { currencyCode }
      }
    `),
  ]);
  const shopData = (await shopResponse.json()) as { data?: { shop: { currencyCode: string } } };
  const currencyCode = shopData.data?.shop.currencyCode ?? "USD";

  return { rows, counts, search, status, currencyCode };
};

function formatMoney(amount: number, currencyCode: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).format(amount);
}

function formatDate(value: Date | string | null) {
  if (!value) return "--";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Subscriptions() {
  const { rows, counts, search, status, currencyCode } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSearchInput = (event: Event) => {
    const value = (event.target as HTMLInputElement).value;
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set("q", value);
    } else {
      next.delete("q");
    }
    setSearchParams(next, { replace: true });
  };

  const selectStatus = (key: string) => {
    const next = new URLSearchParams(searchParams);
    if (key) {
      next.set("status", key);
    } else {
      next.delete("status");
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <s-page heading="Subscriptions">
      <s-section heading="Manage">
        <s-stack direction="inline" gap="base" alignItems="center">
          {STATUS_TABS.map((tab) => (
            <s-button
              key={tab.key || "all"}
              variant={status === tab.key ? "primary" : "secondary"}
              onClick={() => selectStatus(tab.key)}
            >
              {tab.label} ({counts[tab.countKey]})
            </s-button>
          ))}
        </s-stack>

        <s-search-field
          label="Search"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search by customer or contract #"
          defaultValue={search}
          onInput={handleSearchInput}
        />

        {rows.length === 0 ? (
          <s-paragraph color="subdued">
            {search || status
              ? "No subscriptions match this filter."
              : "No subscriptions yet -- this list populates once a customer completes a subscription checkout."}
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Contract</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Frequency</s-table-header>
              <s-table-header>Next order</s-table-header>
              <s-table-header>MRR</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => (
                <s-table-row key={row.contractShopifyId}>
                  <s-table-cell>{row.contractNumber}</s-table-cell>
                  <s-table-cell>{row.customerName}</s-table-cell>
                  <s-table-cell>{row.productTitle}</s-table-cell>
                  <s-table-cell>{row.frequencyLabel}</s-table-cell>
                  <s-table-cell>{formatDate(row.nextBillingDate)}</s-table-cell>
                  <s-table-cell>{formatMoney(row.mrr, currencyCode)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[row.status] ?? "neutral"}>{row.status}</s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};