import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  getDashboardMetrics,
  getNewVsCancelledSeries,
  getNeedsAttention,
  getUpcomingRenewals,
  type FlowBucketUnit,
} from "../models/dashboard.server";
import type { QuickReviewData } from "../models/adminQuickReview.server";
import styles from "../styles/dashboard.module.css";

const FREQUENCY_OPTIONS = [
  { interval: "DAY", intervalCount: 30, label: "Every 30 days" },
  { interval: "DAY", intervalCount: 45, label: "Every 45 days" },
  { interval: "DAY", intervalCount: 60, label: "Every 60 days" },
  { interval: "WEEK", intervalCount: 1, label: "Every week" },
  { interval: "WEEK", intervalCount: 2, label: "Every 2 weeks" },
  { interval: "MONTH", intervalCount: 1, label: "Every month" },
];

function frequencyKey(interval: string, intervalCount: number) {
  return `${interval}:${intervalCount}`;
}

/** Projects where the next delivery would land if it started today, for
 * previewing a frequency change -- same approach as the customer portal's
 * manage-subscription modal. */
function addIntervalToToday(interval: string, count: number) {
  const result = new Date();
  switch (interval) {
    case "WEEK":
      result.setDate(result.getDate() + count * 7);
      break;
    case "MONTH":
      result.setMonth(result.getMonth() + count);
      break;
    case "YEAR":
      result.setFullYear(result.getFullYear() + count);
      break;
    default:
      result.setDate(result.getDate() + count);
  }
  return result.toISOString().slice(0, 10);
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3.33333 2.66602H12.6667C13.4026 2.66602 14 3.26346 14 3.99935V13.3327C14 14.0686 13.4026 14.666 12.6667 14.666H3.33333C2.59745 14.666 2 14.0686 2 13.3327V3.99935C2 3.26346 2.59745 2.66602 3.33333 2.66602V2.66602"
        stroke="#1F2937"
        strokeWidth="1.33333"
      />
      <path d="M10.6665 1.33398V4.00065" stroke="#1F2937" strokeWidth="1.33333" />
      <path d="M5.3335 1.33398V4.00065" stroke="#1F2937" strokeWidth="1.33333" />
      <path d="M2 6.66602H14" stroke="#1F2937" strokeWidth="1.33333" />
    </svg>
  );
}

