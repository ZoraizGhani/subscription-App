import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";

import { requirePortalSession } from "../portal-auth.server";
import { getPortalCustomerById } from "../models/portalCustomer.server";
import { getPortalOverview } from "../models/portalSubscription.server";
import styles from "../styles/portal.module.css";

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatShortDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatMoney(amount: number | null, currency: string | null) {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
}

// Mirrors Shopify's own OrderDisplayFulfillmentStatus enum -- these are the
// exact values Order.displayFulfillmentStatus can return, so every case is
// covered rather than falling through to a generic label.
const FULFILLMENT_STATUS: Record<string, { label: string; className: keyof typeof styles }> = {
  FULFILLED: { label: "Fulfilled", className: "badgeActive" },
  PARTIALLY_FULFILLED: { label: "Partially fulfilled", className: "badgePaused" },
  IN_PROGRESS: { label: "In progress", className: "badgePaused" },
  ON_HOLD: { label: "On hold", className: "badgePaused" },
  PENDING_FULFILLMENT: { label: "Pending", className: "badgeNeutral" },
  SCHEDULED: { label: "Scheduled", className: "badgeNeutral" },
  OPEN: { label: "Open", className: "badgeNeutral" },
  UNFULFILLED: { label: "Unfulfilled", className: "badgeNeutral" },
  RESTOCKED: { label: "Restocked", className: "badgeCancelled" },
  REQUEST_DECLINED: { label: "Request declined", className: "badgeCancelled" },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);

  if (!customer?.customerShopifyId) {
    return { name: customer?.name ?? "", overview: null };
  }

  const overview = await getPortalOverview({
    shop: session.shop,
    customerShopifyId: customer.customerShopifyId,
  });

  return { name: customer.name, overview };
};

export default function AccountOverview() {
  const { name, overview } = useLoaderData<typeof loader>();
  const firstName = name.split(" ")[0] || name;

  return (
    <>
      <span className={styles.eyebrow}>Welcome back</span>
      <h1 className={styles.heading} style={{ fontSize: "3rem", lineHeight: 1, margin: "0.25rem 0 1.5rem" }}>
        {firstName}
      </h1>

      {!overview ? (
        <div className={styles.emptyState}>
          You don&apos;t have any subscriptions linked to this account yet.
        </div>
      ) : (
        <>
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Active subscriptions</span>
              <div className={styles.statValue}>{overview.activeCount}</div>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Next charge</span>
              <div className={styles.statValue}>{formatShortDate(overview.nextChargeDate)}</div>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>Lifetime orders</span>
              <div className={styles.statValue}>{overview.lifetimeOrders}</div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 1rem" }}>
            <h2 className={styles.heading} style={{ fontSize: "1.875rem", lineHeight: "2.25rem", margin: 0 }}>
              Active subscription
            </h2>
            <Link to="/account/subscriptions" className={styles.viewAllLink}>
              View all &rarr;
            </Link>
          </div>

          {overview.activeSubscription ? (
            <div className={styles.card} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <div className={styles.productThumb}>CLRTY</div>
                <div>
                  <div className={styles.productTitle}>{overview.activeSubscription.productTitle}</div>
                  <div className={styles.productMeta}>
                    Next delivery &bull; {formatDate(overview.activeSubscription.nextBillingDate)}
                  </div>
                </div>
              </div>
              <span className={styles.badgeDot}>Active</span>
            </div>
          ) : (
            <div className={styles.emptyState}>No active subscription right now.</div>
          )}

          <h2 className={styles.heading} style={{ fontSize: "1.875rem", lineHeight: "2.25rem", margin: "2rem 0 1rem" }}>
            Recent orders
          </h2>
          {overview.recentOrders.length === 0 ? (
            <div className={styles.emptyState}>No orders yet.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Date</th>
                  <th>Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {overview.recentOrders.map((order) => (
                  <tr key={order.orderShopifyId}>
                    <td>{order.orderName ?? order.orderShopifyId}</td>
                    <td>{formatDate(order.processedAt)}</td>
                    <td>{formatMoney(order.totalPrice, order.currencyCode)}</td>
                    <td>
                      {order.fulfillmentStatus && FULFILLMENT_STATUS[order.fulfillmentStatus] ? (
                        <span className={styles[FULFILLMENT_STATUS[order.fulfillmentStatus].className]}>
                          {FULFILLMENT_STATUS[order.fulfillmentStatus].label}
                        </span>
                      ) : (
                        <span className={styles.badgeNeutral}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
