import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getShopSettings, updateShopSettings } from "../models/settings.server";
import { FileUploadError, uploadImageFile } from "../models/fileUpload.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getShopSettings(session.shop);
  return { logoUrl: settings.logoUrl ?? "" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  // An uploaded file takes priority over the pasted-URL fallback below --
  // browsers submit an empty File (size 0, name "") for an untouched file
  // input, so size is what actually distinguishes "a file was chosen" from
  // "nothing was chosen".
  const uploaded = formData.get("logoFile");
  if (uploaded instanceof File && uploaded.size > 0) {
    try {
      const logoUrl = await uploadImageFile({ graphql: admin.graphql, file: uploaded });
      await updateShopSettings(session.shop, { logoUrl });
      return { saved: true };
    } catch (error) {
      if (error instanceof FileUploadError) {
        return { saved: false, error: error.message };
      }
      throw error;
    }
  }

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
    // Clears the file input after a successful upload so the form doesn't
    // look like it still has that file staged for a second, unintended
    // submit -- the saved result is now reflected by the preview below
    // instead.
    const fileInput = formRef.current?.elements.namedItem("logoFile");
    if (fileInput instanceof HTMLInputElement) fileInput.value = "";
  }, [actionData, shopify]);

  const save = () => {
    if (formRef.current) submit(formRef.current, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <s-page heading="Branding">
      <s-section heading="Logo">
        <s-paragraph color="subdued">
          Shown in place of the plain text wordmark on the customer account portal (sign-in, create
          account, and the account dashboard) and on this app&rsquo;s own dashboard. Leave blank to
          use the default text wordmark instead.
        </s-paragraph>

        {actionData?.saved === false && actionData.error && (
          <s-paragraph tone="critical">{actionData.error}</s-paragraph>
        )}

        {/* A plain <form>, not React Router's <Form> -- s-button's shadow-DOM
            submit signal doesn't reliably reach React Router's interception,
            so Save reads this form's live FormData explicitly via useSubmit
            (same pattern as the Selling Plan Settings page). */}
        <form ref={formRef} encType="multipart/form-data">
          <s-stack direction="block" gap="base">
            <label>
              <s-text>Upload an image</s-text>
              <input type="file" name="logoFile" accept="image/*" />
            </label>

            <s-text-field
              name="logoUrl"
              label="Or paste an image URL instead"
              defaultValue={logoUrl}
              placeholder="https://"
            />

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
