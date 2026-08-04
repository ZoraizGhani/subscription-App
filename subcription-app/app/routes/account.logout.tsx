import type { LoaderFunctionArgs } from "react-router";

import { destroyPortalSession } from "../portal-auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return destroyPortalSession(request);
};
