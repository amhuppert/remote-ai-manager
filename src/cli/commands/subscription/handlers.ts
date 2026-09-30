import { z } from "zod";
import {
  count,
  invocation,
  page,
  recoveryFacts,
  runner,
  writeRunner,
} from "cli-for-agents";
import type {
  CommandSpec,
  HandlerInput,
  ReadHandler,
  WriteHandler,
  Omission,
} from "cli-for-agents";
import { renderInvocation } from "cli-for-agents/runtime";
import { conversationTargetApiBase } from "@/lib/conversations/conversation-target";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
  type ConversationSubscription,
  type SubscriptionDelivery,
} from "@/lib/subscriptions/schemas";
import {
  resolveCcConversationTarget,
  explicitScopeFlags,
  type CcErrorCode,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import { quoteLiteralText } from "../../framework/literal-text";
import { cliRequest, encodePathSegment } from "../../transport";
import {
  subscriptionListCommand,
  inboxListCommand,
  inboxGetCommand,
  type subscriptionListSpec,
  type subscriptionUnfollowSpec,
  type inboxListSpec,
  type inboxGetSpec,
} from "./definitions";

type Input<S extends CommandSpec> = HandlerInput<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Read<S extends CommandSpec> = ReadHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Write<S extends CommandSpec> = WriteHandler<
  S,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
const pagination = {
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
};
const subscriptionsResponse = z.object({
  subscriptions: z.array(conversationSubscriptionSchema),
  ...pagination,
});
const inboxResponse = z.object({
  deliveries: z.array(subscriptionDeliverySchema),
  ...pagination,
});
const deliveryResponse = z.object({ delivery: subscriptionDeliverySchema });
const unfollowResponse = z.object({
  subscription: conversationSubscriptionSchema,
});

function invalidResponse() {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message:
        "The subscription response is invalid; inspect the conversation before retrying a write.",
    }),
  } as const;
}
function omissionText(
  label: string,
  omission: Pick<Omission, "total" | "returned">,
  next: string | null,
) {
  return `${label}: ${omission.total.kind === "known" ? omission.total.count : "unknown"} total, ${omission.returned} shown${next ? `\nnext: ${next}` : ""}`;
}
function singleLine(text: string) {
  return text.replace(/\s+/g, " ");
}

