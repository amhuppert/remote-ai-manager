import type { AgentAuth } from "@/lib/agent-gateway/token";
import { z } from "zod";
import type { ConversationState } from "@/lib/conversations/schemas";
import { isOrdinaryConversationRole } from "@/lib/conversations/schemas";
import { resolveSessionConversationRoute } from "@/lib/conversations/route-resolution";
import { resolveProjectConversationRoute } from "@/lib/project-conversations/route-resolution";
import {
  jsonError,
  notFound,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  ConversationSubscription,
  SubscriptionRecipient,
  SubscriptionInboxPage,
  InboxQuery,
  SubscriptionDelivery,
} from "./schemas";

export interface SubscriptionRouteService {
  list(recipient: SubscriptionRecipient): Promise<ConversationSubscription[]>;
  unfollow(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<ConversationSubscription | null>;
  readInbox(
    recipient: SubscriptionRecipient,
    query: InboxQuery,
  ): Promise<SubscriptionInboxPage>;
  getDelivery(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<SubscriptionDelivery | null>;
}
export interface SubscriptionRouteDeps {
  getService(): SubscriptionRouteService;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  auth: Pick<AgentAuth, "validateOptionalToken">;
}
export type SubscriptionRouteContext = {
  params: Promise<Record<string, string>>;
};
const paginationSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(20),
    offset: z.coerce.number().int().nonnegative().default(0),
    all: z.enum(["true", "false"]).default("false"),
  })
  .strict();

function pagination(request: Request) {
  const params: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    params[key] = params[key] === undefined ? value : [params[key], value];
  }
  return paginationSchema.safeParse(params);
}

export function createSubscriptionRouteHandlers(
  deps: SubscriptionRouteDeps,
  scope: "session" | "project",
) {
  async function resolve(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<RouteResolution<SubscriptionRecipient>> {
    const token = await deps.auth.validateOptionalToken(request);
    if (token.kind === "invalid")
      return {
        ok: false,
        response: jsonError("Invalid Command Center API token", 401),
      };
    const claimed = request.headers.get("x-cc-conversation-id");
    if (claimed && token.kind !== "valid")
      return {
        ok: false,
        response: jsonError(
          "Conversation attribution requires an API token",
          401,
        ),
      };
    if (
      token.kind === "valid" &&
      claimed !== (await context.params)["conversationId"]
    ) {
      return {
        ok: false,
        response: jsonError(
          "The caller conversation must match the subscription recipient",
          403,
          "SUBSCRIPTION_RECIPIENT_MISMATCH",
        ),
      };
    }
    const resolved =
      scope === "session"
        ? await resolveSessionConversationRoute(deps, context)
        : await resolveProjectConversationRoute(deps, context);
    if (!resolved.ok) return resolved;
    const { conversation, projectPath, conversationId } = resolved.value;
    if (!isOrdinaryConversationRole(conversation.role)) {
      return {
        ok: false,
        response: jsonError(
          "Subscriptions are available to ordinary conversations; workflow lanes retain their assigned context policy",
          409,
          "SUBSCRIPTIONS_ORDINARY_ONLY",
        ),
      };
    }
    return { ok: true, value: { projectPath, conversationId } };
  }

  async function listGET(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<Response> {
    const query = pagination(request);
    if (!query.success)
      return jsonError(
        "Invalid subscription pagination",
        400,
        "INVALID_SUBSCRIPTION_QUERY",
        { issues: query.error.issues },
      );
    const recipient = await resolve(request, context);
    if (!recipient.ok) return recipient.response;
    const subscriptions = await deps.getService().list(recipient.value);
    const { limit, offset } = query.data;
    return Response.json({
      subscriptions: subscriptions.slice(offset, offset + limit),
      total: subscriptions.length,
      limit,
      offset,
    });
  }

  async function inboxGET(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<Response> {
    const query = pagination(request);
    if (!query.success)
      return jsonError(
        "Invalid inbox pagination",
        400,
        "INVALID_SUBSCRIPTION_QUERY",
        { issues: query.error.issues },
      );
    const recipient = await resolve(request, context);
    if (!recipient.ok) return recipient.response;
    const result = await deps.getService().readInbox(recipient.value, {
      limit: query.data.limit,
      offset: query.data.offset,
      includeSettled: query.data.all === "true",
    });
    return Response.json({
      deliveries: result.items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  }

  async function deliveryGET(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<Response> {
    const recipient = await resolve(request, context);
    if (!recipient.ok) return recipient.response;
    const delivery = await deps
      .getService()
      .getDelivery(recipient.value, (await context.params)["deliveryId"] ?? "");
    return delivery
      ? Response.json({ delivery })
      : notFound("Subscription delivery not found");
  }

  async function unfollowDELETE(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<Response> {
    const recipient = await resolve(request, context);
    if (!recipient.ok) return recipient.response;
    const subscription = await deps
      .getService()
      .unfollow(
        recipient.value,
        (await context.params)["subscriptionId"] ?? "",
      );
    return subscription
      ? Response.json({ subscription })
      : notFound("Subscription not found");
  }
  return { listGET, unfollowDELETE, inboxGET, deliveryGET };
}
