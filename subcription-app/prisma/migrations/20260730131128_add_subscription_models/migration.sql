-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "portalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "allowCancel" BOOLEAN NOT NULL DEFAULT true,
    "allowSkipCycle" BOOLEAN NOT NULL DEFAULT true,
    "allowPause" BOOLEAN NOT NULL DEFAULT true,
    "allowChangeFrequency" BOOLEAN NOT NULL DEFAULT true,
    "allowChangeAddress" BOOLEAN NOT NULL DEFAULT true,
    "allowChangePaymentMethod" BOOLEAN NOT NULL DEFAULT true,
    "minCyclesBeforeCancel" INTEGER NOT NULL DEFAULT 0,
    "dunningMaxRetries" INTEGER NOT NULL DEFAULT 3,
    "dunningRetryIntervalDays" INTEGER NOT NULL DEFAULT 3,
    "widgetHeading" TEXT NOT NULL DEFAULT 'Subscribe & Save',
    "widgetOneTimeLabel" TEXT NOT NULL DEFAULT 'One-time purchase',
    "widgetSubscribeLabel" TEXT NOT NULL DEFAULT 'Subscribe',
    "widgetShowDiscountBadge" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SellingPlanGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "merchantCode" TEXT NOT NULL,
    "appName" TEXT,
    "description" TEXT,
    "options" TEXT NOT NULL DEFAULT '[]',
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SellingPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopifyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "billingInterval" TEXT NOT NULL,
    "billingIntervalCount" INTEGER NOT NULL,
    "deliveryInterval" TEXT NOT NULL,
    "deliveryIntervalCount" INTEGER NOT NULL,
    "pricingPolicyType" TEXT NOT NULL DEFAULT 'NONE',
    "discountValue" REAL,
    "minCycles" INTEGER,
    "maxCycles" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SellingPlan_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SellingPlanGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubscriptionContract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "customerShopifyId" TEXT,
    "customerEmail" TEXT,
    "customerName" TEXT,
    "status" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "nextBillingDate" DATETIME,
    "billingInterval" TEXT,
    "billingIntervalCount" INTEGER,
    "sellingPlanGroupShopifyId" TEXT,
    "originOrderShopifyId" TEXT,
    "linesJson" TEXT,
    "lastPaymentStatus" TEXT,
    "totalAmount" REAL,
    "pausedAt" DATETIME,
    "cancelledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BillingAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyId" TEXT,
    "contractShopifyId" TEXT,
    "status" TEXT NOT NULL,
    "orderShopifyId" TEXT,
    "amount" REAL,
    "currencyCode" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingAttempt_contractShopifyId_fkey" FOREIGN KEY ("contractShopifyId") REFERENCES "SubscriptionContract" ("shopifyId") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SubscriptionOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderShopifyId" TEXT NOT NULL,
    "orderName" TEXT,
    "contractShopifyId" TEXT,
    "totalPrice" REAL,
    "currencyCode" TEXT,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "webhookId" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SellingPlanGroup_shopifyId_key" ON "SellingPlanGroup"("shopifyId");

-- CreateIndex
CREATE INDEX "SellingPlanGroup_shop_idx" ON "SellingPlanGroup"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "SellingPlan_shopifyId_key" ON "SellingPlan"("shopifyId");

-- CreateIndex
CREATE INDEX "SellingPlan_groupId_idx" ON "SellingPlan"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionContract_shopifyId_key" ON "SubscriptionContract"("shopifyId");

-- CreateIndex
CREATE INDEX "SubscriptionContract_shop_status_idx" ON "SubscriptionContract"("shop", "status");

-- CreateIndex
CREATE INDEX "SubscriptionContract_customerShopifyId_idx" ON "SubscriptionContract"("customerShopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAttempt_shopifyId_key" ON "BillingAttempt"("shopifyId");

-- CreateIndex
CREATE INDEX "BillingAttempt_shop_status_idx" ON "BillingAttempt"("shop", "status");

-- CreateIndex
CREATE INDEX "BillingAttempt_contractShopifyId_idx" ON "BillingAttempt"("contractShopifyId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionOrder_orderShopifyId_key" ON "SubscriptionOrder"("orderShopifyId");

-- CreateIndex
CREATE INDEX "SubscriptionOrder_shop_processedAt_idx" ON "SubscriptionOrder"("shop", "processedAt");

-- CreateIndex
CREATE INDEX "SubscriptionOrder_contractShopifyId_idx" ON "SubscriptionOrder"("contractShopifyId");

-- CreateIndex
CREATE INDEX "ProcessedWebhook_receivedAt_idx" ON "ProcessedWebhook"("receivedAt");
