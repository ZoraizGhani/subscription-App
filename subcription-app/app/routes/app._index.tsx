import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { shop } = session;

  // Counts come from our webhook-synced mirror, not the Admin API.
  const [activeContracts, pausedContracts, recurringOrders, sellingPlanGroups] =
    await Promise.all([
      db.subscriptionContract.count({ where: { shop, status: "ACTIVE" } }),
      db.subscriptionContract.count({ where: { shop, status: "PAUSED" } }),
      db.subscriptionOrder.count({ where: { shop } }),
      db.sellingPlanGroup.count({ where: { shop } }),
    ]);

  return { shop, activeContracts, pausedContracts, recurringOrders, sellingPlanGroups };
};

export default function Dashboard() {
  const { activeContracts, pausedContracts, recurringOrders, sellingPlanGroups } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Dashboard">
      <s-section heading="Overview">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text>Active subscriptions: </s-text>
            <s-text>{activeContracts}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Paused subscriptions: </s-text>
            <s-text>{pausedContracts}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Recurring orders recorded: </s-text>
            <s-text>{recurringOrders}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>Subscription plans: </s-text>
            <s-text>{sellingPlanGroups}</s-text>
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Scaffolding">
        <s-paragraph>
          Placeholder layout that confirms admin auth and the database are wired
          up. Rebuild this section from the Dashboard frame in Figma.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};