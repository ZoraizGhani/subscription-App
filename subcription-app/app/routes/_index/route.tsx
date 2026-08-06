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
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3 9h18" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M8 14l2 2 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: "Branded customer portal",
    detail:
      "Subscribers sign in to their own account to view orders, skip or reschedule a delivery, swap products, or cancel — without contacting support.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 20c0-3.6 3.13-6 7-6s7 2.4 7 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: "Billing that stays in sync",
    detail:
      "Every renewal, skipped cycle, and failed payment is tracked automatically, so your Dashboard and Subscriptions screens always match what Shopify billed.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path d="M17 4v3.5h-3.5M7 20v-3.5h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>S</span>
          Subscription App
        </div>
      </header>

      <main className={styles.hero}>
        <span className={styles.eyebrow}>Private app for this store</span>
        <h1 className={styles.heading}>Recurring orders, run your way</h1>
        <p className={styles.text}>
          Selling plans, automatic billing sync, and a self-service customer
          portal for your subscribers — all in one private app.
        </p>

        {showForm && (
          <div className={styles.loginCard}>
            <span className={styles.loginCardLabel}>Store login</span>
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
          </div>
        )}
      </main>

      <section className={styles.features}>
        <ul className={styles.list}>
          {FEATURES.map((feature) => (
            <li key={feature.title}>
              <span className={styles.icon}>{feature.icon}</span>
              <strong>{feature.title}</strong>
              <p>{feature.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <footer className={styles.footer}>
        Built for this store &middot; not distributed on the Shopify App Store
      </footer>
    </div>
  );
}
