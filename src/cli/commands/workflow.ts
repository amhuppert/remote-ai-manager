import { z } from "zod";
import { dispatchGroup } from "../dispatch";
import { flagNamesFor } from "../help-registry";
import {
  EXIT_OK,
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
const mutationResponseSchema = z.object({ item: definitionItemSchema });

/**
 * Located advice the validate endpoint returns beside `ok: true` (today the
 * guard enum-coverage lint). Never affects the exit code — a warned plan is
 * still creatable — so the parse is lenient: an unrecognized shape simply
 * yields no warnings rather than failing a valid plan.
 */
const validateResponseSchema = z.object({
  warnings: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
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
      list: (r) => runWorkflowList(r, flags, values, env, host),
      get: (r) => runWorkflowGet(r, flags, values, env, host),
      edit: (r) => runWorkflowEdit(r, flags, values, env, host),
      status: (r) => runWorkflowStatus(r, flags, values, env, host),
      start: (r) => runWorkflowStart(r, flags, values, env, host),
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
  const warningLines = warnings
    .map((warning) => `warning: ${warning.path}: ${warning.message}\n`)
    .join("");

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${warningLines}plan is valid\n`, {
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
    body: plan.value,
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = mutationResponseSchema.safeParse(result.body);
  const item = parsed.success ? parsed.data.item : null;
  const humanLine = item
    ? `created ${item.name} (id: ${item.id})\n`
    : "workflow created\n";

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanLine, {
      ok: true,
      ...(item ? { workflowId: item.id } : {}),
      ...(item
        ? { hint: `start it with 'cctl workflow start ${item.id}'` }
        : {}),
    }),
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
    body: plan.value,
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = mutationResponseSchema.safeParse(result.body);
  const item = parsed.success ? parsed.data.item : null;
  // No hint — replace is a revision, not a step in the author-then-start chain.
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      item
        ? `replaced ${item.name} (revision: ${item.revision})\n`
        : `replaced ${id}\n`,
      { ok: true, ...(item ? { revision: item.revision } : {}) },
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
  if (rest.length > 0) {
    return usageFailure("workflow status takes no arguments", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: `${graphWorkflowPath(context)}/execution`,
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
  const sections = [
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
  if (
    result.kind === "error" &&
    result.status === 409 &&
    result.code === "definition_approval_required"
  ) {
    const executionId = (
      result.details as { executionId?: unknown } | undefined
    )?.executionId;
    if (typeof executionId === "string" && executionId.trim().length > 0) {
      const instruction =
        result.instruction ??
        `Approve the pending workflow definition to resume execution ${executionId}.`;
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
  }
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = startResponseSchema.safeParse(result.body);
  const executionId = parsed.success ? parsed.data.execution.executionId : null;
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
      release: (r) => runWorkflowLiveRelease(r, flags, values, env, host),
    },
  });
}

/**
 * `workflow live abort` — end the session's active run. The recovery verb the
 * orphan dead end lacked: abort and release existed only as API routes, so an
 * agent that stranded a run had to call them raw (ticket #47 note 9e5ba960).
 *
 * `aborted` auto-releases, so this hands the session's execution slot back on
 * its own; `live release` is the backstop for a run that settled without one.
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

/**
 * `workflow live release` — the explicit, audited archive act: hand the
 * session's execution slot back. Releasing an already-released session is a
 * success, not a conflict, so a retry after a partial cleanup converges.
 */
async function runWorkflowLiveRelease(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor("workflow live release"),
    json,
  );
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("workflow live release takes no arguments", json);
  }
  const reason = (values["reason"] ?? "").trim();
  if (reason.length === 0) {
    return usageFailure(
      "workflow live release requires --reason <reason>",
      json,
    );
  }
  const expectedExecutionId = values["execution"]?.trim();

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${graphWorkflowPath(context)}/release`,
    body:
      expectedExecutionId === undefined || expectedExecutionId.length === 0
        ? { reason }
        : { reason, expectedExecutionId },
  });
  if (result.kind !== "ok") return workflowFailure(result, json);

  const parsed = releaseResponseSchema.safeParse(result.body);
  const alreadyReleased =
    parsed.success && parsed.data.alreadyReleased === true;
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      alreadyReleased
        ? "already released — this session owns no execution slot\n"
        : "released\n",
      {
        ok: true,
        released: true,
        alreadyReleased,
        execution: parsed.success ? parsed.data.executionId : undefined,
        status: parsed.success ? parsed.data.status : undefined,
      },
    ),
    stderr: "",
  };
}

const releaseResponseSchema = z.object({
  released: z.boolean(),
  alreadyReleased: z.boolean().optional(),
  executionId: z.string().optional(),
  status: z.string().optional(),
});

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
