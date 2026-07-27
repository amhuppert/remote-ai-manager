import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  createAuthoringSpecInputSchema,
  createSpecInitialElementSchema,
  draftElementBatchItemSchema,
} from "@/lib/specs/authoring-service";
import {
  explainInvalidElementHandle,
  isWellFormedElementHandle,
  parseElementHandle,
  specSlugSchema,
} from "@/lib/specs/handles";
import {
  dialRequiresHumanApproval,
  resolveDial,
  type ResolvedGateDial,
} from "@/lib/specs/policy";
import { approvalRequestReceiptSchema } from "@/lib/specs/review-service";
import {
  specAliasSchema,
  specElementSchema,
  specElementVersionSchema,
  specExecutionRowSchema,
  specGateSchema,
  specRevisionSchema,
  specSchema,
  specTaskClaimRowSchema,
  taskElementPayloadSchema,
} from "@/lib/specs/schemas";
import { executionScopeSchema } from "@/lib/specs/scope-validation";
import {
  specAssumptionViewSchema,
  specEditContextViewSchema,
  specQuestionViewSchema,
  specStartedExecutionViewSchema,
  type SpecEditContextView,
} from "@/lib/specs/view-schemas";
import { flagNamesFor } from "../../help-registry";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  readJsonObjectFile,
  render,
  resolveConversationContext,
  resolveProjectConversationContext,
  structuredErrorFields,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type ProjectConversationContext,
  type GlobalFlags,
} from "../../shared";

const logger = createLogger("cli.spec");
const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";
const CALLER_BACKEND_HEADER = "x-cc-agent-backend";

const createFlagsSchema = createAuthoringSpecInputSchema
  .omit({ projectPath: true, actor: true, initialElement: true })
  .strict();
/**
 * The addressing handle the server allocated for the element just written.
 * Criterion handles (R3.2) need the parent requirement's number, which the
 * element row does not carry, so the handle can only come from the server.
 * Optional so a CLI newer than its server still parses and degrades to the
 * kind/version phrasing rather than failing with invalid_response.
 */
const assignedHandleSchema = z.string().min(1).nullable().optional();
const createResponseSchema = z
  .object({
    spec: specSchema,
    draft: specRevisionSchema,
    element: specElementSchema,
    version: specElementVersionSchema,
    handle: assignedHandleSchema,
  })
  .strict();
// One element-file shape serves both the create --file (first save) and
// draft --file payloads; it is the server's own input schema, so the CLI
// cannot drift from what the create/draft-upsert actions accept.
const draftFileSchema = createSpecInitialElementSchema;
const draftResponseSchema = z
  .object({
    element: specElementSchema,
    version: specElementVersionSchema,
    handle: assignedHandleSchema,
  })
  .strict();
/**
 * The batch form of the same document: an array of element writes, each
 * carrying its OWN `baseElementVersion`. It is the server's batch item schema,
 * so a batch cannot be authored against a shape the action would reject.
 */
const draftBatchFileSchema = z.array(draftElementBatchItemSchema).min(1);
const draftBatchResponseSchema = z
  .object({
    revisionId: z.string().min(1),
    written: z.array(
      draftResponseSchema.extend({
        index: z.number().int().nonnegative(),
        elementId: z.string().min(1),
      }),
    ),
  })
  .strict();
/**
 * One refused element, addressed by its index in the submitted array. Parsed
 * leniently at the edges (an unknown future refusal code must still print) —
 * the index/elementId pairing is what the caller needs to act.
 */
const draftBatchRefusalSchema = z
  .object({
    index: z.number().int(),
    elementId: z.string().min(1).nullable(),
    code: z.string().min(1),
    unmetConditions: z.array(z.string()),
    currentElementVersion: z.number().int().positive().nullable(),
  })
  .passthrough();
const draftBatchRefusalsSchema = z
  .object({ refusals: z.array(draftBatchRefusalSchema).min(1) })
  .passthrough();
// Mutations answer with the same domain views the read path projects, so
// the CLI parses those views — a raw persistence row is a contract break.
const questionResponseSchema = specQuestionViewSchema;
const proposeResponseSchema = z
  .object({
    revision: specRevisionSchema,
    diff: z.unknown(),
    absorbedSignOff: z.boolean(),
  })
  .strict();
const advanceStageSchema = z.enum(["requirements", "design"]);
const advanceResponseSchema = z
  .object({ revision: specRevisionSchema })
  .strict();
