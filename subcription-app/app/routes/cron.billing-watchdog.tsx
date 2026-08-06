import type { LoaderFunctionArgs } from "react-router";

import { runBillingWatchdog } from "../models/billingWatchdog.server";

/**
 * Triggered by the Vercel Cron Job defined in vercel.json. Vercel signs cron
 * requests with a bearer token matching the CRON_SECRET env var -- verifying
 * it here stops anyone else from hitting this endpoint and forcing charges.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const results = await runBillingWatchdog();

  const summary = {
    charged: results.filter((r) => r.outcome === "charged").length,
    notDue: results.filter((r) => r.outcome === "not-due").length,
    errors: results.filter((r) => r.outcome === "error").length,
  };

  console.log("[billing-watchdog]", JSON.stringify({ summary, results }));

  return Response.json({ summary, results });
};
