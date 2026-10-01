import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigation, useActionData } from "react-router";

import { requestPortalPasswordReset } from "../models/portalCustomer.server";
import { resolveDefaultShop } from "../portal-auth.server";
import { getShopSettings } from "../models/settings.server";
import styles from "../styles/portal.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || (await resolveDefaultShop());
  const settings = shop ? await getShopSettings(shop) : null;
  return { shop, logoUrl: settings?.logoUrl ?? null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  // Resolved server-side, not trusted from the form -- this app is
  // single-merchant, so a client-supplied shop value can only ever cause a
  // mismatch against the canonical domain SubscriptionContract rows use.
  const shop = await resolveDefaultShop();
  const email = String(formData.get("email") ?? "");

  if (!shop) {
    return { error: "Missing store context. Use the link from the store's account page." };
  }
  if (!email) {
    return { error: "Enter your email." };
  }

  const url = new URL(request.url);
  await requestPortalPasswordReset({ shop, email, appUrl: url.origin });

  // Always the same response whether or not an account exists for this email
  // -- see requestPortalPasswordReset's doc comment for why.
  return { sent: true };
};

export default function PortalForgotPassword() {
  const { shop, logoUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className={styles.page}>
      <div className={styles.authWrap}>
        <div className={styles.authLogo}>
          {logoUrl ? (
            <img src={logoUrl} alt={shop ?? ""} className={styles.authLogoImage} />
          ) : (
            <>
              <span className={styles.authLogoMark}>CLRTY</span>
              <span className={styles.authLogoSub}>Supplements</span>
            </>
          )}
        </div>

        <span className={styles.authEyebrow}>My account</span>
        <h1 className={`${styles.heading} ${styles.authTitle}`}>Reset your password</h1>

        <div className={styles.authCard}>
          {actionData?.error && <div className={styles.error}>{actionData.error}</div>}

          {actionData?.sent ? (
            <p>If an account exists for that email, we&apos;ve sent a link to reset your password.</p>
          ) : (
            <>
              <p>Enter your email and we&apos;ll send you a link to reset your password.</p>
              <Form method="post">
                <input type="hidden" name="shop" value={shop} />
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Email</span>
                  <input className={styles.input} type="email" name="email" required />
                </label>
                <button className={styles.buttonPrimary} type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Sending..." : "Send reset link"}
                </button>
              </Form>
            </>
          )}

          <div className={styles.authFooter}>
            <Link to={`/account/sign-in?shop=${encodeURIComponent(shop)}`}>Back to sign in</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
