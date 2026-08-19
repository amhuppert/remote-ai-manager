import { z } from "zod";
import {
  graphWorkflowExecutionActReceiptSchema,
  graphWorkflowExecutionOriginSchema,
  graphWorkflowLaunchReceiptSchema,
  graphWorkflowLeaseBlockerSchema,
  type GraphWorkflowExecutionOrigin,
  type GraphWorkflowLaunchReceipt,
} from "@/lib/workflow-graph/schemas";
import { graphWorkflowBoundaryKindSchema } from "@/lib/workflow-graph/event-schemas";
import { graphWorkflowStatusSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  planReviewAcknowledgementRefusalSchema,
  planReviewAdvisorySchema,
  planReviewFindingsCommand,
  planReviewRecordResponseSchema,
  planReviewStatusResponseSchema,
  REVIEW_CHANGES_REQUESTED_UNACKNOWLEDGED_CODE,
  type PlanReviewAdvisory,
} from "@/lib/workflows/plan-review/status-schemas";
import { dispatchGroup } from "../dispatch";
import { flagNamesFor } from "../help-registry";
import {
  EXIT_OK,
  EXIT_CONNECTION,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  failureFromRequestNotFoundAsUsage,
  issueDetailLines,
  readJsonObjectFile,
  render,
  resolveCliPrincipalCapabilities,
  resolveLaneContext,
  resolveProjectContext,
  resolveSessionContext,
  structuredErrorFields,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type GlobalFlags,
  type JsonEnvelope,
  type LaneContext,
  type ProjectContext,
  type SessionContext,
} from "../shared";
import {
  buildOutlineData,
  parseOutlineRecord,
  renderOutline,
  sliceCharter,
  sliceConfig,
  sliceContext,
  sliceParams,
  sliceTask,
  type OutlineRecord,
  type SliceResult,
} from "./workflow-outline";
import {
  liveOutlineSchema,
  liveOutputsSchema,
  renderLiveOutline,
  renderLiveOutputs,
} from "./workflow-live-outline";
import {
  buildLedger,
  ledgerEventPageSchema,
  ledgerExecutionSchema,
  type LedgerWalk,
  renderLedger,
  selectLedgerDecisionRows,
  type LedgerDecisionRow,
} from "./workflow-ledger";
import { deriveExecutionLaneActivities } from "@/lib/workflow-graph/lane-activity";
import { parseDuration } from "./agent";

/**
 * `cctl workflow validate|create|replace|list|get|status|delete|start|templates`
 * — graph-workflow authoring, read, and lifecycle verbs over the existing routes
 * (docs/design/cc-cli/02 §2.4, §3.1). The routes are unchanged (bar the new
 * non-persisting `validate` endpoint); this is CLI mapping only. `validate` and
 * `create` steer the next step of the canonical author flow (validate → create →
 * start); the read/replace verbs are deliberately hint-free.
 *
 * `list|get|delete|create|replace|templates` are project-scoped
 * (`/api/projects/[name]/…`); `validate|status|start` are session-scoped
 * (`…/sessions/[session]/graph-workflow`).
 *
 * The LANE verbs `task complete|add`, `shared-doc upsert`, and `collab request`
 * (docs/design/cc-cli/02 §4) live in the same namespace — they are graph-workflow
 * lane operations a running implementer calls. They resolve their execution +
 * context identity from the env CC injects at spawn (CC_WORKFLOW_EXECUTION_ID /
 * CC_WORKFLOW_CONTEXT_ID) and target the token-gated lane endpoints, which run
 * the pre-dispatch halt check first (409 halt → the reason is printed verbatim,
 * exit 1).
 */

const WORKFLOW_START_HINT = "track progress with 'cctl workflow status'";
const WORKFLOW_WAIT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WORKFLOW_WAIT_BUDGET_MS = 30 * 60 * 1_000;
const DEFAULT_WORKFLOW_WAIT_TIMEOUT_LABEL = "30m";
const PROJECT_SCOPE_RUN_REMEDY =
  "Use or create a session conversation, then run the one-off workflow from that conversation.";

const blockerFreeWorkflowRefusalDetailsSchema = z
  .object({ remedy: z.string().trim().min(1) })
  .strict();
const workflowLaunchRefusalDetailsSchema = z.union([
  graphWorkflowLeaseBlockerSchema,
  blockerFreeWorkflowRefusalDetailsSchema,
]);
type WorkflowLaunchRefusalDetails = z.infer<
  typeof workflowLaunchRefusalDetailsSchema
>;

function formatWorkflowOrigin(origin: GraphWorkflowExecutionOrigin): string {
  switch (origin.kind) {
    case "one_off":
      return `one_off (${origin.planName})`;
    case "spec_delivery":
      return `spec_delivery (${origin.specSlug} candidate ${origin.candidateId})`;
    case "template":
      return `template (${origin.tier}:${origin.definitionId}@${origin.definitionRevision})`;
  }
}

/** One text projection for every launch refusal carrying the typed D7 details. */
function workflowLaunchRefusalDetailLines(
  details: WorkflowLaunchRefusalDetails,
): string[] {
  return [
    ...(details && "executionId" in details
      ? [
          `  execution: ${details.executionId}`,
          `  status: ${details.status}`,
          `  origin: ${formatWorkflowOrigin(details.origin)}`,
          `  origin conversation: ${details.originConversationId ?? "-"}`,
          `  deep link: ${details.deepLink}`,
        ]
      : []),
    `  remedy: ${details.remedy}`,
  ];
}

/**
 * Normalize the server's lease/nesting launch refusals onto the one CLI detail
 * contract. Lease details already arrive in the flat blocker shape; a nesting
 * refusal has no blocker and carries its remedy as the server instruction.
 */
function workflowLaunchFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
): CliResult {
  if (result.kind !== "error") return workflowFailure(result, json);

  let details: WorkflowLaunchRefusalDetails | null = null;
  if (result.code === "lease_held") {
    const parsed = workflowLaunchRefusalDetailsSchema.safeParse(result.details);
    if (parsed.success && "executionId" in parsed.data) details = parsed.data;
  } else if (
    result.code === "workflow_nesting_refused" ||
    result.code === "unverified_principal"
  ) {
    const remedy =
      result.instruction ??
      "Launch the workflow from an ordinary session conversation.";
    details = { remedy };
  }

  if (details === null) return workflowFailure(result, json);
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message: result.error,
    detail: workflowLaunchRefusalDetailLines(details).join("\n"),
    ...(result.issues ? { issues: result.issues } : {}),
    ...(result.code ? { code: result.code } : {}),
    ...(result.reminders ? { reminders: result.reminders } : {}),
    details,
    json,
  });
}

function projectScopeRunFailure(json: boolean): CliResult {
  const details: WorkflowLaunchRefusalDetails = {
    remedy: PROJECT_SCOPE_RUN_REMEDY,
  };
  return failure({
    exitCode: EXIT_USAGE,
    message: "workflow run requires a session conversation",
    code: "project_scope_refused",
    details,
    detail: workflowLaunchRefusalDetailLines(details).join("\n"),
    json,
  });
}

/**
 * Names the conversation issuing the request. On `workflow start` the server
 * verifies it against the session's own conversations and, only then, records
 * it as the execution's owner — the single identity allowed to run validation
 * while the run holds the slot with no lanes yet. A header rather than a body
 * field because the body is client-supplied data the start path never reads for
 * identity; absent (a browser start, or a shell outside any conversation) is an
 * honest unowned launch, not an error.
 */
const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";
const CALLER_BACKEND_HEADER = "x-cc-agent-backend";

/** JSON-object plan file the author flow (validate/create/replace) reads. */
const definitionItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number(),
});

/**
 * An authoring warning: located exactly like an issue, but never a refusal —
 * the guard enum-coverage lint and the semantic authoring lints (#69 change 6)
 * both arrive in this shape, from validate and from create/replace alike.
 */
const planWarningSchema = z.object({ path: z.string(), message: z.string() });
type PlanWarning = z.infer<typeof planWarningSchema>;

/** `warning: <path>: <message>` per warning, newline-terminated. */
function planWarningLines(warnings: readonly PlanWarning[]): string {
  return warnings
    .map((warning) => `warning: ${warning.path}: ${warning.message}\n`)
    .join("");
}

const mutationResponseSchema = z.object({
  item: definitionItemSchema,
  /**
   * The advisory review status of the exact revision just saved (#69 change 5).
   * Optional on the parse: a server that predates it simply prints no advisory
   * line, which is the same non-event as having no review recorded.
   */
  reviewStatus: planReviewAdvisorySchema.optional(),
  /**
   * Admission warnings for the saved revision (#69 change 6). Optional for two
   * distinct reasons that print the same: a server that predates the field, and
   * a save with nothing to warn about.
   */
  warnings: z.array(planWarningSchema).optional(),
});

/** One advisory line beside a save. Never an error, never an exit code. */
function planReviewAdvisoryLine(advisory: PlanReviewAdvisory): string {
  return advisory.state === "unreviewed"
    ? "plan review: none recorded for this revision (advisory)\n"
    : `plan review: ${advisory.state} by ${advisory.reviewerConversationId} at ${advisory.reviewedAt}\n`;
}

/**
 * The ONE refusal review machinery can produce: this exact revision carries a
 * changes-requested verdict nobody acknowledged (#69 change 5).
 *
 * Rendered as a refusal the caller can act on without a second lookup — the
 * findings command re-built with THIS caller's plan path (the server can only
 * emit the placeholder shape, since it never sees the file), and the expected
 * hash spelled out beside the flag that carries it. Returns null for every
 * other failure, so the shared mapping keeps owning them.
 */
function reviewAcknowledgementFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  planFilePath: string,
  json: boolean,
): CliResult | null {
  if (
    result.kind !== "error" ||
    result.code !== REVIEW_CHANGES_REQUESTED_UNACKNOWLEDGED_CODE
  ) {
    return null;
  }
  const parsed = planReviewAcknowledgementRefusalSchema.safeParse(
    result.details,
  );
  if (!parsed.success) return null;
  const refusal = parsed.data;

  return failure({
    // Exit 1, not 2: the plan is well-formed and the invocation is correct —
    // the server is saying no about state the caller has not read yet.
    exitCode: EXIT_OPERATION_FAILED,
    message: result.error,
    detail: [
      `  revision: ${refusal.definitionHash}`,
      `  reviewer: ${refusal.reviewerConversationId}`,
      `  reviewed: ${refusal.reviewedAt}`,
    ].join("\n"),
    hint: `read the findings with '${planReviewFindingsCommand(planFilePath)}', then revise the plan or re-run with --acknowledge-review ${refusal.definitionHash}`,
    code: result.code,
    details: refusal,
    json,
  });
}

/**
 * The plan body plus the acknowledgement, when the caller passed one. Absent
 * stays absent rather than becoming an explicit null: no acknowledgement is the
 * ordinary case, and it must not read as acknowledging nothing.
 */
