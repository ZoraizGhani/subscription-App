import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  getDashboardMetrics,
  getNewVsCancelledSeries,
  getNeedsAttention,
  getUpcomingRenewals,
  type FlowBucketUnit,
} from "../models/dashboard.server";
import styles from "../styles/dashboard.module.css";

const STATUS_PILL: Record<string, string> = {
  ACTIVE: styles.statusActive,
  PAUSED: styles.statusWarning,
  CANCELLED: styles.statusCritical,
  FAILED: styles.statusCritical,
  EXPIRED: styles.statusNeutral,
};

// Reuses this app's existing critical-red status color (see STATUS_PILL.CANCELLED
// above) for the "cancelled" series, paired with near-black for "new" --
// deliberately a neutral-baseline + status-highlight pairing rather than two
// arbitrary categorical hues, since "cancelled" already carries that meaning
// everywhere else in this app. Validated for CVD/contrast separately.
const CHART_COLORS = { created: "#1a1a1a", cancelled: "#b91c1c" };

type RangeKey = "today" | "weekly" | "monthly" | "yearly";

/**
 * Drives every time-boxed widget on the page from one selector. `windowDays`
 * sets both the stat-card comparison period and the renewals lookahead;
 * `chartUnit`/`chartCount` set the trend chart's bucketing. "Needs attention"
 * is deliberately NOT driven by this -- it's a snapshot of contracts that are
 * FAILED right now, not a historical window, so a range picker doesn't apply
 * to it the same way.
 */
const RANGE_CONFIG: Record<
  RangeKey,
  { label: string; windowDays: number; chartUnit: FlowBucketUnit; chartCount: number; chartSpanLabel: string; renewalsLabel: string }
> = {
  today: { label: "Today", windowDays: 1, chartUnit: "day", chartCount: 7, chartSpanLabel: "last 7 days", renewalsLabel: "today" },
  weekly: { label: "Weekly", windowDays: 7, chartUnit: "week", chartCount: 8, chartSpanLabel: "last 8 weeks", renewalsLabel: "this week" },
  monthly: { label: "Monthly", windowDays: 30, chartUnit: "month", chartCount: 6, chartSpanLabel: "last 6 months", renewalsLabel: "this month" },
  yearly: { label: "Yearly", windowDays: 365, chartUnit: "month", chartCount: 12, chartSpanLabel: "last 12 months", renewalsLabel: "this year" },
};

function isRangeKey(value: string | null): value is RangeKey {
  return value === "today" || value === "weekly" || value === "monthly" || value === "yearly";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;

  const url = new URL(request.url);
  const rangeParam = url.searchParams.get("range");
  const range: RangeKey = isRangeKey(rangeParam) ? rangeParam : "monthly";
  const config = RANGE_CONFIG[range];

  const [metrics, series, needsAttention, renewals, shopResponse] = await Promise.all([
    getDashboardMetrics({ shop, windowDays: config.windowDays }),
    getNewVsCancelledSeries({ shop, unit: config.chartUnit, count: config.chartCount }),
    getNeedsAttention({ shop }),
    getUpcomingRenewals({ shop, windowDays: config.windowDays }),
    admin.graphql(`#graphql
      query ShopInfo {
        shop { name currencyCode }
      }
    `),
  ]);
  const shopData = (await shopResponse.json()) as { data?: { shop: { name: string; currencyCode: string } } };
  const currencyCode = shopData.data?.shop.currencyCode ?? "USD";
  const shopName = shopData.data?.shop.name ?? shop;

  return { metrics, series, needsAttention, renewals, currencyCode, shopName, range };
};

function formatMoney(amount: number | null, currencyCode: string) {
  if (amount == null) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode, maximumFractionDigits: 0 }).format(
    amount,
  );
}

