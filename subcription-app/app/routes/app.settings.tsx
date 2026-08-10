import { redirect } from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

// No settings form lives on this index yet -- Selling plans is the only real
// settings screen built so far, so land here directly instead of showing a
// placeholder page in between.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  throw redirect("/app/settings/selling-plans");
};
