import crypto from "node:crypto";

import bcrypt from "bcryptjs";

import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { sendEmail, renderPasswordResetEmail } from "./email.server";

const SALT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

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

function hashResetToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const SHOP_NAME_QUERY = `#graphql
  query PortalShopName {
    shop { name }
  }
`;

/** Falls back to the raw shop domain if the Admin API call fails -- shop
 * name is cosmetic (email branding), never worth failing the reset over. */
async function getShopName(shop: string): Promise<string> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(SHOP_NAME_QUERY);
    const body = (await response.json()) as { data?: { shop: { name: string } } };
    return body.data?.shop.name ?? shop;
  } catch {
    return shop;
  }
}

/**
 * Starts a password reset for the given email, if a portal account exists
 * for it. Deliberately never reveals whether the account exists (mirrors
 * verifyPortalLogin's generic "incorrect email or password" -- same
 * anti-enumeration reasoning applies to "forgot password").
 */
export async function requestPortalPasswordReset({
  shop,
  email,
  appUrl,
}: {
  shop: string;
  email: string;
  appUrl: string;
}) {
  const normalizedEmail = email.trim().toLowerCase();
  const account = await db.portalCustomer.findUnique({
    where: { shop_email: { shop, email: normalizedEmail } },
  });
  if (!account) {
    return;
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  await db.portalPasswordResetToken.create({
    data: {
      tokenHash: hashResetToken(rawToken),
      portalCustomerId: account.id,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  const resetUrl = `${appUrl}/account/reset-password?token=${rawToken}`;
  const shopName = await getShopName(shop);
  try {
    await sendEmail({
      to: account.email,
      subject: `Reset your password – ${shopName}`,
      html: renderPasswordResetEmail({ shopName, resetUrl }),
    });
  } catch (error) {
    // The reset token is already created above -- don't let a Resend outage
    // or misconfiguration (bad API key, unverified sender) crash the page or
    // reveal account existence via a differing response. Log it so it's
    // visible in server logs, since the customer otherwise has no way to
    // know their reset link never arrived.
    console.error(`[portal] Failed to send password reset email for shop ${shop}:`, error);
  }
}

/**
 * Completes a password reset. Looks the token up by its hash (never the raw
 * value) and rejects it if already used or past expiry, then marks it used
 * in the same operation it's consumed so a link can't be replayed.
 */
export async function resetPortalPassword({
  token,
  newPassword,
}: {
  token: string;
  newPassword: string;
}) {
  const tokenHash = hashResetToken(token);
  const resetToken = await db.portalPasswordResetToken.findUnique({ where: { tokenHash } });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    throw new PortalAuthError("This reset link is invalid or has expired.");
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  const [, account] = await db.$transaction([
    db.portalPasswordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
    db.portalCustomer.update({ where: { id: resetToken.portalCustomerId }, data: { passwordHash } }),
  ]);

  return account;
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

const DEFAULT_ADDRESS_QUERY = `#graphql
  query PortalDefaultAddress($id: ID!) {
    customer(id: $id) {
      defaultAddress {
        id
        firstName
        lastName
        address1
        address2
        city
        provinceCode
        zip
        countryCodeV2
        phone
      }
    }
  }
`;

export async function getPortalDefaultAddress({
  shop,
  customerShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
}) {
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(DEFAULT_ADDRESS_QUERY, { variables: { id: customerShopifyId } });
  const body = (await response.json()) as {
    data?: {
      customer: {
        defaultAddress: {
          id: string;
          firstName: string | null;
          lastName: string | null;
          address1: string;
          address2: string | null;
          city: string;
          provinceCode: string | null;
          zip: string | null;
          countryCodeV2: string;
          phone: string | null;
        } | null;
      } | null;
    };
  };
  return body.data?.customer?.defaultAddress ?? null;
}

const ADDRESS_CREATE_MUTATION = `#graphql
  mutation PortalAddressCreate($customerId: ID!, $address: MailingAddressInput!) {
    customerAddressCreate(customerId: $customerId, address: $address, setAsDefault: true) {
      userErrors { field message }
    }
  }
`;

const ADDRESS_UPDATE_MUTATION = `#graphql
  mutation PortalAddressUpdate($customerId: ID!, $addressId: ID!, $address: MailingAddressInput!) {
    customerAddressUpdate(customerId: $customerId, addressId: $addressId, address: $address, setAsDefault: true) {
      userErrors { field message }
    }
  }
`;

export async function updatePortalDefaultAddress({
  shop,
  customerShopifyId,
  address,
}: {
  shop: string;
  customerShopifyId: string;
  address: {
    firstName: string;
    lastName: string;
    address1: string;
    address2: string;
    city: string;
    provinceCode: string;
    zip: string;
    countryCode: string;
    phone: string;
  };
}) {
  if (!address.address1 || !address.city || !address.countryCode) {
    throw new Error("Address line, city, and country are required.");
  }

  const { admin } = await unauthenticated.admin(shop);
  const existing = await getPortalDefaultAddress({ shop, customerShopifyId });

  const response = existing
    ? await admin.graphql(ADDRESS_UPDATE_MUTATION, {
        variables: { customerId: customerShopifyId, addressId: existing.id, address },
      })
    : await admin.graphql(ADDRESS_CREATE_MUTATION, {
        variables: { customerId: customerShopifyId, address },
      });
  const body = (await response.json()) as {
    data?: {
      customerAddressCreate?: { userErrors: { field: string[]; message: string }[] };
      customerAddressUpdate?: { userErrors: { field: string[]; message: string }[] };
    };
  };
  const userErrors =
    body.data?.customerAddressCreate?.userErrors ?? body.data?.customerAddressUpdate?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(`Address update failed: ${JSON.stringify(userErrors)}`);
  }
}

const CUSTOMER_PAYMENT_METHODS_FOR_EMAIL_QUERY = `#graphql
  query PortalCustomerPaymentMethodsForEmail($id: ID!) {
    customer(id: $id) {
      paymentMethods(first: 1, showRevoked: false) {
        edges { node { id } }
      }
    }
  }
`;

const SEND_UPDATE_EMAIL_MUTATION = `#graphql
  mutation PortalSendPaymentUpdateEmail($id: ID!) {
    customerPaymentMethodSendUpdateEmail(customerPaymentMethodId: $id) {
      customer { id }
      userErrors { field message }
    }
  }
`;

/**
 * Credit card payment methods can't be added or changed through the API at
 * all -- Shopify's own docs are explicit about this being blocked for
 * security reasons. The only supported path is emailing the customer a
 * secure Shopify-hosted link where they enter card details themselves,
 * never touching our server.
 */
export async function sendPortalPaymentUpdateEmail({
  shop,
  customerShopifyId,
}: {
  shop: string;
  customerShopifyId: string;
}) {
  const { admin } = await unauthenticated.admin(shop);

  const methodsResponse = await admin.graphql(CUSTOMER_PAYMENT_METHODS_FOR_EMAIL_QUERY, {
    variables: { id: customerShopifyId },
  });
  const methodsBody = (await methodsResponse.json()) as {
    data?: { customer: { paymentMethods: { edges: { node: { id: string } }[] } } | null };
  };
  const paymentMethodId = methodsBody.data?.customer?.paymentMethods.edges[0]?.node.id;
  if (!paymentMethodId) {
    throw new Error("No payment method on file to update.");
  }

  const response = await admin.graphql(SEND_UPDATE_EMAIL_MUTATION, {
    variables: { id: paymentMethodId },
  });
  const body = (await response.json()) as {
    data?: { customerPaymentMethodSendUpdateEmail: { userErrors: { field: string[]; message: string }[] } };
  };
  const userErrors = body.data?.customerPaymentMethodSendUpdateEmail?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(`customerPaymentMethodSendUpdateEmail failed: ${JSON.stringify(userErrors)}`);
  }
}
