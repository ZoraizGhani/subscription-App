import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigation, useActionData } from "react-router";

import { createPortalAccount, PortalAuthError } from "../models/portalCustomer.server";
import { createPortalUserSession, resolveDefaultShop } from "../portal-auth.server";
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
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!shop) {
    return { error: "Missing store context. Use the link from the store's account page." };
  }
  if (!name) {
    return { error: "Enter your name." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  try {
    const account = await createPortalAccount({ shop, email, password, name });
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

export default function PortalCreateAccount() {
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
        <h1 className={`${styles.heading} ${styles.authTitle}`}>Create your account</h1>

        <div className={styles.authCard}>
          {actionData?.error && <div className={styles.error}>{actionData.error}</div>}

          <Form method="post">
            <input type="hidden" name="shop" value={shop} />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Full name</span>
              <input className={styles.input} type="text" name="name" required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input className={styles.input} type="email" name="email" required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Password</span>
              <input
                className={styles.input}
                type="password"
                name="password"
                required
                minLength={8}
                placeholder="At least 8 characters"
              />
            </label>
            <button className={styles.buttonPrimary} type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating account..." : "Create account"}
            </button>
          </Form>

          <div className={styles.authFooter}>
            Already have an account?{" "}
            <Link to={`/account/sign-in?shop=${encodeURIComponent(shop)}`}>Sign in</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
