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
  activeSubscriptionWaitSchema,
  subscriptionWakeBatchSchema,
  type ActiveSubscriptionWait,
  type SubscriptionWakeBatch,
} from "@/lib/subscriptions/active-wait-schemas";
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
import { subscriptionGetCommand } from "./controls-definitions";
import {
  subscriptionListCommand,
  inboxListCommand,
  inboxGetCommand,
  subscriptionWaitGetCommand,
  subscriptionWaitsCommand,
  type subscriptionListSpec,
  type subscriptionUnfollowSpec,
  type inboxListSpec,
  type inboxGetSpec,
  type subscriptionWaitSpec,
  type subscriptionWaitsSpec,
  type subscriptionWaitGetSpec,
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
const waitResponse = z.object({ wait: activeSubscriptionWaitSchema });
const waitsResponse = z.object({
  waits: z.array(activeSubscriptionWaitSchema),
  ...pagination,
});
const waitDetailResponse = waitResponse.extend({
  batch: subscriptionWakeBatchSchema.nullable(),
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
function summary(text: string, limit = 240) {
  const line = singleLine(text);
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

export const subscriptionWaitHandler: Write<typeof subscriptionWaitSpec> = {
  run: writeRunner<
    Input<typeof subscriptionWaitSpec>,
    { wait: ActiveSubscriptionWait; getCommand: string },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const { target, ...connection } = resolved.value;
      const recovery = recoveryFacts([
        { kind: "conversation", id: target.conversationId },
      ]);
      const response = await cliRequest(app.host, {
        ...connection,
        headers: { "x-cc-conversation-id": target.conversationId },
        method: "POST",
        path: `${conversationTargetApiBase(target)}/subscriptions/waits`,
        body: {
          source: { kind: ctx.args.kind, id: ctx.args["source-id"] },
          reason: ctx.flags.reason,
          expiresIn: ctx.flags["expires-in"],
        },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = waitResponse.safeParse(response.body);
      if (!parsed.success)
        return { effect: "unknown", recovery, result: invalidResponse() };
      const { wait } = parsed.data;
      const getCommand = renderInvocation(
        invocation(subscriptionWaitGetCommand, {
          args: { "subscription-id": wait.subscriptionId },
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
      );
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "subscription", id: wait.subscriptionId },
          { kind: "subscription-wait", id: wait.id },
        ]),
        result: { ok: true, data: { wait, getCommand } },
      };
    },
    text: ({ wait, getCommand }) =>
      quoteLiteralText(
        `${wait.id}  ${wait.state}  ${wait.source.kind}:${wait.source.id}\nsubscription: ${wait.subscriptionId}\nexpires: ${wait.expiresAt}\nget: ${getCommand}\n`,
      ),
  }),
};

type WaitOutline = Pick<
  ActiveSubscriptionWait,
  | "id"
  | "subscriptionId"
  | "source"
  | "state"
  | "outcome"
  | "expiresAt"
  | "batchId"
  | "deliveryId"
> & {
  reasonSummary: string;
  getCommand: string;
};

export const subscriptionWaitsHandler: Read<typeof subscriptionWaitsSpec> = {
  run: runner<
    Input<typeof subscriptionWaitsSpec>,
    { waits: readonly WaitOutline[]; omission: Omission; next: string | null },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return resolved;
      const { target, ...connection } = resolved.value;
      const flags = {
        ...explicitScopeFlags(app),
        project: target.projectName,
        conversation: target.conversationId,
        ...(target.scope === "session" ? { session: target.sessionName } : {}),
      };
      const query = new URLSearchParams({
        limit: String(ctx.flags.limit),
        offset: String(ctx.flags.offset),
      });
      const response = await cliRequest(app.host, {
        ...connection,
        headers: { "x-cc-conversation-id": target.conversationId },
        method: "GET",
        path: `${conversationTargetApiBase(target)}/subscriptions/waits?${query}`,
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = waitsResponse.safeParse(response.body);
      if (!parsed.success) return invalidResponse();
      const { waits, total, offset, limit } = parsed.data;
      const items = waits.map((wait) => ({
        id: wait.id,
        subscriptionId: wait.subscriptionId,
        source: wait.source,
        state: wait.state,
        outcome: wait.outcome,
        expiresAt: wait.expiresAt,
        batchId: wait.batchId,
        deliveryId: wait.deliveryId,
        reasonSummary: singleLine(wait.reason).slice(0, 240),
        getCommand: renderInvocation(
          invocation(subscriptionWaitGetCommand, {
            args: { "subscription-id": wait.subscriptionId },
            flags,
          }),
          "cctl",
        ),
      }));
      const source = {
        items,
        total: { kind: "known", count: count(total) } as const,
      };
      const bounded = page(
        offset + waits.length < total
          ? {
              ...source,
              more: true,
              reveal: invocation(subscriptionWaitsCommand, {
                flags: { ...flags, limit, offset: offset + waits.length },
              }),
            }
          : { ...source, more: false },
      );
      return {
        ok: true,
        data: {
          waits: bounded.items,
          omission: bounded.omission,
          next: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
        },
      };
    },
    text: ({ waits, omission, next }) =>
      quoteLiteralText(
        `${omissionText("waits", omission, next)}\n${waits.map((wait) => `${wait.id}  ${wait.state}  ${wait.source.kind}:${wait.source.id}  ${wait.outcome ?? "pending"}\n  subscription: ${wait.subscriptionId}  expires: ${wait.expiresAt}\n  reason: ${wait.reasonSummary}\n  get: ${wait.getCommand}`).join("\n")}\n`,
      ),
  }),
};