function planBodyWithAcknowledgement(
  plan: Record<string, unknown>,
  acknowledgement: string | undefined,
): Record<string, unknown> {
  return acknowledgement === undefined
    ? plan
    : { ...plan, acknowledgeReviewHash: acknowledgement };
}

/**
 * Located advice the validate endpoint returns beside `ok: true`. Never affects
 * the exit code — a warned plan is still creatable — so the parse is lenient:
 * an unrecognized shape simply yields no warnings rather than failing a valid
 * plan.
 */
const validateResponseSchema = z.object({
  warnings: z.array(planWarningSchema).optional(),
});

const TEMPLATE_TIERS = ["global", "project"] as const;
type TemplateTier = (typeof TEMPLATE_TIERS)[number];

/** `workflow get`/`edit` `--tier` (default project). One selector per invocation. */
function resolveTierFlag(
  values: Record<string, string>,
  json: boolean,
): { ok: true; tier: TemplateTier } | { ok: false; result: CliResult } {
  const tierValue = values["tier"];
  if (tierValue === undefined) return { ok: true, tier: "project" };
  if (!(TEMPLATE_TIERS as readonly string[]).includes(tierValue)) {
    return {
      ok: false,
      result: usageFailure(
        `--tier must be one of: ${TEMPLATE_TIERS.join(", ")}`,
        json,
      ),
    };
  }
  return { ok: true, tier: tierValue as TemplateTier };
}

const editResponseSchema = z.object({
  item: z.object({ id: z.string(), name: z.string(), revision: z.number() }),
  applied: z.number(),
  dryRun: z.boolean().optional(),
});

const definitionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  revision: z.number(),
});
const listResponseSchema = z.object({
  items: z.array(definitionSummarySchema),
});

const getResponseSchema = z.object({
  item: z.unknown(),
  resolved: z.unknown().optional(),
});

const templateItemSchema = z.object({
  tier: z.enum(TEMPLATE_TIERS),
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
const templatesResponseSchema = z.object({
  items: z.array(templateItemSchema),
});

const startResponseSchema = z.object({
  execution: z.object({ executionId: z.string(), status: z.string() }),
  // The launch receipt (D7 R1.2). Optional so a response from an older server
  // still parses; the disposition then falls back to "started".
  receipt: z.object({ status: z.string() }).optional(),
});

const contextStateSchema = z.object({
  contextId: z.string(),
  status: z.string(),
  totalTaskCount: z.number(),
  completedTaskCount: z.number(),
  batchId: z.string().nullable().optional(),
  laneId: z.string().nullable().optional(),
});
const executionSchema = z.object({
  id: z.string(),
  status: z.string(),
  activeContextIds: z.array(z.string()).default([]),
  // haltReason is a structured discriminated union server-side; keep it lenient
  // here and derive a short label for display (see haltLabel).
  haltReason: z.unknown().nullish(),
  // Read leniently for the same reason: the halt block reports the repair round
  // that answered a plan-defect halt, and one unreadable row must not cost the
  // caller the whole status table.
  planRepairRounds: z.array(z.unknown()).default([]),
  workingDefinition: z.object({
    executionContexts: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        placement: z.object({ lane: z.string() }).optional(),
      }),
    ),
  }),
  contextStates: z.record(z.string(), contextStateSchema),
  executionLanes: z
    .record(
      z.string(),
      z.object({
        laneId: z.string(),
        kind: z.enum(["session", "worktree"]),
        status: z.string(),
        includedContextIds: z.array(z.string()).default([]),
      }),
    )
    .default({}),
});
const statusResponseSchema = z.object({
  execution: executionSchema.nullable(),
});
const abandonResponseSchema = z.object({
  execution: graphWorkflowExecutionActReceiptSchema,
  abandoned: z.literal(true),
});

const workflowBoundaryCursorSchema = z.union([
  z.string().trim().min(1),
  z.number().int().positive(),
]);
const workflowBoundaryResultSchema = z.object({
  cursor: workflowBoundaryCursorSchema,
  occurredAt: z.string(),
  executionId: z.string().trim().min(1),
  boundaryKind: graphWorkflowBoundaryKindSchema,
  status: graphWorkflowStatusSchema,
  contextId: z.string().nullable(),
  pendingActions: z.array(z.record(z.string(), z.unknown())),
  outputs: z.unknown(),
  name: z.string(),
  origin: graphWorkflowExecutionOriginSchema,
  originConversationId: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  haltReason: z.unknown().nullable(),
  abandonment: z.unknown().nullable(),
  documents: z.array(z.unknown()),
  deepLink: z.string(),
});
const workflowBoundaryResponseSchema = z.object({
  result: workflowBoundaryResultSchema.nullable(),
});
type WorkflowBoundaryResult = z.infer<typeof workflowBoundaryResultSchema>;

function definitionsPath(context: ProjectContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/workflows`;
}

function templatesPath(context: ProjectContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/workflow-templates`;
}

function graphWorkflowPath(context: SessionContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/graph-workflow`;
}

/** A 404 against a workflow route is a caller/config mistake (exit 2), else the shared mapping. */
function workflowFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
): CliResult {
  return failureFromRequestNotFoundAsUsage(result, json);
}

/** The read/edit resource path for one definition, tier-aware. */
function definitionResourcePath(
  context: ProjectContext,
  tier: TemplateTier,
  id: string,
): string {
  return tier === "global"
    ? `/api/workflow-templates/${encodePathSegment(id)}`
    : `${definitionsPath(context)}/${encodePathSegment(id)}`;
}

/**
 * `workflow edit` failure mapping (docs/design/cc-cli/05 §Error contract): a 404
 * (unknown id) is a caller mistake → exit 2; a SEMANTIC rejection (server code
 * `invalid_edit`) and a `revision_conflict` are "server said no about valid-shaped
 * ops" → exit 1; a malformed-shape 400 (no code) is a usage error → exit 2. All
 * carry the structured issues/code onto the JSON envelope.
 */
function workflowEditFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
): CliResult {
  if (result.kind === "error" && result.status === 400) {
    const semantic = result.code !== undefined;
    const detail =
      result.issues && result.issues.length > 0
        ? issueDetailLines(result.issues).join("\n")
        : undefined;
    return failure({
      exitCode: semantic ? EXIT_OPERATION_FAILED : EXIT_USAGE,
      message: result.error,
      ...(detail ? { detail } : {}),
      ...structuredErrorFields(result),
      json,
    });
  }
  return failureFromRequestNotFoundAsUsage(result, json);
}

/**
 * `workflow live edit` failure mapping (docs/design/cc-cli/06 §Error contract): a
 * `code`-bearing rejection (`execution_mismatch`/`revision_conflict`/
 * `not_editable`/`frozen`/`requires_pause`/`invalid_edit`) is an operation-level
 * "server said no about valid-shaped ops" → exit 1, issues one per line, `code`
 * carried on the JSON envelope. A codeless 400 (malformed body) or 404 (no active
 * execution) is a caller mistake → exit 2. Connection/auth fall through to the
 * shared mapping (exit 3).
 */
function workflowLiveFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
): CliResult {
  if (result.kind === "error" && result.code !== undefined) {
    const detail =
      result.issues && result.issues.length > 0
        ? issueDetailLines(result.issues).join("\n")
        : undefined;
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: result.error,
      ...(detail ? { detail } : {}),
      ...structuredErrorFields(result),
      json,
    });
  }
  if (result.kind === "error" && result.status === 400) {
    return failure({
      exitCode: EXIT_USAGE,
      message: result.error,
      ...structuredErrorFields(result),
      json,
    });
  }
  return failureFromRequestNotFoundAsUsage(result, json);
}

export async function runWorkflow(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  // `workflow execution …` and `workflow exec …` are dispatch-rewrite aliases
  // for `workflow live …` (doc 06, D10) — one implementation, one help node. The
  // aliases carry no registry entry, so rewrite before dispatch.
  const rewritten =
    rest[0] === "execution" || rest[0] === "exec"
      ? ["live", ...rest.slice(1)]
      : rest;
  return dispatchGroup({
    group: ["workflow"],
    rest: rewritten,
    json: flags.json,
    handlers: {
      validate: (r) => runWorkflowValidate(r, flags, values, env, host),
      create: (r) => runWorkflowCreate(r, flags, values, env, host),
      replace: (r) => runWorkflowReplace(r, flags, values, env, host),
      review: (r) => runWorkflowReview(r, flags, values, env, host),
      list: (r) => runWorkflowList(r, flags, values, env, host),
      get: (r) => runWorkflowGet(r, flags, values, env, host),
      edit: (r) => runWorkflowEdit(r, flags, values, env, host),
      status: (r) => runWorkflowStatus(r, flags, values, env, host),
      start: (r) => runWorkflowStart(r, flags, values, env, host),
      run: (r) => runWorkflowRun(r, flags, values, env, host),
      wait: (r) => runWorkflowWait(r, flags, values, env, host),
      abandon: (r) => runWorkflowAbandon(r, flags, values, env, host),
      delete: (r) => runWorkflowDelete(r, flags, values, env, host),
      templates: (r) => runWorkflowTemplates(r, flags, values, env, host),
      live: (r) => runWorkflowLive(r, flags, values, env, host),
      task: (r) => runWorkflowTask(r, flags, values, env, host),
      graph: (r) => runWorkflowGraph(r, flags, values, env, host),
      "shared-doc": (r) => runWorkflowSharedDoc(r, flags, values, env, host),
      collab: (r) => runWorkflowCollab(r, flags, values, env, host),
    },
  });
}

async function runWorkflowValidate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow validate"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "workflow validate takes no positional arguments",
      json,
    );
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("workflow validate requires --file <plan.json>", json);
  }

  // The scope the plan is destined for, not merely where it is being checked
  // from: a global template may reference only builtin and global agent
  // profiles, so validating it under the default project rules would pass a
  // plan the save then refuses (R4.2).
  const tier = resolveTierFlag(values, json);
  if (!tier.ok) return tier.result;

  const plan = await readJsonObjectFile(host, filePath, "plan", json);
  if (!plan.ok) return plan.result;

  // Session-scoped: the validate endpoint lives under the graph-workflow
  // resource so it is reachable from a lane/session identity.
  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${graphWorkflowPath(context)}/validate${tier.tier === "global" ? "?tier=global" : ""}`,
    body: plan.value,
  });
  // A 400 carries { error, issues[] }; the shared mapping renders each issue on
  // its own line with its JSON path and exits 2 (doc 02 §3.1).
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = validateResponseSchema.safeParse(result.body);
  const warnings = parsed.success ? (parsed.data.warnings ?? []) : [];

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${planWarningLines(warnings)}plan is valid\n`, {
      ok: true,
      ...(warnings.length > 0 ? { warnings } : {}),
      // `workflow create` writes into THIS project, so it is not the next step
      // for a plan validated as a global template — hinting it would send the
      // author to the wrong tier after they deliberately selected the other one.
      hint:
        tier.tier === "global"
          ? "valid as a global-scope template — note 'cctl workflow create' saves under this project, not the global library"
          : `valid — create it with 'cctl workflow create --file ${filePath}'`,
    }),
    stderr: "",
  };
}

async function runWorkflowCreate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow create"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("workflow create takes no positional arguments", json);
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("workflow create requires --file <plan.json>", json);
  }

  const plan = await readJsonObjectFile(host, filePath, "plan", json);
  if (!plan.ok) return plan.result;

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: definitionsPath(context),
    body: planBodyWithAcknowledgement(
      plan.value,
      values["acknowledge-review"],
    ),
  });
  if (result.kind !== "ok") {
    return (
      reviewAcknowledgementFailure(result, filePath, json) ??
      workflowFailure(result, json)
    );
  }

  const parsed = mutationResponseSchema.safeParse(result.body);
  const item = parsed.success ? parsed.data.item : null;
  const reviewStatus = parsed.success ? parsed.data.reviewStatus : undefined;
  const warnings = parsed.success ? (parsed.data.warnings ?? []) : [];
  const humanLine = item
    ? `created ${item.name} (id: ${item.id})\n`
    : "workflow created\n";
  const advisoryLine =
    reviewStatus === undefined ? "" : planReviewAdvisoryLine(reviewStatus);

  return {
    exitCode: EXIT_OK,
    // Warnings first, same as `workflow validate`: they describe the plan that
    // was just saved, and an author who skipped validate is reading them here
    // for the first time.
    stdout: render(
      json,
      `${planWarningLines(warnings)}${humanLine}${advisoryLine}`,
      {
        ok: true,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(reviewStatus === undefined ? {} : { reviewStatus }),
        ...(item ? { workflowId: item.id } : {}),
        ...(item
          ? { hint: `start it with 'cctl workflow start ${item.id}'` }
          : {}),
      },
    ),
    stderr: "",
  };
}

async function runWorkflowReplace(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow replace"), json);
  if (denied) return denied;

  const id = rest[0];
  if (id === undefined) {
    return usageFailure("workflow replace requires an <id> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("workflow replace takes a single <id> argument", json);
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("workflow replace requires --file <plan.json>", json);
  }

  const plan = await readJsonObjectFile(host, filePath, "plan", json);
  if (!plan.ok) return plan.result;

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "PUT",
    path: `${definitionsPath(context)}/${encodePathSegment(id)}`,
    body: planBodyWithAcknowledgement(
      plan.value,
      values["acknowledge-review"],
    ),
  });
  if (result.kind !== "ok") {
    return (
      reviewAcknowledgementFailure(result, filePath, json) ??
      workflowFailure(result, json)
    );
  }

  const parsed = mutationResponseSchema.safeParse(result.body);
  const item = parsed.success ? parsed.data.item : null;
  const reviewStatus = parsed.success ? parsed.data.reviewStatus : undefined;
  const warnings = parsed.success ? (parsed.data.warnings ?? []) : [];
  const humanLine = item
    ? `replaced ${item.name} (revision: ${item.revision})\n`
    : `replaced ${id}\n`;
  const advisoryLine =
    reviewStatus === undefined ? "" : planReviewAdvisoryLine(reviewStatus);
  // No hint — replace is a revision, not a step in the author-then-start chain.
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${planWarningLines(warnings)}${humanLine}${advisoryLine}`,
      {
        ok: true,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(item ? { revision: item.revision } : {}),
        ...(reviewStatus === undefined ? {} : { reviewStatus }),
      },
    ),
    stderr: "",
  };
}