function formatDate(value: Date | string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function Delta({ value, unit, positiveIsGood }: { value: number | null; unit: "pct" | "pt"; positiveIsGood: boolean }) {
  if (value == null || Math.abs(value) < 0.05) {
    return <span className={styles.deltaFlat}>— flat</span>;
  }
  const isPositive = value > 0;
  const isGood = isPositive === positiveIsGood;
  const arrow = isPositive ? "↑" : "↓";
  const formatted = `${arrow} ${Math.abs(value).toFixed(1)}${unit === "pct" ? "%" : "pt"}`;
  return (
    <span className={isGood ? styles.deltaGood : styles.deltaBad}>{unit === "pct" ? `${formatted} vs prior period` : formatted}</span>
  );
}

export default function Dashboard() {
  const { metrics, series, needsAttention, renewals, currencyCode, shopName, range } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const config = RANGE_CONFIG[range];

  const maxFlow = Math.max(1, ...series.flatMap((m) => [m.created, m.cancelled]));

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <Form className={styles.searchForm} method="get" action="/app/subscriptions">
          <input className={styles.search} type="search" name="q" placeholder="Search customers, orders, contract #..." />
        </Form>
        <div className={styles.spacer} />
        {metrics.failedPayments > 0 && (
          <span className={styles.failedBadge}>{metrics.failedPayments} FAILED PAYMENTS</span>
        )}
        <div className={styles.avatar}>{initialsOf(shopName)}</div>
      </div>

      <div className={styles.eyebrow}>Overview</div>
      <div className={styles.headingRow}>
        <h1 className={styles.heading}>Subscriptions dashboard</h1>
        <div className={styles.headingActions}>
          <Form method="get">
            {Array.from(searchParams.entries())
              .filter(([key]) => key !== "range")
              .map(([key, value]) => (
                <input key={key} type="hidden" name={key} value={value} />
              ))}
            <select
              className={styles.rangeSelect}
              name="range"
              defaultValue={range}
              onChange={(event) => event.currentTarget.form?.requestSubmit()}
            >
              {Object.entries(RANGE_CONFIG).map(([key, cfg]) => (
                <option key={key} value={key}>
                  {cfg.label}
                </option>
              ))}
            </select>
          </Form>
        </div>
      </div>

      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>MRR</div>
          <div className={styles.statValue}>{formatMoney(metrics.mrr, currencyCode)}</div>
          <div className={styles.statDelta}>
            <Delta value={metrics.mrrDeltaPct} unit="pct" positiveIsGood />
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Active subs</div>
          <div className={styles.statValue}>{metrics.activeSubs.toLocaleString()}</div>
          <div className={styles.statDelta}>
            <Delta value={metrics.activeSubsDeltaPct} unit="pct" positiveIsGood />
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Churn ({config.windowDays}d)</div>
          <div className={styles.statValue}>{metrics.churnRate.toFixed(1)}%</div>
          <div className={styles.statDelta}>
            <Delta value={metrics.churnDeltaPts} unit="pt" positiveIsGood={false} />
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Avg LTV</div>
          <div className={styles.statValue}>{formatMoney(metrics.avgLtv, currencyCode)}</div>
          <div className={styles.statDelta}>
            <Delta value={metrics.avgLtvDeltaPct} unit="pct" positiveIsGood />
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statLabel}>Failed payments</div>
          <div className={styles.statValue}>{metrics.failedPayments}</div>
          <div className={styles.statDelta}>
            {metrics.failedPayments > 0 ? (
              <span className={styles.deltaAction}>needs action</span>
            ) : (
              <span className={styles.deltaFlat}>all clear</span>
            )}
          </div>
        </div>
      </div>

      <div className={styles.panelsRow}>
        <div className={styles.card}>
          <div className={styles.cardHeadingRow}>
            <h2 className={styles.cardHeading}>New vs. cancelled — {config.chartSpanLabel}</h2>
            <div className={styles.legend}>
              <span className={styles.legendItem}>
                <span className={styles.legendDot} style={{ backgroundColor: CHART_COLORS.created }} />
                New
              </span>
              <span className={styles.legendItem}>
                <span className={styles.legendDot} style={{ backgroundColor: CHART_COLORS.cancelled }} />
                Cancelled
              </span>
            </div>
          </div>
          <div className={styles.chartArea}>
            {series.map((bucket, index) => (
              <div key={`${bucket.label}-${index}`} className={styles.barGroup}>
                <div className={styles.barPair}>
                  <div
                    className={styles.bar}
                    title={`${bucket.label}: ${bucket.created} new`}
                    style={{
                      height: `${Math.max(4, (bucket.created / maxFlow) * 120)}px`,
                      backgroundColor: CHART_COLORS.created,
                    }}
                  />
                  <div
                    className={styles.bar}
                    title={`${bucket.label}: ${bucket.cancelled} cancelled`}
                    style={{
                      height: `${Math.max(4, (bucket.cancelled / maxFlow) * 120)}px`,
                      backgroundColor: CHART_COLORS.cancelled,
                    }}
                  />
                </div>
                <span className={styles.barMonthLabel}>{bucket.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardHeadingRow}>
            <h2 className={styles.cardHeading}>Needs attention</h2>
          </div>
          {needsAttention.length === 0 ? (
            <p className={styles.emptyState}>Nothing needs review right now.</p>
          ) : (
            <div className={styles.attentionList}>
              {needsAttention.map((row) => (
                <div key={row.contractShopifyId} className={styles.attentionRow}>
                  <div>
                    <div className={styles.attentionName}>{row.customerName}</div>
                    <div className={styles.attentionMeta}>{row.contractNumber} • Payment declined</div>
                  </div>
                  <Link className={styles.reviewLink} to={`/app/subscriptions/${row.contractShopifyId.split("/").pop()}`}>
                    Review
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.renewalsSection}>
        <div className={styles.cardHeadingRow}>
          <h2 className={styles.cardHeading}>Renewals due {config.renewalsLabel}</h2>
          <Link className={styles.viewAllLink} to="/app/subscriptions">
            View all →
          </Link>
        </div>
        {renewals.length === 0 ? (
          <p className={styles.emptyState}>No renewals due {config.renewalsLabel}.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Product</th>
                <th>Renewal date</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {renewals.map((row) => (
                <tr key={row.contractShopifyId}>
                  <td>{row.customerName}</td>
                  <td>{row.productTitle}</td>
                  <td>{formatDate(row.nextBillingDate)}</td>
                  <td>{formatMoney(row.amount, row.currencyCode)}</td>
                  <td>
                    <span className={`${styles.statusPill} ${STATUS_PILL[row.status] ?? styles.statusNeutral}`}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