function QuickReviewModal({
  contractShopifyId,
  currencyCode,
  onClose,
}: {
  contractShopifyId: string;
  currencyCode: string;
  onClose: () => void;
}) {
  const optionsFetcher = useFetcher<QuickReviewData | { error: string }>();
  const actionFetcher = useFetcher<{ intent: string; success?: boolean; error?: string }>();

  const [nextDeliveryDate, setNextDeliveryDate] = useState<string | null>(null);
  const [frequencyKeyValue, setFrequencyKeyValue] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);

  if (optionsFetcher.state === "idle" && !optionsFetcher.data) {
    optionsFetcher.load(`/app/subscriptions/quick-review?contractId=${encodeURIComponent(contractShopifyId)}`);
  }

  const data = optionsFetcher.data && "contractNumber" in optionsFetcher.data ? optionsFetcher.data : null;
  const loadError = optionsFetcher.data && "error" in optionsFetcher.data ? optionsFetcher.data.error : null;

  const activeDate = nextDeliveryDate ?? (data?.nextBillingDate ? data.nextBillingDate.slice(0, 10) : "");
  const activeFrequencyKey = frequencyKeyValue ?? (data ? frequencyKey(data.billingInterval, data.billingIntervalCount) : "");
  const activeQuantity = quantity ?? data?.quantity ?? 1;
  const unitPrice = data?.totalAmount && data.quantity ? data.totalAmount / data.quantity : 0;

  const busy = actionFetcher.state !== "idle";
  const busyIntent = busy ? actionFetcher.formData?.get("intent") : null;
  const saved = actionFetcher.state === "idle" && actionFetcher.data?.intent === "saveChanges" && actionFetcher.data.success;

  const runAction = (intent: string, extra: Record<string, string> = {}) => {
    actionFetcher.submit({ intent, contractShopifyId, ...extra }, { method: "post", action: "/app/subscriptions/quick-review" });
  };

  const saveChanges = () => {
    if (!data) return;
    const payload: Record<string, string> = { intent: "saveChanges", contractShopifyId, lineId: data.lineId ?? "" };
    if (nextDeliveryDate && nextDeliveryDate !== data.nextBillingDate?.slice(0, 10)) {
      payload.nextBillingDate = nextDeliveryDate;
    }
    if (frequencyKeyValue && frequencyKeyValue !== frequencyKey(data.billingInterval, data.billingIntervalCount)) {
      const option = FREQUENCY_OPTIONS.find((o) => frequencyKey(o.interval, o.intervalCount) === frequencyKeyValue);
      if (option) {
        payload.interval = option.interval;
        payload.intervalCount = String(option.intervalCount);
      }
    }
    if (quantity != null && quantity !== data.quantity) {
      payload.quantity = String(quantity);
    }
    actionFetcher.submit(payload, { method: "post", action: "/app/subscriptions/quick-review" });
  };

  return (
    <div className={styles.reviewOverlay}>
      <div className={styles.reviewCard} role="dialog" aria-modal="true">
        <div className={styles.reviewHeader}>
          <div>
            <span className={styles.reviewEyebrow}>Contract {data?.contractNumber ?? ""}</span>
            <h2 className={styles.reviewTitle}>{data?.customerName ?? "Loading..."}</h2>
          </div>
          <button type="button" className={styles.reviewClose} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {loadError && <div className={styles.emptyState}>{loadError}</div>}

        {data && (
          <>
            <div className={styles.reviewGrid2}>
              <div>
                <span className={styles.reviewEyebrow}>Product</span>
                <div className={styles.reviewFieldValue}>{data.productTitle}</div>
              </div>
              <div>
                <span className={styles.reviewEyebrow}>Status</span>
                <div>
                  <span className={styles.reviewStatusBadge}>⚠ {data.status.replace(/_/g, " ")}</span>
                </div>
              </div>
            </div>

            <div className={styles.reviewField}>
              <span className={styles.reviewEyebrow}>Next delivery date</span>
              <div className={styles.reviewDateWrap}>
                <input
                  type="date"
                  className={styles.reviewDateInput}
                  value={activeDate}
                  onChange={(e) => setNextDeliveryDate(e.target.value)}
                />
                <CalendarIcon className={styles.reviewCalendarIcon} />
              </div>
            </div>

            <div className={styles.reviewField}>
              <span className={styles.reviewEyebrow}>Frequency</span>
              <select
                className={styles.reviewSelect}
                value={activeFrequencyKey}
                onChange={(e) => {
                  const key = e.target.value;
                  setFrequencyKeyValue(key);
                  const option = FREQUENCY_OPTIONS.find((o) => frequencyKey(o.interval, o.intervalCount) === key);
                  if (option) setNextDeliveryDate(addIntervalToToday(option.interval, option.intervalCount));
                }}
              >
                {!FREQUENCY_OPTIONS.some((o) => frequencyKey(o.interval, o.intervalCount) === activeFrequencyKey) && (
                  <option value={activeFrequencyKey}>
                    Every {data.billingIntervalCount} {data.billingInterval.toLowerCase()}
                    {data.billingIntervalCount === 1 ? "" : "s"}
                  </option>
                )}
                {FREQUENCY_OPTIONS.map((o) => (
                  <option key={frequencyKey(o.interval, o.intervalCount)} value={frequencyKey(o.interval, o.intervalCount)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.reviewQuantityRow}>
              <div className={styles.reviewField}>
                <span className={styles.reviewEyebrow}>Quantity</span>
                <div className={styles.reviewQuantity}>
                  <button type="button" onClick={() => setQuantity(Math.max(1, activeQuantity - 1))}>
                    &minus;
                  </button>
                  <span>{activeQuantity}</span>
                  <button type="button" onClick={() => setQuantity(activeQuantity + 1)}>
                    +
                  </button>
                </div>
              </div>
              <div className={styles.reviewTotal}>
                <span className={styles.reviewTotalLabel}>Total:</span>
                <span className={styles.reviewTotalValue}>
                  {new Intl.NumberFormat("en-US", { style: "currency", currency: data.currencyCode ?? currencyCode }).format(
                    unitPrice * activeQuantity,
                  )}
                </span>
              </div>
            </div>

            <div className={styles.reviewPillRow}>
              <button
                type="button"
                className={styles.reviewPill}
                disabled={busy}
                onClick={() => runAction("applyDiscount")}
              >
                {busyIntent === "applyDiscount" ? "Applying..." : "Apply 25% discount"}
              </button>
              <button type="button" className={styles.reviewPill} disabled={busy} onClick={() => runAction("pause")}>
                {busyIntent === "pause" ? "Pausing..." : "Pause subscription"}
              </button>
              <button
                type="button"
                className={styles.reviewPill}
                disabled={busy || !data.hasPaymentMethod}
                title={data.hasPaymentMethod ? undefined : "No payment method on file"}
                onClick={() => runAction("resendPaymentLink")}
              >
                {busyIntent === "resendPaymentLink" ? "Sending..." : "Resend payment link"}
              </button>
            </div>

            {actionFetcher.data?.error && <div className={styles.emptyState}>{actionFetcher.data.error}</div>}
            {saved && <div className={styles.emptyState}>Changes saved.</div>}
            {actionFetcher.data?.intent === "pause" && actionFetcher.data.success && (
              <div className={styles.emptyState}>Subscription paused.</div>
            )}
            {actionFetcher.data?.intent === "resendPaymentLink" && actionFetcher.data.success && (
              <div className={styles.emptyState}>Payment link sent.</div>
            )}

            <hr className={styles.reviewDivider} />

            <div className={styles.reviewButtonsRow}>
              <button type="button" className={styles.reviewSaveButton} disabled={busy} onClick={saveChanges}>
                {busyIntent === "saveChanges" ? "Saving..." : "Save changes"}
              </button>
              <button type="button" className={styles.reviewCancelButton} onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

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
  const [reviewContractId, setReviewContractId] = useState<string | null>(null);
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
                  <Link
                    className={styles.barWrap}
                    to={`/app/subscriptions?status=ACTIVE&createdFrom=${encodeURIComponent(bucket.startDate)}&createdTo=${encodeURIComponent(bucket.endDate)}`}
                  >
                    <span className={styles.barTooltip}>{bucket.created}</span>
                    <div
                      className={styles.bar}
                      style={{
                        height: `${Math.max(4, (bucket.created / maxFlow) * 120)}px`,
                        backgroundColor: CHART_COLORS.created,
                      }}
                    />
                  </Link>
                  <Link
                    className={styles.barWrap}
                    to={`/app/subscriptions?status=CANCELLED&cancelledFrom=${encodeURIComponent(bucket.startDate)}&cancelledTo=${encodeURIComponent(bucket.endDate)}`}
                  >
                    <span className={styles.barTooltip}>{bucket.cancelled}</span>
                    <div
                      className={styles.bar}
                      style={{
                        height: `${Math.max(4, (bucket.cancelled / maxFlow) * 120)}px`,
                        backgroundColor: CHART_COLORS.cancelled,
                      }}
                    />
                  </Link>
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
                  <button
                    type="button"
                    className={styles.attentionReviewButton}
                    onClick={() => setReviewContractId(row.contractShopifyId)}
                  >
                    Review
                  </button>
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

      {reviewContractId && (
        <QuickReviewModal
          contractShopifyId={reviewContractId}
          currencyCode={currencyCode}
          onClose={() => setReviewContractId(null)}
        />
      )}
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
