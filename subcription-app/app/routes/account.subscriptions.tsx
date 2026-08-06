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
  updatePortalPaymentMethod,
  updatePortalShippingAddress,
  PortalOwnershipError,
} from "../models/portalSubscription.server";
import styles from "../styles/portal.module.css";

const INTERVAL_OPTIONS = [
  { value: "DAY", label: "Day(s)" },
  { value: "WEEK", label: "Week(s)" },
  { value: "MONTH", label: "Month(s)" },
  { value: "YEAR", label: "Year(s)" },
];

interface ShippingAddress {
  address1: string;
  address2: string;
  city: string;
  provinceCode: string;
  countryCode: string;
  zip: string;
  firstName: string;
  lastName: string;
  phone: string;
}

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
  nextBillingDate: string | null;
  paymentMethodDisplay: string | null;
  paymentMethods: { id: string; display: string; isCurrent: boolean }[];
  shippingAddressDisplay: string | null;
  shippingAddress: ShippingAddress | null;
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

function blankAddress(): ShippingAddress {
  return {
    address1: "",
    address2: "",
    city: "",
    provinceCode: "",
    countryCode: "",
    zip: "",
    firstName: "",
    lastName: "",
    phone: "",
  };
}

type Subscription = Awaited<ReturnType<typeof listPortalSubscriptions>>[number];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);

  if (!customer?.customerShopifyId) {
    return { subscriptions: [], shop: session.shop };
  }

  const subscriptions = await listPortalSubscriptions({
    shop: session.shop,
    customerShopifyId: customer.customerShopifyId,
  });

  return { subscriptions, shop: session.shop };
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

    if (intent === "updatePaymentMethod") {
      const paymentMethodId = String(formData.get("paymentMethodId") ?? "");
      await updatePortalPaymentMethod({
        shop: session.shop,
        customerShopifyId: customer.customerShopifyId,
        contractShopifyId,
        paymentMethodId,
      });
      return { intent, success: true };
    }

    if (intent === "updateShippingAddress") {
      await updatePortalShippingAddress({
        shop: session.shop,
        customerShopifyId: customer.customerShopifyId,
        contractShopifyId,
        address: {
          firstName: String(formData.get("firstName") ?? ""),
          lastName: String(formData.get("lastName") ?? ""),
          address1: String(formData.get("address1") ?? ""),
          address2: String(formData.get("address2") ?? ""),
          city: String(formData.get("city") ?? ""),
          provinceCode: String(formData.get("provinceCode") ?? ""),
          zip: String(formData.get("zip") ?? ""),
          countryCode: String(formData.get("countryCode") ?? ""),
          phone: String(formData.get("phone") ?? ""),
        },
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
  const frequencyFetcher = useFetcher<typeof action>();
  const variantFetcher = useFetcher<typeof action>();
  const paymentFetcher = useFetcher<typeof action>();
  const addressFetcher = useFetcher<typeof action>();

  const [interval, setInterval_] = useState(sub.billingInterval ?? "DAY");
  const [intervalCount, setIntervalCount] = useState(sub.billingIntervalCount ?? 1);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState<string | null>(null);
  const [address, setAddress] = useState<ShippingAddress | null>(null);

  if (optionsFetcher.state === "idle" && !optionsFetcher.data) {
    optionsFetcher.load(`/account/subscriptions/manage?contractId=${encodeURIComponent(sub.contractShopifyId)}`);
  }

  const options = optionsFetcher.data && "variants" in optionsFetcher.data ? optionsFetcher.data : null;
  const loadError = optionsFetcher.data && "error" in optionsFetcher.data ? optionsFetcher.data.error : null;
  const activeVariantId = selectedVariantId ?? options?.currentVariantId ?? null;
  const activePaymentMethodId =
    selectedPaymentMethodId ?? options?.paymentMethods.find((p) => p.isCurrent)?.id ?? null;
  const currentAddress = address ?? options?.shippingAddress ?? null;

  const setAddressField = (field: keyof ShippingAddress, value: string) => {
    setAddress({ ...(currentAddress ?? blankAddress()), [field]: value });
  };

  const saveFrequency = () => {
    frequencyFetcher.submit(
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
    variantFetcher.submit(
      {
        intent: "swapVariant",
        contractShopifyId: sub.contractShopifyId,
        lineId: options.lineId,
        productVariantId: selectedVariantId,
      },
      { method: "post", action: "/account/subscriptions" },
    );
  };

  const savePaymentMethod = () => {
    const currentId = options?.paymentMethods.find((p) => p.isCurrent)?.id ?? null;
    if (!selectedPaymentMethodId || selectedPaymentMethodId === currentId) return;
    paymentFetcher.submit(
      {
        intent: "updatePaymentMethod",
        contractShopifyId: sub.contractShopifyId,
        paymentMethodId: selectedPaymentMethodId,
      },
      { method: "post", action: "/account/subscriptions" },
    );
  };

  const saveAddress = () => {
    if (!currentAddress) return;
    addressFetcher.submit(
      { intent: "updateShippingAddress", contractShopifyId: sub.contractShopifyId, ...currentAddress },
      { method: "post", action: "/account/subscriptions" },
    );
  };

  const frequencyBusy = frequencyFetcher.state !== "idle";
  const variantBusy = variantFetcher.state !== "idle";
  const paymentBusy = paymentFetcher.state !== "idle";
  const addressBusy = addressFetcher.state !== "idle";

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
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Next delivery date</span>
              <div className={styles.metaValue}>{formatDate(options.nextBillingDate)}</div>
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Delivery frequency</span>
              {frequencyFetcher.data?.intent === "updateFrequency" && "success" in frequencyFetcher.data && (
                <div className={styles.success}>Delivery frequency updated.</div>
              )}
              {frequencyFetcher.data && "error" in frequencyFetcher.data && (
                <div className={styles.error}>{frequencyFetcher.data.error}</div>
              )}
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
                  disabled={frequencyBusy}
                  onClick={saveFrequency}
                >
                  {frequencyBusy ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            <hr className={styles.divider} style={{ margin: "1.25rem 0" }} />

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Payment method</span>
              {paymentFetcher.data?.intent === "updatePaymentMethod" && "success" in paymentFetcher.data && (
                <div className={styles.success}>Payment method updated.</div>
              )}
              {paymentFetcher.data && "error" in paymentFetcher.data && (
                <div className={styles.error}>{paymentFetcher.data.error}</div>
              )}
              {options.paymentMethods.length > 1 ? (
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <select
                    className={styles.input}
                    style={{ flex: 1 }}
                    value={activePaymentMethodId ?? ""}
                    onChange={(e) => setSelectedPaymentMethodId(e.target.value)}
                  >
                    {options.paymentMethods.map((pm) => (
                      <option key={pm.id} value={pm.id}>
                        {pm.display}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={styles.pillDark}
                    disabled={paymentBusy}
                    onClick={savePaymentMethod}
                  >
                    {paymentBusy ? "Saving..." : "Save"}
                  </button>
                </div>
              ) : (
                <>
                  <div className={styles.metaValue}>{options.paymentMethodDisplay ?? "—"}</div>
                  <p style={{ color: "#8a8478", fontSize: "0.8125rem", margin: "0.375rem 0 0" }}>
                    This is the only card on file — add another via checkout to enable switching here.
                  </p>
                </>
              )}
            </div>

            <hr className={styles.divider} style={{ margin: "1.25rem 0" }} />

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Shipping address</span>
              {addressFetcher.data?.intent === "updateShippingAddress" && "success" in addressFetcher.data && (
                <div className={styles.success}>Shipping address updated.</div>
              )}
              {addressFetcher.data && "error" in addressFetcher.data && (
                <div className={styles.error}>{addressFetcher.data.error}</div>
              )}
              {currentAddress ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                    <input
                      className={styles.input}
                      placeholder="First name"
                      value={currentAddress.firstName}
                      onChange={(e) => setAddressField("firstName", e.target.value)}
                    />
                    <input
                      className={styles.input}
                      placeholder="Last name"
                      value={currentAddress.lastName}
                      onChange={(e) => setAddressField("lastName", e.target.value)}
                    />
                  </div>
                  <input
                    className={styles.input}
                    style={{ marginTop: "0.5rem" }}
                    placeholder="Address"
                    value={currentAddress.address1}
                    onChange={(e) => setAddressField("address1", e.target.value)}
                  />
                  <input
                    className={styles.input}
                    style={{ marginTop: "0.5rem" }}
                    placeholder="Apartment, suite, etc. (optional)"
                    value={currentAddress.address2}
                    onChange={(e) => setAddressField("address2", e.target.value)}
                  />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", marginTop: "0.5rem" }}>
                    <input
                      className={styles.input}
                      placeholder="City"
                      value={currentAddress.city}
                      onChange={(e) => setAddressField("city", e.target.value)}
                    />
                    <input
                      className={styles.input}
                      placeholder="Province/state code"
                      value={currentAddress.provinceCode}
                      onChange={(e) => setAddressField("provinceCode", e.target.value)}
                    />
                    <input
                      className={styles.input}
                      placeholder="ZIP/postal code"
                      value={currentAddress.zip}
                      onChange={(e) => setAddressField("zip", e.target.value)}
                    />
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginTop: "0.5rem" }}>
                    <input
                      className={styles.input}
                      placeholder="Country code (e.g. US)"
                      value={currentAddress.countryCode}
                      onChange={(e) => setAddressField("countryCode", e.target.value.toUpperCase())}
                    />
                    <input
                      className={styles.input}
                      placeholder="Phone (optional)"
                      value={currentAddress.phone}
                      onChange={(e) => setAddressField("phone", e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className={styles.pillDark}
                    style={{ marginTop: "0.75rem" }}
                    disabled={addressBusy}
                    onClick={saveAddress}
                  >
                    {addressBusy ? "Saving..." : "Save address"}
                  </button>
                </>
              ) : (
                <div className={styles.metaValue}>—</div>
              )}
            </div>

            {options.variants.length > 1 && (
              <>
                <hr className={styles.divider} style={{ margin: "1.25rem 0" }} />
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Select flavor(s)</span>
                  {variantFetcher.data?.intent === "swapVariant" && "success" in variantFetcher.data && (
                    <div className={styles.success}>Option updated.</div>
                  )}
                  {variantFetcher.data && "error" in variantFetcher.data && (
                    <div className={styles.error}>{variantFetcher.data.error}</div>
                  )}
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
                    disabled={variantBusy || !selectedVariantId || selectedVariantId === options.currentVariantId}
                    onClick={saveVariant}
                  >
                    {variantBusy ? "Saving..." : "Save option"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SubscriptionCard({
  sub,
  shop,
  onCancel,
}: {
  sub: Subscription;
  shop: string;
  onCancel: (contractShopifyId: string) => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? fetcher.formData?.get("intent") : null;
  const [manageOpen, setManageOpen] = useState(false);
  const productUrl = sub.productHandle ? `https://${shop}/products/${sub.productHandle}` : null;

  const runAction = (intent: "skip" | "shipNow") => {
    fetcher.submit({ intent, contractShopifyId: sub.contractShopifyId }, { method: "post" });
  };

  return (
    <div className={styles.subCard}>
      <div className={styles.subHeader}>
        <div>
          <span className={styles.eyebrow}>Contract #{sub.contractShopifyId.split("/").pop()}</span>
          <div style={{ fontWeight: 700, fontSize: "1.125rem", marginTop: "0.25rem" }}>
            {productUrl ? (
              <a href={productUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                {sub.productTitle}
              </a>
            ) : (
              sub.productTitle
            )}
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
          {productUrl ? (
            <a
              href={productUrl}
              target="_blank"
              rel="noreferrer"
              className={styles.pillNeutral}
              style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}
            >
              + Add One-time Item
            </a>
          ) : (
            <button type="button" className={styles.pillNeutral} disabled title="Product page unavailable">
              + Add One-time Item
            </button>
          )}
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
    </div>
  );
}

export default function AccountSubscriptions() {
  const { subscriptions, shop } = useLoaderData<typeof loader>();
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
          <SubscriptionCard key={sub.contractShopifyId} sub={sub} shop={shop} onCancel={setCancelTarget} />
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
