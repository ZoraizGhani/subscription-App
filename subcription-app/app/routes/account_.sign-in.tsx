import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigation, useActionData } from "react-router";

import { verifyPortalLogin, PortalAuthError } from "../models/portalCustomer.server";
import { createPortalUserSession, getPortalSession } from "../portal-auth.server";
import styles from "../styles/portal.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const existing = await getPortalSession(request);
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? existing?.shop ?? "";

  return { shop };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const shop = String(formData.get("shop") ?? "");
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
        <div className={styles.authLogo}>Account</div>
        <div className={styles.authCard}>
          <span className={styles.eyebrow}>My account</span>
          <h1 className={`${styles.heading} ${styles.authTitle}`}>Sign in</h1>

          {actionData?.error && <div className={styles.error}>{actionData.error}</div>}

          <Form method="post">
            <input type="hidden" name="shop" value={shop} />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input className={styles.input} type="email" name="email" required autoFocus />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Password</span>
              <input className={styles.input} type="password" name="password" required />
            </label>
            <button className={styles.buttonPrimary} type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Signing in..." : "Sign in"}
            </button>
          </Form>

          <div className={styles.authFooter}>
            No account? <Link to={`/account/create?shop=${encodeURIComponent(shop)}`}>Create one</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
