import { createCookieSessionStorage, redirect } from "react-router";

import db from "./db.server";

// Session for the customer portal (/account/*), entirely separate from
// Shopify's own admin session cookie -- a portal customer is never the same
// thing as an authenticated merchant admin request.
const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "portal_session",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me"],
    secure: process.env.NODE_ENV === "production",
  },
});

export async function createPortalUserSession({
  request,
  portalCustomerId,
  shop,
  redirectTo,
}: {
  request: Request;
  portalCustomerId: string;
  shop: string;
  redirectTo: string;
}) {
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  session.set("portalCustomerId", portalCustomerId);
  session.set("shop", shop);
  return redirect(redirectTo, {
    headers: { "Set-Cookie": await sessionStorage.commitSession(session) },
  });
}

export interface PortalSessionData {
  portalCustomerId: string;
  shop: string;
}

export async function getPortalSession(request: Request): Promise<PortalSessionData | null> {
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const portalCustomerId = session.get("portalCustomerId");
  const shop = session.get("shop");
  if (!portalCustomerId || !shop) return null;
  return { portalCustomerId, shop };
}

/** Redirects to sign-in if no session exists. Callers still verify the
 * customer id resolves to a real, live PortalCustomer row before using it. */
export async function requirePortalSession(
  request: Request,
  redirectTo = "/account/sign-in",
): Promise<PortalSessionData> {
  const session = await getPortalSession(request);
  if (!session) {
    throw redirect(redirectTo);
  }
  return session;
}

/**
 * This app is single-merchant (custom distribution, not the App Store), so
 * when an auth page is reached with no `?shop=` query param and no existing
 * portal session -- e.g. someone bookmarked or typed the URL directly --
 * falling back to the one shop this app is installed on is always correct;
 * there's never a second shop to disambiguate from.
 */
export async function resolveDefaultShop(): Promise<string> {
  const session = await db.session.findFirst({ select: { shop: true } });
  return session?.shop ?? "";
}

export async function destroyPortalSession(request: Request) {
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  return redirect("/account/sign-in", {
    headers: { "Set-Cookie": await sessionStorage.destroySession(session) },
  });
}