export const subscriptionListHandler: Read<typeof subscriptionListSpec> = {
  run: runner<
    Input<typeof subscriptionListSpec>,
    {
      subscriptions: readonly ConversationSubscription[];
      omission: Omission;
      next: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return resolved;
      const { target, ...connection } = resolved.value;
      const query = new URLSearchParams({
        limit: String(ctx.flags.limit),
        offset: String(ctx.flags.offset),
      });
      const response = await cliRequest(app.host, {
        ...connection,
        headers: { "x-cc-conversation-id": target.conversationId },
        method: "GET",
        path: `${conversationTargetApiBase(target)}/subscriptions?${query}`,
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = subscriptionsResponse.safeParse(response.body);
      if (!parsed.success) return invalidResponse();
      const { subscriptions, total, offset, limit } = parsed.data;
      const source = {
        items: subscriptions,
        total: { kind: "known", count: count(total) } as const,
      };
      const bounded = page(
        offset + subscriptions.length < total
          ? {
              ...source,
              more: true,
              reveal: invocation(subscriptionListCommand, {
                flags: {
                  ...explicitScopeFlags(app),
                  project: target.projectName,
                  conversation: target.conversationId,
                  ...(target.scope === "session"
                    ? { session: target.sessionName }
                    : {}),
                  limit,
                  offset: offset + subscriptions.length,
                },
              }),
            }
          : { ...source, more: false },
      );
      return {
        ok: true,
        data: {
          subscriptions: bounded.items,
          omission: bounded.omission,
          next: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
      };
    },
    text: ({ subscriptions, omission, next }) =>
      quoteLiteralText(
        `${omissionText("subscriptions", omission, next)}\n${subscriptions.map((s) => `${s.id}  ${s.status}  ${s.mode}  ${s.source.kind}:${s.source.id}\n  reason: ${singleLine(s.reason)}${s.lastError ? `\n  problem: ${singleLine(s.lastError)}` : ""}${s.missingAt ? `\n  source missing: ${s.missingAt}` : ""}`).join("\n")}\n`,
      ),
  }),
};

export const inboxListHandler: Read<typeof inboxListSpec> = {
  run: runner<
    Input<typeof inboxListSpec>,
    {
      deliveries: readonly (SubscriptionDelivery & { getCommand: string })[];
      omission: Omission;
      next: string | null;
    },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return resolved;
      const { target, ...connection } = resolved.value;
      const query = new URLSearchParams({
        limit: String(ctx.flags.limit),
        offset: String(ctx.flags.offset),
      });
      if (ctx.flags.all) query.set("all", "true");
      const response = await cliRequest(app.host, {
        ...connection,
        headers: { "x-cc-conversation-id": target.conversationId },
        method: "GET",
        path: `${conversationTargetApiBase(target)}/inbox?${query}`,
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = inboxResponse.safeParse(response.body);
      if (!parsed.success) return invalidResponse();
      const { deliveries, total, offset, limit } = parsed.data;
      const addressedDeliveries = deliveries.map((delivery) => ({
        ...delivery,
        getCommand: renderInvocation(
          invocation(inboxGetCommand, {
            args: { "delivery-id": delivery.id },
            flags: {
              ...explicitScopeFlags(app),
              project: target.projectName,
              conversation: target.conversationId,
              ...(target.scope === "session"
                ? { session: target.sessionName }
                : {}),
            },
          }),
          "cctl",
        ),
      }));
      const source = {
        items: addressedDeliveries,
        total: { kind: "known", count: count(total) } as const,
      };
      const bounded = page(
        offset + deliveries.length < total
          ? {
              ...source,
              more: true,
              reveal: invocation(inboxListCommand, {
                flags: {
                  ...explicitScopeFlags(app),
                  project: target.projectName,
                  conversation: target.conversationId,
                  ...(target.scope === "session"
                    ? { session: target.sessionName }
                    : {}),
                  limit,
                  offset: offset + deliveries.length,
                  ...(ctx.flags.all ? { all: true } : {}),
                },
              }),
            }
          : { ...source, more: false },
      );
      return {
        ok: true,
        data: {
          deliveries: bounded.items,
          omission: bounded.omission,
          next: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
      };
    },
    text: ({ deliveries, omission, next }) =>
      quoteLiteralText(
        `${omissionText("updates", omission, next)}\n${deliveries.map((d) => `${d.id}  ${d.state}  ${d.fact.eventKind}  ${d.fact.occurredAt}\n  ${singleLine(d.fact.sourceTitle)}: ${singleLine(d.fact.summary).slice(0, 240)}\n  get: ${d.getCommand}`).join("\n")}\n`,
      ),
  }),
};

export const inboxGetHandler: Read<typeof inboxGetSpec> = {
  run: runner<
    Input<typeof inboxGetSpec>,
    { delivery: SubscriptionDelivery },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return resolved;
      const { target, ...connection } = resolved.value;
      const response = await cliRequest(app.host, {
        ...connection,
        headers: { "x-cc-conversation-id": target.conversationId },
        method: "GET",
        path: `${conversationTargetApiBase(target)}/inbox/${encodePathSegment(ctx.args["delivery-id"])}`,
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = deliveryResponse.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : invalidResponse();
    },
    text: ({ delivery: d }) =>
      quoteLiteralText(
        `${d.id}  ${d.state}  ${d.fact.eventKind}\nsource: ${d.source.kind}:${d.source.id}  ${d.fact.sourceTitle}\nwhen: ${d.fact.occurredAt}\n${d.fact.summary}\nread: ${d.fact.retrievalHandle}\naccepted: ${d.acceptedAt ?? "not accepted"}${d.lastError ? `\nproblem: ${d.lastError}` : ""}\n`,
      ),
  }),
};

export const subscriptionUnfollowHandler: Write<
  typeof subscriptionUnfollowSpec
> = {
  run: writeRunner<
    Input<typeof subscriptionUnfollowSpec>,
    { subscription: ConversationSubscription },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const { target, ...connection } = resolved.value;
      const id = ctx.args["subscription-id"];
      const recovery = recoveryFacts([{ kind: "subscription", id }]);
      const response = await cliRequest(app.host, {
        ...connection,
        headers: { "x-cc-conversation-id": target.conversationId },
        method: "DELETE",
        path: `${conversationTargetApiBase(target)}/subscriptions/${encodePathSegment(id)}`,
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = unfollowResponse.safeParse(response.body);
      return parsed.success
        ? {
            effect: "applied",
            recovery,
            result: { ok: true, data: parsed.data },
          }
        : { effect: "unknown", recovery, result: invalidResponse() };
    },
    text: ({ subscription }) => `${subscription.id}  ${subscription.status}\n`,
  }),
};
