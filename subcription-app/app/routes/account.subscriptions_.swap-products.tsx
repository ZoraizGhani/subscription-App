import type { LoaderFunctionArgs } from "react-router";

import { requirePortalSession } from "../portal-auth.server";
import { getPortalCustomerById } from "../models/portalCustomer.server";
import { listPortalSwappableProducts } from "../models/portalSubscription.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);
  const url = new URL(request.url);
  const excludeProductId = url.searchParams.get("excludeProductId") ?? "";

  if (!customer?.customerShopifyId) {
    return Response.json({ error: "No linked subscription." }, { status: 400 });
  }

  try {
    const products = await listPortalSwappableProducts({ shop: session.shop, excludeProductId });
    return Response.json({ products });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Something went wrong." },
      { status: 500 },
    );
  }
};
