import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Customers() {
  return (
    <s-page heading="Customers">
      <s-section heading="Not built yet">
        <s-paragraph>
          Build this from the Customers frame in Figma. Customer records live in
          Shopify -- query them through the Admin API and join to local contracts
          on customerShopifyId.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};