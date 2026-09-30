import { z } from "zod";
import { jsonError, notFound } from "@/lib/shared/route-resolution";
import {
  subscribeRequestSchema,
  subscriptionControlRequestSchema,
  inboxPreferencesSchema,
} from "./controls-schemas";
import { validateSubscriptionSelection } from "./catalog";
import type { RouteResolution } from "@/lib/shared/route-resolution";
import type { SubscriptionRecipient } from "./schemas";
import type { SubscriptionControlsService } from "./control-service";
import type { SubscriptionDetail } from "./controls-schemas";
import type { SubscriptionRouteContext } from "./route-handlers";

export interface ControlsRouteDeps {
  resolve(
    request: Request,
    context: SubscriptionRouteContext,
  ): Promise<RouteResolution<SubscriptionRecipient>>;
  getControls(): SubscriptionControlsService & {
    getPreferences(
      recipient: SubscriptionRecipient,
    ): Promise<{ hintsEnabled: boolean }>;
    setHintsEnabled(
      recipient: SubscriptionRecipient,
      enabled: boolean,
    ): Promise<{ hintsEnabled: boolean }>;
    markDeliveryRead(
      recipient: SubscriptionRecipient,
      id: string,
      read: boolean,
    ): Promise<boolean>;
    getReadAt(
      recipient: SubscriptionRecipient,
      id: string,
    ): Promise<string | null>;
  };
  getDetail(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<SubscriptionDetail | null>;
  pendingCount(recipient: SubscriptionRecipient): Promise<number>;
  now(): string;
}
export function createSubscriptionControlsHandlers(deps: ControlsRouteDeps) {
  type Handler = (
    recipient: SubscriptionRecipient,
    id: string,
    request: Request,
  ) => Promise<Response>;
  function route(handler: Handler) {
    return async (request: Request, context: SubscriptionRouteContext) => {
      const resolved = await deps.resolve(request, context);
      if (!resolved.ok) return resolved.response;
      const params = await context.params;
      try {
        return await handler(
          resolved.value,
          params["subscriptionId"] ?? params["deliveryId"] ?? "",
          request,
        );
      } catch (error) {
        if (error instanceof SyntaxError)
          return jsonError(
            "Invalid JSON body",
            400,
            "INVALID_SUBSCRIPTION_REQUEST",
          );
        if (error instanceof z.ZodError)
          return jsonError(
            "Invalid subscription request",
            400,
            "INVALID_SUBSCRIPTION_REQUEST",
            { issues: error.issues },
          );
        if (
          error instanceof Error &&
          "status" in error &&
          typeof error.status === "number" &&
          "code" in error &&
          typeof error.code === "string"
        )
          return jsonError(error.message, error.status, error.code);
        throw error;
      }
    };
  }
  async function detail(
    recipient: SubscriptionRecipient,
    id: string,
    status = 200,
  ) {
    const value = await deps.getDetail(recipient, id);
    return value
      ? Response.json(value, { status })
      : notFound("Subscription not found");
  }
  const expiry = (seconds: number) =>
    new Date(Date.parse(deps.now()) + seconds * 1000).toISOString();
  return {
    subscribePOST: route(async (recipient, _id, request) => {
      const body = subscribeRequestSchema.parse(await request.json());
      const invalid = validateSubscriptionSelection(
        body.source.kind,
        body.mode,
        body.eventKinds,
      );
      if (invalid)
        return jsonError(invalid, 400, "INVALID_SUBSCRIPTION_SELECTION");
      const controls = deps.getControls();
      const subscription = await controls.subscribe({
        recipient,
        source: body.source,
        reason: body.reason,
        mode: body.mode,
        eventKinds: body.eventKinds,
        ...(body.mode === "active"
          ? { expiresAt: expiry(body.expiresIn ?? 86400) }
          : body.expiresIn === undefined
            ? {}
            : { expiresAt: expiry(body.expiresIn) }),
      });
      if (!subscription)
        return notFound("Subscription source or recipient not found");
      return detail(recipient, subscription.id, 201);
    }),
    detailGET: route((recipient, id) => detail(recipient, id)),
    controlPATCH: route(async (recipient, id, request) => {
      const body = subscriptionControlRequestSchema.parse(await request.json());
      const controls = deps.getControls();
      const result =
        body.action === "mode"
          ? await controls.setMode(
              recipient,
              id,
              body.mode,
              body.expiresIn === undefined ? undefined : expiry(body.expiresIn),
            )
          : await controls[body.action](recipient, id);
      return result
        ? detail(recipient, id)
        : notFound("Subscription not found");
    }),
    unfollowDELETE: route(async (recipient, id) => {
      const result = await deps.getControls().unfollow(recipient, id);
      return result
        ? Response.json({ subscription: result })
        : notFound("Subscription not found");
    }),
    summaryGET: route(async (recipient) =>
      Response.json({
        pendingCount: await deps.pendingCount(recipient),
        ...(await deps.getControls().getPreferences(recipient)),
      }),
    ),
    preferencesGET: route(async (recipient) =>
      Response.json(await deps.getControls().getPreferences(recipient)),
    ),
    preferencesPATCH: route(async (recipient, _id, request) => {
      const body = inboxPreferencesSchema.parse(await request.json());
      return Response.json(
        await deps.getControls().setHintsEnabled(recipient, body.hintsEnabled),
      );
    }),
    readPATCH: route(async (recipient, id, request) => {
      const { read } = z
        .object({ read: z.boolean() })
        .strict()
        .parse(await request.json());
      if (!(await deps.getControls().markDeliveryRead(recipient, id, read)))
        return notFound("Subscription delivery not found");
      return Response.json({
        readAt: await deps.getControls().getReadAt(recipient, id),
      });
    }),
  };
}