const startResponseSchema = z
  .object({
    execution: specStartedExecutionViewSchema,
    definition: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .strict();
// The discovered-task file is the server's own capture payload shape (minus
// the fixed kind), so local validation cannot drift from what the
// capture-scope-amendment action accepts.
const discoveredTaskFileSchema = taskElementPayloadSchema.omit({ kind: true });
const captureResponseSchema = z
  .object({
    revision: specRevisionSchema,
    task: z
      .object({ element: specElementSchema, version: specElementVersionSchema })
      .strict(),
    restartRequired: z.boolean(),
  })
  .strict();
const renameResponseSchema = z
  .object({ spec: specSchema, alias: specAliasSchema })
  .strict();
const writeStatusSchema = z
  .object({
    openQuestions: z.array(
      z
        .object({
          id: z.string().min(1),
          handle: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const writeElementLookupSchema = z
  .object({
    element: z
      .object({
        element: specElementSchema,
      })
      .passthrough(),
  })
  .passthrough();
const taskClaimResponseSchema = specTaskClaimRowSchema.passthrough();

type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; result: CliResult };

function specBasePath(
  context: ProjectConversationContext,
  slug: string,
): string {
  return `/api/specs/${encodePathSegment(context.project)}/${encodePathSegment(slug)}`;
}

function actionPath(
  context: ProjectConversationContext,
  slug: string,
  action: string,
): string {
  return `${specBasePath(context, slug)}/actions/${encodePathSegment(action)}`;
}

function mutationHeaders(
  context: ProjectConversationContext,
  env: CliEnv,
): Record<string, string> {
  const backend = env["CC_AGENT_BACKEND"];
  return {
    [CALLER_CONVERSATION_HEADER]: context.conversation,
    ...(backend ? { [CALLER_BACKEND_HEADER]: backend } : {}),
  };
}

function validateSlug(
  input: string | undefined,
  command: string,
  json: boolean,
): CommandResult<string> {
  if (input === undefined) {
    return {
      ok: false,
      result: usageFailure(`spec ${command} requires <slug>`, json),
    };
  }
  const parsed = specSlugSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: invalid spec slug ${JSON.stringify(input)}`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

function noExtraPositionals(
  rest: string[],
  expected: number,
  command: string,
  json: boolean,
): CliResult | null {
  if (rest.length === expected) return null;
  return usageFailure(`spec ${command} received unexpected arguments`, json);
}

const MAX_RENDERED_FILE_ISSUES = 5;

function invalidFileResult(
  command: string,
  filePath: string,
  description: string,
  json: boolean,
  error: z.ZodError,
): CliResult {
  // The failing paths are the actionable part of the refusal: without them the
  // caller can only re-derive the mismatch by re-reading `spec schema` and
  // diffing the whole document by hand.
  const issues = error.issues
    .slice(0, MAX_RENDERED_FILE_ISSUES)
    .map(
      (issue) =>
        `  ${issue.path.length === 0 ? "(document root)" : issue.path.join(".")}: ${issue.message}`,
    );
  const overflow = error.issues.length - MAX_RENDERED_FILE_ISSUES;
  return usageFailure(
    [
      `spec ${command}: ${description} file ${JSON.stringify(filePath)} does not match the required schema`,
      ...issues,
      ...(overflow > 0 ? [`  …and ${overflow} more`] : []),
      "  run `cctl spec schema` for the accepted document shapes",
    ].join("\n"),
    json,
  );
}

async function requestTyped<T>(
  host: CliHost,
  context: ProjectConversationContext,
  env: CliEnv,
  input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    schema: z.ZodType<T>;
    command: string;
    /**
     * Replace the default rendering of a server refusal. Only for refusals a
     * command can say something truer about than the generic mapping — return
     * null to fall through to the shared contract.
     */
    onRefusal?: (
      error: Extract<CliRequestResult, { kind: "error" }>,
    ) => CliResult | null;
  },
  json: boolean,
): Promise<CommandResult<T>> {
  const response = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: input.method,
    path: input.path,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.method === "POST"
      ? { headers: mutationHeaders(context, env) }
      : {}),
  });
  if (response.kind !== "ok") {
    if (response.kind === "error" && input.onRefusal !== undefined) {
      const replaced = input.onRefusal(response);
      if (replaced !== null) return { ok: false, result: replaced };
    }
    return { ok: false, result: failureFromRequest(response, json) };
  }
  const parsed = input.schema.safeParse(response.body);
  if (!parsed.success) {
    logger.debug("cli.spec.invalid_response", {
      command: input.command,
      issueCount: parsed.error.issues.length,
    });
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `spec ${input.command} returned an unexpected response — is the CC server the same build as this CLI?`,
        code: "invalid_response",
        json,
      }),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * The draft document is one element or an array of them, so this path cannot
 * use the shared object-only reader: an array is a legal document here, not a
 * malformed one.
 */
async function readDraftFile(
  host: CliHost,
  filePath: string,
  json: boolean,
): Promise<CommandResult<unknown>> {
  const raw = await host.readTextFile(filePath);
  if (raw === null) {
    return {
      ok: false,
      result: usageFailure(
        `cannot read draft element file ${JSON.stringify(filePath)}`,
        json,
      ),
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      result: usageFailure(
        `draft element file ${JSON.stringify(filePath)} is not valid JSON`,
        json,
      ),
    };
  }
}

/** `  [1] audit-log/R1.1 (criterion) at version 3` */
function batchWrittenLine(
  slug: string,
  entry: z.infer<typeof draftBatchResponseSchema>["written"][number],
): string {
  return `  [${entry.index}] ${elementLabel(slug, entry.handle, entry.element.kind)} at version ${entry.version.elementVersion}`;
}

/**
 * A batch refuses as a whole, so the caller's question is never "did it fail?"
 * but "which element refused, and why?". Every refusal is printed against the
 * index the caller submitted, with the version a stale element is actually at.
 */
function batchRefusalLine(
  refusal: z.infer<typeof draftBatchRefusalSchema>,
): string {
  const subject = refusal.elementId ?? "the revision";
  const version =
    refusal.currentElementVersion === null
      ? ""
      : ` (element is at version ${refusal.currentElementVersion})`;
  return `  [${refusal.index}] ${subject}: ${refusal.code} — ${refusal.unmetConditions.join(" ")}${version}`;
}

/**
 * The write path's read (R7.1). A write must name the revision it targets, and
 * nothing else in the full spec view; reading it from the detail view made an
 * authoring session transfer the whole document once per saved element.
 */
async function readEditContext(
  host: CliHost,
  context: ProjectConversationContext,
  env: CliEnv,
  slug: string,
  command: string,
  json: boolean,
): Promise<CommandResult<SpecEditContextView>> {
  return requestTyped(
    host,
    context,
    env,
    {
      method: "GET",
      path: `${specBasePath(context, slug)}/edit-context`,
      schema: specEditContextViewSchema,
      command,
    },
    json,
  );
}

function currentRevisionId(
  editContext: SpecEditContextView,
  command: string,
  json: boolean,
): CommandResult<string> {
  const current = editContext.currentRevision;
  if (current !== null) return { ok: true, value: current.id };
  return {
    ok: false,
    result: failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `spec ${command}: the spec has no current revision`,
      code: "not_found",
      instruction: "Create or open an editable revision, then retry.",
      json,
    }),
  };
}

function executionRevisionId(
  editContext: SpecEditContextView,
  json: boolean,
): CommandResult<string> {
  const approved = editContext.latestApprovedRevision;
  if (approved !== null) return { ok: true, value: approved.id };
  return currentRevisionId(editContext, "start", json);
}

/**
 * The four things every mutating response owes its caller (R24.1): what
 * changed, the state that leaves behind, the addressing tokens the server
 * assigned, and the exact next action together with the party who performs it.
 * `instruction` stays scarce — it is the tier-3 "do this now", reserved for
 * outcomes that park work, never a restatement of `next`.
 */
interface MutationOutcome {
  readonly changed: string;
  /**
   * The per-item lines a multi-item outcome is made of, rendered under the
   * summary. Which element landed at which version is the answer a batch owes
   * its caller; folding it into one sentence would lose it.
   */
  readonly items?: readonly string[];
  readonly state: string;
  /** Server-assigned addressing tokens, keyed machine-side in camelCase. */
  readonly tokens: Readonly<Record<string, string>>;
  readonly actsNext: "agent" | "human";
  /** What is blocked and on whom, or null when nothing is. */
  readonly blocked: string | null;
  readonly next: string;
  readonly instruction?: string;
}

/** `workflowDefinition` → `workflow definition`, for the text rendering only. */
function tokenLabel(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function mutationResult(
  json: boolean,
  outcome: MutationOutcome,
  field: string,
  value: unknown,
  extra: Record<string, unknown> = {},
): CliResult {
  const tokens = Object.entries(outcome.tokens);
  const lines = [
    outcome.changed,
    ...(outcome.items ?? []),
    `state: ${outcome.state}`,
    ...(tokens.length === 0
      ? []
      : [
          "tokens:",
          ...tokens.map(([key, token]) => `  ${tokenLabel(key)}: ${token}`),
        ]),
    `acts next: ${outcome.actsNext}${outcome.blocked === null ? "" : ` — ${outcome.blocked}`}`,
    `next: ${outcome.next}`,
    ...(outcome.instruction === undefined
      ? []
      : [`instruction: ${outcome.instruction}`]),
  ];
  logger.debug("cli.spec.write_complete", { command: field });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${lines.join("\n")}\n`, {
      ok: true,
      [field]: value,
      changed: outcome.changed,
      state: outcome.state,
      tokens: outcome.tokens,
      actsNext: outcome.actsNext,
      blocked: outcome.blocked,
      next: outcome.next,
      ...(outcome.instruction === undefined
        ? {}
        : { instruction: outcome.instruction }),
      ...extra,
    }),
    stderr: "",
  };
}

/** The command that continues authoring in an open draft. */
function draftNextCommand(slug: string): string {
  return `cctl spec draft ${slug} --file <element.json> --base-version new`;
}

/**
 * Address the element a write produced. A handle is an address; an element id
 * is not, so the two never share a token name (R24.2).
 */
function elementTokens(
  slug: string,
  handle: string | null | undefined,
  elementId: string,
): Record<string, string> {
  return handle === null || handle === undefined
    ? { elementId }
    : { handle: `${slug}/${handle}` };
}

/**
 * Name a just-written element by the address the author can paste into the
 * next command. Sections and unnumbered rows have no handle, so those degrade
 * to the element kind — as does any response from a server that predates the
 * projected handle.
 */
function elementLabel(
  slug: string,
  handle: string | null | undefined,
  kind: string,
): string {
  if (handle === null || handle === undefined) return kind;
  return `${slug}/${handle} (${kind})`;
}

/**
 * Handle grammar does not depend on the slug, but resolving a bare handle
 * needs one. This stands in for the slug these commands require so an
 * unqualified handle can be refused as unqualified rather than as
 * ungrammatical.
 */
const GRAMMAR_PROBE_SLUG = "spec";

function parseQualifiedTarget(
  input: string | undefined,
  expectedKind: "question" | "task",
  command: string,
  json: boolean,
): CommandResult<{ slug: string; handle: string }> {
  const example = expectedKind === "task" ? "T7" : "Q2";
  if (input === undefined) {
    return {
      ok: false,
      result: usageFailure(`spec ${command} requires <slug>/${example}`, json),
    };
  }
  // Three distinct failures, refused in order of how much they tell the
  // caller: an ungrammatical address, a well-formed handle of the wrong kind,
  // and a handle that is only missing the slug this command needs. The shared
  // grammar text offers qualification as optional, so the ungrammatical
  // refusal names the qualified form this command actually takes.
  if (!isWellFormedElementHandle(input, GRAMMAR_PROBE_SLUG)) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: ${explainInvalidElementHandle(input)} This command takes the qualified form <slug>/${example}.`,
        json,
      ),
    };
  }
  const parsed = parseElementHandle(input, GRAMMAR_PROBE_SLUG);
  if (parsed.kind !== expectedKind) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: ${JSON.stringify(input)} is a ${parsed.kind} handle; this command takes a ${expectedKind} handle like <slug>/${example}`,
        json,
      ),
    };
  }
  if (!input.includes("/")) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: ${JSON.stringify(input)} is missing its spec slug; this command takes a qualified handle like <slug>/${example}`,
        json,
      ),
    };
  }
  return {
    ok: true,
    value: {
      slug: parsed.slug,
      handle: input.slice(input.indexOf("/") + 1),
    },
  };
}

export async function runSpecCreate(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec create"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 0, "create", json);
  if (extra) return extra;
  const candidate = {
    slug: values["slug"],
    name: values["name"],
    gatePolicy: { preset: values["preset"] },
  };
  const parsed = createFlagsSchema.safeParse(candidate);
  const filePath = values["file"];
  if (!parsed.success || filePath === undefined) {
    return usageFailure(
      "spec create requires --slug <slug> --name <name> --preset <preset> --file <element.json> — the durable spec is created by this first draft save",
      json,
    );
  }
  const file = await readJsonObjectFile(host, filePath, "first element", json);
  if (!file.ok) return file.result;
  const parsedFile = draftFileSchema.safeParse(file.value);
  if (!parsedFile.success) {
    return invalidFileResult(
      "create",
      filePath,
      "first element",
      json,
      parsedFile.error,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: `/api/specs/${encodePathSegment(resolved.context.project)}/actions/create`,
      body: { ...parsed.data, initialElement: parsedFile.data },
      schema: createResponseSchema,
      command: "create",
    },
    json,
  );
  if (!response.ok) return response.result;
  const created = response.value;
  const label = elementLabel(
    created.spec.slug,
    created.handle,
    created.element.kind,
  );
  return mutationResult(
    json,
    {
      changed: `created spec ${created.spec.slug} from its first draft save — ${label} at version ${created.version.elementVersion} in draft revision ${created.draft.number}`,
      state: `draft revision ${created.draft.number} at ${created.draft.authoringStage} stage`,
      tokens: {
        spec: created.spec.slug,
        revision: created.draft.id,
        ...elementTokens(created.spec.slug, created.handle, created.element.id),
        elementVersion: String(created.version.elementVersion),
      },
      actsNext: "agent",
      blocked: null,
      next: draftNextCommand(created.spec.slug),
    },
    "created",
    created,
  );
}

export async function runSpecAmend(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec amend"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "amend", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "amend", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "open-amendment"),
      // The action body is strict and empty; a bodyless POST is a 400.
      body: {},
      schema: specRevisionSchema,
      command: "amend",
    },
    json,
  );
  if (!response.ok) return response.result;
  const opened = response.value;
  return mutationResult(
    json,
    {
      changed: `opened amendment revision ${opened.number} at ${opened.authoringStage} stage`,
      state: `draft revision ${opened.number} at ${opened.authoringStage} stage`,
      tokens: { revision: opened.id },
      actsNext: "agent",
      blocked: null,
      next: draftNextCommand(slug.value),
    },
    "revision",
    opened,
  );
}

interface DraftWriteRequest {
  readonly host: CliHost;
  readonly flags: GlobalFlags;
  readonly env: CliEnv;
  readonly slug: string;
  readonly filePath: string;
  readonly document: unknown;
  readonly rawBaseVersion: string | undefined;
  readonly json: boolean;
}

/** The command `spec status` names as the next step after any draft save. */
function draftStatusNext(slug: string): string {
  return `cctl spec status ${slug} — reads the stages this draft still owes and the command that concludes the current one`;
}

async function draftSingleElement(
  request: DraftWriteRequest,
): Promise<CliResult> {
  const { host, flags, env, slug, filePath, document, json } = request;
  const rawBaseVersion = request.rawBaseVersion;
  if (rawBaseVersion === undefined) {
    return usageFailure(
      "spec draft requires --file <element.json> --base-version <number|new>",
      json,
    );
  }
  const baseElementVersion =
    rawBaseVersion === "new" ? null : Number(rawBaseVersion);
  if (
    baseElementVersion !== null &&
    (!Number.isInteger(baseElementVersion) || baseElementVersion <= 0)
  ) {
    return usageFailure(
      "spec draft: --base-version must be a positive integer or new",
      json,
    );
  }
  const parsedFile = draftFileSchema.safeParse(document);
  if (!parsedFile.success) {
    return invalidFileResult(
      "draft",
      filePath,
      "draft element",
      json,
      parsedFile.error,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const editContext = await readEditContext(
    host,
    resolved.context,
    env,
    slug,
    "draft",
    json,
  );
  if (!editContext.ok) return editContext.result;
  const revisionId = currentRevisionId(editContext.value, "draft", json);
  if (!revisionId.ok) return revisionId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug, "draft-upsert"),
      body: {
        revisionId: revisionId.value,
        ...parsedFile.data,
        baseElementVersion,
      },
      schema: draftResponseSchema,
      command: "draft",
    },
    json,
  );
  if (!response.ok) return response.result;
  const saved = response.value;
  const label = elementLabel(slug, saved.handle, saved.element.kind);
  return mutationResult(
    json,
    {
      changed: `saved ${label} at version ${saved.version.elementVersion}`,
      state: `element version ${saved.version.elementVersion} in the open draft`,
      tokens: {
        revision: revisionId.value,
        ...elementTokens(slug, saved.handle, saved.element.id),
        elementVersion: String(saved.version.elementVersion),
      },
      actsNext: "agent",
      blocked: null,
      next: draftStatusNext(slug),
    },
    "draft",
    saved,
  );
}

/**
 * Many elements, one transaction, still one compare-and-swap per element. The
 * batch is reported element by element — a whole-document write would hide
 * both which element refused and which version each landed at (R7.3).
 */
async function draftElementBatch(
  request: DraftWriteRequest,
): Promise<CliResult> {
  const { host, flags, env, slug, filePath, document, json } = request;
  if (request.rawBaseVersion !== undefined) {
    return usageFailure(
      "spec draft: --base-version does not apply to a batch file — every element in the array carries its own baseElementVersion (the version you last read, or null to create it)",
      json,
    );
  }
  const parsedFile = draftBatchFileSchema.safeParse(document);
  if (!parsedFile.success) {
    return invalidFileResult(
      "draft",
      filePath,
      "draft element",
      json,
      parsedFile.error,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const editContext = await readEditContext(
    host,
    resolved.context,
    env,
    slug,
    "draft",
    json,
  );
  if (!editContext.ok) return editContext.result;
  const revisionId = currentRevisionId(editContext.value, "draft", json);
  if (!revisionId.ok) return revisionId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug, "draft-batch"),
      body: { revisionId: revisionId.value, elements: parsedFile.data },
      schema: draftBatchResponseSchema,
      command: "draft",
      onRefusal: (error) => {
        const refused = draftBatchRefusalsSchema.safeParse(error.details);
        if (!refused.success) return null;
        return failure({
          exitCode: EXIT_OPERATION_FAILED,
          message: error.error,
          detail: refused.data.refusals.map(batchRefusalLine).join("\n"),
          ...structuredErrorFields(error),
          json,
        });
      },
    },
    json,
  );
  if (!response.ok) return response.result;
  const saved = response.value;
  const count = saved.written.length;
  const plural = count === 1 ? "" : "s";
  return mutationResult(
    json,
    {
      changed: `saved ${count} element${plural} in one transaction`,
      items: saved.written.map((entry) => batchWrittenLine(slug, entry)),
      state: `all ${count} element${plural} current in the open draft`,
      tokens: { revision: saved.revisionId },
      actsNext: "agent",
      blocked: null,
      next: draftStatusNext(slug),
    },
    "batch",
    saved,
  );
}

export async function runSpecDraft(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec draft"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "draft", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "draft", json);
  if (!slug.ok) return slug.result;
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "spec draft requires --file <element.json> --base-version <number|new>",
      json,
    );
  }
  const file = await readDraftFile(host, filePath, json);
  if (!file.ok) return file.result;
  const request: DraftWriteRequest = {
    host,
    flags,
    env,
    slug: slug.value,
    filePath,
    document: file.value,
    rawBaseVersion: values["base-version"],
    json,
  };
  // The document's own shape selects the write: an array is a batch, an object
  // is the single element form the batch never replaced.
  return Array.isArray(file.value)
    ? draftElementBatch(request)
    : draftSingleElement(request);
}

export async function runSpecPropose(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec propose"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "propose", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "propose", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const editContext = await readEditContext(
    host,
    resolved.context,
    env,
    slug.value,
    "propose",
    json,
  );
  if (!editContext.ok) return editContext.result;
  const revisionId = currentRevisionId(editContext.value, "propose", json);
  if (!revisionId.ok) return revisionId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "propose"),
      body: { revisionId: revisionId.value },
      schema: proposeResponseSchema,
      command: "propose",
    },
    json,
  );
  if (!response.ok) return response.result;
  const proposed = response.value.revision;
  // A combined-approval policy can absorb the sign-off into the propose, which
  // leaves the revision approved and nothing waiting on a human.
  const awaitingHuman = proposed.state !== "approved";
  return mutationResult(
    json,
    {
      changed: `proposed revision ${proposed.number}`,
      state: `revision ${proposed.number} is ${proposed.state}`,
      tokens: { revision: proposed.id },
      actsNext: awaitingHuman ? "human" : "agent",
      blocked: awaitingHuman
        ? `the ${proposed.authoringStage} gate needs human sign-off in Spec Studio`
        : null,
      next: awaitingHuman
        ? `cctl spec request-approval ${slug.value} --gate ${proposed.authoringStage}`
        : `cctl spec amend ${slug.value}`,
    },
    "proposal",
    response.value,
  );
}

export async function runSpecAdvance(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec advance"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "advance", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "advance", json);
  if (!slug.ok) return slug.result;
  const expectedStage = advanceStageSchema.safeParse(values["from"]);
  if (!expectedStage.success) {
    return usageFailure(
      "spec advance requires --from requirements or design",
      json,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const editContext = await readEditContext(
    host,
    resolved.context,
    env,
    slug.value,
    "advance",
    json,
  );
  if (!editContext.ok) return editContext.result;
  const revisionId = currentRevisionId(editContext.value, "advance", json);
  if (!revisionId.ok) return revisionId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "advance"),
      body: {
        revisionId: revisionId.value,
        expectedStage: expectedStage.data,
      },
      schema: advanceResponseSchema,
      command: "advance",
    },
    json,
  );
  if (!response.ok) return response.result;
  const advanced = response.value.revision;
  return mutationResult(
    json,
    {
      changed: `advanced revision ${advanced.number} to ${advanced.authoringStage} stage`,
      state: `draft revision ${advanced.number} at ${advanced.authoringStage} stage`,
      tokens: { revision: advanced.id },
      actsNext: "agent",
      blocked: null,
      next: draftNextCommand(slug.value),
    },
    "revision",
    advanced,
  );
}

export async function runSpecAnswer(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec answer"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "answer", json);
  if (extra) return extra;
  const target = parseQualifiedTarget(rest[0], "question", "answer", json);
  if (!target.ok) return target.result;
  const answer = values["answer"];
  if (answer === undefined) {
    return usageFailure("spec answer requires --answer <text>", json);
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const status = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "GET",
      path: `${specBasePath(resolved.context, target.value.slug)}/status`,
      schema: writeStatusSchema,
      command: "answer",
    },
    json,
  );
  if (!status.ok) return status.result;
  const question = status.value.openQuestions.find(
    (candidate) => candidate.handle === target.value.handle,
  );
  if (question === undefined) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `spec answer: open question ${target.value.handle} was not found`,
      code: "not_found",
      instruction: "Read `cctl spec status` and answer an open question.",
      json,
    });
  }
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, target.value.slug, "answer-question"),
      body: { questionId: question.id, answer },
      schema: specQuestionViewSchema,
      command: "answer",
      // Answering is the human half of the question split: the agent opened
      // the question FOR a human, so the refusal must say where the human
      // answers it rather than pointing at a browser session generically.
      onRefusal: (error) =>
        error.code === "human_act_required"
          ? failure({
              exitCode: EXIT_OPERATION_FAILED,
              message: error.error,
              code: error.code,
              instruction: `Answering a spec question is a human act performed in Spec Studio (Questions & assumptions). Ask the operator to answer ${target.value.handle} there — an answer given in conversation still gets recorded by the human, so the durable record shows who decided.`,
              json,
            })
          : null,
    },
    json,
  );
  if (!response.ok) return response.result;
  const answered = response.value;
  return mutationResult(
    json,
    {
      changed: `answered ${target.value.handle}`,
      state: `question ${target.value.handle} is ${answered.status}`,
      tokens: {
        handle: `${target.value.slug}/${target.value.handle}`,
        question: answered.id,
      },
      actsNext: "agent",
      blocked: null,
      next: `cctl spec status ${target.value.slug}`,
    },
    "question",
    answered,
  );
}

/**
 * Resolve an optional `--element <handle>` attachment for the question and
 * assume verbs. Attachment targets are spec content elements only — Q/A
 * handles parse but cannot anchor another record, so they are rejected
 * locally before any network request.
 */
async function resolveAttachmentElementId(
  command: "question" | "assume",
  rawElement: string | undefined,
  slug: string,
  context: ProjectConversationContext,
  env: CliEnv,
  host: CliHost,
  json: boolean,
): Promise<CommandResult<string | null>> {
  if (rawElement === undefined) return { ok: true, value: null };
  if (!isWellFormedElementHandle(rawElement, slug)) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: --element ${explainInvalidElementHandle(rawElement)}`,
        json,
      ),
    };
  }
  const handle = parseElementHandle(rawElement, slug);
  if (handle.slug !== slug) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: --element ${JSON.stringify(rawElement)} addresses spec ${handle.slug}, not ${slug}`,
        json,
      ),
    };
  }
  if (handle.kind === "question" || handle.kind === "assumption") {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: --element must reference a requirement, criterion, decision, or task handle, not ${JSON.stringify(rawElement)}`,
        json,
      ),
    };
  }
  const bareHandle = rawElement.includes("/")
    ? rawElement.slice(rawElement.indexOf("/") + 1)
    : rawElement;
  const element = await requestTyped(
    host,
    context,
    env,
    {
      method: "GET",
      path: `${specBasePath(context, slug)}/elements/${encodePathSegment(bareHandle)}`,
      schema: writeElementLookupSchema,
      command,
    },
    json,
  );
  if (!element.ok) return element;
  return { ok: true, value: element.value.element.element.id };
}

