import bcrypt from "bcryptjs";

import { unauthenticated } from "../shopify.server";
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

export async function updatePortalAccountInfo({
  id,
  name,
  email,
}: {
  id: string;
  name: string;
  email: string;
}) {
  return db.portalCustomer.update({
    where: { id },
    data: { name, email: email.trim().toLowerCase() },
  });
}

export async function updatePortalPassword({
  id,
  currentPassword,
  newPassword,
}: {
  id: string;
  currentPassword: string;
  newPassword: string;
}) {
  const account = await db.portalCustomer.findUnique({ where: { id } });
  if (!account) {
    throw new PortalAuthError("Account not found.");
  }
  const valid = await bcrypt.compare(currentPassword, account.passwordHash);
  if (!valid) {
    throw new PortalAuthError("Current password is incorrect.");
  }
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.portalCustomer.update({ where: { id }, data: { passwordHash } });
}

const DELETE_CANCEL_MUTATION = `#graphql
  mutation PortalDeleteAccountCancel($id: ID!) {
    subscriptionContractCancel(subscriptionContractId: $id, actor: CUSTOMER) {
      contract { id status }
      userErrors { field message }
    }
  }
`;

/**
 * Cancels every active contract the customer owns on Shopify, then deletes
 * the local portal login. Matches the portal's own "delete account" warning
 * (deleting the account cancels all active subscriptions).
 */
export async function deletePortalAccount({ id, shop }: { id: string; shop: string }) {
  const account = await db.portalCustomer.findUnique({ where: { id } });
  if (!account || account.shop !== shop) {
    throw new PortalAuthError("Account not found.");
  }

  if (account.customerShopifyId) {
    const activeContracts = await db.subscriptionContract.findMany({
      where: { shop, customerShopifyId: account.customerShopifyId, status: "ACTIVE" },
    });

    if (activeContracts.length) {
      const { admin } = await unauthenticated.admin(shop);
      for (const contract of activeContracts) {
        const response = await admin.graphql(DELETE_CANCEL_MUTATION, {
          variables: { id: contract.shopifyId },
        });
        const body = (await response.json()) as {
          data?: {
            subscriptionContractCancel: {
              contract: { id: string; status: string } | null;
              userErrors: { field: string[]; message: string }[];
            };
          };
        };
        const result = body.data?.subscriptionContractCancel;
        if (result?.contract) {
          await db.subscriptionContract.update({
            where: { shopifyId: contract.shopifyId },
            data: {
              status: result.contract.status,
              cancelledAt: new Date(),
              cancellationReason: "Account deleted",
            },
          });
        }
      }
    }
  }

  await db.portalCustomer.delete({ where: { id } });
}