/** The kebab-case flag vocabulary mapped onto the stored verdict enum. */
const REVIEW_VERDICT_BY_FLAG: Record<string, "approved" | "changes_requested"> =
  {
    approved: "approved",
    "changes-requested": "changes_requested",
  };

function planReviewsPath(context: ProjectContext): string {
  return `${definitionsPath(context)}/reviews`;
}

/**
 * `cctl workflow review` — read (default) or record the advisory review verdict
 * bound to one plan revision (#69 change 5).
 *
 * The plan is posted whole and hashed SERVER-side on both paths. The CLI never
 * computes a definition hash, so the revision identity these records key on has
 * exactly one implementation and cannot drift between the recording and the
 * reading side.
 */
async function runWorkflowReview(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow review"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("workflow review takes no positional arguments", json);
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("workflow review requires --file <plan.json>", json);
  }

  const verdictFlag = values["verdict"];
  const findingsPath = values["findings"];
  if (verdictFlag === undefined && findingsPath !== undefined) {
    return usageFailure(
      "workflow review --findings applies only when recording — add --verdict approved|changes-requested",
      json,
    );
  }

  const plan = await readJsonObjectFile(host, filePath, "plan", json);
  if (!plan.ok) return plan.result;

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  return verdictFlag === undefined
    ? readWorkflowPlanReview(context, plan.value, json, host)
    : recordWorkflowPlanReview({
        context,
        plan: plan.value,
        verdictFlag,
        findingsPath,
        reviewerFlag: values["reviewer"],
        filePath,
        json,
        env,
        host,
      });
}

async function readWorkflowPlanReview(
  context: ProjectContext,
  plan: Record<string, unknown>,
  json: boolean,
  host: CliHost,
): Promise<CliResult> {
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${planReviewsPath(context)}/status`,
    body: { plan },
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = planReviewStatusResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "the server returned an unrecognized review status",
      json,
    });
  }
  const status = parsed.data.status;

  if (status.state === "unreviewed") {
    return {
      exitCode: EXIT_OK,
      // No hint: the next step after "nobody reviewed this" belongs to whoever
      // decides a review is wanted, and nudging the author toward recording
      // their own verdict is the one suggestion this command must not make.
      stdout: render(
        json,
        `plan review: none recorded for this revision (advisory)\nrevision: ${status.definitionHash}\n`,
        { ok: true, status },
      ),
      stderr: "",
    };
  }

  const lines = [
    `plan review: ${status.state} by ${status.reviewerConversationId} at ${status.reviewedAt}`,
    `revision: ${status.definitionHash}`,
  ];
  if (status.findings !== null && status.findings.trim().length > 0) {
    lines.push("findings:", status.findings.trimEnd());
  }
  lines.push("reviewer conversation:");
  if (status.reviewer.note !== null) {
    lines.push(`  note: ${status.reviewer.note}`);
  }
  for (const command of status.reviewer.commands) {
    lines.push(`  ${command.command}`);
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${lines.join("\n")}\n`, {
      ok: true,
      status,
      ...(status.state === "changes_requested"
        ? {
            hint: "address the findings above, then re-validate the revised plan before creating or replacing it",
          }
        : {}),
    }),
    stderr: "",
  };
}

interface RecordPlanReviewInput {
  context: ProjectContext;
  plan: Record<string, unknown>;
  verdictFlag: string;
  findingsPath: string | undefined;
  reviewerFlag: string | undefined;
  filePath: string;
  json: boolean;
  env: CliEnv;
  host: CliHost;
}

async function recordWorkflowPlanReview(
  input: RecordPlanReviewInput,
): Promise<CliResult> {
  const { context, json, host } = input;
  const verdict = REVIEW_VERDICT_BY_FLAG[input.verdictFlag];
  if (verdict === undefined) {
    return usageFailure(
      `unknown --verdict "${input.verdictFlag}" — use approved or changes-requested`,
      json,
    );
  }

  // Shape only, and deliberately: an existence check here would let a lookup
  // refuse a review, which is a new way for an advisory mechanism to fail.
  const reviewer = (
    input.reviewerFlag ??
    input.env["CC_CONVERSATION_ID"] ??
    ""
  ).trim();
  if (reviewer === "") {
    return usageFailure(
      "no reviewer identity — pass --reviewer <conversation-id> or run this from a conversation where CC_CONVERSATION_ID is set",
      json,
    );
  }

  let findings: string | null = null;
  if (input.findingsPath !== undefined) {
    const raw = await host.readTextFile(input.findingsPath);
    if (raw === null) {
      return usageFailure(
        `cannot read findings file "${input.findingsPath}"`,
        json,
      );
    }
    findings = raw;
  }
  if (
    verdict === "changes_requested" &&
    (findings === null || findings.trim() === "")
  ) {
    return usageFailure(
      "a changes-requested verdict requires its findings artifact — pass --findings <path> naming the file that justifies it",
      json,
    );
  }

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: planReviewsPath(context),
    body: {
      plan: input.plan,
      verdict,
      ...(findings === null ? {} : { findings }),
      reviewerConversationId: reviewer,
    },
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = planReviewRecordResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "the server returned an unrecognized review receipt",
      json,
    });
  }
  const review = parsed.data;

  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `recorded ${review.verdict} review of ${review.definitionHash} (reviewer: ${review.reviewerConversationId})\n`,
      {
        ok: true,
        review,
        ...(review.verdict === "changes_requested"
          ? {
              hint: `the planner recovers these findings with 'cctl workflow review --file ${input.filePath}' — no access to this conversation needed`,
            }
          : {}),
      },
    ),
    stderr: "",
  };
}

async function runWorkflowList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow list"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("workflow list takes no arguments", json);
  }

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: definitionsPath(context),
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = listResponseSchema.safeParse(result.body);
  const items = parsed.success ? parsed.data.items : [];
  const humanBody =
    items.length === 0
      ? "no workflow definitions found for this project\n"
      : `${items
          .map(
            (w) =>
              `${w.id}  ${w.name} (rev ${w.revision})${w.description ? `  —  ${w.description}` : ""}`,
          )
          .join("\n")}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, { ok: true, workflows: items }),
    stderr: "",
  };
}

/** The mutually-exclusive `workflow get` section selectors, in help order. */
const GET_SELECTOR_FLAGS = [
  "full",
  "context",
  "task",
  "charter",
  "config",
  "params",
] as const;

function applyGetSelector(
  record: OutlineRecord,
  selector: string,
  values: Record<string, string>,
): SliceResult {
  switch (selector) {
    case "context":
      return sliceContext(record, values["context"] ?? "");
    case "task":
      return sliceTask(record, values["task"] ?? "");
    case "charter":
      return sliceCharter(record);
    case "config":
      return sliceConfig(record);
    case "params":
      return sliceParams(record);
    default:
      return { ok: false, error: `unknown selector "${selector}"` };
  }
}

async function runWorkflowGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow get"), json);
  if (denied) return denied;

  const id = rest[0];
  if (id === undefined) {
    return usageFailure("workflow get requires an <id> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("workflow get takes a single <id> argument", json);
  }

  const tierResult = resolveTierFlag(values, json);
  if (!tierResult.ok) return tierResult.result;

  const selectors = GET_SELECTOR_FLAGS.filter(
    (name) => values[name] !== undefined,
  );
  if (selectors.length > 1) {
    return usageFailure(
      `choose at most one section selector (--${selectors.join(", --")})`,
      json,
    );
  }
  const selector = selectors[0];

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: definitionResourcePath(context, tierResult.tier, id),
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = getResponseSchema.safeParse(result.body);
  const item = parsed.success ? parsed.data.item : result.body;

  // --full: the entire record (the pre-outline behavior), for wholesale edits.
  if (selector === "full") {
    return {
      exitCode: EXIT_OK,
      stdout: render(json, `${JSON.stringify(item, null, 2)}\n`, {
        ok: true,
        item,
        ...(parsed.success && parsed.data.resolved !== undefined
          ? { resolved: parsed.data.resolved }
          : {}),
      }),
      stderr: "",
    };
  }

  const record = parseOutlineRecord(item);
  if (!record) {
    // Unrecognizable shape — fall back to the full item so nothing is hidden.
    return {
      exitCode: EXIT_OK,
      stdout: render(json, `${JSON.stringify(item, null, 2)}\n`, {
        ok: true,
        item,
      }),
      stderr: "",
    };
  }

  // Default: the compact outline (structure + identifiers + prose sizes).
  if (selector === undefined) {
    return {
      exitCode: EXIT_OK,
      stdout: render(json, renderOutline(record), {
        ok: true,
        outline: buildOutlineData(record),
      }),
      stderr: "",
    };
  }

  // A section selector: one full-prose slice.
  const slice = applyGetSelector(record, selector, values);
  if (!slice.ok) return usageFailure(slice.error, json);
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${JSON.stringify(slice.value, null, 2)}\n`, {
      ok: true,
      section: selector,
      value: slice.value,
    }),
    stderr: "",
  };
}