export async function runSpecQuestion(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec question"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "question", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "question", json);
  if (!slug.ok) return slug.result;
  const text = values["text"];
  if (text === undefined) {
    return usageFailure("spec question requires --text <text>", json);
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const elementId = await resolveAttachmentElementId(
    "question",
    values["element"],
    slug.value,
    resolved.context,
    env,
    host,
    json,
  );
  if (!elementId.ok) return elementId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "open-question"),
      body: { elementId: elementId.value, text },
      schema: questionResponseSchema,
      command: "question",
    },
    json,
  );
  if (!response.ok) return response.result;
  const opened = response.value;
  const handle = opened.handle;
  return mutationResult(
    json,
    {
      changed: `opened ${slug.value}/${handle}`,
      state: `question ${handle} is ${opened.status}`,
      tokens: { handle: `${slug.value}/${handle}`, question: opened.id },
      actsNext: "human",
      blocked: "a human answers the question in Spec Studio",
      next: `cctl spec status ${slug.value} — reports the question until it is answered`,
    },
    "question",
    opened,
  );
}

export async function runSpecAssume(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec assume"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "assume", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "assume", json);
  if (!slug.ok) return slug.result;
  const text = values["text"];
  if (text === undefined) {
    return usageFailure("spec assume requires --text <text>", json);
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const elementId = await resolveAttachmentElementId(
    "assume",
    values["element"],
    slug.value,
    resolved.context,
    env,
    host,
    json,
  );
  if (!elementId.ok) return elementId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "propose-assumption"),
      body: { elementId: elementId.value, text },
      schema: specAssumptionViewSchema,
      command: "assume",
    },
    json,
  );
  if (!response.ok) return response.result;
  const assumption = response.value;
  const handle = assumption.handle;
  return mutationResult(
    json,
    {
      changed: `proposed assumption ${slug.value}/${handle}`,
      state: `assumption ${handle} is ${assumption.disposition}`,
      tokens: {
        handle: `${slug.value}/${handle}`,
        assumption: assumption.id,
      },
      actsNext: "human",
      blocked:
        "a human accepts or rejects the assumption in Spec Studio — agents propose, never dispose",
      next: `cctl spec status ${slug.value} — reports the assumption's disposition`,
    },
    "assumption",
    assumption,
  );
}

