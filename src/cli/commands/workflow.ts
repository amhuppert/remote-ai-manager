import { z } from "zod";
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

/** JSON-object plan file the author flow (validate/create/replace) reads. */
const definitionItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  revision: z.number(),
});
const mutationResponseSchema = z.object({ item: definitionItemSchema });

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
});
const executionSchema = z.object({
  id: z.string(),
  status: z.string(),
  // haltReason is a structured discriminated union server-side; keep it lenient
  // here and derive a short label for display (see haltLabel).
  haltReason: z.unknown().nullish(),
  workingDefinition: z.object({
    executionContexts: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  contextStates: z.record(z.string(), contextStateSchema),
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
  if (result.kind === "error" && result.status === 404) {
    return failure({
      exitCode: EXIT_USAGE,
      message: result.error,
      ...structuredErrorFields(result),
      json,
    });
  }
  if (result.kind === "error" && result.status === 400) {
    const semantic = result.code !== undefined;
    const detail =
      result.issues && result.issues.length > 0
        ? result.issues
            .map((issue) => `  ${issue.path}: ${issue.message}`)
            .join("\n")
        : undefined;
    return failure({
      exitCode: semantic ? EXIT_OPERATION_FAILED : EXIT_USAGE,
      message: result.error,
      ...(detail ? { detail } : {}),
      ...structuredErrorFields(result),
      json,
    });
  }
  return failureFromRequest(result, json);
}

export async function runWorkflow(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure(
      "workflow requires a subcommand: validate, create, replace, edit, list, get, status, delete, start, templates, task, shared-doc, or collab",
      json,
    );
  }
  if (sub === "task") {
    return runWorkflowTask(rest.slice(1), flags, values, env, host);
  }
  if (sub === "shared-doc") {
    return runWorkflowSharedDoc(rest.slice(1), flags, values, env, host);
  }
  if (sub === "collab") {
    return runWorkflowCollab(rest.slice(1), flags, values, env, host);
  }
  if (sub === "validate") {
    return runWorkflowValidate(rest.slice(1), flags, values, env, host);
  }
  if (sub === "create") {
    return runWorkflowCreate(rest.slice(1), flags, values, env, host);
  }
  if (sub === "replace") {
    return runWorkflowReplace(rest.slice(1), flags, values, env, host);
  }
  if (sub === "edit") {
    return runWorkflowEdit(rest.slice(1), flags, values, env, host);
  }
  if (sub === "list") {
    return runWorkflowList(rest.slice(1), flags, values, env, host);
  }
  if (sub === "get") {
    return runWorkflowGet(rest.slice(1), flags, values, env, host);
  }
  if (sub === "status") {
    return runWorkflowStatus(rest.slice(1), flags, values, env, host);
  }
  if (sub === "delete") {
    return runWorkflowDelete(rest.slice(1), flags, values, env, host);
  }
  if (sub === "start") {
    return runWorkflowStart(rest.slice(1), flags, values, env, host);
  }
  if (sub === "templates") {
    return runWorkflowTemplates(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown workflow subcommand "${sub}"`, json);
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
    path: `${graphWorkflowPath(context)}/validate`,
    body: plan.value,
  });
  // A 400 carries { error, issues[] }; the shared mapping renders each issue on
  // its own line with its JSON path and exits 2 (doc 02 §3.1).
  if (result.kind !== "ok") return workflowFailure(result, json);

  return {
    exitCode: EXIT_OK,
    stdout: render(json, "plan is valid\n", {
      ok: true,
      hint: `valid — create it with 'cctl workflow create --file ${filePath}'`,
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

  return {
    exitCode: EXIT_OK,
    stdout: render(json, formatStatusTable(execution), {
      ok: true,
      execution: rawExecution,
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
  const body = rows
    .map(
      (r) =>
        `  ${r.id.padEnd(idWidth)}  ${r.status.padEnd(statusWidth)}  ${r.tasks}`,
    )
    .join("\n");
  return rows.length === 0 ? `${header}\n` : `${header}\n${body}\n`;
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

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: graphWorkflowPath(context),
    body: {
      definitionId: id,
      ...(parameters !== undefined ? { parameters } : {}),
    },
  });
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

async function runWorkflowTask(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure(
      "workflow task requires a subcommand: complete or add",
      json,
    );
  }
  if (sub === "complete") {
    return runWorkflowTaskComplete(rest.slice(1), flags, values, env, host);
  }
  if (sub === "add") {
    return runWorkflowTaskAdd(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown workflow task subcommand "${sub}"`, json);
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

  const envelope: JsonEnvelope = { ok: true, remainingTaskCount: remaining };
  const humanLines = [`completed ${taskId}`];
  if (stopInstruction !== undefined) {
    // Load-bearing stop: primary output that REPLACES the remaining-count hint —
    // a "continue" hint must never sit beside a "stop" instruction (doc 01 §6).
    envelope.stopInstruction = stopInstruction;
    humanLines.push(stopInstruction);
  } else {
    envelope.hint = remainingTasksHint(remaining);
  }
  // Tier-2 reminders render after the primary output (and any stop
  // instruction), before the hint — `render()` places them (doc 04 §5.1).
  if (reminders && reminders.length > 0) envelope.reminders = reminders;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${humanLines.join("\n")}\n`, envelope),
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

async function runWorkflowSharedDoc(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure(
      "workflow shared-doc requires a subcommand: upsert",
      json,
    );
  }
  if (sub === "upsert") {
    return runWorkflowSharedDocUpsert(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown workflow shared-doc subcommand "${sub}"`, json);
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
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure("workflow collab requires a subcommand: request", json);
  }
  if (sub === "request") {
    return runWorkflowCollabRequest(rest.slice(1), flags, values, env, host);
  }
  return usageFailure(`unknown workflow collab subcommand "${sub}"`, json);
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
