import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { requirePortalSession } from "../portal-auth.server";
import { getPortalCustomerById } from "../models/portalCustomer.server";
import { listPortalOrders } from "../models/portalSubscription.server";
import styles from "../styles/portal.module.css";

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
    return { orders: [] };
  }

  const orders = await listPortalOrders({
    shop: session.shop,
    customerShopifyId: customer.customerShopifyId,
  });

  return { orders };
};

export default function AccountOrderHistory() {
  const { orders } = useLoaderData<typeof loader>();

  return (
    <>
      <span className={styles.eyebrow}>My account</span>
      <h1 className={styles.heading} style={{ fontSize: "2rem", margin: "0.25rem 0 1.5rem" }}>
        Order history
      </h1>

      {orders.length === 0 ? (
        <div className={styles.emptyState}>No orders yet.</div>
      ) : (
        <div className={styles.card} style={{ padding: 0 }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Date</th>
                <th>Items</th>
                <th>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderShopifyId}>
                  <td>{order.orderName ?? order.orderShopifyId}</td>
                  <td>{formatDate(order.processedAt)}</td>
                  <td>{order.productTitle ?? "Subscription"}</td>
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
        </div>
      )}
    </>
  );
}