export async function runSpecTaskComplete(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  lists: Record<string, string[]>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec task complete"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "task complete", json);
  if (extra) return extra;
  const target = parseQualifiedTarget(rest[0], "task", "task complete", json);
  if (!target.ok) return target.result;
  const executionId = values["execution"];
  if (executionId === undefined) {
    return usageFailure(
      "spec task complete requires --execution <execution-id>",
      json,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const task = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "GET",
      path: `${specBasePath(resolved.context, target.value.slug)}/elements/${encodePathSegment(target.value.handle)}`,
      schema: writeElementLookupSchema,
      command: "task complete",
    },
    json,
  );
  if (!task.ok) return task.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(
        resolved.context,
        target.value.slug,
        "claim-task-complete",
      ),
      body: {
        taskElementId: task.value.element.element.id,
        executionId,
        evidenceIds: lists["evidence"] ?? [],
      },
      schema: taskClaimResponseSchema,
      command: "task complete",
    },
    json,
  );
  if (!response.ok) return response.result;
  const claim = response.value;
  return mutationResult(
    json,
    {
      changed: `claimed ${target.value.handle} complete`,
      state: `claim ${claim.status}`,
      tokens: {
        claim: claim.id,
        task: `${target.value.slug}/${target.value.handle}`,
        execution: claim.execution_id ?? executionId,
      },
      actsNext: "agent",
      blocked: null,
      next: `cctl spec status ${target.value.slug} — reports the run's remaining tasks and coverage`,
    },
    "claim",
    claim,
  );
}

