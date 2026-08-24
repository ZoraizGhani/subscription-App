import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  SellingPlanValidationError,
  confirmPlanImageUpload,
  getProductSellingPlans,
  listSellingPlanGroups,
  requestPlanImageUpload,
  saveSellingPlanTiers,
  type ProductSellingPlanData,
  type SellingPlanTier,
} from "../models/sellingPlan.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("product");

  const [productData, configuredProducts] = await Promise.all([
    productId ? getProductSellingPlans({ graphql: admin.graphql, productId }) : Promise.resolve(null),
    listSellingPlanGroups(session.shop),
  ]);

  return { productData, configuredProducts };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "save");

  if (intent === "requestImageUpload") {
    const target = await requestPlanImageUpload({
      graphql: admin.graphql,
      filename: String(formData.get("filename")),
      mimeType: String(formData.get("mimeType")),
      fileSize: Number(formData.get("fileSize")),
    });
    return { intent, target };
  }

  if (intent === "confirmImageUpload") {
    const imageUrl = await confirmPlanImageUpload({
      graphql: admin.graphql,
      resourceUrl: String(formData.get("resourceUrl")),
      filename: String(formData.get("filename")),
    });
    return { intent, imageUrl };
  }

  const productId = String(formData.get("productId"));
  const productTitle = String(formData.get("productTitle") ?? "Untitled product");
  const existingGroupId = formData.get("groupId") ? String(formData.get("groupId")) : null;
  const existingPlanIds = JSON.parse(String(formData.get("existingPlanIds") ?? "[]")) as string[];
  const tierCount = Number(formData.get("tierCount") ?? 0);

  const tiers: SellingPlanTier[] = Array.from({ length: tierCount }, (_, i) => ({
    intervalCount: Number(formData.get(`days_${i}`)),
    discountPercent: Number(formData.get(`discount_${i}`) || 0),
    planId: formData.get(`planId_${i}`) ? String(formData.get(`planId_${i}`)) : null,
    imageUrl: formData.get(`image_${i}`) ? String(formData.get(`image_${i}`)) : null,
  })).filter((tier) => tier.intervalCount > 0);

  try {
    await saveSellingPlanTiers({
      graphql: admin.graphql,
      shop: session.shop,
      productId,
      productTitle,
      existingGroupId,
      existingPlanIds,
      tiers,
    });
  } catch (error) {
    if (error instanceof SellingPlanValidationError) {
      // Stay on the same product (still in the URL) so the merchant can see
      // and fix the tiers that caused the error, rather than losing context.
      return { saved: false, error: error.message };
    }
    throw error;
  }

  // On success, deliberately drop back to the empty "Choose product" state --
  // the merchant re-opens a product explicitly via the list or the picker.
  return redirect("/app/settings/selling-plans?saved=1");
};

interface TierRow extends SellingPlanTier {
  key: number;
}

/** The numeric tail of a Shopify GID, e.g. "gid://shopify/SellingPlan/123" -> "123". */
function shortId(gid: string) {
  return gid.split("/").pop();
}

