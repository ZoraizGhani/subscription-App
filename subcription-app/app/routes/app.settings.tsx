import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getShopSettings } from "../models/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);

  return { settings };
};

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Settings">
      <s-section heading="Not built yet">
        <s-paragraph>
          Build the form from the Settings frame in Figma. The ShopSettings row for
          this shop already exists and is loaded below; add an action that writes
          back through updateShopSettings.
        </s-paragraph>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            <code>{JSON.stringify(settings, null, 2)}</code>
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};