async function runWorkflowEdit(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow edit"), json);
  if (denied) return denied;

  const id = rest[0];
  if (id === undefined) {
    return usageFailure("workflow edit requires an <id> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("workflow edit takes a single <id> argument", json);
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "workflow edit requires --file <ops.json> (or --file - for stdin)",
      json,
    );
  }

  const tierResult = resolveTierFlag(values, json);
  if (!tierResult.ok) return tierResult.result;

  const ops = await readJsonObjectFile(host, filePath, "ops", json);
  if (!ops.ok) return ops.result;
  const body =
    values["dry-run"] !== undefined
      ? { ...ops.value, dryRun: true }
      : ops.value;

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "PATCH",
    path: definitionResourcePath(context, tierResult.tier, id),
    body,
  });
  if (result.kind !== "ok") return workflowEditFailure(result, json);

  const parsed = editResponseSchema.safeParse(result.body);
  const applied = parsed.success ? parsed.data.applied : undefined;
  const dryRun = parsed.success ? parsed.data.dryRun === true : false;
  const revision = parsed.success ? parsed.data.item.revision : undefined;
  const name = parsed.success ? parsed.data.item.name : undefined;
  const opCount =
    applied === undefined
      ? ""
      : `${applied} operation${applied === 1 ? "" : "s"}`;

  const humanLine = dryRun
    ? `dry-run OK${opCount ? `: ${opCount} would apply` : ""}\n`
    : `edited ${name ? `"${name}"` : id}${opCount ? `: ${opCount} applied` : ""}${revision !== undefined ? `, revision ${revision}` : ""}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanLine, {
      ok: true,
      workflowId: id,
      ...(applied !== undefined ? { applied } : {}),
      ...(revision !== undefined ? { revision } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    }),
    stderr: "",
  };
}

async function runWorkflowStatus(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow status"), json);
  if (denied) return denied;
  if (rest.length > 1) {
    return usageFailure(
      "workflow status takes at most one <executionId> argument",
      json,
    );
  }
  const executionId = rest[0];

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path:
      executionId === undefined
        ? `${graphWorkflowPath(context)}/execution`
        : `${graphWorkflowPath(context)}/executions/${encodePathSegment(executionId)}`,
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = statusResponseSchema.safeParse(result.body);
  const execution = parsed.success ? parsed.data.execution : null;

  if (!execution) {
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        "no active graph workflow execution in this session\n",
        {
          ok: true,
          execution: null,
        },
      ),
      stderr: "",
    };
  }

  // --json emits the full, unstripped execution the route returned; the human
  // table uses only the focused fields (doc 02 §2.4: status is the
  // highest-frequency call, so the default output stays compact).
  const rawExecution =
    result.body !== null &&
    typeof result.body === "object" &&
    "execution" in result.body
      ? (result.body as { execution: unknown }).execution
      : execution;
  const lanes = deriveExecutionLaneActivities(execution);

  return {
    exitCode: EXIT_OK,
    stdout: render(json, formatStatusTable(execution), {
      ok: true,
      execution: rawExecution,
      lanes,
    }),
    stderr: "",
  };
}

/**
 * The plan-defect halt as the halt block needs to read it. Deliberately lenient
 * and open: the persisted reason carries fields this renderer has no vocabulary
 * for (and a newer server adds more), and dropping the block over one of them
 * would leave the caller with a reason type and nothing to act on.
 */
const planDefectHaltReasonSchema = z.object({
  type: z.literal("plan_defect"),
  contextId: z.string(),
  planDefects: z
    .array(z.object({ title: z.string(), conflictingContract: z.string() }))
    .min(1),
  summary: z.string().nullish(),
});

/**
 * The candidate-unstable halt as the halt block needs to read it. Lenient for
 * the same reason as the plan-defect one above, and additionally over
 * `lastIncident`: a newer server can name an incident this build has never
 * heard of, and the count and stage are still worth printing. Absent rather
 * than defaulted, though — the persisted schema's `candidate_mismatch` default
 * is a statement about legacy ROWS, and restating it for a payload that simply
 * did not carry the field would print an invented diagnosis as fact.
 */
const candidateUnstableHaltReasonSchema = z.object({
  type: z.literal("candidate_unstable"),
  contextId: z.string(),
  stage: z.string(),
  driftedComponents: z.string().nullish(),
  lastIncident: z.string().nullish(),
  consecutiveCount: z.number(),
  summary: z.string().nullish(),
});

/** The plan-repair round fields the halt block reports. */
const planRepairRoundRowSchema = z.object({
  seq: z.number(),
  contextId: z.string(),
  haltType: z.string(),
  outcome: z.string().nullish(),
});

/**
 * The latest repair round answering this halt: same context, same halt type.
 * Repair may run more than once against one halt and the log is append-only, so
 * the highest seq is the live verdict; a round for a different halt type on the
 * same context is not this halt's answer.
 */
function latestRepairRoundLine(
  planRepairRounds: readonly unknown[],
  haltType: string,
  contextId: string,
): string[] {
  const repair = planRepairRounds
    .flatMap((round) => {
      const row = planRepairRoundRowSchema.safeParse(round);
      return row.success ? [row.data] : [];
    })
    .filter(
      (round) => round.haltType === haltType && round.contextId === contextId,
    )
    .reduce<z.infer<typeof planRepairRoundRowSchema> | null>(
      (latest, round) =>
        latest === null || round.seq > latest.seq ? round : latest,
      null,
    );
  return repair === null
    ? []
    : [`  repair: round ${repair.seq} ${repair.outcome ?? "in flight"}`];
}

/**
 * The halt block for the reasons whose type name is not, on its own, an account
 * of what stopped the run.
 *
 * `plan_defect` is the first: it reopens no task and charges no attempt, so the
 * finding it carries is the only thing that says what to repair, and the
 * automatic repair round that already answered it is the difference between "go
 * read the plan" and "repair already declined — decide yourself".
 * `candidate_unstable` is the second, for the same reason with different
 * evidence: the type says a loop was cut, and only the stage, the incident, and
 * the count say what was looping. Explicit vocabulary rather than a generic
 * dump: a reason type with no entry here keeps the bare `(halted: <type>)`
 * header it has always had.
 */
function formatHaltDetail(
  haltReason: unknown,
  planRepairRounds: readonly unknown[],
): string[] {
  const planDefect = planDefectHaltReasonSchema.safeParse(haltReason);
  if (planDefect.success) {
    return formatPlanDefectHalt(planDefect.data, planRepairRounds);
  }
  const unstable = candidateUnstableHaltReasonSchema.safeParse(haltReason);
  if (unstable.success) {
    return formatCandidateUnstableHalt(unstable.data, planRepairRounds);
  }
  return [];
}

function formatPlanDefectHalt(
  reason: z.infer<typeof planDefectHaltReasonSchema>,
  planRepairRounds: readonly unknown[],
): string[] {
  const first = reason.planDefects[0];
  if (first === undefined) return [];

  // Only the first finding is shown, so the omission states total/shown and
  // names the command that reveals the rest (steering: a cap without
  // disclosure is a defect). `status --json` returns the unstripped execution.
  const total = reason.planDefects.length;
  const disclosure =
    total > 1 ? " — cctl workflow status --json for the rest" : "";

  return [
    `plan defect: ${reason.contextId} — the plan, not the work`,
    `  findings: ${total} total, 1 shown${disclosure}`,
    `  finding: ${first.title}`,
    `  contract: ${first.conflictingContract}`,
    ...latestRepairRoundLine(planRepairRounds, "plan_defect", reason.contextId),
    ...(reason.summary ? [`  summary: ${reason.summary}`] : []),
  ];
}

function formatCandidateUnstableHalt(
  reason: z.infer<typeof candidateUnstableHaltReasonSchema>,
  planRepairRounds: readonly unknown[],
): string[] {
  return [
    `candidate unstable: ${reason.contextId} — validation never reached a verdict`,
    `  stage: ${reason.stage}`,
    ...(reason.lastIncident ? [`  incident: ${reason.lastIncident}`] : []),
    `  consecutive rounds: ${reason.consecutiveCount}`,
    // A `stale_result_rejected` run saw nothing move, and the halt records that
    // as an empty list. Printing an empty `drifted:` would send an operator
    // hunting a worktree writer that does not exist.
    ...(reason.driftedComponents
      ? [`  drifted: ${reason.driftedComponents}`]
      : []),
    ...latestRepairRoundLine(
      planRepairRounds,
      "candidate_unstable",
      reason.contextId,
    ),
    ...(reason.summary ? [`  summary: ${reason.summary}`] : []),
  ];
}

/** Short display label for the structured haltReason (or null when not halted). */
function haltLabel(haltReason: unknown): string | null {
  if (haltReason === null || haltReason === undefined) return null;
  if (typeof haltReason === "string") return haltReason;
  if (
    typeof haltReason === "object" &&
    "type" in haltReason &&
    typeof (haltReason as { type: unknown }).type === "string"
  ) {
    return (haltReason as { type: string }).type;
  }
  return "halted";
}

function formatStatusTable(execution: z.infer<typeof executionSchema>): string {
  const lanes = deriveExecutionLaneActivities(execution);
  const rows = execution.workingDefinition.executionContexts.map((ctx) => {
    const state = execution.contextStates[ctx.id];
    return {
      id: ctx.id,
      status: state?.status ?? "-",
      tasks: state
        ? `${state.completedTaskCount}/${state.totalTaskCount}`
        : "-",
    };
  });
  const idWidth = Math.max(0, ...rows.map((r) => r.id.length));
  const statusWidth = Math.max(0, ...rows.map((r) => r.status.length));

  const halt = haltLabel(execution.haltReason);
  const header = `${execution.id}  ${execution.status}${
    halt ? `  (halted: ${halt})` : ""
  }`;
  const laneBody = lanes
    .map(
      (lane) =>
        `  ${lane.laneId}  ${lane.status}  ${lane.members
          .map(
            (member) =>
              `${member.contextId}: ${member.activity} (${member.status})`,
          )
          .join(", ")}`,
    )
    .join("\n");
  const contextBody = rows
    .map(
      (r) =>
        `  ${r.id.padEnd(idWidth)}  ${r.status.padEnd(statusWidth)}  ${r.tasks}`,
    )
    .join("\n");
  const haltDetail = formatHaltDetail(
    execution.haltReason,
    execution.planRepairRounds,
  );
  const sections = [
    haltDetail.length > 0 ? haltDetail.join("\n") : null,
    lanes.length > 0 ? `lanes:\n${laneBody}` : null,
    rows.length > 0 ? `contexts:\n${contextBody}` : null,
  ].filter((section): section is string => section !== null);
  return sections.length === 0
    ? `${header}\n`
    : `${header}\n${sections.join("\n")}\n`;
}

async function runWorkflowDelete(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow delete"), json);
  if (denied) return denied;

  const id = rest[0];
  if (id === undefined) {
    return usageFailure("workflow delete requires an <id> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("workflow delete takes a single <id> argument", json);
  }

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "DELETE",
    path: `${definitionsPath(context)}/${encodePathSegment(id)}`,
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  // No hint — delete is terminal.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `deleted ${id}\n`, { ok: true }),
    stderr: "",
  };
}

async function runWorkflowStart(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow start"), json);
  if (denied) return denied;

  const id = rest[0];
  if (id === undefined) {
    return usageFailure("workflow start requires an <id> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("workflow start takes a single <id> argument", json);
  }

  let parameters: Record<string, unknown> | undefined;
  const filePath = values["file"];
  if (filePath !== undefined) {
    const inputs = await readJsonObjectFile(host, filePath, "inputs", json);
    if (!inputs.ok) return inputs.result;
    parameters = inputs.value;
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const callerConversationId = env["CC_CONVERSATION_ID"] ?? null;
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: graphWorkflowPath(context),
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    ...(callerConversationId === null
      ? {}
      : {
          headers: { [CALLER_CONVERSATION_HEADER]: callerConversationId },
        }),
    body: {
      definitionId: id,
      ...(parameters !== undefined ? { parameters } : {}),
    },
  });
  if (result.kind !== "ok") return workflowLaunchFailure(result, json);

  const parsed = startResponseSchema.safeParse(result.body);
  const executionId = parsed.success ? parsed.data.execution.executionId : null;

  // A park is an ACCEPTED launch carrying a receipt (D7 decision D1): the run
  // is durable and holds the session's lease, it simply has not begun. Read from
  // the receipt rather than decoding a refusal as a success.
  if (
    parsed.success &&
    parsed.data.receipt?.status === "awaiting_definition_approval" &&
    executionId !== null
  ) {
    const instruction = `Approve the pending workflow definition to resume execution ${executionId}.`;
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        `parked ${id} (run ${executionId}) awaiting definition approval\ninstruction: ${instruction}\n`,
        {
          ok: true,
          executionId,
          status: "awaiting_definition_approval",
          instruction,
        },
      ),
      stderr: "",
    };
  }
  const humanLine = executionId
    ? `started ${id} (run ${executionId})\n`
    : `started ${id}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanLine, {
      ok: true,
      ...(executionId ? { executionId } : {}),
      hint: WORKFLOW_START_HINT,
    }),
    stderr: "",
  };
}