export default function SellingPlanSettings() {
  const { productData, configuredProducts } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const shopify = useAppBridge();

  useEffect(() => {
    if (!searchParams.get("saved")) return;
    shopify.toast.show("Selling plan settings saved");
    const next = new URLSearchParams(searchParams);
    next.delete("saved");
    setSearchParams(next, { replace: true });
    // Only ever react to the "saved" flag changing -- rerunning this whenever
    // searchParams/setSearchParams identity changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get("saved")]);

  const selectProduct = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("product", id);
    setSearchParams(next);
  };

  const chooseProduct = async () => {
    const result = await shopify.resourcePicker({ type: "product", multiple: false });
    const picked = result?.[0];
    if (!picked) return;
    selectProduct(picked.id);
  };

  return (
    <s-page heading="Selling Plan Settings">
      <s-section heading="Products with a plan configured">
        {configuredProducts.length === 0 ? (
          <s-paragraph>
            Nothing configured yet -- choose a product below to set up its first plan.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Product</s-table-header>
              <s-table-header>Plans</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {configuredProducts.map((group) => (
                <s-table-row key={group.groupId}>
                  <s-table-cell>{group.productTitle}</s-table-cell>
                  <s-table-cell>{group.tierCount}</s-table-cell>
                  <s-table-cell>
                    <s-button onClick={() => selectProduct(group.productId)}>Edit</s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Product">
        <s-stack direction="inline" gap="base">
          <s-button onClick={chooseProduct}>
            {productData ? "Change product" : "Choose product"}
          </s-button>
          {productData && <s-text>{productData.product.title}</s-text>}
        </s-stack>
      </s-section>

      {/* Keyed by product id + the current set of plan ids: must remount (and
          re-sync local state from the loader) whenever the product changes OR
          a save just created/deleted plans server-side -- otherwise a second
          edit in the same session would work off stale plan ids. */}
      {productData && (
        <ProductTiersForm
          key={`${productData.product.id}:${productData.tiers.map((t) => t.planId ?? "new").join(",")}`}
          productData={productData}
        />
      )}
    </s-page>
  );
}

function ProductTiersForm({ productData }: { productData: ProductSellingPlanData }) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const location = useLocation();
  const shopify = useAppBridge();
  const actionData = useActionData<{ saved: boolean; error: string | null } | undefined>();
  const isSaving = navigation.state === "submitting";
  const formRef = useRef<HTMLFormElement>(null);

  const nextKey = useRef(0);
  const makeRow = (tier?: SellingPlanTier): TierRow => ({
    intervalCount: tier?.intervalCount ?? 30,
    discountPercent: tier?.discountPercent ?? 0,
    planId: tier?.planId ?? null,
    imageUrl: tier?.imageUrl ?? null,
    key: nextKey.current++,
  });

  const [tiers, setTiers] = useState<TierRow[]>(() => productData.tiers.map((t) => makeRow(t)));
  // Original plan ids for this product, used server-side to figure out which
  // tiers the merchant removed. Captured once on mount, not re-derived from
  // `tiers` state (which changes as rows are added/removed).
  const [existingPlanIds] = useState<string[]>(() =>
    productData.tiers.map((t) => t.planId).filter((id): id is string => Boolean(id)),
  );

  // A successful save redirects away (see the route's action), unmounting
  // this component -- so the only outcome ever visible here is an error.
  useEffect(() => {
    if (navigation.state === "idle" && actionData?.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [navigation.state, actionData, shopify]);

  const addTier = () =>
    setTiers((prev) => {
      // Default to an interval not already used, so clicking this repeatedly
      // doesn't immediately create two plans Shopify will reject as duplicates.
      const usedDays = new Set(prev.map((t) => t.intervalCount));
      let days = 30;
      while (usedDays.has(days)) days += 15;
      return [...prev, makeRow({ intervalCount: days, discountPercent: 0, planId: null, imageUrl: null })];
    });
  const removeTier = (key: number) => setTiers((prev) => prev.filter((t) => t.key !== key));

  const [uploadState, setUploadState] = useState<Record<number, { uploading: boolean; error: string | null }>>({});

  /**
   * Direct-to-Shopify upload: ask our action for a pre-signed staged URL,
   * POST the raw file straight to Shopify from the browser (never through
   * our server), then ask our action to register it as a real File and
   * return its ready CDN url. Uses plain fetch rather than a fetcher because
   * step 2 posts to a Shopify-owned URL, not this route.
   */
  const uploadTierImage = async (key: number, file: File) => {
    setUploadState((prev) => ({ ...prev, [key]: { uploading: true, error: null } }));
    const actionUrl = `${location.pathname}${location.search}`;

    try {
      const requestBody = new FormData();
      requestBody.set("intent", "requestImageUpload");
      requestBody.set("filename", file.name);
      requestBody.set("mimeType", file.type || "image/jpeg");
      requestBody.set("fileSize", String(file.size));
      const requestResponse = await fetch(actionUrl, { method: "post", body: requestBody });
      if (!requestResponse.ok) throw new Error("Couldn't start the upload.");
      const { target } = (await requestResponse.json()) as {
        target: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] };
      };

      const uploadBody = new FormData();
      target.parameters.forEach((param) => uploadBody.append(param.name, param.value));
      uploadBody.append("file", file);
      const uploadResponse = await fetch(target.url, { method: "POST", body: uploadBody });
      if (!uploadResponse.ok) throw new Error("Shopify rejected the upload.");

      const confirmBody = new FormData();
      confirmBody.set("intent", "confirmImageUpload");
      confirmBody.set("resourceUrl", target.resourceUrl);
      confirmBody.set("filename", file.name);
      const confirmResponse = await fetch(actionUrl, { method: "post", body: confirmBody });
      if (!confirmResponse.ok) throw new Error("Shopify is still processing the image -- try again shortly.");
      const { imageUrl } = (await confirmResponse.json()) as { imageUrl: string };

      setTiers((prev) => prev.map((t) => (t.key === key ? { ...t, imageUrl } : t)));
      setUploadState((prev) => ({ ...prev, [key]: { uploading: false, error: null } }));
    } catch (error) {
      setUploadState((prev) => ({
        ...prev,
        [key]: { uploading: false, error: error instanceof Error ? error.message : "Upload failed." },
      }));
    }
  };

  const saveTiers = () => {
    if (formRef.current) {
      // Without an explicit action, submit() doesn't reliably keep the
      // ?product=<id> query param -- losing it means the loader comes back
      // with no product selected after saving, and the whole editor appears
      // to close. Submitting to the exact current URL keeps it selected.
      submit(formRef.current, {
        method: "post",
        action: `${location.pathname}${location.search}`,
      });
    }
  };

  return (
    <s-section heading="Selling Plan Settings">
      <s-paragraph color="subdued">Configure</s-paragraph>
      <s-text>
        {productData.product.title}
        {tiers.length > 0 ? ` · ${tiers.length} plan${tiers.length === 1 ? "" : "s"}` : ""}
      </s-text>

      {/*
        A plain <form>, not React Router's <Form> -- <s-button type="submit">
        is a shadow-DOM custom element and its native submit signal doesn't
        reliably reach React Router's submit interception. Instead, the Save
        button below reads this form's live FormData explicitly via useSubmit,
        which sidesteps depending on a submit event firing at all.
      */}
      <form ref={formRef}>
        <input type="hidden" name="productId" value={productData.product.id} />
        <input type="hidden" name="productTitle" value={productData.product.title} />
        {productData.groupId && <input type="hidden" name="groupId" value={productData.groupId} />}
        <input type="hidden" name="existingPlanIds" value={JSON.stringify(existingPlanIds)} />
        <input type="hidden" name="tierCount" value={tiers.length} />
        <s-stack direction="block" gap="base">
          {tiers.map((tier, i) => (
            <s-box key={tier.key} padding="base" borderWidth="base" borderRadius="base">
              {tier.planId && <input type="hidden" name={`planId_${i}`} value={tier.planId} />}
              <input type="hidden" name={`image_${i}`} value={tier.imageUrl ?? ""} />
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-stack direction="block" gap="small-300">
                  <s-text>Every {tier.intervalCount} days</s-text>
                  <s-paragraph color="subdued">
                    {tier.planId ? `Selling plan ID ${shortId(tier.planId)}` : "New plan"}
                  </s-paragraph>
                </s-stack>
                <s-text-field
                  name={`days_${i}`}
                  label="Every"
                  labelAccessibilityVisibility="exclusive"
                  defaultValue={String(tier.intervalCount)}
                  suffix="days"
                />
                <s-text-field
                  name={`discount_${i}`}
                  label="Discount"
                  labelAccessibilityVisibility="exclusive"
                  defaultValue={String(tier.discountPercent)}
                  suffix="% off"
                />
                <s-button type="button" variant="tertiary" onClick={() => removeTier(tier.key)}>
                  Remove
                </s-button>
              </s-stack>

              <s-stack direction="inline" gap="base" alignItems="center">
                {tier.imageUrl && (
                  <img
                    src={tier.imageUrl}
                    alt=""
                    width={48}
                    height={48}
                    style={{ objectFit: "cover", borderRadius: 6 }}
                  />
                )}
                <label>
                  <span style={{ display: "block", fontSize: 12, color: "#6b6459", marginBottom: 4 }}>
                    Bundle image (shown for this plan on the storefront widget)
                  </span>
                  <input
                    type="file"
                    accept="image/*"
                    disabled={uploadState[tier.key]?.uploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) uploadTierImage(tier.key, file);
                      event.target.value = "";
                    }}
                  />
                </label>
                {uploadState[tier.key]?.uploading && <s-text color="subdued">Uploading...</s-text>}
                {uploadState[tier.key]?.error && (
                  <s-text tone="critical">{uploadState[tier.key]?.error}</s-text>
                )}
              </s-stack>
            </s-box>
          ))}
          <s-button type="button" onClick={addTier}>
            Add another plan
          </s-button>
          {actionData?.error && <s-paragraph tone="critical">{actionData.error}</s-paragraph>}
          <s-button
            type="button"
            variant="primary"
            onClick={saveTiers}
            {...(isSaving ? { loading: true } : {})}
          >
            Save settings
          </s-button>
        </s-stack>
      </form>
    </s-section>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};