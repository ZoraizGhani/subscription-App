import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getCustomerDetail } from "../models/customer.server";

const STATUS_TONE: Record<string, "success" | "warning" | "critical" | "neutral"> = {
  ACTIVE: "success",
  PAUSED: "warning",
  CANCELLED: "critical",
  FAILED: "critical",
  EXPIRED: "neutral",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const customerShopifyId = `gid://shopify/Customer/${params.customerId}`;

  const [detail, shopResponse] = await Promise.all([
    getCustomerDetail({ shop: session.shop, customerShopifyId, graphql: admin.graphql }),
    admin.graphql(`#graphql
      query ShopCurrency {
        shop { currencyCode }
      }
    `),
  ]);

  if (!detail) {
    throw new Response("Customer not found", { status: 404 });
  }

  const shopData = (await shopResponse.json()) as { data?: { shop: { currencyCode: string } } };
  const currencyCode = shopData.data?.shop.currencyCode ?? "USD";

  return { detail, currencyCode };
};

function formatMoney(amount: number | null, currencyCode: string) {
  if (amount == null) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).format(amount);
}

function formatDate(value: Date | string | null) {
  if (!value) return "--";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function CustomerDetail() {
  const { detail, currencyCode } = useLoaderData<typeof loader>();

  return (
    <s-page heading={detail.name}>
      <s-link slot="breadcrumb-actions" href="/app/customers">
        Customers
      </s-link>

      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>Email: </s-text>
            <s-text>{detail.email}</s-text>
          </s-paragraph>
          {detail.phone ? (
            <s-paragraph>
              <s-text>Phone: </s-text>
              <s-text>{detail.phone}</s-text>
            </s-paragraph>
          ) : null}
          <s-paragraph>
            <s-text>Customer since: </s-text>
            <s-text>{formatDate(detail.since)}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Lifetime value: </s-text>
            <s-text>{formatMoney(detail.lifetimeValue, currencyCode)}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Subscriptions: </s-text>
            <s-text>{detail.subscriptionCount}</s-text>
          </s-paragraph>
          {detail.defaultAddress ? (
            <s-paragraph>
              <s-text>Address: </s-text>
              <s-text>{detail.defaultAddress}</s-text>
            </s-paragraph>
          ) : null}
          {detail.paymentMethods.length > 0 ? (
            <s-paragraph>
              <s-text>Payment methods: </s-text>
              <s-text>{detail.paymentMethods.join(", ")}</s-text>
            </s-paragraph>
          ) : null}
          {detail.tags.length > 0 ? (
            <s-paragraph>
              <s-text>Tags: </s-text>
              <s-text>{detail.tags.join(", ")}</s-text>
            </s-paragraph>
          ) : null}
          {detail.note ? (
            <s-paragraph>
              <s-text>Note: </s-text>
              <s-text>{detail.note}</s-text>
            </s-paragraph>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Subscriptions">
        <s-table>
          <s-table-header-row>
            <s-table-header>Contract</s-table-header>
            <s-table-header>Product</s-table-header>
            <s-table-header>Frequency</s-table-header>
            <s-table-header>Next order</s-table-header>
            <s-table-header>Amount</s-table-header>
            <s-table-header>Status</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {detail.subscriptions.map((sub) => (
              <s-table-row key={sub.contractShopifyId}>
                <s-table-cell>{sub.contractNumber}</s-table-cell>
                <s-table-cell>{sub.productTitle}</s-table-cell>
                <s-table-cell>{sub.frequencyLabel}</s-table-cell>
                <s-table-cell>{formatDate(sub.nextBillingDate)}</s-table-cell>
                <s-table-cell>{formatMoney(sub.totalAmount, sub.currencyCode)}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={STATUS_TONE[sub.status] ?? "neutral"}>{sub.status}</s-badge>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Order history">
        {detail.orders.length === 0 ? (
          <s-paragraph color="subdued">No recurring orders yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Order</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Date</s-table-header>
              <s-table-header>Total</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {detail.orders.map((order) => (
                <s-table-row key={order.orderShopifyId}>
                  <s-table-cell>{order.orderName ?? "--"}</s-table-cell>
                  <s-table-cell>{order.productTitle ?? "--"}</s-table-cell>
                  <s-table-cell>{formatDate(order.processedAt)}</s-table-cell>
                  <s-table-cell>{formatMoney(order.totalPrice, order.currencyCode ?? currencyCode)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Billing attempts">
        {detail.billingHistory.length === 0 ? (
          <s-paragraph color="subdued">No billing attempts recorded yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Date</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Error</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {detail.billingHistory.map((attempt) => (
                <s-table-row key={attempt.id}>
                  <s-table-cell>{formatDate(attempt.attemptedAt)}</s-table-cell>
                  <s-table-cell>{formatMoney(attempt.amount, attempt.currencyCode ?? currencyCode)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={attempt.status === "SUCCESS" ? "success" : "critical"}>{attempt.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{attempt.errorMessage ?? "--"}</s-table-cell>
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