/** `workflow run` launches an authored plan directly; it never writes a definition. */
async function runWorkflowRun(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow run"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "workflow run takes no positional arguments — pass --file",
      json,
    );
  }

  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("workflow run requires --file <plan.json>", json);
  }
  const wait = values["wait"] !== undefined;
  const timeoutValue = values["timeout"];
  if (timeoutValue !== undefined && !wait) {
    return usageFailure(
      "workflow run: --timeout only applies with --wait",
      json,
    );
  }
  let waitBudgetMs = DEFAULT_WORKFLOW_WAIT_BUDGET_MS;
  if (timeoutValue !== undefined) {
    const parsedTimeout = parseDuration(timeoutValue);
    if (parsedTimeout === null) {
      return usageFailure(
        `invalid --timeout "${timeoutValue}" — use e.g. 25m, 90s, 500ms`,
        json,
      );
    }
    waitBudgetMs = parsedTimeout;
  }

  const plan = await readJsonObjectFile(host, filePath, "plan", json);
  if (!plan.ok) return plan.result;

  let inputs: Record<string, unknown> | undefined;
  const inputsPath = values["inputs"];
  if (inputsPath !== undefined) {
    const inputDocument = await readJsonObjectFile(
      host,
      inputsPath,
      "inputs",
      json,
    );
    if (!inputDocument.ok) return inputDocument.result;
    inputs = inputDocument.value;
  }

  if (env["CC_CONVERSATION_SCOPE"] === "project") {
    return projectScopeRunFailure(json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${graphWorkflowPath(context)}/run`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    body: {
      plan: plan.value,
      ...(inputs !== undefined ? { inputs } : {}),
    },
  });
  if (result.kind !== "ok") return workflowLaunchFailure(result, json);

  const response = z
    .object({ receipt: graphWorkflowLaunchReceiptSchema })
    .safeParse(result.body);
  if (!response.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected workflow run response from the CC server",
      json,
    });
  }
  const receipt = response.data.receipt;
  if (wait) {
    return waitForWorkflowBoundary({
      context,
      executionId: receipt.executionId,
      cursor: null,
      budgetMs: waitBudgetMs,
      timeoutLabel: timeoutValue ?? DEFAULT_WORKFLOW_WAIT_TIMEOUT_LABEL,
      json,
      host,
      launchReceipt: receipt,
      scope:
        flags.project !== undefined || flags.session !== undefined
          ? { project: context.project, session: context.session }
          : undefined,
    });
  }
  return {
    exitCode: EXIT_OK,
    stdout: render(json, formatWorkflowLaunchReceipt(receipt), {
      ok: true,
      ...receipt,
    }),
    stderr: "",
  };
}

function formatWorkflowLaunchReceipt(
  receipt: GraphWorkflowLaunchReceipt,
): string {
  return [
    `launched ${receipt.executionId}  ${receipt.status}`,
    `  origin: ${formatWorkflowOrigin(receipt.origin)}`,
    `  origin conversation: ${receipt.originConversationId ?? "-"}`,
    `  deep link: ${receipt.deepLink}`,
    "",
  ].join("\n");
}

function formatWorkflowBoundaryResult(result: WorkflowBoundaryResult): string {
  const actions = result.pendingActions.map(
    (action, index) => `  action[${index + 1}]: ${JSON.stringify(action)}`,
  );
  // A halt boundary carries the reason the run stopped; without the block a
  // `halt` line says only that something did. The boundary projection has no
  // repair log, so the round outcome is a `status` detail only.
  const halt = formatHaltDetail(result.haltReason, []).map(
    (line) => `  ${line}`,
  );
  return [
    `${result.executionId}  ${result.boundaryKind}`,
    `  status: ${result.status}`,
    `  cursor: ${String(result.cursor)}`,
    ...halt,
    ...(result.contextId === null ? [] : [`  context: ${result.contextId}`]),
    `  origin: ${formatWorkflowOrigin(result.origin)}`,
    `  origin conversation: ${result.originConversationId ?? "-"}`,
    `  deep link: ${result.deepLink}`,
    ...actions,
    `  outputs: ${JSON.stringify(result.outputs)}`,
    "",
  ].join("\n");
}

type WorkflowWaitContinuationDetails = Record<string, unknown> & {
  executionId: string;
  cursor: string | null;
  continueWith: string;
  project?: string;
  session?: string;
};

interface WorkflowWaitScope {
  project: string;
  session: string;
}

function workflowWaitContinuation(input: {
  executionId: string;
  cursor: string | null;
  timeoutLabel: string;
  scope?: WorkflowWaitScope;
}): WorkflowWaitContinuationDetails {
  const cursorArgs = input.cursor === null ? "" : ` --cursor ${input.cursor}`;
  const scopeArgs =
    input.scope === undefined
      ? ""
      : ` --project ${input.scope.project} --session ${input.scope.session}`;
  return {
    executionId: input.executionId,
    cursor: input.cursor,
    ...(input.scope ?? {}),
    continueWith: `cctl workflow wait ${input.executionId}${cursorArgs}${scopeArgs} --timeout ${input.timeoutLabel}`,
  };
}

function workflowWaitContinuationFailure(input: {
  kind: "timeout" | "disconnected";
  executionId: string;
  cursor: string | null;
  timeoutLabel: string;
  json: boolean;
  scope?: WorkflowWaitScope;
  connectionDetail?: string;
}): CliResult {
  const details = workflowWaitContinuation(input);
  const message =
    input.kind === "timeout"
      ? `workflow wait timed out after ${input.timeoutLabel} — execution ${input.executionId} continues server-side`
      : `workflow wait disconnected — execution ${input.executionId} continues server-side`;
  const detail = [
    ...(input.connectionDetail ? [input.connectionDetail] : []),
    `  execution: ${details.executionId}`,
    `  cursor: ${details.cursor ?? "-"}`,
    `  continue: ${details.continueWith}`,
  ].join("\n");
  return failure({
    exitCode:
      input.kind === "timeout" ? EXIT_OPERATION_FAILED : EXIT_CONNECTION,
    message,
    detail,
    code: input.kind === "timeout" ? "wait_timeout" : "wait_disconnected",
    details,
    json: input.json,
  });
}

async function waitForWorkflowBoundary(input: {
  context: SessionContext;
  executionId: string;
  cursor: string | null;
  budgetMs: number;
  timeoutLabel: string;
  json: boolean;
  host: CliHost;
  launchReceipt?: GraphWorkflowLaunchReceipt;
  scope?: WorkflowWaitScope;
}): Promise<CliResult> {
  let remainingBudgetMs = Math.max(0, input.budgetMs);
  const now = input.host.now ?? Date.now;
  for (;;) {
    if (remainingBudgetMs === 0) {
      return workflowWaitContinuationFailure({
        kind: "timeout",
        executionId: input.executionId,
        cursor: input.cursor,
        timeoutLabel: input.timeoutLabel,
        json: input.json,
        scope: input.scope,
      });
    }
    const params = new URLSearchParams();
    if (input.cursor !== null) params.set("cursor", input.cursor);
    const query = params.toString();
    const requestStartedAt = now();
    const result = await cliRequest(input.host, {
      server: input.context.server,
      token: input.context.token,
      tokenSource: input.context.tokenSource,
      method: "GET",
      path: `${graphWorkflowPath(input.context)}/executions/${encodePathSegment(input.executionId)}/result${query ? `?${query}` : ""}`,
      timeoutMs: Math.max(1, Math.ceil(remainingBudgetMs)),
    });
    const requestElapsedMs = Math.max(0, now() - requestStartedAt);
    remainingBudgetMs = Math.max(0, remainingBudgetMs - requestElapsedMs);
    if (result.kind === "connection") {
      return workflowWaitContinuationFailure({
        kind: remainingBudgetMs === 0 ? "timeout" : "disconnected",
        executionId: input.executionId,
        cursor: input.cursor,
        timeoutLabel: input.timeoutLabel,
        json: input.json,
        scope: input.scope,
        connectionDetail: result.detail,
      });
    }
    if (remainingBudgetMs === 0) {
      return workflowWaitContinuationFailure({
        kind: "timeout",
        executionId: input.executionId,
        cursor: input.cursor,
        timeoutLabel: input.timeoutLabel,
        json: input.json,
        scope: input.scope,
      });
    }
    if (result.kind !== "ok") return workflowFailure(result, input.json);

    const parsed = workflowBoundaryResponseSchema.safeParse(result.body);
    if (!parsed.success) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "unexpected workflow wait response from the CC server",
        json: input.json,
      });
    }
    if (parsed.data.result !== null) {
      const humanText = [
        ...(input.launchReceipt === undefined
          ? []
          : [formatWorkflowLaunchReceipt(input.launchReceipt)]),
        formatWorkflowBoundaryResult(parsed.data.result),
      ].join("");
      return {
        exitCode: EXIT_OK,
        stdout: render(input.json, humanText, {
          ok: true,
          ...(input.launchReceipt ?? {}),
          result: parsed.data.result,
        }),
        stderr: "",
      };
    }
    const sleepMs = Math.min(WORKFLOW_WAIT_POLL_INTERVAL_MS, remainingBudgetMs);
    const sleepStartedAt = now();
    await input.host.sleep(sleepMs);
    const sleepElapsedMs = Math.max(0, now() - sleepStartedAt);
    remainingBudgetMs = Math.max(
      0,
      remainingBudgetMs - Math.max(sleepMs, sleepElapsedMs),
    );
  }
}

async function runWorkflowWait(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow wait"), json);
  if (denied) return denied;
  const executionId = rest[0];
  if (executionId === undefined) {
    return usageFailure("workflow wait requires an <executionId>", json);
  }
  if (rest.length > 1) {
    return usageFailure(
      "workflow wait takes a single <executionId> argument",
      json,
    );
  }

  const cursorValue = values["cursor"];
  const cursor = cursorValue === undefined ? null : cursorValue.trim();
  if (cursor !== null && cursor.length === 0) {
    return usageFailure("workflow wait: --cursor must not be empty", json);
  }
  const timeoutValue = values["timeout"];
  let budgetMs = DEFAULT_WORKFLOW_WAIT_BUDGET_MS;
  if (timeoutValue !== undefined) {
    const parsedTimeout = parseDuration(timeoutValue);
    if (parsedTimeout === null) {
      return usageFailure(
        `invalid --timeout "${timeoutValue}" — use e.g. 25m, 90s, 500ms`,
        json,
      );
    }
    budgetMs = parsedTimeout;
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;
  return waitForWorkflowBoundary({
    context,
    executionId,
    cursor,
    budgetMs,
    timeoutLabel: timeoutValue ?? DEFAULT_WORKFLOW_WAIT_TIMEOUT_LABEL,
    json,
    host,
    scope:
      flags.project !== undefined || flags.session !== undefined
        ? { project: context.project, session: context.session }
        : undefined,
  });
}

/** Explicit, audited release of a resumably halted execution into History. */
async function runWorkflowAbandon(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow abandon"), json);
  if (denied) return denied;
  const executionId = rest[0];
  if (executionId === undefined) {
    return usageFailure("workflow abandon requires an <executionId>", json);
  }
  if (rest.length > 1) {
    return usageFailure(
      "workflow abandon takes a single <executionId> argument",
      json,
    );
  }
  const reason = (values["reason"] ?? "").trim();
  if (reason.length === 0) {
    return usageFailure("workflow abandon requires --reason <reason>", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${graphWorkflowPath(context)}/abandon`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    body: { executionId, reason },
  });
  if (result.kind !== "ok") return workflowLiveFailure(result, json);

  const parsed = abandonResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected workflow abandon response from the CC server",
      json,
    });
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `abandoned ${executionId}\n`, {
      ok: true,
      abandoned: true,
      execution: parsed.data.execution,
    }),
    stderr: "",
  };
}

