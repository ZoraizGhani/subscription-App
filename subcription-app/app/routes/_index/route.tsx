import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

const FEATURES = [
  {
    title: "Flexible selling plans",
    detail:
      "Set up day, week, month, or year intervals with an optional discount, right from the Selling Plans screen — no theme code required.",
  },
  {
    title: "Branded customer portal",
    detail:
      "Subscribers sign in to their own account to view orders, skip or reschedule a delivery, swap products, or cancel — without contacting support.",
  },
  {
    title: "Billing that stays in sync",
    detail:
      "Every renewal, skipped cycle, and failed payment is tracked automatically, so your Dashboard and Subscriptions screens always match what Shopify billed.",
  },
];

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <span className={styles.eyebrow}>Subscription App</span>
        <h1 className={styles.heading}>Recurring orders, run your way</h1>
        <p className={styles.text}>
          Selling plans, automatic billing sync, and a self-service customer
          portal for your subscribers — all in one private app.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span className={styles.labelText}>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="my-shop-domain.myshopify.com"
              />
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          {FEATURES.map((feature) => (
            <li key={feature.title}>
              <strong>{feature.title}</strong>
              <p>{feature.detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
