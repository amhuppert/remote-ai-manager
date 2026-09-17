import { quoteLiteralText } from "../../framework/literal-text";
import {
  invocation,
  runner,
  type JsonData,
  type JsonValue,
} from "cli-for-agents";
import { hint } from "cli-for-agents/guidance";
import { z } from "zod";
import { deriveExecutionLaneActivities } from "@/lib/workflow-graph/lane-activity";
import {
  liveOutlineSchema,
  liveOutputsSchema,
} from "@/lib/workflow-graph/live-outline-schemas";
import {
  explicitScopeFlags,
  resolveCcProject,
  resolveCcSession,
  type CcErrorCode,
} from "../../framework/context";
import { cliRequest, encodePathSegment } from "../../transport";
import {
  buildOutlineData,
  parseOutlineRecord,
  sliceContext,
  sliceTask,
  sliceCharter,
  sliceConfig,
  sliceParams,
  type OutlineData,
} from "../workflow-outline";
import { renderLiveOutline, renderLiveOutputs } from "../workflow-live-outline";
import {
  ledgerExecutionSchema,
  ledgerEventPageSchema,
  buildLedger,
  selectLedgerDecisionRows,
  type LedgerDecisionRow,
  type LedgerWalk,
} from "../workflow-ledger";
import {
  getCommand,
  liveLedgerCommand,
  statusCommand,
  type listSpec,
  type getSpec,
  type statusSpec,
  type templatesSpec,
  type liveGetSpec,
  type liveLedgerSpec,
} from "./definitions";
import {
  listResponseSchema,
  templatesResponseSchema,
  statusResponseSchema,
} from "./schemas";
import {
  definitionsPath,
  definitionPath,
  graphPath,
  invalid,
  usage,
  readResponse,
  workflowFailure,
  jsonObjectSchema,
  jsonValueSchema,
  type Input,
  type Read,
  type JsonObject,
} from "./shared";