async function runWorkflowTemplates(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow templates"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "workflow templates takes no positional arguments",
      json,
    );
  }

  let tier: TemplateTier | undefined;
  const tierValue = values["tier"];
  if (tierValue !== undefined) {
    if (!(TEMPLATE_TIERS as readonly string[]).includes(tierValue)) {
      return usageFailure(
        `--tier must be one of: ${TEMPLATE_TIERS.join(", ")}`,
        json,
      );
    }
    tier = tierValue as TemplateTier;
  }

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  // The project templates route already returns tier-tagged items across BOTH
  // tiers (mirroring the list_templates MCP tool); --tier filters client-side.
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: templatesPath(context),
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = templatesResponseSchema.safeParse(result.body);
  const all = parsed.success ? parsed.data.items : [];
  const items = tier ? all.filter((t) => t.tier === tier) : all;
  const humanBody =
    items.length === 0
      ? "no workflow templates found\n"
      : `${items
          .map(
            (t) =>
              `${t.tier}  ${t.id}  ${t.name}${t.description ? `  —  ${t.description}` : ""}`,
          )
          .join("\n")}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, { ok: true, templates: items }),
    stderr: "",
  };
}

// --- Lane verbs (docs/design/cc-cli/02 §4) ------------------------------------

const completeResponseSchema = z.object({
  ok: z.literal(true),
  remainingTaskCount: z.number(),
  stopInstruction: z.string().optional(),
  // Server-authored tier-2 reminders (doc 04 §6). The CLI is a dumb renderer:
  // it never authors these — it only surfaces what the lane handler computed.
  reminders: z.array(z.string()).optional(),
});

const collabResponseSchema = z.object({
  ok: z.literal(true),
  status: z.string(),
  workflowId: z.string().optional(),
});

const sharedDocFileSchema = z.object({
  description: z.string(),
  readWhen: z.string(),
});

/** `…/graph-workflow/contexts/[contextId]` — the lane's own context resource. */
function laneContextPath(context: LaneContext): string {
  return `${graphWorkflowPath(context)}/contexts/${encodePathSegment(context.contextId)}`;
}

/** Steer for the lane loop: what to do once the current task is done. */
function remainingTasksHint(remaining: number): string {
  return remaining === 1
    ? "1 task remains in this context"
    : `${remaining} tasks remain in this context`;
}

// --- Live execution editing (docs/design/cc-cli/06) --------------------------

/**
 * The mutually-exclusive `workflow live get` section selectors, in help order.
 * `context`/`task`/`config` take a value (one item) and map to the endpoint's
 * `?context` / `?task` / `?config=<ctx>` (doc 06 §CLI surface: `--config <id>`
 * returns one context's FULL resolved config); `full` and `charter` (booleans)
 * map to `?full=true` / `?charter=true` (doc 07: the charter selector returns
 * the rendered charter document + amendment log). `outputs` (boolean) maps to
 * `?outputs=true` — the captured/pending structured output of every
 * schema-declaring context (R7.2). All are mutually exclusive; the default (no
 * selector) is the compact text outline.
 */
const LIVE_GET_SELECTOR_FLAGS = [
  "full",
  "context",
  "task",
  "config",
  "charter",
  "outputs",
] as const;

const amendResponseSchema = z.object({
  amended: z.number(),
  liveRevision: z.number(),
  policyBasis: z.string(),
  addedContextIds: z.array(z.string()).default([]),
  addedTaskIds: z.array(z.string()).default([]),
  addedEdgeIds: z.array(z.string()).default([]),
  previousWorkingDefinitionHash: z.string(),
  workingDefinitionHash: z.string().nullable(),
});

const liveEditResponseSchema = z.object({
  applied: z.number(),
  liveRevision: z.number(),
  affectedContextIds: z.array(z.string()).default([]),
  dryRun: z.boolean().optional(),
});

/**
 * `cctl workflow live get|edit|pause|resume` — act on the session's ACTIVE
 * launched execution (doc 06 §CLI surface). Session-scoped via
 * `resolveSessionContext`; the `execution`/`exec` aliases are rewritten to `live`
 * before dispatch (see `runWorkflow`), so all three share this one implementation
 * and one help node.
 */
/**
 * Rows per ledger page. The PAGE is what D9 bounds; the walk itself runs to
 * exhaustion unless `--max-pages` bounds it, because complete decision history
 * has to stay reachable from the CLI.
 */
const LEDGER_PAGE_SIZE = 500;

async function runWorkflowLive(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["workflow", "live"],
    rest,
    json: flags.json,
    handlers: {
      get: (r) => runWorkflowLiveGet(r, flags, values, env, host),
      ledger: (r) => runWorkflowLiveLedger(r, flags, values, env, host),
      edit: (r) => runWorkflowLiveEdit(r, flags, values, env, host),
      amend: (r) => runWorkflowLiveAmend(r, flags, values, env, host),
      pause: (r) => runWorkflowLivePause(r, flags, values, env, host),
      resume: (r) => runWorkflowLiveResume(r, flags, values, env, host),
      abort: (r) => runWorkflowLiveAbort(r, flags, values, env, host),
    },
  });
}

/**
 * `workflow live abort` — end the session's active run. The recovery verb the
 * orphan dead end lacked: it existed only as an API route, so an agent that
 * stranded a run had to call it raw (ticket #47 note 9e5ba960).
 *
 * `aborted` auto-releases, so this hands the session's execution slot back on
 * its own — there is no separate release step.
 */
async function runWorkflowLiveAbort(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow live abort"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("workflow live abort takes no arguments", json);
  }
  const reason = (values["reason"] ?? "").trim();
  if (reason.length === 0) {
    return usageFailure("workflow live abort requires --reason <reason>", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${graphWorkflowPath(context)}/abort`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    body: { reason },
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  return {
    exitCode: EXIT_OK,
    stdout: render(json, "aborted\n", {
      ok: true,
      aborted: true,
      released: true,
    }),
    stderr: "",
  };
}

/** The endpoint body's `section` slice value, for pretty-printing a selector. */
function liveOutlineSectionValue(body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  const record = body as Record<string, unknown>;
  const section = record["section"];
  if (typeof section === "string" && section in record) return record[section];
  return body;
}

