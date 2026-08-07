-- CreateTable
CREATE TABLE "PortalPasswordResetToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "portalCustomerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalPasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalPasswordResetToken_tokenHash_key" ON "PortalPasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PortalPasswordResetToken_portalCustomerId_idx" ON "PortalPasswordResetToken"("portalCustomerId");

-- AddForeignKey
ALTER TABLE "PortalPasswordResetToken" ADD CONSTRAINT "PortalPasswordResetToken_portalCustomerId_fkey" FOREIGN KEY ("portalCustomerId") REFERENCES "PortalCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
