import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getQuickReviewData,
  updateContractQuickEdit,
  applyContractDiscount,
  pauseContractAdmin,
  resendPaymentLink,
  QuickReviewNotFoundError,
} from "../models/adminQuickReview.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const contractShopifyId = url.searchParams.get("contractId") ?? "";

  try {
    const data = await getQuickReviewData({ graphql: admin.graphql, shop: session.shop, contractShopifyId });
    return Response.json(data);
  } catch (error) {
    if (error instanceof QuickReviewNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Something went wrong." },
      { status: 500 },
    );
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const contractShopifyId = String(formData.get("contractShopifyId") ?? "");

  try {
    if (intent === "saveChanges") {
      const lineId = formData.get("lineId") ? String(formData.get("lineId")) : null;
      const nextBillingDate = formData.get("nextBillingDate") ? String(formData.get("nextBillingDate")) : undefined;
      const interval = formData.get("interval") ? String(formData.get("interval")) : undefined;
      const intervalCount = formData.get("intervalCount") ? Number(formData.get("intervalCount")) : undefined;
      const quantity = formData.get("quantity") ? Number(formData.get("quantity")) : undefined;
      await updateContractQuickEdit({
        graphql: admin.graphql,
        shop: session.shop,
        contractShopifyId,
        lineId,
        nextBillingDate,
        interval,
        intervalCount,
        quantity,
      });
      return { intent, success: true };
    }

    if (intent === "applyDiscount") {
      await applyContractDiscount({ graphql: admin.graphql, shop: session.shop, contractShopifyId, percentage: 25 });
      return { intent, success: true };
    }

    if (intent === "pause") {
      await pauseContractAdmin({ graphql: admin.graphql, shop: session.shop, contractShopifyId });
      return { intent, success: true };
    }

    if (intent === "resendPaymentLink") {
      await resendPaymentLink({ graphql: admin.graphql, shop: session.shop, contractShopifyId });
      return { intent, success: true };
    }

    return { intent, error: "Unknown action." };
  } catch (error) {
    if (error instanceof QuickReviewNotFoundError) {
      return { intent, error: error.message };
    }
    return { intent, error: error instanceof Error ? error.message : "Something went wrong." };
  }
};
