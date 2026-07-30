import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Subscriptions() {
  return (
    <s-page heading="Subscriptions">
      <s-section heading="Not built yet">
        <s-paragraph>
          Build this from the Subscriptions list frame in Figma. Data source is the
          SubscriptionContract table, kept in sync by the subscription webhooks.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};