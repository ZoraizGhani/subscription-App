import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  getDashboardMetrics,
  getNewVsCancelledSeries,
  getNeedsAttention,
  getRenewalsDueThisWeek,
} from "../models/dashboard.server";

const STATUS_TONE: Record<string, "success" | "warning" | "critical" | "neutral"> = {
  ACTIVE: "success",
  PAUSED: "warning",
  CANCELLED: "critical",
  FAILED: "critical",
  EXPIRED: "neutral",
};

// Reuses this app's existing critical-red status color (see STATUS_TONE.CANCELLED
// elsewhere) for the "cancelled" series, paired with near-black for "new" --
// deliberately a neutral-baseline + status-highlight pairing rather than two
// arbitrary categorical hues, since "cancelled" already carries that meaning
// everywhere else in this app.
const CHART_COLORS = { created: "#1a1a1a", cancelled: "#b91c1c" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;

  const [metrics, series, needsAttention, renewals, shopResponse] = await Promise.all([
    getDashboardMetrics({ shop }),
    getNewVsCancelledSeries({ shop, months: 6 }),
    getNeedsAttention({ shop }),
    getRenewalsDueThisWeek({ shop }),
    admin.graphql(`#graphql
      query ShopCurrency {
        shop { currencyCode }
      }
    `),
  ]);
  const shopData = (await shopResponse.json()) as { data?: { shop: { currencyCode: string } } };
  const currencyCode = shopData.data?.shop.currencyCode ?? "USD";

  return { metrics, series, needsAttention, renewals, currencyCode };
};

function formatMoney(amount: number | null, currencyCode: string) {
  if (amount == null) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).format(amount);
}

function formatDate(value: Date | string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function Delta({
  value,
  unit,
  positiveIsGood,
}: {
  value: number | null;
  unit: "pct" | "pt";
  positiveIsGood: boolean;
}) {
  if (value == null || Math.abs(value) < 0.05) {
    return <s-text color="subdued">— flat</s-text>;
  }
  const isPositive = value > 0;
  const isGood = isPositive === positiveIsGood;
  const arrow = isPositive ? "↑" : "↓";
  const formatted = `${arrow} ${Math.abs(value).toFixed(1)}${unit === "pct" ? "%" : "pt"}`;
  return <s-text tone={isGood ? "success" : "critical"}>{unit === "pct" ? `${formatted} MoM` : formatted}</s-text>;
}

function StatTile({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta: React.ReactNode;
}) {
  return (
    <div
      style={{
        flex: "1 1 180px",
        border: "1px solid #e5e5e5",
        borderRadius: "8px",
        padding: "16px",
      }}
    >
      <div style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", color: "#8a8a8a", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: "28px", fontWeight: 600, margin: "6px 0" }}>{value}</div>
      <div style={{ fontSize: "13px" }}>{delta}</div>
    </div>
  );
}

export default function Dashboard() {
  const { metrics, series, needsAttention, renewals, currencyCode } = useLoaderData<typeof loader>();

  const maxFlow = Math.max(1, ...series.flatMap((m) => [m.created, m.cancelled]));

  return (
    <s-page heading="Subscriptions dashboard">
      <s-section heading="Overview">
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <StatTile
            label="MRR"
            value={formatMoney(metrics.mrr, currencyCode)}
            delta={<Delta value={metrics.mrrDeltaPct} unit="pct" positiveIsGood />}
          />
          <StatTile
            label="Active subs"
            value={String(metrics.activeSubs)}
            delta={<Delta value={metrics.activeSubsDeltaPct} unit="pct" positiveIsGood />}
          />
          <StatTile
            label="Churn (30d)"
            value={`${metrics.churn30d.toFixed(1)}%`}
            delta={<Delta value={metrics.churnDeltaPts} unit="pt" positiveIsGood={false} />}
          />
          <StatTile
            label="Avg LTV"
            value={formatMoney(metrics.avgLtv, currencyCode)}
            delta={<Delta value={metrics.avgLtvDeltaPct} unit="pct" positiveIsGood />}
          />
          <StatTile
            label="Failed payments"
            value={String(metrics.failedPayments)}
            delta={
              metrics.failedPayments > 0 ? (
                <s-text tone="critical">needs action</s-text>
              ) : (
                <s-text color="subdued">all clear</s-text>
              )
            }
          />
        </div>
      </s-section>

      <s-section heading="New vs. cancelled — last 6 months">
        <div style={{ display: "flex", alignItems: "center", gap: "16px", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: CHART_COLORS.created,
              }}
            />
            New
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: CHART_COLORS.cancelled,
              }}
            />
            Cancelled
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: "24px", height: "160px" }}>
          {series.map((month) => (
            <div key={month.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "120px" }}>
                <div
                  title={`${month.label}: ${month.created} new`}
                  style={{
                    width: "18px",
                    height: `${Math.max(4, (month.created / maxFlow) * 120)}px`,
                    backgroundColor: CHART_COLORS.created,
                    borderRadius: "4px 4px 0 0",
                  }}
                />
                <div
                  title={`${month.label}: ${month.cancelled} cancelled`}
                  style={{
                    width: "18px",
                    height: `${Math.max(4, (month.cancelled / maxFlow) * 120)}px`,
                    backgroundColor: CHART_COLORS.cancelled,
                    borderRadius: "4px 4px 0 0",
                  }}
                />
              </div>
              <span style={{ fontSize: "12px", color: "#8a8a8a" }}>{month.label}</span>
            </div>
          ))}
        </div>
      </s-section>

      <s-section slot="aside" heading="Needs attention">
        {needsAttention.length === 0 ? (
          <s-paragraph color="subdued">Nothing needs review right now.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {needsAttention.map((row) => (
              <div
                key={row.contractShopifyId}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{row.customerName}</div>
                  <div style={{ fontSize: "12px", color: "#8a8a8a" }}>
                    {row.contractNumber} • Payment declined
                  </div>
                </div>
                <s-link href={`/app/subscriptions/${row.contractShopifyId.split("/").pop()}`}>Review</s-link>
              </div>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Renewals due this week">
        {renewals.length === 0 ? (
          <s-paragraph color="subdued">No renewals due in the next 7 days.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Product</s-table-header>
              <s-table-header>Renewal date</s-table-header>
              <s-table-header>Amount</s-table-header>
              <s-table-header>Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {renewals.map((row) => (
                <s-table-row key={row.contractShopifyId}>
                  <s-table-cell>{row.customerName}</s-table-cell>
                  <s-table-cell>{row.productTitle}</s-table-cell>
                  <s-table-cell>{formatDate(row.nextBillingDate)}</s-table-cell>
                  <s-table-cell>{formatMoney(row.amount, row.currencyCode)}</s-table-cell>
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
