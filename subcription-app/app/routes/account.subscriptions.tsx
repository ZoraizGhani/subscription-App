import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { requirePortalSession } from "../portal-auth.server";
import { getPortalCustomerById } from "../models/portalCustomer.server";
import {
  listPortalSubscriptions,
  cancelPortalSubscription,
  PortalOwnershipError,
} from "../models/portalSubscription.server";
import styles from "../styles/portal.module.css";

const CANCEL_REASONS = [
  "Too expensive",
  "Too much product / behind on inventory",
  "Didn't see results",
  "Other",
];

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatMoney(amount: number | null, currency: string | null) {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
}

function formatInterval(interval: string | null, count: number | null) {
  if (!interval || !count) return "—";
  const unit = interval.toLowerCase();
  return `Every ${count} ${unit}${count === 1 ? "" : "s"}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);

  if (!customer?.customerShopifyId) {
    return { subscriptions: [] };
  }

  const subscriptions = await listPortalSubscriptions({
    shop: session.shop,
    customerShopifyId: customer.customerShopifyId,
  });

  return { subscriptions };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);
  if (!customer?.customerShopifyId) {
    return { error: "No linked subscription." };
  }

  const formData = await request.formData();
  const contractShopifyId = String(formData.get("contractShopifyId") ?? "");
  const reason = String(formData.get("reason") ?? "Not specified");

  try {
    await cancelPortalSubscription({
      shop: session.shop,
      customerShopifyId: customer.customerShopifyId,
      contractShopifyId,
      reason,
    });
    return { success: true };
  } catch (error) {
    if (error instanceof PortalOwnershipError) {
      return { error: error.message };
    }
    throw error;
  }
};

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: styles.badgeActive,
  PAUSED: styles.badgePaused,
  CANCELLED: styles.badgeCancelled,
  EXPIRED: styles.badgeNeutral,
  FAILED: styles.badgeCancelled,
};

export default function AccountSubscriptions() {
  const { subscriptions } = useLoaderData<typeof loader>();
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const fetcher = useFetcher<typeof action>();

  const closeModal = () => {
    setCancelTarget(null);
    setReason(null);
  };

  const confirmCancel = () => {
    if (!cancelTarget || !reason) return;
    fetcher.submit(
      { contractShopifyId: cancelTarget, reason },
      { method: "post" },
    );
  };

  if (fetcher.state === "idle" && fetcher.data && "success" in fetcher.data && cancelTarget) {
    closeModal();
  }

  return (
    <>
      <span className={styles.eyebrow}>My account</span>
      <h1 className={styles.heading} style={{ fontSize: "2rem", margin: "0.25rem 0 1.5rem" }}>
        Subscriptions
      </h1>

      {subscriptions.length === 0 ? (
        <div className={styles.emptyState}>You don&apos;t have any subscriptions yet.</div>
      ) : (
        subscriptions.map((sub) => (
          <div key={sub.contractShopifyId} className={styles.subCard}>
            <div className={styles.subHeader}>
              <div>
                <span className={styles.eyebrow}>
                  Contract #{sub.contractShopifyId.split("/").pop()}
                </span>
                <div style={{ fontWeight: 700, fontSize: "1.125rem", marginTop: "0.25rem" }}>
                  {sub.productTitle}
                </div>
                <span className={STATUS_BADGE[sub.status] ?? styles.badgeNeutral} style={{ marginTop: "0.5rem", display: "inline-flex" }}>
                  {sub.status}
                </span>
              </div>
              <div className={styles.subPrice}>{formatMoney(sub.totalAmount, sub.currencyCode)}</div>
            </div>

            <div className={styles.metaGrid}>
              <div>
                <span className={styles.metaLabel}>Next shipment</span>
                <div className={styles.metaValue}>{formatDate(sub.nextBillingDate)}</div>
              </div>
              <div>
                <span className={styles.metaLabel}>Delivery interval</span>
                <div className={styles.metaValue}>
                  {formatInterval(sub.billingInterval, sub.billingIntervalCount)}
                </div>
              </div>
              <div>
                <span className={styles.metaLabel}>Billing status</span>
                <div className={styles.metaValue}>{sub.status === "ACTIVE" ? "Active" : sub.status}</div>
              </div>
            </div>

            {sub.status === "ACTIVE" && (
              <div className={styles.actionsRow}>
                <button type="button" className={styles.pillNeutral} disabled title="Coming soon">
                  Skip Next Order
                </button>
                <button type="button" className={styles.pillNeutral} disabled title="Coming soon">
                  Ship Now
                </button>
                <button type="button" className={styles.pillDark} disabled title="Coming soon">
                  Manage Subscription
                </button>
                <button type="button" className={styles.pillNeutral} disabled title="Coming soon">
                  + Add One-time Item
                </button>
                <button
                  type="button"
                  className={styles.cancelLink}
                  onClick={() => setCancelTarget(sub.contractShopifyId)}
                >
                  Cancel subscription
                </button>
              </div>
            )}
          </div>
        ))
      )}

      {cancelTarget && (
        <div className={styles.modalOverlay}>
          <div className={styles.modalCard} role="dialog" aria-modal="true">
            <div className={styles.modalHeader}>
              <span className={styles.eyebrow}>Cancel subscription</span>
              <button type="button" className={styles.modalClose} onClick={closeModal} aria-label="Close">
                &times;
              </button>
            </div>

            {!reason ? (
              <>
                <h2 className={styles.heading} style={{ fontSize: "1.5rem", margin: "0.5rem 0 0" }}>
                  Before you go — why are you cancelling?
                </h2>
                <div className={styles.reasonList}>
                  {CANCEL_REASONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={styles.reasonOption}
                      onClick={() => setReason(option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2 className={styles.heading} style={{ fontSize: "1.5rem", margin: "0.5rem 0 0" }}>
                  Confirm cancellation
                </h2>
                <p style={{ color: "#6b6558", fontSize: "0.9375rem" }}>
                  Reason: <strong>{reason}</strong>. This ends the subscription immediately and
                  can&apos;t be undone.
                </p>
                {fetcher.data && "error" in fetcher.data && (
                  <div className={styles.error}>{fetcher.data.error}</div>
                )}
                <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
                  <button type="button" className={styles.pillNeutral} onClick={() => setReason(null)}>
                    Back
                  </button>
                  <button
                    type="button"
                    className={styles.buttonDangerFull}
                    style={{ flex: 1 }}
                    disabled={fetcher.state !== "idle"}
                    onClick={confirmCancel}
                  >
                    {fetcher.state !== "idle" ? "Cancelling..." : "Cancel subscription"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
