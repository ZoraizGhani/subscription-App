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
  updatePortalNextBillingDate,
  updatePortalLineQuantity,
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
  quantity: number;
  productTitle: string;
  variants: {
    id: string;
    title: string;
    price: string;
    currencyCode: string;
    availableForSale: boolean;
    imageUrl: string | null;
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

    if (intent === "saveChanges") {
      const lineId = String(formData.get("lineId") ?? "");

      // Each of these opens and commits its own draft -- run sequentially,
      // not in parallel, so overlapping drafts on the same contract can't
      // race each other.
      if (formData.has("nextBillingDate")) {
        await updatePortalNextBillingDate({
          shop: session.shop,
          customerShopifyId: customer.customerShopifyId,
          contractShopifyId,
          nextBillingDate: String(formData.get("nextBillingDate")),
        });
      }

      if (formData.has("interval") && formData.has("intervalCount")) {
        await updatePortalDeliveryFrequency({
          shop: session.shop,
          customerShopifyId: customer.customerShopifyId,
          contractShopifyId,
          interval: String(formData.get("interval")),
          intervalCount: Number(formData.get("intervalCount")),
        });
      }

      if (formData.has("productVariantId")) {
        await swapPortalProductVariant({
          shop: session.shop,
          customerShopifyId: customer.customerShopifyId,
          contractShopifyId,
          lineId,
          productVariantId: String(formData.get("productVariantId")),
        });
      }

      if (formData.has("quantity")) {
        await updatePortalLineQuantity({
          shop: session.shop,
          customerShopifyId: customer.customerShopifyId,
          contractShopifyId,
          lineId,
          quantity: Number(formData.get("quantity")),
        });
      }

      if (formData.has("paymentMethodId")) {
        await updatePortalPaymentMethod({
          shop: session.shop,
          customerShopifyId: customer.customerShopifyId,
          contractShopifyId,
          paymentMethodId: String(formData.get("paymentMethodId")),
        });
      }

      if (formData.has("address1")) {
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
      }

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

const STATUS_PILL: Record<string, string> = {
  ACTIVE: styles.statusActive,
  PAUSED: styles.statusCancelled,
  CANCELLED: styles.statusCancelled,
  EXPIRED: styles.statusCancelled,
  FAILED: styles.statusFailed,
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

  const [nextDeliveryDate, setNextDeliveryDate] = useState<string | null>(null);
  const [interval, setInterval_] = useState<string | null>(null);
  const [intervalCount, setIntervalCount] = useState<number | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState<string | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const [address, setAddress] = useState<ShippingAddress | null>(null);

  if (optionsFetcher.state === "idle" && !optionsFetcher.data) {
    optionsFetcher.load(`/account/subscriptions/manage?contractId=${encodeURIComponent(sub.contractShopifyId)}`);
  }

  const options = optionsFetcher.data && "variants" in optionsFetcher.data ? optionsFetcher.data : null;
  const loadError = optionsFetcher.data && "error" in optionsFetcher.data ? optionsFetcher.data.error : null;

  const activeDate = nextDeliveryDate ?? (options?.nextBillingDate ? options.nextBillingDate.slice(0, 10) : "");
  const activeInterval = interval ?? options?.billingInterval ?? "DAY";
  const activeIntervalCount = intervalCount ?? options?.billingIntervalCount ?? 1;
  const activeVariantId = selectedVariantId ?? options?.currentVariantId ?? null;
  const activeQuantity = quantity ?? options?.quantity ?? 1;
  const activePaymentMethodId =
    selectedPaymentMethodId ?? options?.paymentMethods.find((p) => p.isCurrent)?.id ?? null;
  const currentAddress = address ?? options?.shippingAddress ?? null;
  const activeVariant = options?.variants.find((v) => v.id === activeVariantId) ?? null;
  const unitPrice = activeVariant ? Number(activeVariant.price) : 0;
  const currencyCode = activeVariant?.currencyCode ?? sub.currencyCode;

  const setAddressField = (field: keyof ShippingAddress, value: string) => {
    setAddress({ ...(currentAddress ?? blankAddress()), [field]: value });
  };

  const saving = saveFetcher.state !== "idle";

  const saveChanges = () => {
    if (!options) return;
    const payload: Record<string, string> = {
      intent: "saveChanges",
      contractShopifyId: sub.contractShopifyId,
      lineId: options.lineId,
    };

    if (nextDeliveryDate && nextDeliveryDate !== options.nextBillingDate?.slice(0, 10)) {
      payload.nextBillingDate = nextDeliveryDate;
    }
    if (
      (interval !== null && interval !== options.billingInterval) ||
      (intervalCount !== null && intervalCount !== options.billingIntervalCount)
    ) {
      payload.interval = activeInterval;
      payload.intervalCount = String(activeIntervalCount);
    }
    if (selectedVariantId && selectedVariantId !== options.currentVariantId) {
      payload.productVariantId = selectedVariantId;
    }
    if (quantity !== null && quantity !== options.quantity) {
      payload.quantity = String(quantity);
    }
    const currentPaymentId = options.paymentMethods.find((p) => p.isCurrent)?.id ?? null;
    if (selectedPaymentMethodId && selectedPaymentMethodId !== currentPaymentId) {
      payload.paymentMethodId = selectedPaymentMethodId;
    }
    if (address) {
      Object.assign(payload, address);
    }

    saveFetcher.submit(payload, { method: "post", action: "/account/subscriptions" });
  };

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.manageModalCard} role="dialog" aria-modal="true">
        <div className={styles.manageHeader}>
          <div>
            <h2 className={styles.manageTitle}>Manage subscription</h2>
            <span className={styles.manageSubtitle}>
              #{sub.contractShopifyId.split("/").pop()} &bull; {sub.productTitle}
            </span>
          </div>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {loadError && <div className={styles.error}>{loadError}</div>}
        {!options && !loadError && <div className={styles.emptyState}>Loading...</div>}

        {options && (
          <div className={styles.manageBody}>
            <div className={styles.manageField}>
              <span className={styles.manageFieldLabel}>Next delivery date</span>
              <input
                type="date"
                className={styles.manageDateInput}
                value={activeDate}
                onChange={(e) => setNextDeliveryDate(e.target.value)}
              />
            </div>

            <div className={styles.manageField}>
              <span className={styles.manageFieldLabel}>Delivery frequency</span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  className={styles.input}
                  style={{ width: "5rem" }}
                  type="number"
                  min={1}
                  value={activeIntervalCount}
                  onChange={(e) => setIntervalCount(Math.max(1, Number(e.target.value) || 1))}
                />
                <select
                  className={styles.manageSelect}
                  style={{ flex: 1 }}
                  value={activeInterval}
                  onChange={(e) => setInterval_(e.target.value)}
                >
                  {INTERVAL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className={styles.manageField}>
              <span className={styles.manageFieldLabel}>Payment method</span>
              {options.paymentMethods.length > 1 ? (
                <select
                  className={styles.manageSelect}
                  value={activePaymentMethodId ?? ""}
                  onChange={(e) => setSelectedPaymentMethodId(e.target.value)}
                >
                  {options.paymentMethods.map((pm) => (
                    <option key={pm.id} value={pm.id}>
                      {pm.display}
                    </option>
                  ))}
                </select>
              ) : (
                <div className={styles.manageStaticBox}>{options.paymentMethodDisplay ?? "—"}</div>
              )}
            </div>

            <div className={styles.manageField}>
              <span className={styles.manageFieldLabel}>Shipping address</span>
              <button
                type="button"
                className={styles.manageSelect}
                onClick={() => setAddressOpen((open) => !open)}
              >
                {currentAddress
                  ? [currentAddress.address1, currentAddress.city].filter(Boolean).join(" — ") || "—"
                  : "—"}
              </button>
              {addressOpen && currentAddress && (
                <div style={{ marginTop: "0.5rem" }}>
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
                </div>
              )}
            </div>

            {options.variants.length > 1 && (
              <div className={styles.manageField}>
                <span className={styles.manageFieldLabel}>1. Select flavor(s)</span>
                <div className={styles.manageSwatchGrid}>
                  {options.variants.map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      className={`${styles.manageSwatch} ${activeVariantId === variant.id ? styles["is-selected"] : ""}`}
                      disabled={!variant.availableForSale}
                      onClick={() => setSelectedVariantId(variant.id)}
                      style={{ opacity: variant.availableForSale ? 1 : 0.5 }}
                    >
                      <span className={styles.manageSwatchCheck} aria-hidden="true">
                        &check;
                      </span>
                      <span className={styles.manageSwatchImage}>
                        {variant.imageUrl && <img src={variant.imageUrl} alt={variant.title} />}
                      </span>
                      <span className={styles.manageSwatchName}>
                        {variant.title}
                        {!variant.availableForSale && " (out of stock)"}
                      </span>
                    </button>
                  ))}
                </div>
                <p className={styles.manageMixNote}>
                  Mix flavors freely &mdash; {activeQuantity} pouch{activeQuantity === 1 ? "" : "es"} selected, same
                  price per pouch either way.
                </p>
              </div>
            )}

            <div className={styles.manageQuantityRow}>
              <span className={styles.manageFieldLabel}>Quantity</span>
              <div className={styles.manageQuantity}>
                <button type="button" onClick={() => setQuantity(Math.max(1, activeQuantity - 1))} aria-label="Decrease quantity">
                  &minus;
                </button>
                <span>{activeQuantity}</span>
                <button type="button" onClick={() => setQuantity(activeQuantity + 1)} aria-label="Increase quantity">
                  +
                </button>
              </div>
            </div>

            <div className={styles.manageTotal}>
              Total: {formatMoney(unitPrice * activeQuantity, currencyCode)} &bull; {activeQuantity} pouch
              {activeQuantity === 1 ? "" : "es"} per delivery
            </div>

            {saveFetcher.data?.intent === "saveChanges" && "success" in saveFetcher.data && (
              <div className={styles.success}>Changes saved.</div>
            )}
            {saveFetcher.data && "error" in saveFetcher.data && saveFetcher.data.intent === "saveChanges" && (
              <div className={styles.error}>{saveFetcher.data.error}</div>
            )}

            <button type="button" className={styles.manageSaveButton} disabled={saving} onClick={saveChanges}>
              {saving ? "Saving..." : "Save changes"}
            </button>

            <button type="button" className={styles.manageSwapLink} disabled title="Coming soon">
              Swap product
            </button>
          </div>
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
        <div style={{ display: "flex", alignItems: "flex-start", gap: "1rem" }}>
          <div className={styles.productThumb}>
            {sub.productImageUrl ? (
              <img src={sub.productImageUrl} alt={sub.productTitle} className={styles.productThumbImg} />
            ) : (
              "CLRTY"
            )}
          </div>
          <div>
            <span className={styles.subContract}>Contract #{sub.contractShopifyId.split("/").pop()}</span>
            <div className={styles.subTitle}>
              {productUrl ? (
                <a href={productUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                  {sub.productTitle}
                </a>
              ) : (
                sub.productTitle
              )}
            </div>
            <span className={STATUS_PILL[sub.status] ?? styles.statusCancelled}>{sub.status}</span>
          </div>
        </div>
        <div>
          <span className={styles.subPriceLabel}>Unit price</span>
          <div className={styles.subPrice}>{formatMoney(sub.totalAmount, sub.currencyCode)}</div>
        </div>
      </div>

      {sub.status === "ACTIVE" && (
        <>
          <hr className={styles.subDivider} />

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
              <span className={styles.metaLabel}>Quantity</span>
              <div className={styles.metaValue}>{sub.quantity ?? "—"}</div>
              {sub.variantTitle && <span className={styles.metaSubtext}>{sub.variantTitle}</span>}
            </div>
            <div>
              <span className={styles.metaLabel}>Billing status</span>
              <div className={styles.metaValue}>Active</div>
            </div>
          </div>

          {(sub.shipToDisplay || sub.paymentMethodDisplay) && (
            <div className={styles.shipPayRow}>
              <span>Ship to &bull; {sub.shipToDisplay ?? "—"}</span>
              <span>Pay with &bull; {sub.paymentMethodDisplay ?? "—"}</span>
            </div>
          )}

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
          {fetcher.data &&
            "error" in fetcher.data &&
            (fetcher.data.intent === "skip" || fetcher.data.intent === "shipNow") && (
              <div className={styles.error}>{fetcher.data.error}</div>
            )}

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
                style={{ textDecoration: "none" }}
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
        </>
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
