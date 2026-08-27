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
  updatePortalFlavorMix,
  swapPortalProductVariant,
  updatePortalPaymentMethod,
  updatePortalShippingAddress,
  updatePortalOneTimeAddons,
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
  productId: string | null;
  currentVariantId: string | null;
  quantity: number;
  // Per-flavor breakdown behind `quantity` -- more than one entry means the
  // subscription already has a saved flavor mix (multiple lines for the same
  // product), not just one flavor at that quantity.
  lines: { id: string; variantId: string | null; quantity: number }[];
  sellingPlanId: string | null;
  sellingPlanName: string | null;
  // Cap on the flavor mix's total, from the selling plan's own "Quantity"
  // option -- null for a legacy plan saved before that option existed
  // (no cap).
  maxQuantity: number | null;
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

interface SwappableProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  variants: { id: string; title: string; availableForSale: boolean; price: string }[];
}

interface OneTimeAddonOptions {
  nextBillingDate: string;
  currencyCode: string;
  products: { productId: string; variantId: string; title: string; imageUrl: string | null; price: string }[];
  existingAddons: { lineId: string; variantId: string | null; title: string; imageUrl: string | null; price: string }[];
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

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function todayIsoDate() {
  return toIsoDate(new Date());
}

/** Adds `count` units of `interval` to today's date, for previewing where a
 * frequency change would land the next delivery. */
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
  return toIsoDate(result);
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

