import { quoteLiteralText } from "../../framework/literal-text";
import {
  invocation,
  mutation,
  recoveryFacts,
  runner,
  writeRunner,
  type CommandSpec,
  type JsonData,
  type HandlerInput,
  type MutationHandler,
  type ReadHandler,
  type WriteHandler,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import {
  agentRunCreatedResponseSchema,
  agentRunRequestSchema,
  agentRunStatusResponseSchema,
  agentRunStatusSchema,
  type AgentRunRequest,
  type AgentRunStatusResponse,
} from "@/lib/agent-runs/schemas";
import {
  agentProfileLibraryEntrySchema,
  agentProfileLibraryListingSchema,
  formatAgentProfileRef,
  parseAgentProfileRef,
  type AgentProfileLibraryEntry,
  type AgentProfileLibraryListing,
} from "@/lib/agent-profiles/schemas";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import {
  explicitScopeFlags,
  resolveCcProject,
  resolveCcSession,
  type CcErrorCode,
  sessionReference,
} from "../../framework/context";
import { ccRequestFailure, ccWriteFailure } from "../../framework/request";
import { observeJob, waitDurationMs } from "../../framework/observe-job";
import {
  cliRequest,
  encodePathSegment,
  type ProjectContext,
  type SessionContext,
} from "../../transport";
import {
  agentStatusCommand,
  agentGetCommand,
  agentListCommand,
  type agentRunSpec,
  type agentStatusSpec,
  type agentCancelSpec,
  type agentListSpec,
  type agentGetSpec,
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
type Run = MutationHandler<
  typeof agentRunSpec,
  CcApplication,
  { context: SessionContext; waitMs: number },
  typeof ccErrors.definitions,
  typeof ccGlobalFlags,
  AgentRunRequest
>;
const cancelResponseSchema = z.object({
  ok: z.literal(true),
  status: agentRunStatusSchema,
});
type RunData = {
  runId: string;
  status: "started" | AgentRunStatusResponse["status"];
  backend?: AgentRunStatusResponse["backend"];
  summary?: string;
  referenceDocuments?: AgentRunStatusResponse["referenceDocuments"];
  error?: string;
};
const invalid = (message: string) =>
  ({
    ok: false,
    error: ccErrors.error("CC_INVALID_RESPONSE", { message }),
  }) as const;
function runsPath(context: SessionContext) {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/agent-runs`;
}
function profilesPath(context: ProjectContext) {
  return `/api/projects/${encodePathSegment(context.project)}/agent-profiles`;
}
function runText(data: JsonData<RunData>): string {
  return quoteLiteralText(
    [
      `Agent run ${data.runId}: ${data.status}`,
      ...("summary" in data && data.summary ? [data.summary] : []),
      ...("error" in data && data.error ? [data.error] : []),
      ...("referenceDocuments" in data
        ? (data.referenceDocuments ?? []).map(
            (doc) => `${doc.filePath} — ${doc.description}`,
          )
        : []),
    ].join("\n") + "\n",
  );
}
const runImplementation: Run = {
  decode: agentRunRequestSchema,
  async prepare({ app, ctx }) {
    if (ctx.flags.timeout !== undefined && !ctx.flags.wait)
      return {
        ok: false,
        error: ccErrors.error("CC_USAGE", {
          message: "--timeout only applies with --wait.",
        }),
      };
    const waitMs = waitDurationMs(ctx.flags.timeout ?? "30m");
    if (waitMs === null)
      return {
        ok: false,
        error: ccErrors.error("CC_USAGE", {
          message: "The wait duration is too large.",
        }),
      };
    const context = await resolveCcSession(app);
    return context.ok
      ? { ok: true, value: { context: context.value, waitMs } }
      : context;
  },
  commit: writeRunner<Parameters<Run["commit"]>[0], RunData, CcErrorCode>({
    async run({ app, ctx, payload, prepared }) {
      const { context, waitMs } = prepared.value;
      const target = recoveryFacts([sessionReference(context.session)]);
      const response = await cliRequest(app.host, {
        ...context,
        method: "POST",
        path: runsPath(context),
        body: payload,
      });
      if (response.kind !== "ok") return ccWriteFailure(response, target);
      const created = agentRunCreatedResponseSchema.safeParse(response.body);
      if (!created.success || !created.data.runId.trim())
        return {
          effect: "unknown",
          recovery: target,
          result: invalid("The agent endpoint did not return a run receipt."),
        };
      const runId = created.data.runId;
      const recovery = recoveryFacts([{ kind: "agent-run", id: runId }]);
      const followup = hint(
        invocation(agentStatusCommand, {
          args: { "run-id": runId },
          flags: {
            ...explicitScopeFlags(app),
            project: context.project,
            session: context.session,
          },
        }),
        "Read this durable agent run",
      );
      if (!ctx.flags.wait)
        return {
          effect: "applied",
          recovery,
          result: {
            ok: true,
            data: { runId, status: "started" },
            hint: followup,
          },
        };
      const observed = await observeJob<AgentRunStatusResponse>({
        clock: ctx.clock,
        signal: ctx.signal,
        timeoutMs: waitMs,
        async poll({ remainingMs }) {
          const response = await cliRequest(app.host, {
            ...context,
            method: "GET",
            path: `${runsPath(context)}/${encodePathSegment(runId)}`,
            timeoutMs: Math.max(1, Math.ceil(remainingMs)),
          });
          if (response.kind !== "ok")
            return { kind: "failure", failure: ccRequestFailure(response) };
          const parsed = agentRunStatusResponseSchema.safeParse(response.body);
          if (!parsed.success || parsed.data.runId !== runId)
            return { kind: "invalid" };
          return parsed.data.status === "running"
            ? { kind: "pending" }
            : { kind: "done", value: parsed.data };
        },
      });
      if (observed.kind === "done")
        return {
          effect: "applied",
          recovery,
          result:
            observed.value.status === "completed"
              ? { ok: true, data: observed.value }
              : {
                  ok: false,
                  data: observed.value,
                  error: ccErrors.error("CC_OPERATION_FAILED", {
                    message:
                      "The agent run failed; inspect the run error for details.",
                  }),
                  hint: followup,
                },
        };
      if (observed.kind === "failure")
        return {
          effect: "applied",
          recovery,
          result: { ...observed.failure, data: { runId, status: "started" } },
        };
      const result =
        observed.kind === "invalid"
          ? invalid("The agent status response remained unreadable.")
          : ({
              ok: false,
              error: ccErrors.error("CC_OPERATION_FAILED", {
                message:
                  observed.kind === "timeout"
                    ? "The agent wait timed out; the durable run continues."
                    : "Agent observation was interrupted; the durable run continues.",
              }),
            } as const);
      return {
        effect: "applied",
        recovery,
        result: {
          ...result,
          data: { runId, status: "started" },
          hint: followup,
        },
      };
    },
    text: runText,
  }),
};
export const runHandler = mutation(runImplementation);
export const statusHandler: Read<typeof agentStatusSpec> = {
  run: runner<
    Input<typeof agentStatusSpec>,
    AgentRunStatusResponse,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${runsPath(resolved.value)}/${encodePathSegment(ctx.args["run-id"])}`,
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = agentRunStatusResponseSchema.safeParse(response.body);
      return parsed.success && parsed.data.runId === ctx.args["run-id"]
        ? { ok: true, data: parsed.data }
        : invalid("The agent status response is invalid.");
    },
    text: runText,
  }),
};
export const cancelHandler: Write<typeof agentCancelSpec> = {
  run: writeRunner<
    Input<typeof agentCancelSpec>,
    { runId: string; status: AgentRunStatusResponse["status"] },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const resolved = await resolveCcSession(app);
      if (!resolved.ok) return { effect: "not_applied", result: resolved };
      const runId = ctx.args["run-id"];
      const recovery = recoveryFacts([{ kind: "agent-run", id: runId }]);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "POST",
        path: `${runsPath(resolved.value)}/${encodePathSegment(runId)}/cancel`,
      });
      if (response.kind !== "ok") return ccWriteFailure(response, recovery);
      const parsed = cancelResponseSchema.safeParse(response.body);
      if (!parsed.success)
        return {
          effect: "unknown",
          recovery,
          result: invalid(
            "The agent cancellation acknowledgement is invalid; read status before retrying.",
          ),
        };
      return {
        effect: "applied",
        recovery,
        result: {
          ok: true,
          data: { runId, status: parsed.data.status },
          hint: hint(
            invocation(agentStatusCommand, {
              flags: explicitScopeFlags(app),
              args: { "run-id": runId },
            }),
            "Read the resulting run state",
          ),
        },
      };
    },
    text: ({ runId, status }) =>
      quoteLiteralText(
        `Cancellation requested for agent run ${runId}; status: ${status}.\n`,
      ),
  }),
};
export const listHandler: Read<typeof agentListSpec> = {
  run: runner<
    Input<typeof agentListSpec>,
    AgentProfileLibraryListing,
    CcErrorCode
  >({
    async run({ app }) {
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: profilesPath(resolved.value),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = agentProfileLibraryListingSchema.safeParse(response.body);
      if (!parsed.success)
        return invalid("The agent profile listing is invalid.");
      const first = parsed.data.profiles[0];
      return {
        ok: true,
        data: parsed.data,
        ...(first
          ? {
              hint: hint(
                invocation(agentGetCommand, {
                  flags: explicitScopeFlags(app),
                  args: { profile: formatAgentProfileRef(first.ref) },
                }),
                "Read profile instructions",
              ),
            }
          : {}),
      };
    },
    text: ({ profiles, diagnostics }) =>
      quoteLiteralText(
        [
          `${profiles.length} agent profiles`,
          ...profiles.flatMap((profile) => [
            `${formatAgentProfileRef(profile.ref)} (rev ${profile.revision}) ${profile.name} — ${profile.description}`,
            `  for: ${profile.recommendedFor.join(", ") || "any"}; tags: ${profile.tags.join(", ") || "none"}${profile.readOnly ? "; read-only" : ""}`,
          ]),
          ...(diagnostics.length
            ? [
                "Unreadable records (quarantined):",
                ...diagnostics.map(
                  (item) => `${item.tier}:${item.id} — ${item.reason}`,
                ),
              ]
            : []),
        ].join("\n") + "\n",
      ),
  }),
};
export const getHandler: Read<typeof agentGetSpec> = {
  run: runner<
    Input<typeof agentGetSpec>,
    { profile: AgentProfileLibraryEntry },
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const ref = parseAgentProfileRef(ctx.args.profile);
      if (!ref.ok)
        return {
          ok: false,
          error: ccErrors.error("CC_USAGE", {
            message: ref.failure.message,
            details: { ...ref.failure },
          }),
          hint: hint(
            invocation(agentListCommand, { flags: explicitScopeFlags(app) }),
            "List qualified references",
          ),
        };
      const resolved = await resolveCcProject(app);
      if (!resolved.ok) return resolved;
      const response = await cliRequest(app.host, {
        ...resolved.value,
        method: "GET",
        path: `${profilesPath(resolved.value)}/${encodePathSegment(ref.ref.tier)}/${encodePathSegment(ref.ref.id)}`,
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = agentProfileLibraryEntrySchema.safeParse(response.body);
      return parsed.success
        ? { ok: true, data: { profile: parsed.data } }
        : invalid("The agent profile response is invalid.");
    },
    text: ({ profile }) =>
      quoteLiteralText(
        `${profile.tier}:${profile.id} (rev ${profile.revision}) ${profile.name}\n${profile.description}\nfor: ${profile.recommendedFor.join(", ") || "any"}; tags: ${profile.tags.join(", ") || "none"}${profile.readOnly ? "; read-only" : ""}\n\n${profile.instructions}\n`,
      ),
  }),
};
