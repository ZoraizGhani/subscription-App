import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { confirmPlanImageUpload, requestPlanImageUpload } from "../models/sellingPlan.server";

/**
 * Resource route (no default export, so no UI to render) backing the plan
 * image uploader on app.settings_.selling-plans.tsx. Deliberately separate
 * from that page route: a plain browser fetch() to a route WITH a UI
 * component gets the full server-rendered HTML document back (React Router
 * only skips that and returns raw JSON for requests made through its own
 * <Form>/useFetcher/useSubmit, which attach the headers that signal a
 * data-only request) -- a route with no component always just returns
 * whatever the action returns, regardless of how it's called.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "requestImageUpload") {
    const target = await requestPlanImageUpload({
      graphql: admin.graphql,
      filename: String(formData.get("filename")),
      mimeType: String(formData.get("mimeType")),
      fileSize: Number(formData.get("fileSize")),
    });
    return { target };
  }

  if (intent === "confirmImageUpload") {
    const imageUrl = await confirmPlanImageUpload({
      graphql: admin.graphql,
      resourceUrl: String(formData.get("resourceUrl")),
      filename: String(formData.get("filename")),
    });
    return { imageUrl };
  }

  return Response.json({ error: "Unknown intent." }, { status: 400 });
};
