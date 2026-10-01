import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getShopSettings, updateShopSettings } from "../models/settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);
  return { logoUrl: settings.logoUrl ?? "" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const logoUrl = String(formData.get("logoUrl") ?? "").trim();

  await updateShopSettings(session.shop, { logoUrl: logoUrl || null });

  return { saved: true };
};

export default function BrandingSettings() {
  const { logoUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const formRef = useRef<HTMLFormElement>(null);
  const isSaving = navigation.state === "submitting";

  useEffect(() => {
    if (!actionData?.saved) return;
    shopify.toast.show("Branding settings saved");
  }, [actionData, shopify]);

  const save = () => {
    if (formRef.current) submit(formRef.current, { method: "post" });
  };

  return (
    <s-page heading="Branding">
      <s-section heading="Logo">
        <s-paragraph color="subdued">
          Shown in place of the plain text wordmark on the customer account portal (sign-in, create
          account, and the account dashboard) and on this app&rsquo;s own dashboard. Paste a direct
          image URL -- e.g. a link to a file already uploaded under Shopify admin&rsquo;s Content &gt;
          Files. Leave blank to use the default text wordmark instead.
        </s-paragraph>

        {/* A plain <form>, not React Router's <Form> -- s-button's shadow-DOM
            submit signal doesn't reliably reach React Router's interception,
            so Save reads this form's live FormData explicitly via useSubmit
            (same pattern as the Selling Plan Settings page). */}
        <form ref={formRef}>
          <s-stack direction="block" gap="base">
            <s-text-field name="logoUrl" label="Logo image URL" defaultValue={logoUrl} placeholder="https://" />

            {logoUrl && (
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-300">
                  <s-text color="subdued">Current logo</s-text>
                  <img src={logoUrl} alt="Logo preview" style={{ height: "40px", width: "auto", display: "block" }} />
                </s-stack>
              </s-box>
            )}

            <s-button type="button" variant="primary" onClick={save} {...(isSaving ? { loading: true } : {})}>
              Save settings
            </s-button>
          </s-stack>
        </form>
      </s-section>
    </s-page>
  );
}