async function runWorkflowLiveGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow live get"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("workflow live get takes no arguments", json);
  }

  const selectors = LIVE_GET_SELECTOR_FLAGS.filter(
    (name) => values[name] !== undefined,
  );
  if (selectors.length > 1) {
    return usageFailure(
      `choose at most one section selector (--${selectors.join(", --")})`,
      json,
    );
  }
  const selector = selectors[0];

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  // Each selector maps to its endpoint query param (doc 06); the default (no
  // selector) fetches the compact outline.
  const params = new URLSearchParams();
  if (selector === "full") params.set("full", "true");
  else if (selector === "charter") params.set("charter", "true");
  else if (selector === "outputs") params.set("outputs", "true");
  else if (selector === "context")
    params.set("context", values["context"] ?? "");
  else if (selector === "task") params.set("task", values["task"] ?? "");
  else if (selector === "config") params.set("config", values["config"] ?? "");
  const query = params.toString();

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: `${graphWorkflowPath(context)}/live-outline${query ? `?${query}` : ""}`,
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const body = result.body;
  const envelope: JsonEnvelope =
    body !== null && typeof body === "object"
      ? { ...(body as Record<string, unknown>), ok: true }
      : { ok: true };

  // Default (no selector) → the compact text outline; --charter → the rendered
  // charter document itself (markdown is the readable form, not a JSON dump);
  // --outputs → the capture table with each payload printed beneath its row;
  // any other section selector (--context/--task/--config/--full) → the
  // full-prose/full-config slice as JSON (same discipline as `workflow get`).
  let humanText: string;
  if (selector === undefined) {
    const outline =
      body !== null && typeof body === "object"
        ? (body as { outline?: unknown }).outline
        : undefined;
    const parsed = liveOutlineSchema.safeParse(outline);
    humanText = parsed.success
      ? `${renderLiveOutline(parsed.data)}\n`
      : `${JSON.stringify(body, null, 2)}\n`;
  } else if (selector === "outputs") {
    const parsed = liveOutputsSchema.safeParse(body);
    humanText = parsed.success
      ? renderLiveOutputs(parsed.data)
      : `${JSON.stringify(liveOutlineSectionValue(body), null, 2)}\n`;
  } else if (selector === "charter") {
    const section = liveOutlineSectionValue(body);
    const markdown =
      section !== null &&
      typeof section === "object" &&
      typeof (section as { markdown?: unknown }).markdown === "string"
        ? (section as { markdown: string }).markdown
        : null;
    humanText =
      markdown !== null
        ? `${markdown}\n`
        : `${JSON.stringify(section, null, 2)}\n`;
  } else {
    humanText = `${JSON.stringify(liveOutlineSectionValue(body), null, 2)}\n`;
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanText, envelope),
    stderr: "",
  };
}

/**
 * The loop ledger (D4 R16.2): current markers off the execution, complete
 * decision history off the cursor-paginated event reader, both projected by the
 * shared `deriveLoopLedger` the inspector uses.
 */
async function runWorkflowLiveLedger(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow live ledger"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("workflow live ledger takes no arguments", json);
  }

  const startCursor = integerFlag(values["cursor"], "--cursor", 0);
  if (!startCursor.ok) return usageFailure(startCursor.message, json);
  const maxPages = integerFlag(values["max-pages"], "--max-pages", 1);
  if (!maxPages.ok) return usageFailure(maxPages.message, json);

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const executionResult = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: `${graphWorkflowPath(context)}/execution`,
  });
  if (executionResult.kind !== "ok")
    return workflowFailure(executionResult, json);

  const parsed = ledgerExecutionSchema.safeParse(executionResult.body);
  const execution = parsed.success ? parsed.data.execution : null;
  if (!execution) {
    return usageFailure(
      "no active graph workflow execution in this session",
      json,
    );
  }

  // A loop-free execution has no ledger to read, so it never walks the log.
  const declaresLoops =
    (execution.workingDefinition.loopGroups ?? []).length > 0 ||
    Object.keys(execution.loopStates).length > 0;

  const rows: LedgerDecisionRow[] = [];
  let cursor: number | null = startCursor.value;
  let walk: LedgerWalk = {
    complete: true,
    resumeCursor: null,
    reason: "complete",
  };
  let pagesRead = 0;
  while (declaresLoops) {
    if (maxPages.value !== null && pagesRead >= maxPages.value) {
      walk = { complete: false, resumeCursor: cursor, reason: "page-bound" };
      break;
    }
    const params = new URLSearchParams({
      executionId: execution.id,
      page: "true",
      direction: "asc",
      limit: String(LEDGER_PAGE_SIZE),
    });
    if (cursor !== null) params.set("cursor", String(cursor));
    const pageResult = await cliRequest(host, {
      server: context.server,
      token: context.token,
      tokenSource: context.tokenSource,
      method: "GET",
      path: `${graphWorkflowPath(context)}/events?${params.toString()}`,
    });
    if (pageResult.kind !== "ok") return workflowFailure(pageResult, json);
    const parsedPage = ledgerEventPageSchema.safeParse(pageResult.body);
    if (!parsedPage.success) {
      walk = { complete: false, resumeCursor: null, reason: "unreadable" };
      break;
    }
    pagesRead += 1;
    rows.push(...selectLedgerDecisionRows(parsedPage.data));

    const next: number | null = parsedPage.data.nextCursor;
    if (next === null) break;
    // A cursor that does not advance would walk forever. It cannot happen
    // against the keyset reader, which is exactly why the CLI must not trust it
    // blind: a hung command reads as a broken tool, not a broken server.
    if (cursor !== null && next <= cursor) {
      walk = { complete: false, resumeCursor: null, reason: "reader-stalled" };
      break;
    }
    cursor = next;
  }

  const entries = buildLedger(execution, rows);
  return {
    exitCode: EXIT_OK,
    stdout: render(json, renderLedger(entries, walk), {
      ok: true,
      loops: entries,
      ...walk,
    }),
    stderr: "",
  };
}

type IntegerFlag =
  | { readonly ok: true; readonly value: number | null }
  | { readonly ok: false; readonly message: string };

/** An optional integer flag, refused locally before any network call. */
function integerFlag(
  raw: string | undefined,
  flag: string,
  minimum: number,
): IntegerFlag {
  if (raw === undefined) return { ok: true, value: null };
  const parsed = Number(raw.trim());
  if (raw.trim() === "" || !Number.isInteger(parsed) || parsed < minimum) {
    return { ok: false, message: `${flag} must be an integer >= ${minimum}` };
  }
  return { ok: true, value: parsed };
}

async function runWorkflowLiveEdit(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow live edit"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "workflow live edit takes no positional arguments — pass --file",
      json,
    );
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "workflow live edit requires --file <live-ops.json> (or --file - for stdin)",
      json,
    );
  }

  // Deterministic local checks (flag present, file readable, JSON parses) fail
  // at exit 2 BEFORE any network round-trip (doc 06 §CLI surface).
  const ops = await readJsonObjectFile(host, filePath, "ops", json);
  if (!ops.ok) return ops.result;

  // The CLI always self-identifies as `cli` (D15); `--dry-run` maps to the body.
  const body: Record<string, unknown> = {
    ...ops.value,
    source: "cli",
    ...(values["dry-run"] !== undefined ? { dryRun: true } : {}),
  };

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${graphWorkflowPath(context)}/runtime-edits`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    body,
  });
  if (result.kind !== "ok") return workflowLiveFailure(result, json);

  const parsed = liveEditResponseSchema.safeParse(result.body);
  const applied = parsed.success ? parsed.data.applied : undefined;
  const liveRevision = parsed.success ? parsed.data.liveRevision : undefined;
  const dryRun = parsed.success ? parsed.data.dryRun === true : false;
  const affectedContextIds = parsed.success
    ? parsed.data.affectedContextIds
    : [];

  const opCount =
    applied === undefined
      ? "0 operations"
      : `${applied} operation${applied === 1 ? "" : "s"}`;
  const revSuffix =
    liveRevision !== undefined ? ` · liveRev ${liveRevision}` : "";
  const humanLine = dryRun
    ? `dry-run OK: ${opCount} would apply${revSuffix}\n`
    : `applied ${opCount}${revSuffix}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanLine, {
      ok: true,
      ...(applied !== undefined ? { applied } : {}),
      ...(liveRevision !== undefined ? { liveRevision } : {}),
      affectedContextIds,
      ...(dryRun ? { dryRun: true } : {}),
    }),
    stderr: "",
  };
}

/**
 * `workflow live amend` — the dedicated audited amendment of a launched
 * delivery-plan run (design §11). A delivery plan's compiled regions are locked
 * once launched, so a direct `live edit` into them refuses; this verb is the
 * escape that keeps locking safe. It is additive only (add-context, add-task,
 * add-edge with caller-chosen ids) and it never touches the approved candidate
 * — the rationale and the old/new working-definition hashes land in a durable
 * amendment event so the drift from the approved bytes stays readable.
 */