export const listHandler: Read<typeof listSpec> = {
  run: runner<
    Input<typeof listSpec>,
    z.infer<typeof listResponseSchema>,
    CcErrorCode
  >({
    async run({ app }) {
      const context = await resolveCcProject(app);
      return context.ok
        ? readResponse(
            app,
            {
              ...context.value,
              method: "GET",
              path: definitionsPath(context.value),
            },
            listResponseSchema,
          )
        : context;
    },
    text: ({ items }) =>
      quoteLiteralText(
        items.length
          ? items
              .map(
                (item) =>
                  `${item.id}: ${item.name}; revision ${item.revision}${item.description ? ` — ${item.description}` : ""}`,
              )
              .join("\n") + "\n"
          : "No saved workflow definitions.\n",
      ),
  }),
};
export const templatesHandler: Read<typeof templatesSpec> = {
  run: runner<
    Input<typeof templatesSpec>,
    z.infer<typeof templatesResponseSchema>,
    CcErrorCode
  >({
    async run({ app, ctx }) {
      const context = await resolveCcProject(app);
      if (!context.ok) return context;
      const response = await readResponse(
        app,
        {
          ...context.value,
          method: "GET",
          path: `/api/projects/${encodePathSegment(context.value.project)}/workflow-templates`,
        },
        templatesResponseSchema,
      );
      return response.ok
        ? {
            ok: true,
            data: {
              items: response.data.items.filter(
                (item) =>
                  ctx.flags.tier === undefined || item.tier === ctx.flags.tier,
              ),
            },
          }
        : response;
    },
    text: ({ items }) =>
      quoteLiteralText(
        items.length
          ? items
              .map(
                (item) =>
                  `${item.tier}:${item.id}: ${item.name}${item.description ? ` — ${item.description}` : ""}`,
              )
              .join("\n") + "\n"
          : "No workflow templates.\n",
      ),
  }),
};
type GetData = {
  expectedRevision?: number;
  outline?: OutlineData;
  section?: string;
  value?: JsonValue;
  item?: JsonObject;
  resolved?: JsonValue;
};
function outlineText(data: JsonData<GetData>): string {
  const outline = data.outline;
  if (!outline)
    return `${JSON.stringify(data.section ? data.value : data.item, null, 2)}\n${data.expectedRevision === undefined ? "" : `Next write: expectedRevision ${data.expectedRevision}\n`}`;
  return (
    [
      `${outline.name} (${outline.id}); revision ${outline.revision}`,
      `Next write: expectedRevision ${outline.revision}`,
      `Contexts (${outline.contexts.length}):`,
      ...outline.contexts.map(
        (row) =>
          `  ${row.id}: ${row.title}; dependencies ${row.deps.join(", ") || "none"}; ${row.taskCount} tasks; criteria ${row.criteria.map((criterion) => `${criterion.id} (${criterion.statementChars} chars)`).join(", ") || "none"}; output ${row.outputSchema ? JSON.stringify(row.outputSchema) : "none"}; overrides ${row.overrides.join(", ") || "none"}`,
      ),
      `Tasks (${outline.tasks.length}):`,
      ...outline.tasks.map(
        (row) =>
          `  ${row.contextId}/${row.id}: ${row.title}; order ${row.order}; ${row.instructionChars} instruction chars`,
      ),
      `Charter: mission ${outline.charter.missionChars} chars; ${outline.charter.invariants.length} invariants; ${outline.charter.conventions} conventions; ${outline.charter.nonGoals} non-goals; ${outline.charter.vocabulary} vocabulary; ${outline.charter.knownAmbiguities} ambiguities; ${outline.charter.sources} sources`,
      ...outline.charter.invariants.map(
        (row) =>
          `  Invariant ${row.id}: ${row.statementChars} chars; contexts ${row.contextIds?.join(", ") ?? "all"}`,
      ),
      ...outline.parameters.map(
        (row) =>
          `Parameter ${row.name}: ${row.type}${row.required ? " required" : ""}`,
      ),
      ...outline.prerequisites.map(
        (row) => `Prerequisite ${row.kind}: ${row.locator}`,
      ),
      ...outline.staffing.map(
        (row) =>
          `Staffing ${row.scope}/${row.role}/${row.assignmentId}: ${row.profile}; ${row.runtime}${row.strategy ? `; ${row.strategy}` : ""}${row.dormant ? "; dormant" : ""}${row.focus ? `; ${row.focus}` : ""}`,
      ),
      `Workflow config overrides: ${outline.configOverrides.workflow.join(", ") || "none"}`,
      ...outline.configOverrides.contexts.map(
        (row) => `Config ${row.id}: ${row.blocks.join(", ") || "none"}`,
      ),
    ].join("\n") + "\n"
  );
}
function getRunner(full: boolean) {
  return runner<Input<typeof getSpec>, GetData, CcErrorCode>({
    async run({ app, ctx }) {
      const selectors = [
        ctx.flags.context ? "context" : undefined,
        ctx.flags.task ? "task" : undefined,
        ctx.flags.charter ? "charter" : undefined,
        ctx.flags.config ? "config" : undefined,
        ctx.flags.params ? "params" : undefined,
      ].filter((value) => value !== undefined);
      if (selectors.length + Number(full) > 1)
        return usage("Choose one workflow section selector or --full.");
      const context = await resolveCcProject(app);
      if (!context.ok) return context;
      const response = await readResponse(
        app,
        {
          ...context.value,
          method: "GET",
          path: definitionPath(
            context.value,
            ctx.flags.tier,
            ctx.args["definition-id"],
          ),
        },
        z.object({
          item: jsonObjectSchema,
          resolved: jsonValueSchema.optional(),
        }),
      );
      if (!response.ok) return response;
      const record = parseOutlineRecord(response.data.item);
      const revision = record?.revision;
      if (full)
        return {
          ok: true,
          data: {
            ...response.data,
            ...(revision === undefined ? {} : { expectedRevision: revision }),
          },
        };
      if (!record)
        return invalid(
          "The saved definition has no readable outline; inspect workflow get --full.",
        );
      const selector = selectors[0];
      if (!selector)
        return {
          ok: true,
          data: {
            outline: buildOutlineData(record),
            expectedRevision: record.revision,
          },
          hint: hint(
            invocation(getCommand, {
              args: { "definition-id": record.id },
              flags: { ...explicitScopeFlags(app), tier: ctx.flags.tier },
              level: "full",
            }),
            "Read full prose before a wholesale edit",
          ),
        };
      const section = ctx.flags.context
        ? sliceContext(record, ctx.flags.context)
        : ctx.flags.task
          ? sliceTask(record, ctx.flags.task)
          : selector === "charter"
            ? sliceCharter(record)
            : selector === "config"
              ? sliceConfig(record)
              : sliceParams(record);
      if (!section.ok) return usage(section.error);
      const parsed = jsonValueSchema.safeParse(section.value);
      return parsed.success
        ? {
            ok: true,
            data: {
              section: selector,
              value: parsed.data,
              expectedRevision: record.revision,
            },
          }
        : invalid("The selected workflow section is not JSON data.");
    },
    text: (data) => quoteLiteralText(outlineText(data)),
  });
}
export const getHandler: Read<typeof getSpec> = {
  run: getRunner(false),
  levels: { full: getRunner(true) },
};

