import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigation, useActionData } from "react-router";

import { verifyPortalLogin, PortalAuthError } from "../models/portalCustomer.server";
import { createPortalUserSession, getPortalSession, resolveDefaultShop } from "../portal-auth.server";
import styles from "../styles/portal.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const existing = await getPortalSession(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || existing?.shop || (await resolveDefaultShop());

  return { shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  // Resolved server-side, not trusted from the form -- this app is
  // single-merchant, so a client-supplied shop value can only ever cause a
  // mismatch against the canonical domain SubscriptionContract rows use.
  const shop = await resolveDefaultShop();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!shop) {
    return { error: "Missing store context. Use the link from the store's account page." };
  }

  try {
    const account = await verifyPortalLogin({ shop, email, password });
    return createPortalUserSession({
      request,
      portalCustomerId: account.id,
      shop,
      redirectTo: "/account",
    });
  } catch (error) {
    if (error instanceof PortalAuthError) {
      return { error: error.message };
    }
    throw error;
  }
};

export default function PortalSignIn() {
  const { shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className={styles.page}>
      <div className={styles.authWrap}>
        <div className={styles.authLogo}>
          <span className={styles.authLogoMark}>CLRTY</span>
          <span className={styles.authLogoSub}>Supplements</span>
        </div>

        <span className={styles.authEyebrow}>My account</span>
        <h1 className={`${styles.heading} ${styles.authTitle}`}>Sign in</h1>

        <div className={styles.authCard}>
          {actionData?.error && <div className={styles.error}>{actionData.error}</div>}

          <Form method="post">
            <input type="hidden" name="shop" value={shop} />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input className={styles.input} type="email" name="email" required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Password</span>
              <input className={styles.input} type="password" name="password" required />
            </label>
            <Link
              className={styles.forgotLink}
              to={`/account/forgot-password?shop=${encodeURIComponent(shop)}`}
            >
              Forgot password?
            </Link>
            <button className={styles.buttonPrimary} type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Signing in..." : "Sign in"}
            </button>
          </Form>
        </div>

        <div className={styles.authFooter}>
          No account? <Link to={`/account/create?shop=${encodeURIComponent(shop)}`}>Create one</Link>
        </div>
      </div>
    </div>
  );
}