      // A flavor mix replaces the single-line quantity update entirely --
      // it's the general case (one flavor is just a mix with one entry), so
      // when it's present, skip the old single-quantity path rather than
      // doing both.
      if (formData.has("flavorMix")) {
        const quantities = JSON.parse(String(formData.get("flavorMix"))) as Record<string, number>;
        await updatePortalFlavorMix({
          shop: session.shop,
          customerShopifyId: customer.customerShopifyId,
          contractShopifyId,
          quantities,
        });
      } else if (formData.has("quantity")) {
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

    if (intent === "updateOneTimeAddons") {
      const addVariantIds = formData.getAll("addVariantId").map(String);
      const removeLineIds = formData.getAll("removeLineId").map(String);
      await updatePortalOneTimeAddons({
        shop: session.shop,
        customerShopifyId: customer.customerShopifyId,
        contractShopifyId,
        addVariantIds,
        removeLineIds,
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
  const swapFetcher = useFetcher<{ products: SwappableProduct[] } | { error: string }>();

  const [nextDeliveryDate, setNextDeliveryDate] = useState<string | null>(null);
  const [interval, setInterval_] = useState<string | null>(null);
  const [intervalCount, setIntervalCount] = useState<number | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  // variantId -> quantity, for the current (non-swap) product's flavor mix.
  // null means "not yet touched" -- derived from options.lines instead.
  const [flavorQuantities, setFlavorQuantities] = useState<Record<string, number> | null>(null);
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState<string | null>(null);
  const [addressOpen, setAddressOpen] = useState(false);
  const [address, setAddress] = useState<ShippingAddress | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapProduct, setSwapProduct] = useState<SwappableProduct | null>(null);

  if (optionsFetcher.state === "idle" && !optionsFetcher.data) {
    optionsFetcher.load(`/account/subscriptions/manage?contractId=${encodeURIComponent(sub.contractShopifyId)}`);
  }

  const options = optionsFetcher.data && "variants" in optionsFetcher.data ? optionsFetcher.data : null;
  const loadError = optionsFetcher.data && "error" in optionsFetcher.data ? optionsFetcher.data.error : null;

  if (swapOpen && swapFetcher.state === "idle" && !swapFetcher.data && options) {
    swapFetcher.load(
      `/account/subscriptions/swap-products?contractId=${encodeURIComponent(sub.contractShopifyId)}`,
    );
  }
  const swapProducts = swapFetcher.data && "products" in swapFetcher.data ? swapFetcher.data.products : [];
  const swapLoadError = swapFetcher.data && "error" in swapFetcher.data ? swapFetcher.data.error : null;

  const activeDate = nextDeliveryDate ?? (options?.nextBillingDate ? options.nextBillingDate.slice(0, 10) : "");
  const activeInterval = interval ?? options?.billingInterval ?? "DAY";
  const activeIntervalCount = intervalCount ?? options?.billingIntervalCount ?? 1;
  const activeVariantId = selectedVariantId ?? options?.currentVariantId ?? null;
  const activePaymentMethodId =
    selectedPaymentMethodId ?? options?.paymentMethods.find((p) => p.isCurrent)?.id ?? null;
  const currentAddress = address ?? options?.shippingAddress ?? null;
  const displayVariants = swapProduct
    ? swapProduct.variants.map((v) => ({ ...v, imageUrl: swapProduct.imageUrl, currencyCode: null as string | null }))
    : (options?.variants ?? []);
  const activeVariant = displayVariants.find((v) => v.id === activeVariantId) ?? null;
  const unitPrice = activeVariant ? Number(activeVariant.price) : 0;
  const currencyCode = activeVariant?.currencyCode ?? sub.currencyCode;

  // The flavor mix for the CURRENT product only -- swapping to a different
  // product still picks a single target variant (activeVariantId above), not
  // a mix, since the target isn't even on the contract until the swap saves.
  const initialFlavorQuantities = (): Record<string, number> => {
    const map: Record<string, number> = {};
    for (const line of options?.lines ?? []) {
      if (line.variantId) map[line.variantId] = (map[line.variantId] ?? 0) + line.quantity;
    }
    return map;
  };
  const activeFlavorQuantities = flavorQuantities ?? initialFlavorQuantities();
  const flavorTotal = Object.values(activeFlavorQuantities).reduce((sum, qty) => sum + qty, 0);
  const mixTotalPrice = Object.entries(activeFlavorQuantities).reduce((sum, [variantId, qty]) => {
    const variant = (options?.variants ?? []).find((v) => v.id === variantId);
    return sum + (variant ? Number(variant.price) * qty : 0);
  }, 0);
  const activeQuantity = swapProduct ? (quantity ?? options?.quantity ?? 1) : flavorTotal;

  const setFlavorQty = (variantId: string, qty: number) => {
    const next = { ...activeFlavorQuantities };
    if (qty <= 0) {
      delete next[variantId];
    } else {
      next[variantId] = qty;
    }
    setFlavorQuantities(next);
  };
  // The selling plan's own "Quantity" caps the mix's total -- a legacy plan
  // with no cap (maxQuantity null) can grow without limit, same as before.
  const atMaxQuantity = options?.maxQuantity != null && flavorTotal >= options.maxQuantity;
  const incrementFlavor = (variantId: string) => {
    if (atMaxQuantity) return;
    setFlavorQty(variantId, (activeFlavorQuantities[variantId] ?? 0) + 1);
  };
  const decrementFlavor = (variantId: string) =>
    setFlavorQty(variantId, Math.max(0, (activeFlavorQuantities[variantId] ?? 0) - 1));

  const selectSwapProduct = (product: SwappableProduct) => {
    setSwapProduct(product);
    const firstAvailable = product.variants.find((v) => v.availableForSale) ?? product.variants[0];
    setSelectedVariantId(firstAvailable?.id ?? null);
    setSwapOpen(false);
  };

  // Can't schedule a delivery earlier than today, and if today's cycle has
  // already been billed (options.nextBillingDate -- the corrected true next
  // *unbilled* cycle -- has moved past today), today is spoken for too.
  const minSelectableDate = options?.nextBillingDate
    ? [todayIsoDate(), options.nextBillingDate.slice(0, 10)].sort().pop()!
    : todayIsoDate();

  const setAddressField = (field: keyof ShippingAddress, value: string) => {
    setAddress({ ...(currentAddress ?? blankAddress()), [field]: value });
  };

  const applyFrequency = (newInterval: string, newIntervalCount: number) => {
    setInterval_(newInterval);
    setIntervalCount(newIntervalCount);
    const projected = addIntervalToToday(newInterval, newIntervalCount);
    setNextDeliveryDate(projected < minSelectableDate ? minSelectableDate : projected);
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
    if (swapProduct) {
      if (selectedVariantId && selectedVariantId !== options.currentVariantId) {
        payload.productVariantId = selectedVariantId;
      }
      if (quantity !== null && quantity !== options.quantity) {
        payload.quantity = String(quantity);
      }
    } else if (flavorQuantities) {
      const original = initialFlavorQuantities();
      const originalKeys = Object.keys(original);
      const nextKeys = Object.keys(flavorQuantities);
      const changed =
        originalKeys.length !== nextKeys.length || nextKeys.some((id) => original[id] !== flavorQuantities[id]);
      if (changed) {
        payload.flavorMix = JSON.stringify(flavorQuantities);
      }
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
              <div className={styles.manageDateWrap}>
                <input
                  type="date"
                  className={styles.manageDateInput}
                  value={activeDate}
                  min={minSelectableDate}
                  onChange={(e) =>
                    setNextDeliveryDate(e.target.value < minSelectableDate ? minSelectableDate : e.target.value)
                  }
                />
                <svg
                  className={styles.manageDateIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                  <line x1="8" y1="3" x2="8" y2="7" />
                  <line x1="16" y1="3" x2="16" y2="7" />
                </svg>
              </div>
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
                  onChange={(e) => applyFrequency(activeInterval, Math.max(1, Number(e.target.value) || 1))}
                />
                <select
                  className={styles.manageSelect}
                  style={{ flex: 1 }}
                  value={activeInterval}
                  onChange={(e) => applyFrequency(e.target.value, activeIntervalCount)}
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

            {swapProduct && (
              <div className={styles.manageStaticBox} style={{ justifyContent: "flex-start", gap: "0.5rem" }}>
                Swapping to <strong>{swapProduct.title}</strong>
                <button
                  type="button"
                  className={styles.cancelLink}
                  onClick={() => {
                    setSwapProduct(null);
                    setSelectedVariantId(null);
                  }}
                >
                  Undo
                </button>
              </div>
            )}

            {/* Swapping to a different product still picks a single target
                variant -- it isn't on the contract yet, so there's no
                existing mix to split across. */}
            {swapProduct && displayVariants.length > 1 && (
              <div className={styles.manageField}>
                <span className={styles.manageFieldLabel}>Select flavor</span>
                <div className={styles.manageSwatchGrid}>
                  {displayVariants.map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      className={`${styles.manageSwatch} ${activeVariantId === variant.id ? styles["is-selected"] : ""}`}
                      disabled={!variant.availableForSale}
                      onClick={() => setSelectedVariantId(variant.id)}
                      style={{ opacity: variant.availableForSale ? 1 : 0.5 }}
                    >
                      <span className={styles.manageSwatchCheck} aria-hidden="true">
                        ✓
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
              </div>
            )}

            {/* The current product's flavor mix -- each flavor gets its own
                +/- stepper, and the total below is however many pouches
                across all of them add up to, not a separately-editable
                number. */}
            {!swapProduct && displayVariants.length > 1 && (
              <div className={styles.manageField}>
                <span className={styles.manageFieldLabel}>1. Select flavor(s)</span>
                <div className={styles.manageSwatchGrid}>
                  {displayVariants.map((variant) => {
                    const flavorQty = activeFlavorQuantities[variant.id] ?? 0;
                    return (
                      <div
                        key={variant.id}
                        className={`${styles.manageSwatch} ${flavorQty > 0 ? styles["is-selected"] : ""}`}
                        style={{ opacity: variant.availableForSale ? 1 : 0.5 }}
                      >
                        <span className={styles.manageSwatchImage}>
                          {variant.imageUrl && <img src={variant.imageUrl} alt={variant.title} />}
                        </span>
                        <span className={styles.manageSwatchName}>
                          {variant.title}
                          {!variant.availableForSale && " (out of stock)"}
                        </span>
                        <div className={styles.manageQuantity}>
                          <button
                            type="button"
                            onClick={() => decrementFlavor(variant.id)}
                            disabled={flavorQty <= 0}
                            aria-label={`Decrease ${variant.title} quantity`}
                          >
                            &minus;
                          </button>
                          <span>{flavorQty}</span>
                          <button
                            type="button"
                            onClick={() => incrementFlavor(variant.id)}
                            disabled={!variant.availableForSale || atMaxQuantity}
                            aria-label={`Increase ${variant.title} quantity`}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className={styles.manageMixNote}>
                  Mix flavors freely &mdash; {flavorTotal}
                  {options?.maxQuantity != null ? ` of ${options.maxQuantity}` : ""} pouch
                  {flavorTotal === 1 ? "" : "es"} selected, same price per pouch either way.
                </p>
              </div>
            )}

            {/* No standalone quantity control when there's a flavor mix to
                adjust instead -- the steppers above already change quantity,
                so a second, separate control here would just be a
                redundant, confusing way to do the same thing. Still shown
                for a swap (no mix to adjust yet) and for a single-variant
                product (no flavor picker at all, so nothing else changes
                quantity). */}
            {swapProduct && (
              <div className={styles.manageQuantityRow}>
                <span className={styles.manageFieldLabel}>Quantity</span>
                <div className={styles.manageQuantity}>
                  <button
                    type="button"
                    onClick={() => setQuantity(Math.max(1, activeQuantity - 1))}
                    aria-label="Decrease quantity"
                  >
                    &minus;
                  </button>
                  <span>{activeQuantity}</span>
                  <button type="button" onClick={() => setQuantity(activeQuantity + 1)} aria-label="Increase quantity">
                    +
                  </button>
                </div>
              </div>
            )}

            {!swapProduct && displayVariants.length <= 1 && displayVariants[0] && (
              <div className={styles.manageQuantityRow}>
                <span className={styles.manageFieldLabel}>Quantity</span>
                <div className={styles.manageQuantity}>
                  <button
                    type="button"
                    onClick={() => decrementFlavor(displayVariants[0].id)}
                    aria-label="Decrease quantity"
                  >
                    &minus;
                  </button>
                  <span>{activeQuantity}</span>
                  <button
                    type="button"
                    onClick={() => incrementFlavor(displayVariants[0].id)}
                    disabled={atMaxQuantity}
                    aria-label="Increase quantity"
                  >
                    +
                  </button>
                </div>
              </div>
            )}

            <div className={styles.manageTotal}>
              Total: {formatMoney(swapProduct ? unitPrice * activeQuantity : mixTotalPrice, currencyCode)} &bull;{" "}
              {activeQuantity} pouch{activeQuantity === 1 ? "" : "es"} per delivery
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

            <button type="button" className={styles.manageSwapLink} onClick={() => setSwapOpen((open) => !open)}>
              {swapOpen ? "Cancel swap" : "Swap product"}
            </button>

            {swapOpen && (
              <div className={styles.manageField}>
                {swapLoadError && <div className={styles.error}>{swapLoadError}</div>}
                {!swapFetcher.data && !swapLoadError && (
                  <div className={styles.emptyState}>Loading other products...</div>
                )}
                {swapProducts.length === 0 && swapFetcher.data && !swapLoadError && (
                  <div className={styles.emptyState}>
                    No other products are currently available in this subscription&apos;s currency
                    ({sub.currencyCode}).
                  </div>
                )}
                <div className={styles.manageSwatchGrid}>
                  {swapProducts.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      className={styles.manageSwatch}
                      onClick={() => selectSwapProduct(product)}
                    >
                      <span className={styles.manageSwatchImage}>
                        {product.imageUrl && <img src={product.imageUrl} alt={product.title} />}
                      </span>
                      <span className={styles.manageSwatchName}>{product.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OneTimeAddonModal({ sub, onClose }: { sub: Subscription; onClose: () => void }) {
  const optionsFetcher = useFetcher<OneTimeAddonOptions | { error: string }>();
  const saveFetcher = useFetcher<typeof action>();

  // null until the customer touches a row -- lets the preselected (already on
  // the next order) set come from the load instead of starting empty.
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [visibleCount, setVisibleCount] = useState(3);

  if (optionsFetcher.state === "idle" && !optionsFetcher.data) {
    optionsFetcher.load(
      `/account/subscriptions/one-time-addons?contractId=${encodeURIComponent(sub.contractShopifyId)}`,
    );
  }

  const options = optionsFetcher.data && "products" in optionsFetcher.data ? optionsFetcher.data : null;
  const loadError = optionsFetcher.data && "error" in optionsFetcher.data ? optionsFetcher.data.error : null;

  const existingVariantIds = new Set(
    (options?.existingAddons ?? []).map((a) => a.variantId).filter((id): id is string => Boolean(id)),
  );
  const activeSelection = selection ?? existingVariantIds;

  const toggle = (variantId: string) => {
    const next = new Set(activeSelection);
    if (next.has(variantId)) next.delete(variantId);
    else next.add(variantId);
    setSelection(next);
  };

  const total = (options?.products ?? [])
    .filter((p) => activeSelection.has(p.variantId))
    .reduce((sum, p) => sum + Number(p.price), 0);

  const saving = saveFetcher.state !== "idle";
  const saved = saveFetcher.state === "idle" && saveFetcher.data && "success" in saveFetcher.data;

  const save = () => {
    if (!options) return;
    const addVariantId = Array.from(activeSelection).filter((id) => !existingVariantIds.has(id));
    const removeLineId = options.existingAddons
      .filter((a) => a.variantId && !activeSelection.has(a.variantId))
      .map((a) => a.lineId);

    const formData = new FormData();
    formData.set("intent", "updateOneTimeAddons");
    formData.set("contractShopifyId", sub.contractShopifyId);
    for (const id of addVariantId) formData.append("addVariantId", id);
    for (const id of removeLineId) formData.append("removeLineId", id);

    saveFetcher.submit(formData, { method: "post", action: "/account/subscriptions" });
  };

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.addonModalCard} role="dialog" aria-modal="true">
        <div className={styles.addonHeader}>
          <div>
            <h2 className={styles.addonTitle}>Add to next order</h2>
            {options && (
              <span className={styles.addonSubtitle}>
                Ships with your next renewal on {formatDate(options.nextBillingDate)} — no extra shipping fee.
              </span>
            )}
          </div>
          <button type="button" className={styles.modalClose} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {loadError && <div className={styles.error}>{loadError}</div>}
        {!options && !loadError && <div className={styles.emptyState}>Loading...</div>}

        {options && (
          <>
            <div className={styles.addonList}>
              {options.products.length === 0 ? (
                <div className={styles.emptyState}>No other products are available to add right now.</div>
              ) : (
                options.products.slice(0, visibleCount).map((product) => {
                  const isSelected = activeSelection.has(product.variantId);
                  return (
                    <button
                      key={product.variantId}
                      type="button"
                      className={`${styles.addonRow} ${isSelected ? styles["is-selected"] : ""}`}
                      onClick={() => toggle(product.variantId)}
                    >
                      <span className={styles.addonThumb}>
                        {product.imageUrl ? <img src={product.imageUrl} alt={product.title} /> : "CLRTY"}
                      </span>
                      <span className={styles.addonInfo}>
                        <div className={styles.addonName}>{product.title}</div>
                        <span className={styles.addonMeta}>
                          One-time &bull; <span className={styles.addonPrice}>{formatMoney(Number(product.price), options.currencyCode)}</span>
                        </span>
                      </span>
                      <span className={styles.addonCheck}>{isSelected ? "✓" : ""}</span>
                    </button>
                  );
                })
              )}
              {options.products.length > visibleCount && (
                <button
                  type="button"
                  className={styles.addonLoadMore}
                  onClick={() => setVisibleCount((count) => count + 3)}
                >
                  Load more
                </button>
              )}
            </div>

            <hr className={styles.addonDivider} />

            <div className={styles.addonTotalRow}>
              <span className={styles.addonTotalLabel}>Add-on total</span>
              <span className={styles.addonTotalValue}>{formatMoney(total, options.currencyCode)}</span>
            </div>

            {saved && <div className={styles.success}>Next shipment updated.</div>}
            {saveFetcher.data && "error" in saveFetcher.data && (
              <div className={styles.error}>{saveFetcher.data.error}</div>
            )}

            <button
              type="button"
              className={styles.addonSubmitButton}
              disabled={saving || Boolean(saved)}
              onClick={save}
            >
              {saving ? "Saving..." : saved ? "Added" : "Add to next shipment"}
            </button>
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
  const [oneTimeOpen, setOneTimeOpen] = useState(false);
  const productUrl = sub.productHandle ? `https://${shop}/products/${sub.productHandle}` : null;

  const runAction = (intent: "skip" | "shipNow") => {
    fetcher.submit({ intent, contractShopifyId: sub.contractShopifyId }, { method: "post" });
  };

  const removingLineId =
    busy && busyIntent === "updateOneTimeAddons" ? String(fetcher.formData?.get("removeLineId") ?? "") : null;

  const removeOneTimeAddon = (lineId: string) => {
    fetcher.submit(
      { intent: "updateOneTimeAddons", contractShopifyId: sub.contractShopifyId, removeLineId: lineId },
      { method: "post" },
    );
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
            <span className={sub.paymentFailed ? styles.statusFailed : (STATUS_PILL[sub.status] ?? styles.statusCancelled)}>
              {sub.paymentFailed ? "PAYMENT FAILED" : sub.status}
            </span>
          </div>
        </div>
        <div>
          <span className={styles.subPriceLabel}>Total price</span>
          <div className={styles.subPrice}>{formatMoney(sub.totalAmount, sub.currencyCode)}</div>
          {sub.quantity && sub.totalAmount != null ? (
            <span className={styles.subUnitPrice}>
              {formatMoney(sub.totalAmount / sub.quantity, sub.currencyCode)} / unit
            </span>
          ) : null}
        </div>
      </div>

      {sub.paymentFailed && (
        <div className={styles.error} style={{ marginTop: "0.75rem" }}>
          Your last payment failed. Please{" "}
          <a href="/account/settings#payment-method" style={{ color: "inherit", fontWeight: 700 }}>
            update your payment method
          </a>{" "}
          to keep this subscription active.
        </div>
      )}

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
              {sub.flavorLines.map((line, index) => (
                <span key={index} className={styles.metaSubtext}>
                  {line.variantTitle ?? "—"}
                  {sub.flavorLines.length > 1 ? ` ×${line.quantity}` : ""}
                </span>
              ))}
            </div>
            <div>
              <span className={styles.metaLabel}>Billing status</span>
              <div className={sub.paymentFailed ? styles.metaValueError : styles.metaValue}>
                {sub.paymentFailed ? "Payment failed" : "Active"}
              </div>
            </div>
          </div>

          {(sub.shipToDisplay || sub.paymentMethodDisplay) && (
            <div className={styles.shipPayRow}>
              <span>Ship to &bull; {sub.shipToDisplay ?? "—"}</span>
              <span>Pay with &bull; {sub.paymentMethodDisplay ?? "—"}</span>
            </div>
          )}

          {sub.oneTimeAddons.length > 0 && (
            <div className={styles.shipPayRow}>
              <span>
                One-time add-ons &bull;{" "}
                {sub.oneTimeAddons.map((addon, index) => (
                  <span key={addon.lineId}>
                    {index > 0 && ", "}
                    {addon.title} ({formatMoney(Number(addon.price), sub.currencyCode)})
                    <button
                      type="button"
                      onClick={() => removeOneTimeAddon(addon.lineId)}
                      disabled={busy}
                      aria-label={`Remove ${addon.title}`}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "inherit",
                        textDecoration: "underline",
                        marginLeft: "0.25rem",
                        padding: 0,
                        font: "inherit",
                      }}
                    >
                      {removingLineId === addon.lineId ? "Removing..." : "Remove"}
                    </button>
                  </span>
                ))}
              </span>
            </div>
          )}
          {fetcher.data?.intent === "updateOneTimeAddons" && "success" in fetcher.data && (
            <div className={styles.success}>One-time add-on removed.</div>
          )}
          {fetcher.data?.intent === "updateOneTimeAddons" && "error" in fetcher.data && (
            <div className={styles.error}>{fetcher.data.error}</div>
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
            <button type="button" className={styles.pillNeutral} onClick={() => setOneTimeOpen(true)}>
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
        </>
      )}

      {manageOpen && <ManageSubscriptionModal sub={sub} onClose={() => setManageOpen(false)} />}
      {oneTimeOpen && <OneTimeAddonModal sub={sub} onClose={() => setOneTimeOpen(false)} />}
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
        <div className={styles.emptyStateCentered}>
          <h2 className={styles.emptyStateHeading}>No active subscriptions</h2>
          <p className={styles.emptyStateSubtext}>Start a subscription to save 15% on every delivery.</p>
          <a className={styles.emptyStateAction} href={`https://${shop}`} target="_blank" rel="noopener noreferrer">
            Shop CLRTY
          </a>
        </div>
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
