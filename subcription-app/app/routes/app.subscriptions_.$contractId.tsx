import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getSubscriptionContractDetail } from "../models/subscriptionList.server";

const STATUS_TONE: Record<string, "success" | "warning" | "critical" | "neutral"> = {
  ACTIVE: "success",
  PAUSED: "warning",
  CANCELLED: "critical",
  FAILED: "critical",
  EXPIRED: "neutral",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const contractShopifyId = `gid://shopify/SubscriptionContract/${params.contractId}`;

  const [detail, shopResponse] = await Promise.all([
    getSubscriptionContractDetail({ shop: session.shop, contractShopifyId }),
    admin.graphql(`#graphql
      query ShopCurrency {
        shop { currencyCode }
      }
    `),
  ]);

  if (!detail) {
    throw new Response("Subscription not found", { status: 404 });
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

export default function SubscriptionDetail() {
  const { detail, currencyCode } = useLoaderData<typeof loader>();
  const customerNumericId = detail.customerShopifyId?.split("/").pop();

  return (
    <s-page heading={detail.contractNumber}>
      <s-link slot="breadcrumb-actions" href="/app/subscriptions">
        Subscriptions
      </s-link>
      <s-button slot="secondary-actions" href="/app/subscriptions" icon="arrow-left">
        Back to subscriptions
      </s-button>

      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>Customer: </s-text>
            {customerNumericId ? (
              <s-link href={`/app/customers/${customerNumericId}`} tone="neutral">
                {detail.customerName}
              </s-link>
            ) : (
              <s-text>{detail.customerName}</s-text>
            )}
          </s-paragraph>
          <s-paragraph>
            <s-text>Email: </s-text>
            <s-text>{detail.customerEmail}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Status: </s-text>
            {detail.status === "ACTIVE" && detail.lastPaymentStatus === "FAILED" ? (
              <s-badge tone="critical">PAYMENT FAILED</s-badge>
            ) : (
              <s-badge tone={STATUS_TONE[detail.status] ?? "neutral"}>{detail.status}</s-badge>
            )}
          </s-paragraph>
          <s-paragraph>
            <s-text>Frequency: </s-text>
            <s-text>{detail.frequencyLabel}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Next order: </s-text>
            <s-text>{formatDate(detail.nextBillingDate)}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Amount per order: </s-text>
            <s-text>{formatMoney(detail.totalAmount, detail.currencyCode)}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Started: </s-text>
            <s-text>{formatDate(detail.createdAt)}</s-text>
          </s-paragraph>
          {detail.pausedAt ? (
            <s-paragraph>
              <s-text>Paused: </s-text>
              <s-text>{formatDate(detail.pausedAt)}</s-text>
            </s-paragraph>
          ) : null}
          {detail.cancelledAt ? (
            <s-paragraph>
              <s-text>Cancelled: </s-text>
              <s-text>{formatDate(detail.cancelledAt)}</s-text>
            </s-paragraph>
          ) : null}
          {detail.cancellationReason ? (
            <s-paragraph>
              <s-text>Cancellation reason: </s-text>
              <s-text>{detail.cancellationReason}</s-text>
            </s-paragraph>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Line items">
        <s-table>
          <s-table-header-row>
            <s-table-header>Product</s-table-header>
            <s-table-header>Variant</s-table-header>
            <s-table-header>Quantity</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {detail.lines.map((line, index) => (
              <s-table-row key={`${line.title}-${index}`}>
                <s-table-cell>{line.title}</s-table-cell>
                <s-table-cell>{line.variantTitle ?? "--"}</s-table-cell>
                <s-table-cell>{line.quantity}</s-table-cell>
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
              <s-table-header>Date</s-table-header>
              <s-table-header>Total</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {detail.orders.map((order) => (
                <s-table-row key={order.orderShopifyId}>
                  <s-table-cell>{order.orderName ?? "--"}</s-table-cell>
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
