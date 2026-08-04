import type { LoaderFunctionArgs } from "react-router";
import { Link, NavLink, Outlet, useLoaderData } from "react-router";

import { requirePortalSession, destroyPortalSession } from "../portal-auth.server";
import { getPortalCustomerById } from "../models/portalCustomer.server";
import styles from "../styles/portal.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const session = await requirePortalSession(request);
  const customer = await getPortalCustomerById(session.portalCustomerId);

  if (!customer || customer.shop !== session.shop) {
    throw await destroyPortalSession(request);
  }

  return {
    shop: session.shop,
    customer: { name: customer.name, email: customer.email },
  };
};

export default function AccountLayout() {
  const { customer } = useLoaderData<typeof loader>();

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <div className={styles.topbarNav}>
          <span>Shop</span>
          <span>Science</span>
          <span className={styles.topbarNavActive}>My Account</span>
        </div>
        <div className={styles.topbarRight}>
          <span>{customer.email}</span>
          <Link to="/account/logout" className={styles.pillNeutral} style={{ textDecoration: "none" }}>
            Log out
          </Link>
        </div>
      </div>

      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>CLRTY</div>
          <nav className={styles.nav}>
            <NavLink
              to="/account"
              end
              className={({ isActive }) => (isActive ? styles.navLinkActive : styles.navLink)}
            >
              Overview
            </NavLink>
            <NavLink
              to="/account/subscriptions"
              className={({ isActive }) => (isActive ? styles.navLinkActive : styles.navLink)}
            >
              Subscription
            </NavLink>
            <NavLink
              to="/account/order-history"
              className={({ isActive }) => (isActive ? styles.navLinkActive : styles.navLink)}
            >
              Order History
            </NavLink>
            <NavLink
              to="/account/settings"
              className={({ isActive }) => (isActive ? styles.navLinkActive : styles.navLink)}
            >
              Settings
            </NavLink>
          </nav>
          <div className={styles.sidebarFooter}>
            <button type="button" className={styles.buttonPrimary}>
              Create New Plan
            </button>
            <Link to="/account/logout" className={styles.buttonSecondary} style={{ textAlign: "center", textDecoration: "none" }}>
              Logout
            </Link>
          </div>
        </aside>

        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