async function runWorkflowLiveAmend(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow live amend"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "workflow live amend takes no positional arguments — pass --reason and --file",
      json,
    );
  }
  const reason = (values["reason"] ?? "").trim();
  if (reason.length === 0) {
    return usageFailure(
      "workflow live amend requires --reason <rationale> — the rationale lands in the durable amendment event beside the old and new definition hashes",
      json,
    );
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "workflow live amend requires --file <live-ops.json> (or --file - for stdin)",
      json,
    );
  }

  // Deterministic local checks first (doc 06 §CLI surface): a missing flag or
  // an unreadable/unparseable file exits 2 before any network round-trip.
  const ops = await readJsonObjectFile(host, filePath, "ops", json);
  if (!ops.ok) return ops.result;

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const callerConversationId = env["CC_CONVERSATION_ID"] ?? null;
  const callerBackend = env["CC_AGENT_BACKEND"];
  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${graphWorkflowPath(context)}/amend`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    ...(callerConversationId === null
      ? {}
      : {
          headers: {
            [CALLER_CONVERSATION_HEADER]: callerConversationId,
            ...(callerBackend
              ? { [CALLER_BACKEND_HEADER]: callerBackend }
              : {}),
          },
        }),
    // `--reason` wins over a `reason` in the file: the flag is what the shell
    // history and the receipt both show, so the two must not disagree.
    body: { ...ops.value, reason },
  });
  if (result.kind !== "ok") return workflowLiveFailure(result, json);

  const parsed = amendResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return {
      exitCode: EXIT_OK,
      stdout: render(json, "amended\n", { ok: true }),
      stderr: "",
    };
  }
  const amended = parsed.data;
  const added = [
    ...amended.addedContextIds.map((id) => `context ${id}`),
    ...amended.addedTaskIds.map((id) => `task ${id}`),
    ...amended.addedEdgeIds.map((id) => `edge ${id}`),
  ];
  const humanText = [
    `amended ${amended.amended} operation${amended.amended === 1 ? "" : "s"} · liveRev ${amended.liveRevision} · admitted by ${amended.policyBasis}`,
    ...added.map((entry) => `  + ${entry}`),
    `  working definition ${amended.previousWorkingDefinitionHash} -> ${amended.workingDefinitionHash ?? "unchanged"}`,
    "",
  ].join("\n");

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanText, { ok: true, ...amended }),
    stderr: "",
  };
}

async function runWorkflowLivePause(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return runWorkflowLivePauseResume("pause", rest, flags, values, env, host);
}

async function runWorkflowLiveResume(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return runWorkflowLivePauseResume("resume", rest, flags, values, env, host);
}

/**
 * `workflow live pause` / `live resume` POST the existing endpoints (no body
 * flags in v1). A server 409 (pausing an already-paused / resuming a running
 * execution) renders as exit 1 with the server's message; a 404 (no active
 * execution) is a caller mistake → exit 2.
 */
async function runWorkflowLivePauseResume(
  action: "pause" | "resume",
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor(`workflow live ${action}`),
    json,
  );
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(`workflow live ${action} takes no arguments`, json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${graphWorkflowPath(context)}/${action}`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${action === "pause" ? "paused" : "resumed"}\n`, {
      ok: true,
    }),
    stderr: "",
  };
}

async function runWorkflowTask(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["workflow", "task"],
    rest,
    json: flags.json,
    handlers: {
      complete: (r) => runWorkflowTaskComplete(r, flags, values, env, host),
      add: (r) => runWorkflowTaskAdd(r, flags, values, env, host),
    },
  });
}

async function runWorkflowTaskComplete(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor("workflow task complete"),
    json,
  );
  if (denied) return denied;

  const taskId = rest[0];
  if (taskId === undefined) {
    return usageFailure(
      "workflow task complete requires a <taskId> argument",
      json,
    );
  }
  if (rest.length > 1) {
    return usageFailure(
      "workflow task complete takes a single <taskId> argument",
      json,
    );
  }
  const summary = values["summary"];
  if (summary === undefined) {
    return usageFailure(
      "workflow task complete requires --summary <what you changed and how you verified it>",
      json,
    );
  }

  const resolved = await resolveLaneContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${laneContextPath(context)}/tasks/${encodePathSegment(taskId)}/complete`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    body: { executionId: context.executionId, summary },
  });
  // A 409 halt carries { error: reason, halt, reason }; the generic mapping
  // prints the reason verbatim and exits 1 (doc 02 §4).
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = completeResponseSchema.safeParse(result.body);
  const remaining = parsed.success ? parsed.data.remainingTaskCount : 0;
  const stopInstruction = parsed.success
    ? parsed.data.stopInstruction
    : undefined;
  const reminders = parsed.success ? parsed.data.reminders : undefined;

  // A load-bearing stop (mid-turn context rotation) is primary output: it prints
  // in the body verbatim. The tier arbitration — that the remaining-count hint is
  // suppressed whenever a stop instruction is present, in both text and JSON — is
  // owned by `render` (doc 01 §6), so pass both `stopInstruction` and the `hint`
  // and let the renderer drop the hint.
  const humanBody =
    stopInstruction !== undefined
      ? `completed ${taskId}\n${stopInstruction}\n`
      : `completed ${taskId}\n`;
  const envelope: JsonEnvelope = {
    ok: true,
    remainingTaskCount: remaining,
    hint: remainingTasksHint(remaining),
    ...(stopInstruction !== undefined ? { stopInstruction } : {}),
    ...(reminders && reminders.length > 0 ? { reminders } : {}),
  };

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, envelope),
    stderr: "",
  };
}

async function runWorkflowTaskAdd(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("workflow task add"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "workflow task add takes no positional arguments — pass --title and --instructions",
      json,
    );
  }
  const title = values["title"];
  const instructions = values["instructions"];
  if (title === undefined || instructions === undefined) {
    return usageFailure(
      "workflow task add requires --title <name> and --instructions <what to do>",
      json,
    );
  }
  const slug = values["slug"];

  const resolved = await resolveLaneContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${laneContextPath(context)}/tasks`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    body: {
      executionId: context.executionId,
      title,
      instructions,
      ...(slug !== undefined ? { slug } : {}),
    },
  });
  // 403 (allowAgentTaskAdd disabled) carries { error }; exit 1 with the text.
  if (result.kind !== "ok") return failureFromRequest(result, json);

  // No hint — adding a task is a side action off the current task, not a step
  // in a chained flow.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `added task "${title}"\n`, { ok: true }),
    stderr: "",
  };
}

// --- Runtime graph expansion (D4 R6) -----------------------------------------

const expandResponseSchema = z.object({
  /** True when the server answered from a prior acceptance receipt (D4 R6.3). */
  replayed: z.boolean().default(false),
  liveRevision: z.number(),
  createdContextIds: z.array(z.string()).default([]),
  createdTaskIds: z.array(z.string()).default([]),
  rejoinContextIds: z.array(z.string()).default([]),
});

async function runWorkflowGraph(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["workflow", "graph"],
    rest,
    json: flags.json,
    handlers: {
      expand: (r) => runWorkflowGraphExpand(r, flags, values, env, host),
    },
  });
}

/**
 * `cctl workflow graph expand --file <expansion.json>` — the lane verb that
 * appends a bounded subgraph to the RUNNING execution (D4 R6).
 *
 * Unlike every other lane verb it carries a SECOND credential: the signed
 * implementer-lane capability CC injects as `CC_WORKFLOW_LANE_CAPABILITY` at
 * dispatch, forwarded verbatim in the `x-cc-lane-capability` header. The CLI
 * never mints, inspects, or rewrites it — it is opaque transport here, and the
 * server is what verifies its signature and scope.
 *
 * The payload is NOT validated client-side beyond "is it an object": the
 * envelope is a server decision, and a CLI that pre-judged it would drift.
 */
async function runWorkflowGraphExpand(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor("workflow graph expand"),
    json,
  );
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "workflow graph expand takes no positional arguments — pass --file",
      json,
    );
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "workflow graph expand requires --file <expansion.json>",
      json,
    );
  }

  const file = await readJsonObjectFile(host, filePath, "expansion", json);
  if (!file.ok) return file.result;
  const payload = file.value;
  if (
    !Array.isArray((payload as Record<string, unknown>)["contexts"]) ||
    !Array.isArray((payload as Record<string, unknown>)["tasks"])
  ) {
    return usageFailure(
      `expansion file "${filePath}" must be a JSON object with "contexts" and "tasks" arrays`,
      json,
    );
  }

  const capability = env["CC_WORKFLOW_LANE_CAPABILITY"];
  if (!capability) {
    return usageFailure(
      "no lane capability — set CC_WORKFLOW_LANE_CAPABILITY (graph expansion runs only in an implementer lane CC dispatched)",
      json,
    );
  }

  const resolved = await resolveLaneContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${laneContextPath(context)}/expand`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    headers: { "x-cc-lane-capability": capability },
    body: { executionId: context.executionId, request: payload },
  });
  // 403 (no capability / unauthorized lane) and 409 (envelope refusal) both
  // carry { error, code, issues }; the generic mapping prints them and exits 1.
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = expandResponseSchema.safeParse(result.body);
  const added = parsed.success ? parsed.data : null;
  const contextList =
    added === null
      ? ""
      : `${added.createdContextIds.map((id) => `  ${id}`).join("\n")}\n`;
  // A replay is not an expansion. Saying "added" when the server answered from
  // a receipt would tell a lane that retried after a lost response that it just
  // grew the graph a second time (D4 R6.3).
  const humanBody =
    added === null
      ? "expanded the graph\n"
      : added.replayed
        ? `this request was already applied — replayed its receipt, the graph is unchanged\n${contextList}`
        : `expanded the graph — added ${added.createdContextIds.length} context(s), ${added.createdTaskIds.length} task(s)\n${contextList}`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      ...(added ?? {}),
      hint:
        added?.replayed === true
          ? "nothing new to wait for — these contexts are already scheduled; use a fresh requestId for a different expansion"
          : "the scheduler picks the additions up on its next tick — keep working",
    }),
    stderr: "",
  };
}

async function runWorkflowSharedDoc(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["workflow", "shared-doc"],
    rest,
    json: flags.json,
    handlers: {
      upsert: (r) => runWorkflowSharedDocUpsert(r, flags, values, env, host),
    },
  });
}

async function runWorkflowSharedDocUpsert(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor("workflow shared-doc upsert"),
    json,
  );
  if (denied) return denied;

  const relativePath = rest[0];
  if (relativePath === undefined) {
    return usageFailure(
      "workflow shared-doc upsert requires a <relativePath> argument",
      json,
    );
  }
  if (rest.length > 1) {
    return usageFailure(
      "workflow shared-doc upsert takes a single <relativePath> argument — quote paths with spaces",
      json,
    );
  }
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "workflow shared-doc upsert requires --file <doc.json> ({ description, readWhen })",
      json,
    );
  }

  const file = await readJsonObjectFile(host, filePath, "shared-doc", json);
  if (!file.ok) return file.result;
  const meta = sharedDocFileSchema.safeParse(file.value);
  if (!meta.success) {
    return usageFailure(
      `shared-doc file "${filePath}" must be a JSON object with string "description" and "readWhen"`,
      json,
    );
  }

  const resolved = await resolveLaneContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  // The endpoint's [...docPath] catch-all decodes each segment, so encode per
  // segment (a slash in the path stays a real separator).
  const encodedPath = relativePath.split("/").map(encodePathSegment).join("/");

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "PUT",
    path: `${graphWorkflowPath(context)}/shared-documents/${encodedPath}`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    body: {
      executionId: context.executionId,
      contextId: context.contextId,
      description: meta.data.description,
      readWhen: meta.data.readWhen,
    },
  });
  if (result.kind !== "ok") return failureFromRequest(result, json);

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `registered shared document ${relativePath}\n`, {
      ok: true,
    }),
    stderr: "",
  };
}

async function runWorkflowCollab(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["workflow", "collab"],
    rest,
    json: flags.json,
    handlers: {
      request: (r) => runWorkflowCollabRequest(r, flags, values, env, host),
    },
  });
}

async function runWorkflowCollabRequest(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor("workflow collab request"),
    json,
  );
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure(
      "workflow collab request takes no positional arguments — pass --brief",
      json,
    );
  }
  const brief = values["brief"];
  if (brief === undefined) {
    return usageFailure(
      "workflow collab request requires --brief <the question or decision>",
      json,
    );
  }

  const resolved = await resolveLaneContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${laneContextPath(context)}/collaboration-requests`,
    principalCapabilities: resolveCliPrincipalCapabilities(env),
    body: { executionId: context.executionId, brief },
  });
  // 403 (allowAgentCollaboration disabled) carries { error }; exit 1 with text.
  if (result.kind !== "ok") return failureFromRequest(result, json);

  const parsed = collabResponseSchema.safeParse(result.body);
  const workflowId = parsed.success ? parsed.data.workflowId : undefined;
  const startedLine = workflowId
    ? `collaboration started (workflow ${workflowId})`
    : "collaboration started";
  // The stop-and-wait directive is load-bearing protocol (the collaboration runs
  // in the background), so it is primary output, not a hint.
  const humanBody = `${startedLine}\nStop work on this turn and wait for the follow-up that delivers the outcome.\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      status: "started",
      ...(workflowId ? { workflowId } : {}),
    }),
    stderr: "",
  };
}