export async function runSpecRequestApproval(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor("spec request-approval"),
    json,
  );
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "request-approval", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "request-approval", json);
  if (!slug.ok) return slug.result;
  const gate = specGateSchema.safeParse(values["gate"]);
  if (!gate.success) {
    return usageFailure(
      "spec request-approval requires --gate <requirements|design|plan|execution_start|delivery>",
      json,
    );
  }
  // An omitted --subject travels as an omission: the server resolves it (the
  // gate itself for execution gates, the single outstanding subject for
  // authoring gates) instead of the CLI guessing a gate-name subject the
  // validation would refuse.
  const subject = values["subject"];
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const editContext = await readEditContext(
    host,
    resolved.context,
    env,
    slug.value,
    "request-approval",
    json,
  );
  if (!editContext.ok) return editContext.result;
  const revisionId = currentRevisionId(
    editContext.value,
    "request-approval",
    json,
  );
  if (!revisionId.ok) return revisionId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "request-approval"),
      body: {
        revisionId: revisionId.value,
        gate: gate.data,
        ...(subject === undefined ? {} : { subject }),
      },
      schema: approvalRequestReceiptSchema,
      command: "request-approval",
    },
    json,
  );
  if (!response.ok) return response.result;
  const receipt = response.value;
  return mutationResult(
    json,
    {
      // An ask that was already open issued no second Needs You entry, so
      // saying "requested" would report an escalation that did not happen.
      changed: receipt.alreadyRequested
        ? `the ${gate.data} approval request for ${receipt.subject} was already open — no second request was created`
        : `requested ${gate.data} approval for ${receipt.subject}`,
      state: `${gate.data} approval request is pending`,
      tokens: {
        attention: receipt.attentionId,
        revision: receipt.revisionId,
        ...(receipt.elementId === null ? {} : { elementId: receipt.elementId }),
      },
      actsNext: "human",
      blocked: `a human approves the ${gate.data} gate in Spec Studio — agents request, never approve`,
      next: `cctl spec status ${slug.value} — reports the request until it is approved`,
    },
    "request",
    receipt,
  );
}

