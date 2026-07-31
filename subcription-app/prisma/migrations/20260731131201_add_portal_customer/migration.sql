-- AlterTable
ALTER TABLE "SubscriptionContract" ADD COLUMN "cancellationReason" TEXT;

-- CreateTable
CREATE TABLE "PortalCustomer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerShopifyId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PortalCustomer_customerShopifyId_idx" ON "PortalCustomer"("customerShopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalCustomer_shop_email_key" ON "PortalCustomer"("shop", "email");
