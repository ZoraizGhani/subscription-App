import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const contracts = await prisma.subscriptionContract.findMany({
  select: { shopifyId: true, customerName: true, customerEmail: true, status: true, totalAmount: true, currencyCode: true },
  orderBy: { createdAt: "desc" },
});
console.log(JSON.stringify(contracts, null, 2));
await prisma.$disconnect();
