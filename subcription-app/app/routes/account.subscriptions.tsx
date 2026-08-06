import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { requirePortalSession } from "../portal-auth.server";
import { getPortalCustomerById } from "../models/portalCustomer.server";
import {
  listPortalSubscriptions,
  cancelPortalSubscription,
  skipPortalNextOrder,
  shipPortalOrderNow,
  updatePortalDeliveryFrequency,
  swapPortalProductVariant,
  addPortalOneTimeItem,
  PortalOwnershipError,
} from "../models/portalSubscription.server";
import styles from "../styles/portal.module.css";

const INTERVAL_OPTIONS = [
  { value: "DAY", label: "Day(s)" },
  { value: "WEEK", label: "Week(s)" },
  { value: "MONTH", label: "Month(s)" },
  { value: "YEAR", label: "Year(s)" },
];

interface ManageOptions {
  lineId: string;
  currentVariantId: string | null;
  productTitle: string;
  variants: {
    id: string;
    title: string;
    price: string;
    currencyCode: string;
    availableForSale: boolean;
  }[];
  billingInterval: string;
  billingIntervalCount: number;
}

interface ProductSearchResult {
  productId: string;
  title: string;
  imageUrl: string | null;
  variantId: string;
  price: string;
  currencyCode: string;
  availableForSale: boolean;
}

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

type Subscription = Awaited<ReturnType<typeof listPortalSubscriptions>>[number];

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
  const intent = String(formData.get("intent") ?? "cancel");
  const contractShopifyId = String(formData.get("contractShopifyId") ?? "");

  try {
    if (intent === "skip") {
      const result = await skipPortalNextOrder({
        shop: session.shop,
        customerShopifyId: customer.customerShopifyId,
        contractShopifyId,
      });
      return { intent, success: true, nextBillingDate: result.nextBillingDate };
    }

    if (intent === "shipNow") {
      const result = await shipPortalOrderNow({
        shop: session.shop,
        customerShopifyId: customer.customerShopifyId,
        contractShopifyId,
      });
      return { intent, success: true, orderName: result.orderName };
    }

    if (intent === "updateFrequency") {
      const interval = String(formData.get("interval") ?? "");
      const intervalCount = Number(formData.get("intervalCount") ?? 0);
      await updatePortalDeliveryFrequency({
        shop: session.shop,
        customerShopifyId: customer.customerShopifyId,
        contractShopifyId,
        interval,
        intervalCount,
      });
      return { intent, success: true };
    }

    if (intent === "swapVariant") {
      const lineId = String(formData.get("lineId") ?? "");
      const productVariantId = String(formData.get("productVariantId") ?? "");
      await swapPortalProductVariant({
        shop: session.shop,
        customerShopifyId: customer.customerShopifyId,
        contractShopifyId,
        lineId,
        productVariantId,
      });
      return { intent, success: true };
    }

    if (intent === "addOneTimeItem") {
      const productVariantId = String(formData.get("productVariantId") ?? "");
      const quantity = Number(formData.get("quantity") ?? 1);
      await addPortalOneTimeItem({
        shop: session.shop,
        customerShopifyId: customer.customerShopifyId,
        contractShopifyId,
        productVariantId,
        quantity,
      });
      return { intent, success: true };
    }

    const reason = String(formData.get("reason") ?? "Not specified");
    await cancelPortalSubscription({
      shop: session.shop,
      customerShopifyId: customer.customerShopifyId,
      contractShopifyId,
      reason,
    });
    return { intent: "cancel", success: true };
  } catch (error) {
    if (error instanceof PortalOwnershipError) {
      return { intent, error: error.message };
    }
    return { intent, error: error instanceof Error ? error.message : "Something went wrong." };
  }
};

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: styles.badgeActive,
  PAUSED: styles.badgePaused,
  CANCELLED: styles.badgeCancelled,
  EXPIRED: styles.badgeNeutral,
  FAILED: styles.badgeCancelled,
};

