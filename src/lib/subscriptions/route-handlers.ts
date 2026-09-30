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
  ActiveSubscriptionWait,
  RegisterActiveWaitInput,
  SubscriptionWakeBatch,
} from "./active-wait-schemas";
import { registerActiveWaitSchema } from "./active-wait-schemas";
import {
  ActiveWaitConflictError,
  ActiveWaitRegistrationError,
} from "./active-wait-service";
import type {
  ConversationSubscription,
  SubscriptionRecipient,
  SubscriptionInboxPage,
  InboxQuery,
  SubscriptionDelivery,
} from "./schemas";

export interface SubscriptionRouteService {
  list(recipient: SubscriptionRecipient): Promise<ConversationSubscription[]>;
  listRecorded(
    recipient: SubscriptionRecipient,
  ): Promise<ConversationSubscription[]>;
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
  getWaitService(): SubscriptionWaitRouteService;
  now(): string;
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
export interface SubscriptionWaitRouteService {
  register(
    input: Omit<RegisterActiveWaitInput, "causationBatchIds">,
  ): Promise<ActiveSubscriptionWait>;
  list(recipient: SubscriptionRecipient): Promise<ActiveSubscriptionWait[]>;
  get(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
  ): Promise<ActiveSubscriptionWait | null>;
  getBatch(batchId: string): Promise<SubscriptionWakeBatch | null>;
  cancel(
    recipient: SubscriptionRecipient,
    subscriptionId: string,
  ): Promise<ActiveSubscriptionWait | null>;
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
const waitPaginationSchema = paginationSchema.omit({ all: true });
const waitRequestSchema = registerActiveWaitSchema
  .pick({ source: true, reason: true })
  .extend({ expiresIn: z.number().int().min(1).max(604800).default(86400) })
  .strict();

function paginationParams(request: Request) {
  const params: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    params[key] = params[key] === undefined ? value : [params[key], value];
  }
  return params;
}
function pagination(request: Request) {
  return paginationSchema.safeParse(paginationParams(request));
}
function waitErrorResponse(error: unknown): Response | null {
  return error instanceof ActiveWaitConflictError ||
    error instanceof ActiveWaitRegistrationError
    ? jsonError(error.message, error.status, error.code)
    : null;
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
    const id = (await context.params)["subscriptionId"] ?? "";
    const waits = deps.getWaitService();
    if (await waits.get(recipient.value, id)) {
      try {
        const cancelled = await waits.cancel(recipient.value, id);
        if (!cancelled) return notFound("Subscription not found");
        const subscriptions = await deps
          .getService()
          .listRecorded(recipient.value);
        const subscription = subscriptions.find((record) => record.id === id);
        return subscription
          ? Response.json({ subscription })
          : notFound("Subscription not found");
      } catch (error) {
        const response = waitErrorResponse(error);
        if (response) return response;
        throw error;
      }
    }
    const subscription = await deps.getService().unfollow(recipient.value, id);
    return subscription
      ? Response.json({ subscription })
      : notFound("Subscription not found");
  }
  async function waitPOST(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<Response> {
    const recipient = await resolve(request, context);
    if (!recipient.ok) return recipient.response;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid active wait JSON", 400, "INVALID_ACTIVE_WAIT");
    }
    const parsed = waitRequestSchema.safeParse(body);
    if (!parsed.success)
      return jsonError("Invalid active wait", 400, "INVALID_ACTIVE_WAIT", {
        issues: parsed.error.issues,
      });
    const { source, reason, expiresIn } = parsed.data;
    try {
      const wait = await deps.getWaitService().register({
        recipient: recipient.value,
        source,
        reason,
        expiresAt: new Date(
          Date.parse(deps.now()) + expiresIn * 1000,
        ).toISOString(),
      });
      return Response.json({ wait }, { status: 201 });
    } catch (error) {
      const response = waitErrorResponse(error);
      if (response) return response;
      throw error;
    }
  }
  async function waitsGET(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<Response> {
    const query = waitPaginationSchema.safeParse(paginationParams(request));
    if (!query.success)
      return jsonError(
        "Invalid active wait pagination",
        400,
        "INVALID_SUBSCRIPTION_QUERY",
        { issues: query.error.issues },
      );
    const recipient = await resolve(request, context);
    if (!recipient.ok) return recipient.response;
    const waits = await deps.getWaitService().list(recipient.value);
    const { limit, offset } = query.data;
    return Response.json({
      waits: waits.slice(offset, offset + limit),
      total: waits.length,
      limit,
      offset,
    });
  }
  async function waitGET(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<Response> {
    const recipient = await resolve(request, context);
    if (!recipient.ok) return recipient.response;
    const service = deps.getWaitService();
    const wait = await service.get(
      recipient.value,
      (await context.params)["subscriptionId"] ?? "",
    );
    if (!wait) return notFound("Active subscription wait not found");
    const batch = wait.batchId ? await service.getBatch(wait.batchId) : null;
    return Response.json({ wait, batch });
  }
  return {
    resolve,
    listGET,
    unfollowDELETE,
    inboxGET,
    deliveryGET,
    waitPOST,
    waitsGET,
    waitGET,
  };
}
