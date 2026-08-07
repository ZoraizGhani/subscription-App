import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { listSubscribedCustomers } from "../models/customer.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("q") ?? "";

  const [customers, shopResponse] = await Promise.all([
    listSubscribedCustomers({ shop: session.shop, search: search || undefined }),
    admin.graphql(`#graphql
      query ShopCurrency {
        shop { currencyCode }
      }
    `),
  ]);
  const shopData = (await shopResponse.json()) as { data?: { shop: { currencyCode: string } } };
  const currencyCode = shopData.data?.shop.currencyCode ?? "USD";

  return { customers, search, currencyCode };
};

function formatMoney(amount: number, currencyCode: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).format(amount);
}

function formatDate(value: Date | string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function Customers() {
  const { customers, search, currencyCode } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSearchInput = (event: Event) => {
    const value = (event.target as HTMLInputElement).value;
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set("q", value);
    } else {
      next.delete("q");
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <s-page heading="Customers">
      <s-section heading="Manage">
        {/*
          Plain onInput, not a <Form> submission -- <s-search-field> is a
          shadow-DOM custom element with no submit button here, and relying on
          native/implicit form submission (e.g. pressing Enter) hasn't proven
          reliable for these components. Filtering live as you type sidesteps
          the question entirely.
        */}
        <s-search-field
          label="Search customers"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search by customer or contract #"
          defaultValue={search}
          onInput={handleSearchInput}
        />

        {customers.length === 0 ? (
          <s-paragraph color="subdued">
            {search
              ? "No subscribers match that search."
              : "No subscribers yet -- this list populates once a customer completes a subscription checkout."}
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Email</s-table-header>
              <s-table-header>Subscriptions</s-table-header>
              <s-table-header>Lifetime value</s-table-header>
              <s-table-header>Since</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {customers.map((customer) => {
                const numericId = customer.customerShopifyId.split("/").pop();
                const linkId = `customer-link-${numericId}`;
                return (
                  <s-table-row key={customer.customerShopifyId} clickDelegate={linkId}>
                    <s-table-cell>
                      <s-link id={linkId} href={`/app/customers/${numericId}`}>
                        {customer.name}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>{customer.email}</s-table-cell>
                    <s-table-cell>{customer.subscriptionCount}</s-table-cell>
                    <s-table-cell>{formatMoney(customer.lifetimeValue, currencyCode)}</s-table-cell>
                    <s-table-cell>{formatDate(customer.since)}</s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};