export const subscriptionWaitGetHandler: Read<typeof subscriptionWaitGetSpec> =
  {
    run: runner<
      Input<typeof subscriptionWaitGetSpec>,
      {
        wait: ActiveSubscriptionWait;
        batch: SubscriptionWakeBatch | null;
        deliveryCommand: string | null;
      },
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
          path: `${conversationTargetApiBase(target)}/subscriptions/waits/${encodePathSegment(ctx.args["subscription-id"])}`,
        });
        if (response.kind !== "ok") return ccRequestFailure(response);
        const parsed = waitDetailResponse.safeParse(response.body);
        if (!parsed.success) return invalidResponse();
        const { wait, batch } = parsed.data;
        const deliveryCommand = wait.deliveryId
          ? renderInvocation(
              invocation(inboxGetCommand, {
                args: { "delivery-id": wait.deliveryId },
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
            )
          : null;
        return { ok: true, data: { wait, batch, deliveryCommand } };
      },
      text: ({ wait, batch, deliveryCommand }) =>
        quoteLiteralText(
          `${wait.id}  ${wait.state}  ${wait.outcome ?? "pending"}\nsubscription: ${wait.subscriptionId}\nsource: ${wait.source.kind}:${wait.source.id}\nreason: ${wait.reason}\nexpires: ${wait.expiresAt}\nwake batch: ${batch ? `${batch.id}  ${batch.state}\nqueue message: ${batch.queueMessageId}` : "not batched"}${deliveryCommand ? `\ndelivery: ${deliveryCommand}` : ""}${wait.causationBatchIds.length ? `\ncausation: ${wait.causationBatchIds.join(", ")}` : ""}${(batch?.lastError ?? wait.lastError) ? `\nproblem: ${batch?.lastError ?? wait.lastError}` : ""}\n`,
        ),
    }),
  };

type SubscriptionOutline = Pick<
  ConversationSubscription,
  "id" | "source" | "mode" | "status" | "pausedAt" | "missingAt"
> & {
  reasonSummary: string;
  reasonCharacters: number;
  lastErrorSummary: string | null;
  getCommand: string;
};

export const subscriptionListHandler: Read<typeof subscriptionListSpec> = {
  run: runner<
    Input<typeof subscriptionListSpec>,
    {
      subscriptions: readonly SubscriptionOutline[];
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
      const flags = {
        ...explicitScopeFlags(app),
        project: target.projectName,
        conversation: target.conversationId,
        ...(target.scope === "session" ? { session: target.sessionName } : {}),
      };
      const source = {
        items: subscriptions.map((subscription) => ({
          id: subscription.id,
          source: subscription.source,
          mode: subscription.mode,
          status: subscription.status,
          pausedAt: subscription.pausedAt,
          missingAt: subscription.missingAt,
          reasonSummary: summary(subscription.reason),
          reasonCharacters: subscription.reason.length,
          lastErrorSummary:
            subscription.lastError === null
              ? null
              : summary(subscription.lastError),
          getCommand: renderInvocation(
            invocation(subscriptionGetCommand, {
              args: { "subscription-id": subscription.id },
              flags,
            }),
            "cctl",
          ),
        })),
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
        `${omissionText("subscriptions", omission, next)}\n${subscriptions.map((s) => `${s.id}  ${s.status}  ${s.mode}${s.pausedAt ? "  paused" : ""}  ${s.source.kind}:${s.source.id}\n  reason (${s.reasonCharacters} chars): ${s.reasonSummary}${s.lastErrorSummary ? `\n  problem: ${s.lastErrorSummary}` : ""}${s.missingAt ? `\n  source missing: ${s.missingAt}` : ""}\n  get: ${s.getCommand}`).join("\n")}\n`,
      ),
  }),
};

type DeliveryOutline = Pick<
  SubscriptionDelivery,
  "id" | "subscriptionId" | "source" | "state"
> & {
  eventKind: string;
  occurredAt: string;
  sourceTitle: string;
  summary: string;
  summaryCharacters: number;
  getCommand: string;
};

export const inboxListHandler: Read<typeof inboxListSpec> = {
  run: runner<
    Input<typeof inboxListSpec>,
    {
      deliveries: readonly DeliveryOutline[];
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
        id: delivery.id,
        subscriptionId: delivery.subscriptionId,
        source: delivery.source,
        state: delivery.state,
        eventKind: delivery.fact.eventKind,
        occurredAt: delivery.fact.occurredAt,
        sourceTitle: summary(delivery.fact.sourceTitle, 120),
        summary: summary(delivery.fact.summary),
        summaryCharacters: delivery.fact.summary.length,
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
        `${omissionText("updates", omission, next)}\n${deliveries.map((d) => `${d.id}  ${d.state}  ${d.eventKind}  ${d.occurredAt}\n  ${d.sourceTitle} (${d.summaryCharacters} chars): ${d.summary}\n  get: ${d.getCommand}`).join("\n")}\n`,
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
