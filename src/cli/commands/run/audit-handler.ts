import {
  count,
  invocation,
  page,
  runner,
  type HandlerInput,
  type JsonValue,
  type ReadHandler,
} from "cli-for-agents";
import { renderInvocation } from "cli-for-agents/runtime";
import { z } from "zod";
import { runAuditSchema } from "@/lib/runs/schemas";
import {
  explicitScopeFlags,
  resolveCcPrincipal,
  type CcErrorCode,
} from "../../framework/context";
import {
  ccErrors,
  type CcApplication,
  type ccGlobalFlags,
} from "../../framework/family";
import { ccRequestFailure } from "../../framework/request";
import { quoteLiteralText } from "../../framework/literal-text";
import { cliRequest } from "../../transport";
import { readCommand } from "../conversation/definitions";
import { logReportCommand } from "../logs/definitions";
import { runAuditCommand, runAuditSpec } from "./definitions";
import { resolveRunRead } from "./handlers";

type Input = HandlerInput<
  typeof runAuditSpec,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Handler = ReadHandler<
  typeof runAuditSpec,
  CcApplication,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
interface AuditData {
  audit: JsonValue;
  contexts: Array<{
    contextId: string;
    readCommand: string;
    agents: Array<{
      conversationId: string;
      transcriptCommand: string;
      localLogsCommand: string;
    }>;
  }>;
  nextCommand: string | null;
  fullCommand: string;
  ownerTranscriptCommand: string;
}

const auditRun = (full: boolean) =>
  runner<Input, AuditData, CcErrorCode>({
    async run({ app, ctx }) {
      const resolved = await resolveRunRead(app, ctx.args["run-id"]);
      if (!resolved.ok) return resolved;
      const query = new URLSearchParams({
        full: String(full),
        limit: String(ctx.flags.limit),
        offset: String(ctx.flags.offset),
      });
      if (ctx.flags.context !== undefined)
        query.set("context", ctx.flags.context);
      const response = await cliRequest(app.host, {
        ...resolved.value,
        path: `${resolved.value.path}/audit?${query}`,
        method: "GET",
        principalIdentity: resolveCcPrincipal(app),
      });
      if (response.kind !== "ok") return ccRequestFailure(response);
      const parsed = runAuditSchema.safeParse(response.body);
      if (!parsed.success || parsed.data.run.runId !== ctx.args["run-id"])
        return {
          ok: false,
          error: ccErrors.error("CC_INVALID_RESPONSE", {
            message: "The run audit is invalid.",
          }),
        };
      const audit = parsed.data;
      const flags = { ...explicitScopeFlags(app), ...ctx.flags };
      const fullCommand = renderInvocation(
        invocation(runAuditCommand, { args: ctx.args, flags, level: "full" }),
        "cctl",
      );
      const contexts = audit.contexts.items.map((context) => ({
        contextId: context.contextId,
        readCommand: renderInvocation(
          invocation(runAuditCommand, {
            args: ctx.args,
            flags: { ...flags, context: context.contextId, offset: 0 },
          }),
          "cctl",
        ),
        agents: (context.detail?.agents ?? []).map((agent) => ({
          conversationId: agent.conversationId,
          localLogsCommand: renderInvocation(
            invocation(logReportCommand, {
              flags: {
                "conversation-id": agent.conversationId,
                since: audit.run.createdAt,
                until: audit.run.updatedAt,
              },
            }),
            "cctl",
          ),
          transcriptCommand: renderInvocation(
            invocation(readCommand, {
              args: { "conversation-id": agent.conversationId },
              // Each id locates its own transcript, including a historical lane seat.
              flags: {
                ...(app.globals.server === undefined
                  ? {}
                  : { server: app.globals.server }),
                outline: true,
              },
            }),
            "cctl",
          ),
        })),
      }));
      const source = {
        items: contexts,
        total: { kind: "known", count: count(audit.contexts.total) } as const,
      };
      const bounded = page(
        audit.contexts.nextOffset === null
          ? { ...source, more: false }
          : {
              ...source,
              more: true,
              reveal: invocation(runAuditCommand, {
                args: ctx.args,
                flags: { ...flags, offset: audit.contexts.nextOffset },
              }),
            },
      );
      return {
        ok: true,
        data: {
          audit: z.json().parse(JSON.parse(JSON.stringify(audit))),
          contexts,
          nextCommand: bounded.omission.truncated
            ? renderInvocation(bounded.omission.reveal, "cctl")
            : null,
          fullCommand,
          ownerTranscriptCommand: renderInvocation(
            invocation(readCommand, {
              args: { "conversation-id": audit.run.ownerConversationId },
              flags: {
                ...(app.globals.server === undefined
                  ? {}
                  : { server: app.globals.server }),
                outline: true,
              },
            }),
            "cctl",
          ),
        },
      };
    },
    text(data) {
      const audit = runAuditSchema.parse(data.audit);
      if (audit.selection.full || audit.selection.context !== null)
        return quoteLiteralText(`${JSON.stringify(data, null, 2)}\n`);
      const lines = [
        "Coverage: context-seat conversations and durable engine evidence. Ephemeral lane-task transcripts and provider wire requests are unavailable; inspect workspace outcomes and server logs for lane tasks.",
        `Run ${audit.run.runId}: ${audit.run.title} (${audit.run.progress})`,
        `${audit.run.projectPath} / ${audit.run.sessionName}; ${audit.run.createdAt} to ${audit.run.updatedAt}`,
        `Owner conversation: ${audit.run.ownerConversationId}; revision ${audit.run.revision}`,
        `Owner transcript: ${data.ownerTranscriptCommand}`,
        `Totals: ${Object.entries(audit.totals)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`,
        `Contexts: ${audit.contexts.returned} of ${audit.contexts.total} (offset ${audit.contexts.offset})`,
      ];
      if (audit.run.titleOmittedChars)
        lines.push(
          `Title shortened by ${audit.run.titleOmittedChars} characters; read it in full: ${data.fullCommand}`,
        );
      for (const context of audit.contexts.items) {
        lines.push(
          `- ${context.contextId}: ${context.progress ?? (context.started ? "unavailable" : "not started")} (pass ${context.pass}, ${context.current ? "current" : "historical"}; ${context.counts.conversations} agents, ${context.counts.candidates} candidates, ${context.counts.reviewRounds} review rounds)`,
        );
        const handle = data.contexts.find(
          (item) => item.contextId === context.contextId,
        );
        if (handle) lines.push(`  Read: ${handle.readCommand}`);
      }
      if (data.nextCommand) lines.push(`More contexts: ${data.nextCommand}`);
      lines.push(`Detailed evidence omitted; export all: ${data.fullCommand}`);
      return quoteLiteralText(`${lines.join("\n")}\n`);
    },
  });

export const auditHandler: Handler = {
  run: auditRun(false),
  levels: { full: auditRun(true) },
};
