import bcrypt from "bcryptjs";

import db from "../db.server";

const SALT_ROUNDS = 10;

export class PortalAuthError extends Error {}

/**
 * Creates a portal login. NOT email-verified -- this only checks whether the
 * email matches an existing subscriber on file for this shop, it does not
 * prove the signer actually owns that inbox. Fine for building/testing; do
 * not treat this as safe for real customers until email verification exists.
 */
export async function createPortalAccount({
  shop,
  email,
  password,
  name,
}: {
  shop: string;
  email: string;
  password: string;
  name: string;
}) {
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await db.portalCustomer.findUnique({
    where: { shop_email: { shop, email: normalizedEmail } },
  });
  if (existing) {
    throw new PortalAuthError("An account with this email already exists.");
  }

  const matchingContract = await db.subscriptionContract.findFirst({
    where: { shop, customerEmail: normalizedEmail },
    select: { customerShopifyId: true },
    orderBy: { createdAt: "desc" },
  });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  return db.portalCustomer.create({
    data: {
      shop,
      email: normalizedEmail,
      passwordHash,
      name,
      customerShopifyId: matchingContract?.customerShopifyId ?? null,
    },
  });
}

export async function verifyPortalLogin({
  shop,
  email,
  password,
}: {
  shop: string;
  email: string;
  password: string;
}) {
  const normalizedEmail = email.trim().toLowerCase();
  const account = await db.portalCustomer.findUnique({
    where: { shop_email: { shop, email: normalizedEmail } },
  });
  if (!account) {
    throw new PortalAuthError("Incorrect email or password.");
  }

  const valid = await bcrypt.compare(password, account.passwordHash);
  if (!valid) {
    throw new PortalAuthError("Incorrect email or password.");
  }

  return account;
}

export async function getPortalCustomerById(id: string) {
  return db.portalCustomer.findUnique({ where: { id } });
}
