import { z } from "zod";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import { withTracing } from "@/lib/logging";
import { jsonError } from "@/lib/shared/route-resolution";
import { subscriptionCatalog } from "./catalog";
import {
  subscriptionOverviewQuerySchema,
  inboxOverviewQuerySchema,
  subscriptionScopeSchema,
} from "./controls-schemas";
import { getSubscriptionOverviewService } from "./overview-production";

const recipientsQuerySchema = subscriptionScopeSchema.extend({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});
function read<T>(schema: z.ZodType<T>, get: (query: T) => Promise<unknown>) {
  return withTracing(async (request: Request) => {
    const token = await createAgentAuth().validateOptionalToken(request);
    if (token.kind === "invalid")
      return jsonError("Invalid Command Center API token", 401);
    const params: Record<string, unknown> = {};
    for (const [key, value] of new URL(request.url).searchParams)
      params[key] = params[key] === undefined ? value : [params[key], value];
    const query = schema.safeParse(params);
    if (!query.success)
      return jsonError(
        "Invalid subscription scope or filter",
        400,
        "INVALID_SUBSCRIPTION_QUERY",
        { issues: query.error.issues },
      );
    return Response.json(await get(query.data));
  });
}
export const subscriptionOverviewGET = read(
  subscriptionOverviewQuerySchema,
  (query) => getSubscriptionOverviewService().overview(query),
);
export const subscriptionInboxOverviewGET = read(
  inboxOverviewQuerySchema,
  (query) => getSubscriptionOverviewService().inbox(query),
);
export const subscriptionRecipientsGET = read(recipientsQuerySchema, (query) =>
  getSubscriptionOverviewService().recipients(query),
);
export const subscriptionCatalogGET = read(
  z.object({}).strict(),
  async () => subscriptionCatalog,
);