/**
 * Who unblocks a run parked at definition review. It asks the canonical
 * predicate rather than testing for a dial value, so the CLI's notion of "a
 * human acts next" cannot drift from the server's: a dial the server treats as
 * an approval boundary but the CLI reads as agent work would name an agent as
 * the next actor for a run that only a human can move.
 */
export function executionStartActor(
  dial: ResolvedGateDial,
): MutationOutcome["actsNext"] {
  return dialRequiresHumanApproval(dial) ? "human" : "agent";
}

export async function runSpecStart(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec start"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "start", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "start", json);
  if (!slug.ok) return slug.result;
  // `spec start` is the ONE session-only verb in the spec group: it pins the
  // execution to a session, and `approveExecutionStart` refuses an execution
  // whose session is null ("The execution is not pinned to a session"). A project
  // conversation would otherwise persist an unapprovable execution. Resolving the
  // session BEFORE the scope file means the refusal lands before the agent has
  // done the work, not after.
  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("spec start requires --file <scope.json>", json);
  }
  const file = await readJsonObjectFile(host, filePath, "scope", json);
  if (!file.ok) return file.result;
  const scope = executionScopeSchema.safeParse(file.value);
  if (!scope.success) {
    return invalidFileResult("start", filePath, "scope", json, scope.error);
  }
  const editContext = await readEditContext(
    host,
    resolved.context,
    env,
    slug.value,
    "start",
    json,
  );
  if (!editContext.ok) return editContext.result;
  const revisionId = executionRevisionId(editContext.value, json);
  if (!revisionId.ok) return revisionId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "start-execution"),
      body: {
        revisionId: revisionId.value,
        scope: scope.data,
        sessionName: resolved.context.session,
      },
      schema: startResponseSchema,
      command: "start",
    },
    json,
  );
  if (!response.ok) return response.result;
  const execution = response.value.execution;
  const definitionId = response.value.definition.id;
  const launchedLaneId = execution.workflowExecutionId;
  if (launchedLaneId !== null) {
    return mutationResult(
      json,
      {
        changed: `started execution ${execution.id} — workflow lane ${launchedLaneId} is running`,
        state: `execution ${execution.state}, workflow lane running`,
        tokens: {
          execution: execution.id,
          workflowDefinition: definitionId,
          workflowExecution: launchedLaneId,
        },
        actsNext: "agent",
        blocked: null,
        next: `cctl spec status ${slug.value} — reports the run's lane position`,
      },
      "execution",
      response.value,
      {
        workflowDefinitionId: definitionId,
        workflowLaunched: true,
        executionState: execution.state,
      },
    );
  }
  // Starting a spec execution compiles a workflow definition and parks the run
  // at definition review; no lane exists until `workflow start` is run. The
  // dial the server compiled `approvalRequired` from decides who unblocks it,
  // so resolve the same dial rather than mapping the preset name.
  const dial = resolveDial(editContext.value.gatePolicy, "execution_start");
  const actsNext = executionStartActor(dial);
  const nextCommand = `cctl workflow start ${definitionId}`;
  const instruction =
    actsNext === "human"
      ? `Run \`${nextCommand}\`. The execution_start dial is ${dial} for this spec, so the run parks awaiting definition approval until a human approves the compiled definition.`
      : `Run \`${nextCommand}\` to launch the workflow lane — nothing is running until you do.`;
  return mutationResult(
    json,
    {
      changed: `started execution ${execution.id} — no workflow lane has launched yet`,
      state: `execution ${execution.state}, no workflow lane launched`,
      tokens: { execution: execution.id, workflowDefinition: definitionId },
      actsNext,
      blocked:
        actsNext === "human"
          ? `execution_start dial is ${dial}, so a human approves the compiled definition before the lane runs`
          : `execution_start dial is ${dial}; nothing runs until the lane is launched`,
      next: nextCommand,
      instruction,
    },
    "execution",
    response.value,
    {
      workflowDefinitionId: definitionId,
      workflowLaunched: false,
      executionState: execution.state,
      executionStartDial: dial,
    },
  );
}

