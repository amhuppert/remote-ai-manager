import { z } from "zod";
import { invocation, recoveryFacts, runner, writeRunner } from "cli-for-agents";
import type {
  CommandSpec,
  HandlerInput,
  JsonData,
  ReadHandler,
  WriteHandler,
} from "cli-for-agents";
import { renderInvocation } from "cli-for-agents/runtime";
import {
  conversationTargetApiBase,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import {
  inboxPreferencesSchema,
  inboxSummarySchema,
  subscribeRequestSchema,
  subscriptionCatalogSchema,
  subscriptionDetailSchema,
  type SubscriptionCatalog,
  type SubscriptionControlRequest,
  type SubscriptionDetail,
} from "@/lib/subscriptions/controls-schemas";
import {
  explicitScopeFlags,
  resolveCcConversationTarget,
  resolveCcServer,
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
  subscriptionGetCommand,
  type subscriptionCatalogSpec,
  type subscriptionSubscribeSpec,
  type subscriptionGetSpec,
  type subscriptionPauseSpec,
  type subscriptionResumeSpec,
  type subscriptionModeSpec,
  type subscriptionCancelSpec,
  type inboxSummarySpec,
  type inboxHintsSpec,
} from "./controls-definitions";

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
type AddressedDetail = SubscriptionDetail & { getCommand: string };

function invalidResponse() {
  return {
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", {
      message:
        "The subscription response is invalid; inspect the addressed conversation before retrying a write.",
    }),
  } as const;
}
function getCommand(
  app: CcApplication,
  target: ConversationTarget,
  id: string,
) {
  return renderInvocation(
    invocation(subscriptionGetCommand, {
      args: { "subscription-id": id },
      flags: {
        ...explicitScopeFlags(app),
        project: target.projectName,
        conversation: target.conversationId,
        ...(target.scope === "session" ? { session: target.sessionName } : {}),
      },
    }),
    "cctl",
  );
}
function detailText({
  subscription: s,
  wait,
  batch,
  getCommand,
}: JsonData<AddressedDetail>) {
  return quoteLiteralText(
    `${s.id}  ${s.status}  ${s.mode}${s.wakes ? "  wakes" : ""}${s.pausedAt ? "  paused" : ""}\nsource: ${s.source.kind}:${s.source.id}\nreason: ${s.reason}\nevents: ${s.eventKinds?.join(", ") ?? "all supported"}\ncursor: ${s.cursor ?? "none"}\npaused: ${s.pausedAt ?? "no"}\nexpires: ${s.expiresAt ?? "none"}\n${wait ? `wait: ${wait.id}  ${wait.state}  ${wait.outcome ?? "pending"}\n` : ""}${batch ? `wake batch: ${batch.id}  ${batch.state}\nqueue message: ${batch.queueMessageId ?? "none"}\n` : ""}${s.lastError ? `problem: ${s.lastError}\n` : ""}${wait?.lastError ? `wait problem: ${wait.lastError}\n` : ""}${batch?.lastError ? `wake problem: ${batch.lastError}\n` : ""}${s.missingAt ? `source missing: ${s.missingAt}\n` : ""}get: ${getCommand}\n`,
  );
}

export const catalogHandler: Read<typeof subscriptionCatalogSpec> = {
  run: runner<
    Input<typeof subscriptionCatalogSpec>,
    SubscriptionCatalog,
    CcErrorCode
  >({
    async run({ app }) {
      const connection = await resolveCcServer(app);
      if (!connection.ok) return connection;
      const response = await cliRequest(app.host, {
        ...connection.value,
        method: "GET",
        path: "/api/subscriptions/catalog",
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = subscriptionCatalogSchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : invalidResponse();
    },
    text: ({ sources }) =>
      quoteLiteralText(
        sources
          .map(
            (source) =>
              `${source.kind}  ${source.label}  modes: ${source.allowedModes.join(", ")}\n  identity: ${source.identityDescription}\n  ${source.description}\n  events: ${source.eventKinds.map((event) => `${event.id} (${event.label})`).join(", ")}`,
          )
          .join("\n") + "\n",
      ),
  }),
};

export const subscribeHandler: Write<typeof subscriptionSubscribeSpec> = {
  run: writeRunner<
    Input<typeof subscriptionSubscribeSpec>,
    AddressedDetail,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const parsedInput = subscribeRequestSchema.safeParse({
        source: { kind: ctx.args.kind, id: ctx.args["source-id"] },
        reason: ctx.flags.reason,
        mode: ctx.flags.mode,
        eventKinds: ctx.flags["event-kind"].length
          ? ctx.flags["event-kind"]
          : null,
        ...(ctx.flags["expires-in"] === undefined
          ? {}
          : { expiresIn: ctx.flags["expires-in"] }),
      });
      if (!parsedInput.success)
        return {
          effect: "not_applied",
          result: {
            ok: false,
            error: ccErrors.error("CC_USAGE", {
              message: "Invalid subscription input.",
              issues: parsedInput.error.issues.map((issue) => ({
                code: "CC_INPUT_ISSUE",
                path: issue.path.map(String),
                message: issue.message,
              })),
            }),
          },
        };
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const { target, ...connection } = resolved.value;
      const recovery = recoveryFacts([
        { kind: "conversation", id: target.conversationId },
      ]);
      const response = await cliRequest(app.host, {
        ...connection,
        method: "POST",
        path: `${conversationTargetApiBase(target)}/subscriptions`,
        headers: { "x-cc-conversation-id": target.conversationId },
        body: { ...parsedInput.data, reason: ctx.flags.reason },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = subscriptionDetailSchema.safeParse(response.body);
      if (!parsed.success)
        return { effect: "unknown", recovery, result: invalidResponse() };
      return {
        effect: "applied",
        recovery: recoveryFacts([
          { kind: "subscription", id: parsed.data.subscription.id },
        ]),
        result: {
          ok: true,
          data: {
            ...parsed.data,
            getCommand: getCommand(app, target, parsed.data.subscription.id),
          },
        },
      };
    },
    text: detailText,
  }),
};

export const getHandler: Read<typeof subscriptionGetSpec> = {
  run: runner<Input<typeof subscriptionGetSpec>, AddressedDetail, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return resolved;
      const { target, ...connection } = resolved.value;
      const id = ctx.args["subscription-id"];
      const response = await cliRequest(app.host, {
        ...connection,
        method: "GET",
        path: `${conversationTargetApiBase(target)}/subscriptions/${encodePathSegment(id)}`,
        headers: { "x-cc-conversation-id": target.conversationId },
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = subscriptionDetailSchema.safeParse(response.body);
      return parsed.success
        ? {
            ok: true,
            data: { ...parsed.data, getCommand: getCommand(app, target, id) },
          }
        : invalidResponse();
    },
    text: detailText,
  }),
};

