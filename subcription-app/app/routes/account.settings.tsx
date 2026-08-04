import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { requirePortalSession, destroyPortalSession } from "../portal-auth.server";
import {
  getPortalCustomerById,
  updatePortalAccountInfo,
  updatePortalPassword,
  deletePortalAccount,
  PortalAuthError,
} from "../models/portalCustomer.server";
import styles from "../styles/portal.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);
  return { name: customer?.name ?? "", email: customer?.email ?? "" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const session = await requirePortalSession(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "updateInfo") {
      const name = String(formData.get("name") ?? "").trim();
      const email = String(formData.get("email") ?? "").trim();
      if (!name || !email) {
        return { intent, error: "Name and email are required." };
      }
      await updatePortalAccountInfo({ id: session.portalCustomerId, name, email });
      return { intent, success: true };
    }

    if (intent === "updatePassword") {
      const currentPassword = String(formData.get("currentPassword") ?? "");
      const newPassword = String(formData.get("newPassword") ?? "");
      if (newPassword.length < 8) {
        return { intent, error: "New password must be at least 8 characters." };
      }
      await updatePortalPassword({ id: session.portalCustomerId, currentPassword, newPassword });
      return { intent, success: true };
    }

    if (intent === "deleteAccount") {
      await deletePortalAccount({ id: session.portalCustomerId, shop: session.shop });
      return destroyPortalSession(request);
    }

    return { intent, error: "Unknown action." };
  } catch (error) {
    if (error instanceof PortalAuthError) {
      return { intent, error: error.message };
    }
    throw error;
  }
};

export default function AccountSettings() {
  const { name, email } = useLoaderData<typeof loader>();
  const infoFetcher = useFetcher<typeof action>();
  const passwordFetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();

  return (
    <>
      <span className={styles.eyebrow}>My account</span>
      <h1 className={styles.heading} style={{ fontSize: "2rem", margin: "0.25rem 0 1.5rem" }}>
        Settings
      </h1>

      <div className={styles.settingsGrid}>
        <div className={styles.card}>
          <h2 className={styles.sectionHeading}>Account info</h2>
          {infoFetcher.data?.intent === "updateInfo" && "success" in infoFetcher.data && (
            <div className={styles.success}>Saved.</div>
          )}
          {infoFetcher.data?.intent === "updateInfo" && "error" in infoFetcher.data && (
            <div className={styles.error}>{infoFetcher.data.error}</div>
          )}
          <infoFetcher.Form method="post">
            <input type="hidden" name="intent" value="updateInfo" />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Full name</span>
              <input className={styles.input} type="text" name="name" defaultValue={name} required />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <input className={styles.input} type="email" name="email" defaultValue={email} required />
            </label>
            <button
              className={styles.buttonPrimary}
              type="submit"
              disabled={infoFetcher.state !== "idle"}
            >
              {infoFetcher.state !== "idle" ? "Saving..." : "Save account info"}
            </button>
          </infoFetcher.Form>

          <hr className={styles.divider} />

          <h2 className={styles.sectionHeading}>Change password</h2>
          {passwordFetcher.data?.intent === "updatePassword" && "success" in passwordFetcher.data && (
            <div className={styles.success}>Password updated.</div>
          )}
          {passwordFetcher.data?.intent === "updatePassword" && "error" in passwordFetcher.data && (
            <div className={styles.error}>{passwordFetcher.data.error}</div>
          )}
          <passwordFetcher.Form method="post">
            <input type="hidden" name="intent" value="updatePassword" />
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Current password</span>
              <input className={styles.input} type="password" name="currentPassword" required />
            </label>
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
            <button
              className={styles.buttonPrimary}
              type="submit"
              disabled={passwordFetcher.state !== "idle"}
            >
              {passwordFetcher.state !== "idle" ? "Updating..." : "Update password"}
            </button>
          </passwordFetcher.Form>
        </div>

        <div>
          <div className={styles.card}>
            <h2 className={styles.sectionHeading}>Help &amp; support</h2>
            <div className={styles.helpList}>
              <button type="button" className={styles.helpItem} style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", width: "100%" }}>
                Visit the help center
              </button>
              <button type="button" className={styles.helpItem} style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", width: "100%" }}>
                Chat with support
              </button>
              <a className={styles.helpItem} href="mailto:support@clrty.com">Email support@clrty.com</a>
            </div>
          </div>

          <div className={styles.dangerBox} style={{ marginTop: "1.5rem" }}>
            <h2 className={styles.dangerHeading}>Danger zone</h2>
            <p className={styles.dangerText}>
              Deleting your account cancels all active subscriptions and erases your order
              history. This can&apos;t be undone.
            </p>
            {deleteFetcher.data && "error" in deleteFetcher.data && (
              <div className={styles.error}>{deleteFetcher.data.error}</div>
            )}
            <deleteFetcher.Form
              method="post"
              onSubmit={(event) => {
                if (!confirm("Delete your account? This cancels all active subscriptions and can't be undone.")) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="intent" value="deleteAccount" />
              <button
                className={styles.buttonDangerFull}
                type="submit"
                disabled={deleteFetcher.state !== "idle"}
              >
                {deleteFetcher.state !== "idle" ? "Deleting..." : "Delete my account"}
              </button>
            </deleteFetcher.Form>
          </div>
        </div>
      </div>
    </>
  );
}
