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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { shop } = session;

  const [metrics, series, needsAttention, renewals, shopResponse] = await Promise.all([
    getDashboardMetrics({ shop }),
    getNewVsCancelledSeries({ shop, months: 6 }),
    getNeedsAttention({ shop }),
    getRenewalsDueThisWeek({ shop }),
    admin.graphql(`#graphql
      query ShopInfo {
        shop { name currencyCode }
      }
    `),
  ]);
  const shopData = (await shopResponse.json()) as { data?: { shop: { name: string; currencyCode: string } } };
  const currencyCode = shopData.data?.shop.currencyCode ?? "USD";
  const shopName = shopData.data?.shop.name ?? shop;

  return { metrics, series, needsAttention, renewals, currencyCode, shopName };
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
    <span className={isGood ? styles.deltaGood : styles.deltaBad}>{unit === "pct" ? `${formatted} MoM` : formatted}</span>
  );
}

export default function Dashboard() {
  const { metrics, series, needsAttention, renewals, currencyCode, shopName } = useLoaderData<typeof loader>();

  const maxFlow = Math.max(1, ...series.flatMap((m) => [m.created, m.cancelled]));

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <input className={styles.search} placeholder="Search customers, orders, contract #..." readOnly />
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
          <span className={styles.rangeSelect}>Today ▾</span>
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
          <div className={styles.statLabel}>Churn (30d)</div>
          <div className={styles.statValue}>{metrics.churn30d.toFixed(1)}%</div>
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
            <h2 className={styles.cardHeading}>New vs. cancelled — last 6 months</h2>
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
            {series.map((month) => (
              <div key={month.label} className={styles.barGroup}>
                <div className={styles.barPair}>
                  <div
                    className={styles.bar}
                    title={`${month.label}: ${month.created} new`}
                    style={{
                      height: `${Math.max(4, (month.created / maxFlow) * 120)}px`,
                      backgroundColor: CHART_COLORS.created,
                    }}
                  />
                  <div
                    className={styles.bar}
                    title={`${month.label}: ${month.cancelled} cancelled`}
                    style={{
                      height: `${Math.max(4, (month.cancelled / maxFlow) * 120)}px`,
                      backgroundColor: CHART_COLORS.cancelled,
                    }}
                  />
                </div>
                <span className={styles.barMonthLabel}>{month.label}</span>
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
                  <a className={styles.reviewLink} href={`/app/subscriptions/${row.contractShopifyId.split("/").pop()}`}>
                    Review
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={styles.renewalsSection}>
        <div className={styles.cardHeadingRow}>
          <h2 className={styles.cardHeading}>Renewals due this week</h2>
          <a className={styles.viewAllLink} href="/app/subscriptions">
            View all →
          </a>
        </div>
        {renewals.length === 0 ? (
          <p className={styles.emptyState}>No renewals due in the next 7 days.</p>
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
