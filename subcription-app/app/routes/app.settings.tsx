import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function SettingsIndex() {
  return (
    <s-page heading="Settings">
      <s-section heading="Selling plans">
        <s-paragraph color="subdued">Configure subscription plans and discounts per product.</s-paragraph>
        <s-link href="/app/settings/selling-plans">Open</s-link>
      </s-section>

      <s-section heading="Branding">
        <s-paragraph color="subdued">
          Set the logo shown on this dashboard and the customer account portal.
        </s-paragraph>
        <s-link href="/app/settings/branding">Open</s-link>
      </s-section>
    </s-page>
  );
}