async function applyControl(
  app: CcApplication,
  id: string,
  body: SubscriptionControlRequest,
) {
  const resolved = await resolveCcConversationTarget(app);
  if (!resolved.ok) return { effect: "not_applied", result: resolved } as const;
  const { target, ...connection } = resolved.value;
  const recovery = recoveryFacts([{ kind: "subscription", id }]);
  const response = await cliRequest(app.host, {
    ...connection,
    method: "PATCH",
    path: `${conversationTargetApiBase(target)}/subscriptions/${encodePathSegment(id)}`,
    headers: { "x-cc-conversation-id": target.conversationId },
    body,
  });
  if (response.kind !== "ok") return ccWriteFailure(response, recovery);
  const parsed = subscriptionDetailSchema.safeParse(response.body);
  return parsed.success
    ? ({
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: { ...parsed.data, getCommand: getCommand(app, target, id) },
        },
      } as const)
    : ({ effect: "unknown", recovery, result: invalidResponse() } as const);
}

export const pauseHandler: Write<typeof subscriptionPauseSpec> = {
  run: writeRunner<
    Input<typeof subscriptionPauseSpec>,
    AddressedDetail,
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      applyControl(app, ctx.args["subscription-id"], { action: "pause" }),
    text: detailText,
  }),
};
export const resumeHandler: Write<typeof subscriptionResumeSpec> = {
  run: writeRunner<
    Input<typeof subscriptionResumeSpec>,
    AddressedDetail,
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      applyControl(app, ctx.args["subscription-id"], { action: "resume" }),
    text: detailText,
  }),
};
export const cancelHandler: Write<typeof subscriptionCancelSpec> = {
  run: writeRunner<
    Input<typeof subscriptionCancelSpec>,
    AddressedDetail,
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      applyControl(app, ctx.args["subscription-id"], { action: "cancel" }),
    text: detailText,
  }),
};
export const modeHandler: Write<typeof subscriptionModeSpec> = {
  run: writeRunner<
    Input<typeof subscriptionModeSpec>,
    AddressedDetail,
    CcErrorCode
  >({
    run: ({ app, ctx }) =>
      applyControl(app, ctx.args["subscription-id"], {
        action: "mode",
        mode: ctx.args.mode,
        ...(ctx.flags["expires-in"] === undefined
          ? {}
          : { expiresIn: ctx.flags["expires-in"] }),
      }),
    text: detailText,
  }),
};

export const inboxSummaryHandler: Read<typeof inboxSummarySpec> = {
  run: runner<
    Input<typeof inboxSummarySpec>,
    z.infer<typeof inboxSummarySchema>,
    CcErrorCode
  >({
    async run({ app }) {
      const resolved = await resolveCcConversationTarget(app);
      if (!resolved.ok) return resolved;
      const { target, ...connection } = resolved.value;
      const response = await cliRequest(app.host, {
        ...connection,
        method: "GET",
        path: `${conversationTargetApiBase(target)}/inbox/summary`,
        headers: { "x-cc-conversation-id": target.conversationId },
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = inboxSummarySchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : invalidResponse();
    },
    text: ({ pendingCount, hintsEnabled }) =>
      `pending updates: ${pendingCount}\nhints: ${hintsEnabled ? "on" : "off"}\n`,
  }),
};
export const inboxHintsHandler: Write<typeof inboxHintsSpec> = {
  run: writeRunner<
    Input<typeof inboxHintsSpec>,
    z.infer<typeof inboxPreferencesSchema>,
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
        method: "PATCH",
        path: `${conversationTargetApiBase(target)}/inbox/preferences`,
        headers: { "x-cc-conversation-id": target.conversationId },
        body: { hintsEnabled: ctx.args.state === "on" },
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = inboxPreferencesSchema.safeParse(response.body);
      return parsed.success
        ? {
            effect: "applied",
            recovery,
            result: { ok: true, data: parsed.data },
          }
        : { effect: "unknown", recovery, result: invalidResponse() };
    },
    text: ({ hintsEnabled }) => `inbox hints: ${hintsEnabled ? "on" : "off"}\n`,
  }),
};