export async function runSpecCapture(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec capture"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "capture", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "capture", json);
  if (!slug.ok) return slug.result;
  const executionId = values["execution"];
  const filePath = values["file"];
  if (executionId === undefined || filePath === undefined) {
    return usageFailure(
      "spec capture requires --execution <execution-id> --file <task.json>",
      json,
    );
  }
  const rawBlockingReason = values["blocking-reason"];
  const blockingReason = rawBlockingReason?.trim();
  if (rawBlockingReason !== undefined && blockingReason?.length === 0) {
    return usageFailure(
      "spec capture: --blocking-reason must not be empty — it becomes the run's durable abandonment reason",
      json,
    );
  }
  const file = await readJsonObjectFile(
    host,
    filePath,
    "discovered task",
    json,
  );
  if (!file.ok) return file.result;
  const parsedFile = discoveredTaskFileSchema.safeParse(file.value);
  if (!parsedFile.success) {
    return invalidFileResult(
      "capture",
      filePath,
      "discovered task",
      json,
      parsedFile.error,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "capture-scope-amendment"),
      body: {
        executionId,
        discoveredTask: parsedFile.data,
        ...(blockingReason === undefined ? {} : { blockingReason }),
      },
      schema: captureResponseSchema,
      command: "capture",
    },
    json,
  );
  if (!response.ok) return response.result;
  const captured = response.value;
  const taskNumber = captured.task.element.number;
  const taskLabel = taskNumber === null ? "a task" : `T${taskNumber}`;
  const restartRequired = captured.restartRequired;
  const runOutcome = restartRequired
    ? "the blocked run was abandoned — restart from the amended revision once approved"
    : "the run continues on its pinned scope";
  return mutationResult(
    json,
    {
      changed: `captured discovered work as ${taskLabel} in draft revision ${captured.revision.number}; ${runOutcome}`,
      state: restartRequired
        ? `draft revision ${captured.revision.number} carries the discovered task; the run was retired`
        : `draft revision ${captured.revision.number} carries the discovered task; the run keeps its pinned scope`,
      tokens: {
        revision: captured.revision.id,
        ...(taskNumber === null
          ? { elementId: captured.task.element.id }
          : { handle: `${slug.value}/${taskLabel}` }),
        execution: executionId,
      },
      actsNext: "agent",
      blocked: null,
      next: restartRequired
        ? `cctl spec propose ${slug.value}`
        : `cctl spec status ${slug.value}`,
      ...(restartRequired
        ? {
            instruction: `The run no longer exists. Finish the amendment, obtain its approval, then start a new execution with \`cctl spec start ${slug.value} --file <scope.json>\` — do not continue the retired run's work.`,
          }
        : {}),
    },
    "captured",
    captured,
  );
}

