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
  FULFILLED: { label: "Delivered", className: "orderHistoryBadgeDelivered" },
  PARTIALLY_FULFILLED: { label: "Partially fulfilled", className: "orderHistoryBadgePaused" },
  IN_PROGRESS: { label: "In progress", className: "orderHistoryBadgePaused" },
  ON_HOLD: { label: "On hold", className: "orderHistoryBadgePaused" },
  PENDING_FULFILLMENT: { label: "Pending", className: "orderHistoryBadge" },
  SCHEDULED: { label: "Scheduled", className: "orderHistoryBadge" },
  OPEN: { label: "Open", className: "orderHistoryBadge" },
  UNFULFILLED: { label: "Unfulfilled", className: "orderHistoryBadge" },
  RESTOCKED: { label: "Restocked", className: "orderHistoryBadgeCancelled" },
  REQUEST_DECLINED: { label: "Request declined", className: "orderHistoryBadgeCancelled" },
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
        <div className={styles.orderHistoryCard}>
          <table className={styles.orderHistoryTable}>
            <thead>
              <tr>
                <th>Order</th>
                <th>Date</th>
                <th>Items</th>
                <th className={styles.orderHistoryAmountCell}>Total</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderShopifyId}>
                  <td data-label="Order">{order.orderName ?? order.orderShopifyId}</td>
                  <td data-label="Date">{formatDate(order.processedAt)}</td>
                  <td data-label="Items">{order.productTitle ?? "Subscription"}</td>
                  <td data-label="Total" className={styles.orderHistoryAmountCell}>
                    <span className={styles.orderHistoryAmount}>
                      {formatMoney(order.totalPrice, order.currencyCode)}
                    </span>
                  </td>
                  <td data-label="Status">
                    <div className={styles.orderHistoryStatusCell}>
                      {order.fulfillmentStatus && FULFILLMENT_STATUS[order.fulfillmentStatus] ? (
                        <span className={styles[FULFILLMENT_STATUS[order.fulfillmentStatus].className]}>
                          {FULFILLMENT_STATUS[order.fulfillmentStatus].label}
                        </span>
                      ) : (
                        <span className={styles.orderHistoryBadge}>—</span>
                      )}
                      {order.receiptUrl && (
                        <a
                          className={styles.receiptLink}
                          href={order.receiptUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Receipt
                        </a>
                      )}
                    </div>
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