function ManageSubscriptionModal({
  sub,
  onClose,
}: {
  sub: Subscription;
  onClose: () => void;
}) {
  const optionsFetcher = useFetcher<ManageOptions | { error: string }>();
  const saveFetcher = useFetcher<typeof action>();
  const [interval, setInterval_] = useState(sub.billingInterval ?? "DAY");
  const [intervalCount, setIntervalCount] = useState(sub.billingIntervalCount ?? 1);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);

  if (optionsFetcher.state === "idle" && !optionsFetcher.data) {
    optionsFetcher.load(`/account/subscriptions/manage?contractId=${encodeURIComponent(sub.contractShopifyId)}`);
  }

  const options = optionsFetcher.data && "variants" in optionsFetcher.data ? optionsFetcher.data : null;
  const loadError = optionsFetcher.data && "error" in optionsFetcher.data ? optionsFetcher.data.error : null;
  const activeVariantId = selectedVariantId ?? options?.currentVariantId ?? null;

  const saveFrequency = () => {
    saveFetcher.submit(
      {
        intent: "updateFrequency",
        contractShopifyId: sub.contractShopifyId,
        interval,
        intervalCount: String(intervalCount),
      },
      { method: "post", action: "/account/subscriptions" },
    );
  };

  const saveVariant = () => {
    if (!options || !selectedVariantId || selectedVariantId === options.currentVariantId) return;
    saveFetcher.submit(
      {
        intent: "swapVariant",
        contractShopifyId: sub.contractShopifyId,
        lineId: options.lineId,
        productVariantId: selectedVariantId,
      },
      { method: "post", action: "/account/subscriptions" },
    );
  };

  const busy = saveFetcher.state !== "idle";
  const savedIntent =
    saveFetcher.state === "idle" && saveFetcher.data && "success" in saveFetcher.data
      ? saveFetcher.data.intent
      : null;

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalCard} role="dialog" aria-modal="true">
        <div className={styles.modalHeader}>
          <span className={styles.eyebrow}>Manage subscription</span>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <h2 className={styles.heading} style={{ fontSize: "1.5rem", margin: "0.5rem 0 1.25rem" }}>
          {sub.productTitle}
        </h2>

        {loadError && <div className={styles.error}>{loadError}</div>}
        {!options && !loadError && <div className={styles.emptyState}>Loading...</div>}

        {options && (
          <>
            {savedIntent === "updateFrequency" && (
              <div className={styles.success}>Delivery frequency updated.</div>
            )}
            {savedIntent === "swapVariant" && <div className={styles.success}>Option updated.</div>}
            {saveFetcher.data && "error" in saveFetcher.data && (
              <div className={styles.error}>{saveFetcher.data.error}</div>
            )}

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Delivery frequency</span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  className={styles.input}
                  style={{ width: "5rem" }}
                  type="number"
                  min={1}
                  value={intervalCount}
                  onChange={(e) => setIntervalCount(Math.max(1, Number(e.target.value) || 1))}
                />
                <select
                  className={styles.input}
                  value={interval}
                  onChange={(e) => setInterval_(e.target.value)}
                >
                  {INTERVAL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.pillDark}
                  disabled={busy}
                  onClick={saveFrequency}
                >
                  Save
                </button>
              </div>
            </div>

            {options.variants.length > 1 && (
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Select option</span>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {options.variants.map((variant) => (
                    <label
                      key={variant.id}
                      className={styles.reasonOption}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        opacity: variant.availableForSale ? 1 : 0.5,
                      }}
                    >
                      <span>
                        <input
                          type="radio"
                          name="variant"
                          value={variant.id}
                          checked={activeVariantId === variant.id}
                          disabled={!variant.availableForSale}
                          onChange={() => setSelectedVariantId(variant.id)}
                          style={{ marginRight: "0.5rem" }}
                        />
                        {variant.title}
                        {!variant.availableForSale && " (out of stock)"}
                      </span>
                      <span>{formatMoney(Number(variant.price), variant.currencyCode)}</span>
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  className={styles.pillDark}
                  style={{ marginTop: "0.75rem" }}
                  disabled={busy || !selectedVariantId || selectedVariantId === options.currentVariantId}
                  onClick={saveVariant}
                >
                  {busy && saveFetcher.formData?.get("intent") === "swapVariant"
                    ? "Saving..."
                    : "Save option"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AddOneTimeItemModal({
  sub,
  onClose,
}: {
  sub: Subscription;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const productsFetcher = useFetcher<{ products: ProductSearchResult[] } | { error: string }>();
  const saveFetcher = useFetcher<typeof action>();

  if (productsFetcher.state === "idle" && !productsFetcher.data) {
    productsFetcher.load(
      `/account/subscriptions/products?contractId=${encodeURIComponent(sub.contractShopifyId)}&query=`,
    );
  }

  const runSearch = (value: string) => {
    setQuery(value);
    productsFetcher.load(
      `/account/subscriptions/products?contractId=${encodeURIComponent(sub.contractShopifyId)}&query=${encodeURIComponent(value)}`,
    );
  };

  const products = productsFetcher.data && "products" in productsFetcher.data ? productsFetcher.data.products : [];
  const loadError = productsFetcher.data && "error" in productsFetcher.data ? productsFetcher.data.error : null;
  const selected = products.find((p) => p.variantId === selectedVariantId) ?? null;
  const busy = saveFetcher.state !== "idle";
  const added = saveFetcher.state === "idle" && saveFetcher.data && "success" in saveFetcher.data;

  const submit = () => {
    if (!selectedVariantId) return;
    saveFetcher.submit(
      {
        intent: "addOneTimeItem",
        contractShopifyId: sub.contractShopifyId,
        productVariantId: selectedVariantId,
        quantity: String(quantity),
      },
      { method: "post", action: "/account/subscriptions" },
    );
  };

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalCard} role="dialog" aria-modal="true">
        <div className={styles.modalHeader}>
          <span className={styles.eyebrow}>Add to next order</span>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <h2 className={styles.heading} style={{ fontSize: "1.5rem", margin: "0.5rem 0 0.5rem" }}>
          Add one-time item
        </h2>
        <p style={{ color: "#6b6558", fontSize: "0.875rem", margin: "0 0 1.25rem" }}>
          Ships with your next order for {sub.productTitle} — no extra shipping fee.
        </p>

        {added && <div className={styles.success}>Added — it&apos;ll ship with your next order.</div>}
        {saveFetcher.data && "error" in saveFetcher.data && (
          <div className={styles.error}>{saveFetcher.data.error}</div>
        )}
        {loadError && <div className={styles.error}>{loadError}</div>}

        {!added && (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Search products</span>
              <input
                className={styles.input}
                type="text"
                value={query}
                onChange={(e) => runSearch(e.target.value)}
                placeholder="Search by product name"
              />
            </label>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
              {products.length === 0 && productsFetcher.state === "idle" && !loadError && (
                <div className={styles.emptyState}>No products found.</div>
              )}
              {products.map((product) => (
                <label
                  key={product.variantId}
                  className={styles.reasonOption}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    opacity: product.availableForSale ? 1 : 0.5,
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <input
                      type="radio"
                      name="product"
                      value={product.variantId}
                      checked={selectedVariantId === product.variantId}
                      disabled={!product.availableForSale}
                      onChange={() => setSelectedVariantId(product.variantId)}
                    />
                    {product.imageUrl && (
                      <img
                        src={product.imageUrl}
                        alt=""
                        style={{ width: "2.5rem", height: "2.5rem", objectFit: "cover", borderRadius: "0.375rem" }}
                      />
                    )}
                    <span>
                      {product.title}
                      {!product.availableForSale && " (out of stock)"}
                    </span>
                  </span>
                  <span>{formatMoney(Number(product.price), product.currencyCode)}</span>
                </label>
              ))}
            </div>

            {selected && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "1rem" }}>
                <span className={styles.fieldLabel}>Quantity</span>
                <input
                  className={styles.input}
                  style={{ width: "5rem" }}
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            )}

            <button
              type="button"
              className={styles.pillDark}
              style={{ marginTop: "1.25rem", width: "100%" }}
              disabled={!selectedVariantId || busy}
              onClick={submit}
            >
              {busy ? "Adding..." : "Add to next shipment"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SubscriptionCard({
  sub,
  onCancel,
}: {
  sub: Subscription;
  onCancel: (contractShopifyId: string) => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? fetcher.formData?.get("intent") : null;
  const [manageOpen, setManageOpen] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);

  const runAction = (intent: "skip" | "shipNow") => {
    fetcher.submit({ intent, contractShopifyId: sub.contractShopifyId }, { method: "post" });
  };

  return (
    <div className={styles.subCard}>
      <div className={styles.subHeader}>
        <div>
          <span className={styles.eyebrow}>Contract #{sub.contractShopifyId.split("/").pop()}</span>
          <div style={{ fontWeight: 700, fontSize: "1.125rem", marginTop: "0.25rem" }}>
            {sub.productTitle}
          </div>
          <span
            className={STATUS_BADGE[sub.status] ?? styles.badgeNeutral}
            style={{ marginTop: "0.5rem", display: "inline-flex" }}
          >
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

      {fetcher.data?.intent === "skip" && "success" in fetcher.data && (
        <div className={styles.success}>Next order skipped. New next shipment date above.</div>
      )}
      {fetcher.data?.intent === "shipNow" && "success" in fetcher.data && (
        <div className={styles.success}>
          {fetcher.data.orderName
            ? `Order ${fetcher.data.orderName} placed.`
            : "Charge submitted — check Order History shortly."}
        </div>
      )}
      {fetcher.data && "error" in fetcher.data && (fetcher.data.intent === "skip" || fetcher.data.intent === "shipNow") && (
        <div className={styles.error}>{fetcher.data.error}</div>
      )}

      {sub.status === "ACTIVE" && (
        <div className={styles.actionsRow}>
          <button
            type="button"
            className={styles.pillNeutral}
            disabled={busy}
            onClick={() => runAction("skip")}
          >
            {busyIntent === "skip" ? "Skipping..." : "Skip Next Order"}
          </button>
          <button
            type="button"
            className={styles.pillNeutral}
            disabled={busy}
            onClick={() => runAction("shipNow")}
          >
            {busyIntent === "shipNow" ? "Charging..." : "Ship Now"}
          </button>
          <button type="button" className={styles.pillDark} onClick={() => setManageOpen(true)}>
            Manage Subscription
          </button>
          <button type="button" className={styles.pillNeutral} onClick={() => setAddItemOpen(true)}>
            + Add One-time Item
          </button>
          <button
            type="button"
            className={styles.cancelLink}
            onClick={() => onCancel(sub.contractShopifyId)}
          >
            Cancel subscription
          </button>
        </div>
      )}

      {manageOpen && <ManageSubscriptionModal sub={sub} onClose={() => setManageOpen(false)} />}
      {addItemOpen && <AddOneTimeItemModal sub={sub} onClose={() => setAddItemOpen(false)} />}
    </div>
  );
}

export default function AccountSubscriptions() {
  const { subscriptions } = useLoaderData<typeof loader>();
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const cancelFetcher = useFetcher<typeof action>();

  const closeModal = () => {
    setCancelTarget(null);
    setReason(null);
  };

  const confirmCancel = () => {
    if (!cancelTarget || !reason) return;
    cancelFetcher.submit(
      { intent: "cancel", contractShopifyId: cancelTarget, reason },
      { method: "post" },
    );
  };

  if (cancelFetcher.state === "idle" && cancelFetcher.data && "success" in cancelFetcher.data && cancelTarget) {
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
          <SubscriptionCard key={sub.contractShopifyId} sub={sub} onCancel={setCancelTarget} />
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
                {cancelFetcher.data && "error" in cancelFetcher.data && (
                  <div className={styles.error}>{cancelFetcher.data.error}</div>
                )}
                <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
                  <button type="button" className={styles.pillNeutral} onClick={() => setReason(null)}>
                    Back
                  </button>
                  <button
                    type="button"
                    className={styles.buttonDangerFull}
                    style={{ flex: 1 }}
                    disabled={cancelFetcher.state !== "idle"}
                    onClick={confirmCancel}
                  >
                    {cancelFetcher.state !== "idle" ? "Cancelling..." : "Cancel subscription"}
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