const haltSummarySchema = z.object({
  type: z.string().optional(),
  contextId: z.string().optional(),
  summary: z.string().nullish(),
  stage: z.string().optional(),
  lastIncident: z.string().nullish(),
  consecutiveCount: z.number().optional(),
  driftedComponents: z.string().nullish(),
  planDefects: z
    .array(z.object({ title: z.string(), conflictingContract: z.string() }))
    .optional(),
  findings: z.array(jsonValueSchema).optional(),
});
const repairSummarySchema = z.object({
  seq: z.number(),
  haltType: z.string(),
  contextId: z.string(),
  outcome: z.string().nullish(),
});
function haltSummary(
  reason: unknown,
  rounds: readonly unknown[],
): JsonObject | null {
  if (reason === null || reason === undefined) return null;
  const parsed = haltSummarySchema.safeParse(reason);
  if (!parsed.success)
    return { type: "unknown", repairRoundCount: rounds.length };
  const { planDefects, findings, ...fields } = parsed.data;
  const allFindings = planDefects ?? findings ?? [];
  const latest = rounds
    .flatMap((round) => {
      const row = repairSummarySchema.safeParse(round);
      return row.success &&
        row.data.haltType === fields.type &&
        row.data.contextId === fields.contextId
        ? [row.data]
        : [];
    })
    .sort((left, right) => right.seq - left.seq)[0];
  const summary: JsonObject = {};
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) summary[key] = value;
  return {
    ...summary,
    findingCount: allFindings.length,
    firstFinding: allFindings[0] ?? null,
    omittedFindingCount: Math.max(0, allFindings.length - 1),
    repairRoundCount: rounds.length,
    ...(latest
      ? { latestRepair: { seq: latest.seq, outcome: latest.outcome ?? null } }
      : {}),
  };
}
function haltText(halt: JsonData<JsonObject>): string[] {
  const finding = z
    .object({ title: z.string(), conflictingContract: z.string() })
    .safeParse(halt.firstFinding);
  const repair = z
    .object({ seq: z.number(), outcome: z.string().nullable() })
    .safeParse(halt.latestRepair);
  return [
    `Halt: ${halt.type ?? "unknown"}${halt.contextId ? `; context ${halt.contextId}` : ""}`,
    ...(halt.summary ? [String(halt.summary)] : []),
    ...(halt.stage
      ? [
          `Stage: ${halt.stage}; consecutive rounds ${halt.consecutiveCount ?? "unknown"}`,
        ]
      : []),
    ...(halt.lastIncident ? [`Incident: ${halt.lastIncident}`] : []),
    ...(halt.driftedComponents
      ? [`Drifted components: ${halt.driftedComponents}`]
      : []),
    ...(finding.success
      ? [
          `Finding: ${finding.data.title}`,
          `Contract: ${finding.data.conflictingContract}`,
        ]
      : []),
    ...(Number(halt.omittedFindingCount ?? 0) > 0
      ? [`${halt.omittedFindingCount} more halt findings omitted.`]
      : []),
    ...(repair.success
      ? [
          `Repair round ${repair.data.seq}: ${repair.data.outcome ?? "in progress"}`,
        ]
      : []),
  ];
}
type StatusData = {
  execution: { id: string; status: string } | JsonObject | null;
  halt?: JsonObject;
  lanes?: ReturnType<typeof deriveExecutionLaneActivities>;
  contexts?: Array<{
    id: string;
    title: string;
    status: string | null;
    completedTaskCount: number | null;
    totalTaskCount: number | null;
    lane: string | null;
    laneId: string | null;
    batchId: string | null;
  }>;
  haltReason?: JsonValue;
  planRepairRounds?: JsonValue[];
  view?: "full" | "halt";
};
function statusRunner(full: boolean) {
  return runner<Input<typeof statusSpec>, StatusData, CcErrorCode>({
    async run({ app, ctx }) {
      if (full && ctx.flags.halt) return usage("Choose --halt or --full.");
      const context = await resolveCcSession(app);
      if (!context.ok) return context;
      const id = ctx.args["execution-id"];
      const response = await readResponse(
        app,
        {
          ...context.value,
          method: "GET",
          path: `${graphPath(context.value)}/${id === undefined ? "execution" : `executions/${encodePathSegment(id)}`}`,
        },
        z.object({ execution: jsonObjectSchema.nullable() }),
      );
      if (!response.ok) return response;
      const parsed = statusResponseSchema.safeParse(response.data);
      if (!parsed.success)
        return invalid("The workflow status response is unreadable.");
      const execution = parsed.data.execution;
      if (!execution) return { ok: true, data: { execution: null } };
      const lanes = deriveExecutionLaneActivities(execution);
      if (full)
        return {
          ok: true,
          data: { view: "full", execution: response.data.execution, lanes },
        };
      if (ctx.flags.halt)
        return {
          ok: true,
          data: {
            view: "halt",
            execution: { id: execution.id, status: execution.status },
            haltReason: execution.haltReason ?? null,
            planRepairRounds: execution.planRepairRounds,
          },
        };
      const halt = haltSummary(
        execution.haltReason,
        execution.planRepairRounds,
      );
      return {
        ok: true,
        data: {
          execution: {
            id: execution.id,
            status: execution.status,
            halted: halt !== null,
            haltType: halt?.type ?? null,
            activeContextIds: execution.activeContextIds,
          },
          ...(halt ? { halt } : {}),
          lanes,
          contexts: execution.workingDefinition.executionContexts.map(
            (row) => ({
              id: row.id,
              title: row.title,
              status: execution.contextStates[row.id]?.status ?? null,
              completedTaskCount:
                execution.contextStates[row.id]?.completedTaskCount ?? null,
              totalTaskCount:
                execution.contextStates[row.id]?.totalTaskCount ?? null,
              lane: row.placement?.lane ?? null,
              laneId: execution.contextStates[row.id]?.laneId ?? null,
              batchId: execution.contextStates[row.id]?.batchId ?? null,
            }),
          ),
        },
        ...(execution.haltReason
          ? {
              hint: hint(
                invocation(statusCommand, {
                  args: { "execution-id": execution.id },
                  flags: {
                    ...explicitScopeFlags(app),
                    halt: true,
                    project: context.value.project,
                    session: context.value.session,
                  },
                }),
                "Read the complete halt findings and repair history",
              ),
            }
          : {}),
      };
    },
    text: (data) => {
      if (!data.execution)
        return quoteLiteralText(
          "No active graph workflow execution in this session.\n",
        );
      if (data.view)
        return quoteLiteralText(
          `${JSON.stringify(data.view === "full" ? data.execution : { haltReason: data.haltReason, planRepairRounds: data.planRepairRounds }, null, 2)}\n`,
        );
      return quoteLiteralText(
        [
          `${data.execution.id}: ${data.execution.status}`,
          ...(data.halt ? haltText(data.halt) : []),
          ...(data.contexts ?? []).map(
            (row) =>
              `${row.id}: ${row.title}; ${row.status}; ${row.completedTaskCount}/${row.totalTaskCount} tasks`,
          ),
          ...(data.lanes ?? []).map(
            (lane) =>
              `Lane ${lane.laneId}: ${lane.status}; ${lane.members.map((member) => `${member.contextId} (${member.activity})`).join(", ") || "no contexts"}`,
          ),
        ].join("\n") + "\n",
      );
    },
  });
}
export const statusHandler: Read<typeof statusSpec> = {
  run: statusRunner(false),
  levels: { full: statusRunner(true) },
};
function liveRunner(full: boolean) {
  return runner<Input<typeof liveGetSpec>, JsonObject, CcErrorCode>({
    async run({ app, ctx }) {
      const selectors = [
        ctx.flags.context ? "context" : undefined,
        ctx.flags.task ? "task" : undefined,
        ctx.flags.config ? "config" : undefined,
        ctx.flags.charter ? "charter" : undefined,
        ctx.flags.outputs ? "outputs" : undefined,
      ].filter((value) => value !== undefined);
      if (selectors.length + Number(full) > 1)
        return usage("Choose one live section selector or --full.");
      const context = await resolveCcSession(app);
      if (!context.ok) return context;
      const query = new URLSearchParams();
      if (full) query.set("full", "true");
      if (ctx.flags.context) query.set("context", ctx.flags.context);
      if (ctx.flags.task) query.set("task", ctx.flags.task);
      if (ctx.flags.config) query.set("config", ctx.flags.config);
      if (ctx.flags.charter) query.set("charter", "true");
      if (ctx.flags.outputs) query.set("outputs", "true");
      const response = await readResponse(
        app,
        {
          ...context.value,
          method: "GET",
          path: `${graphPath(context.value)}/live-outline${query.size ? `?${query}` : ""}`,
        },
        jsonObjectSchema,
      );
      if (!response.ok) return response;
      const data = response.data;
      if (selectors.length === 0 && !full) {
        const parsed = liveOutlineSchema.safeParse(data.outline);
        if (!parsed.success)
          return invalid("The live outline response is unreadable.");
        return {
          ok: true,
          data: { ...data, baseLiveRevision: parsed.data.header.liveRevision },
        };
      }
      if (ctx.flags.outputs && !liveOutputsSchema.safeParse(data).success)
        return invalid("The live outputs response is unreadable.");
      const header = z
        .object({ liveRevision: z.number() })
        .safeParse(data.header);
      return {
        ok: true,
        data: {
          ...data,
          ...(header.success
            ? { baseLiveRevision: header.data.liveRevision }
            : {}),
        },
      };
    },
    text: (data) => {
      const outline = liveOutlineSchema.safeParse(data.outline);
      if (outline.success)
        return quoteLiteralText(
          `${renderLiveOutline(outline.data)}\nNext write: baseLiveRevision ${outline.data.header.liveRevision}\n`,
        );
      if (data.section === "outputs" || Array.isArray(data.outputs)) {
        const outputs = liveOutputsSchema.safeParse(data);
        if (outputs.success)
          return quoteLiteralText(renderLiveOutputs(outputs.data));
      }
      const value =
        typeof data.section === "string" && data[data.section] !== undefined
          ? data[data.section]
          : data;
      const charter = z.object({ markdown: z.string() }).safeParse(value);
      return quoteLiteralText(
        charter.success
          ? `${charter.data.markdown}\n`
          : `${JSON.stringify(value, null, 2)}\n${data.baseLiveRevision === undefined ? "" : `Next write: baseLiveRevision ${data.baseLiveRevision}\n`}`,
      );
    },
  });
}
export const liveGetHandler: Read<typeof liveGetSpec> = {
  run: liveRunner(false),
  levels: { full: liveRunner(true) },
};
type LedgerData = {
  executionId: string;
  ledger: ReturnType<typeof buildLedger>;
  walk: LedgerWalk;
};
export const liveLedgerHandler: Read<typeof liveLedgerSpec> = {
  run: runner<Input<typeof liveLedgerSpec>, LedgerData, CcErrorCode>({
    async run({ app, ctx }) {
      const context = await resolveCcSession(app);
      if (!context.ok) return context;
      const response = await readResponse(
        app,
        {
          ...context.value,
          method: "GET",
          path: `${graphPath(context.value)}/execution`,
        },
        ledgerExecutionSchema,
      );
      if (!response.ok) return response;
      const execution = response.data.execution;
      if (!execution)
        return usage("No active graph workflow execution in this session.");
      const rows: LedgerDecisionRow[] = [];
      let cursor = ctx.flags.cursor ?? 0;
      let walk: LedgerWalk = {
        complete: true,
        resumeCursor: null,
        reason: "complete",
      };
      const declaresLoops =
        (execution.workingDefinition.loopGroups?.length ?? 0) > 0 ||
        Object.keys(execution.loopStates).length > 0;
      for (let page = 0; declaresLoops; page += 1) {
        if (ctx.signal.aborted)
          return invalid(
            "The ledger read was interrupted. Reattach using the last event cursor.",
          );
        const query = new URLSearchParams({
          executionId: execution.id,
          page: "true",
          direction: "asc",
          limit: "500",
          cursor: String(cursor),
        });
        const reply = await cliRequest(app.host, {
          ...context.value,
          method: "GET",
          path: `${graphPath(context.value)}/events?${query}`,
        });
        if (reply.kind !== "ok") return workflowFailure(reply);
        const parsed = ledgerEventPageSchema.safeParse(reply.body);
        if (!parsed.success) {
          walk = {
            complete: false,
            resumeCursor: cursor,
            reason: "unreadable",
          };
          break;
        }
        rows.push(...selectLedgerDecisionRows(parsed.data));
        const next = parsed.data.nextCursor;
        if (next === null) break;
        if (next <= cursor) {
          walk = {
            complete: false,
            resumeCursor: null,
            reason: "reader-stalled",
          };
          break;
        }
        cursor = next;
        if (
          ctx.flags["max-pages"] !== undefined &&
          page + 1 >= ctx.flags["max-pages"]
        ) {
          walk = {
            complete: false,
            resumeCursor: cursor,
            reason: "page-bound",
          };
          break;
        }
      }
      return {
        ok: true,
        data: {
          executionId: execution.id,
          ledger: buildLedger(execution, rows),
          walk,
        },
        ...(walk.resumeCursor === null
          ? {}
          : {
              hint: hint(
                invocation(liveLedgerCommand, {
                  flags: {
                    ...explicitScopeFlags(app),
                    cursor: walk.resumeCursor,
                  },
                }),
                "Continue the durable event history",
              ),
            }),
      };
    },
    text: ({ executionId, ledger, walk }) =>
      quoteLiteralText(
        [
          `Execution ${executionId}; history ${walk.complete ? "complete" : `incomplete (${walk.reason}); remaining events omitted`}`,
          ...(!ledger.length
            ? ["No loop decisions recorded."]
            : ledger.flatMap((entry) => [
                `${entry.loopGroupId}: ${entry.activation}; pass ${entry.passCount}${entry.maxPasses === null ? "" : ` of ${entry.maxPasses}`}; control revision ${entry.loopControlRevision}`,
                ...entry.decisions.map(
                  (decision) =>
                    `  Pass ${decision.pass}: ${decision.verdict} → ${decision.outcome}; revision ${decision.loopControlRevision}; template ${decision.templateVersion}; exit ${decision.exitContextId}${decision.latest ? "" : "; superseded"}${decision.markerOnly ? "; from current state" : ""}`,
                ),
              ])),
          ...(walk.resumeCursor === null
            ? []
            : [`Resume cursor: ${walk.resumeCursor}`]),
        ].join("\n") + "\n",
      ),
  }),
};
