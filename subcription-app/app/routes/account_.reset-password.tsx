import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigation, useActionData } from "react-router";

import { resetPortalPassword, PortalAuthError } from "../models/portalCustomer.server";
import { createPortalUserSession, resolveDefaultShop } from "../portal-auth.server";
import { getShopSettings } from "../models/settings.server";
import styles from "../styles/portal.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  // No shop is resolvable from the reset token itself at this point (that
  // only happens once the action verifies it) -- this app is
  // single-merchant, so falling back to the one configured shop is enough
  // just to show the right branding here.
  const shop = await resolveDefaultShop();
  const settings = shop ? await getShopSettings(shop) : null;
  return { token, logoUrl: settings?.logoUrl ?? null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const token = String(formData.get("token") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");

  if (!token) {
    return { error: "This reset link is invalid or has expired." };
  }
  if (newPassword.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  try {
    const account = await resetPortalPassword({ token, newPassword });
    return createPortalUserSession({
      request,
      portalCustomerId: account.id,
      shop: account.shop,
      redirectTo: "/account",
    });
  } catch (error) {
    if (error instanceof PortalAuthError) {
      return { error: error.message };
    }
    throw error;
  }
};

export default function PortalResetPassword() {
  const { token, logoUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className={styles.page}>
      <div className={styles.authWrap}>
        <div className={styles.authLogo}>
          {logoUrl ? (
            <img src={logoUrl} alt="" className={styles.authLogoImage} />
          ) : (
            <>
              <span className={styles.authLogoMark}>CLRTY</span>
              <span className={styles.authLogoSub}>Supplements</span>
            </>
          )}
        </div>

        <span className={styles.authEyebrow}>My account</span>
        <h1 className={`${styles.heading} ${styles.authTitle}`}>Choose a new password</h1>

        <div className={styles.authCard}>
          {actionData?.error && <div className={styles.error}>{actionData.error}</div>}

          {token ? (
            <Form method="post">
              <input type="hidden" name="token" value={token} />
              <label className={styles.field}>
                <span className={styles.fieldLabel}>New password</span>
                <input
                  className={styles.input}
                  type="password"
                  name="newPassword"
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                />
              </label>
              <button className={styles.buttonPrimary} type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : "Save new password"}
              </button>
            </Form>
          ) : (
            <p>This reset link is invalid or has expired.</p>
          )}

          <div className={styles.authFooter}>
            <Link to="/account/forgot-password">Request a new link</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