export async function runSpecRename(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec rename"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "rename", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "rename", json);
  if (!slug.ok) return slug.result;
  const to = values["to"];
  if (to === undefined) {
    return usageFailure("spec rename requires --to <new-slug>", json);
  }
  const parsedTo = specSlugSchema.safeParse(to);
  if (!parsedTo.success) {
    return usageFailure(
      `spec rename: invalid spec slug ${JSON.stringify(to)}`,
      json,
    );
  }
  const name = values["name"];
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "rename"),
      body: {
        slug: parsedTo.data,
        ...(name === undefined ? {} : { name }),
      },
      schema: renameResponseSchema,
      command: "rename",
    },
    json,
  );
  if (!response.ok) return response.result;
  const renamed = response.value;
  return mutationResult(
    json,
    {
      changed: `renamed spec to ${renamed.spec.slug}; ${renamed.alias.slug} resolves as an alias`,
      state: `spec ${renamed.spec.slug} with alias ${renamed.alias.slug}`,
      tokens: { spec: renamed.spec.slug, alias: renamed.alias.slug },
      actsNext: "agent",
      blocked: null,
      next: `cctl spec status ${renamed.spec.slug}`,
    },
    "renamed",
    renamed,
  );
}

export async function runSpecAbandon(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec abandon"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "abandon", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "abandon", json);
  if (!slug.ok) return slug.result;
  const reason = values["reason"];
  if (reason === undefined) {
    return usageFailure("spec abandon requires --reason <reason>", json);
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const executionId = values["execution"];
  if (executionId !== undefined) {
    const response = await requestTyped(
      host,
      resolved.context,
      env,
      {
        method: "POST",
        path: actionPath(resolved.context, slug.value, "abandon-execution"),
        body: { executionId, reason },
        schema: specExecutionRowSchema,
        command: "abandon",
      },
      json,
    );
    if (!response.ok) return response.result;
    const abandoned = response.value;
    return mutationResult(
      json,
      {
        changed: `abandoned execution ${abandoned.id}`,
        state: `execution ${abandoned.state}, reason recorded`,
        tokens: {
          execution: abandoned.id,
          workflowDefinition: abandoned.workflow_definition_id,
        },
        actsNext: "agent",
        blocked: null,
        next: `cctl spec status ${slug.value} — the spec keeps its content; only this run was retired`,
      },
      "abandoned",
      abandoned,
    );
  }
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "abandon-spec"),
      body: { reason },
      schema: specSchema,
      command: "abandon",
      // Retiring a whole spec is a human act (R25.7). The server's refusal
      // names the human surface; the agent's own supported path is to raise
      // the proposal as an open question, which only this surface can name.
      onRefusal: (error) =>
        error.code === "human_act_required"
          ? failure({
              exitCode: EXIT_OPERATION_FAILED,
              message: error.error,
              code: error.code,
              instruction: `Abandoning a whole spec is a human act performed in Spec Studio. Raise the proposal instead: cctl spec question ${slug.value} --text ${JSON.stringify(`Abandon this spec? ${reason}`)}`,
              json,
            })
          : null,
    },
    json,
  );
  if (!response.ok) return response.result;
  const abandoned = response.value;
  return mutationResult(
    json,
    {
      changed: `abandoned spec ${abandoned.slug}`,
      state: `spec abandoned at ${abandoned.abandonedAt ?? "an unrecorded time"}`,
      tokens: { spec: abandoned.slug },
      actsNext: "human",
      blocked: "nothing — the spec is retired and admits no further authoring",
      next: `cctl spec list — the retired spec no longer accepts writes`,
    },
    "abandoned",
    abandoned,
  );
}
