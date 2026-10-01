import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";

export class FileUploadError extends Error {}

const STAGED_UPLOADS_CREATE = `#graphql
  mutation GenerateStagedUploadUrl($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation CreateFile($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        ... on MediaImage {
          fileStatus
          image { url }
        }
      }
      userErrors { field message }
    }
  }
`;

const FILE_STATUS_QUERY = `#graphql
  query CheckFileStatus($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        fileStatus
        image { url }
      }
    }
  }
`;

/**
 * Uploads a single image file to Shopify (staged upload -> fileCreate),
 * polling briefly until the CDN URL is ready, and returns that URL.
 *
 * Shopify's own two-step flow: first reserve a temporary upload slot
 * (stagedUploadsCreate), POST the raw bytes there directly (not through the
 * Admin API), then register that upload as a permanent File (fileCreate) --
 * which processes asynchronously, so the CDN URL isn't available on the
 * same response and has to be polled for.
 */
export async function uploadImageFile({
  graphql,
  file,
}: {
  graphql: AdminGraphqlClient;
  file: File;
}): Promise<string> {
  const stagedTarget = await createStagedUpload({ graphql, file });
  await postFileToStagedTarget({ stagedTarget, file });
  const fileId = await createShopifyFile({ graphql, resourceUrl: stagedTarget.resourceUrl, filename: file.name });
  return await pollForImageUrl({ graphql, fileId });
}

async function createStagedUpload({ graphql, file }: { graphql: AdminGraphqlClient; file: File }) {
  const response = await graphql(STAGED_UPLOADS_CREATE, {
    variables: {
      input: [
        {
          filename: file.name,
          mimeType: file.type || "image/png",
          httpMethod: "POST",
          resource: "IMAGE",
          fileSize: String(file.size),
        },
      ],
    },
  });
  const body = (await response.json()) as {
    data?: {
      stagedUploadsCreate?: {
        stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[];
        userErrors: { field: string[]; message: string }[];
      };
    };
  };

  const result = body.data?.stagedUploadsCreate;
  if (result?.userErrors.length) {
    throw new FileUploadError(result.userErrors.map((e) => e.message).join(" "));
  }
  const target = result?.stagedTargets[0];
  if (!target) {
    throw new FileUploadError("Couldn't start the upload -- no staged target returned.");
  }
  return target;
}

async function postFileToStagedTarget({
  stagedTarget,
  file,
}: {
  stagedTarget: { url: string; parameters: { name: string; value: string }[] };
  file: File;
}) {
  // Parameters must come before the file field in the multipart body, per
  // Shopify's own documented upload flow -- this goes straight to the
  // storage target (not Shopify's own API), so there's no admin.graphql
  // client involved here.
  const body = new FormData();
  for (const { name, value } of stagedTarget.parameters) {
    body.append(name, value);
  }
  body.append("file", file, file.name);

  const response = await fetch(stagedTarget.url, { method: "POST", body });
  if (!response.ok) {
    throw new FileUploadError(`Upload to storage failed (${response.status}).`);
  }
}

async function createShopifyFile({
  graphql,
  resourceUrl,
  filename,
}: {
  graphql: AdminGraphqlClient;
  resourceUrl: string;
  filename: string;
}) {
  const response = await graphql(FILE_CREATE, {
    variables: {
      files: [{ alt: filename, contentType: "IMAGE", originalSource: resourceUrl }],
    },
  });
  const body = (await response.json()) as {
    data?: {
      fileCreate?: {
        files: { id: string; fileStatus?: string; image?: { url: string | null } }[];
        userErrors: { field: string[]; message: string }[];
      };
    };
  };

  const result = body.data?.fileCreate;
  if (result?.userErrors.length) {
    throw new FileUploadError(result.userErrors.map((e) => e.message).join(" "));
  }
  const created = result?.files[0];
  if (!created) {
    throw new FileUploadError("Upload succeeded but Shopify didn't return a file record.");
  }
  return created.id;
}

/**
 * fileCreate's own response usually has no image URL yet (processing is
 * async) -- polls node(id) a handful of times with a short delay, which is
 * normally enough for a small logo image to finish processing.
 */
async function pollForImageUrl({
  graphql,
  fileId,
  attempts = 10,
  delayMs = 700,
}: {
  graphql: AdminGraphqlClient;
  fileId: string;
  attempts?: number;
  delayMs?: number;
}): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await graphql(FILE_STATUS_QUERY, { variables: { id: fileId } });
    const body = (await response.json()) as {
      data?: { node?: { fileStatus?: string; image?: { url: string | null } } };
    };
    const node = body.data?.node;
    if (node?.fileStatus === "FAILED") {
      throw new FileUploadError("Shopify couldn't process the uploaded image.");
    }
    if (node?.image?.url) {
      return node.image.url;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new FileUploadError("The image is still processing -- please try saving again in a few seconds.");
}
