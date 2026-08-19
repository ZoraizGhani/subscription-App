import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const sessions = await db.session.findMany({ select: { shop: true, id: true } });
console.log(JSON.stringify(sessions, null, 2));
const contracts = await db.subscriptionContract.findMany({ select: { shop: true }, distinct: ["shop"] });
console.log("distinct contract shops:", JSON.stringify(contracts, null, 2));
const portalCustomers = await db.portalCustomer.findMany({ select: { shop: true, email: true }, distinct: ["shop"] });
console.log("distinct portal customer shops:", JSON.stringify(portalCustomers, null, 2));
await db.$disconnect();
