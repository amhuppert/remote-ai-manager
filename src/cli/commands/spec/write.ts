import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  createAuthoringSpecInputSchema,
  createSpecInitialElementSchema,
} from "@/lib/specs/authoring-service";
import { parseElementHandle, specSlugSchema } from "@/lib/specs/handles";
import { approvalRequestReceiptSchema } from "@/lib/specs/review-service";
import {
  specAliasSchema,
  specAssumptionRowSchema,
  specElementSchema,
  specElementVersionSchema,
  specExecutionRowSchema,
  specGateSchema,
  specQuestionRowSchema,
  specRevisionSchema,
  specSchema,
  specTaskClaimRowSchema,
  taskElementPayloadSchema,
} from "@/lib/specs/schemas";
import { executionScopeSchema } from "@/lib/specs/scope-validation";
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
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type ConversationContext,
  type GlobalFlags,
} from "../../shared";

const logger = createLogger("cli.spec");
const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";
const CALLER_BACKEND_HEADER = "x-cc-agent-backend";

const createFlagsSchema = createAuthoringSpecInputSchema
  .omit({ projectPath: true, actor: true, initialElement: true })
  .strict();
const createResponseSchema = z
  .object({
    spec: specSchema,
    draft: specRevisionSchema,
    element: specElementSchema,
    version: specElementVersionSchema,
  })
  .strict();
// One element-file shape serves both the create --file (first save) and
// draft --file payloads; it is the server's own input schema, so the CLI
// cannot drift from what the create/draft-upsert actions accept.
const draftFileSchema = createSpecInitialElementSchema;
const draftResponseSchema = z
  .object({ element: specElementSchema, version: specElementVersionSchema })
  .strict();
const proposeResponseSchema = z
  .object({
    revision: specRevisionSchema,
    diff: z.unknown(),
    absorbedSignOff: z.boolean(),
  })
  .strict();
const startResponseSchema = z
  .object({
    execution: specExecutionRowSchema,
    definition: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .strict();
const abandonResponseSchema = z.union([specSchema, specExecutionRowSchema]);
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
const writeDetailSchema = z
  .object({
    revisions: z.array(specRevisionSchema),
    currentRevision: z
      .object({
        revision: specRevisionSchema,
      })
      .passthrough()
      .nullable(),
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

type WriteDetailView = z.infer<typeof writeDetailSchema>;

type CommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; result: CliResult };

function specBasePath(context: ConversationContext, slug: string): string {
  return `/api/specs/${encodePathSegment(context.project)}/${encodePathSegment(slug)}`;
}

function actionPath(
  context: ConversationContext,
  slug: string,
  action: string,
): string {
  return `${specBasePath(context, slug)}/actions/${encodePathSegment(action)}`;
}

function mutationHeaders(
  context: ConversationContext,
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

function invalidFileResult(
  command: string,
  filePath: string,
  description: string,
  json: boolean,
): CliResult {
  return usageFailure(
    `spec ${command}: ${description} file ${JSON.stringify(filePath)} does not match the required schema`,
    json,
  );
}

async function requestTyped<T>(
  host: CliHost,
  context: ConversationContext,
  env: CliEnv,
  input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    schema: z.ZodType<T>;
    command: string;
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

async function readDetail(
  host: CliHost,
  context: ConversationContext,
  env: CliEnv,
  slug: string,
  command: string,
  json: boolean,
): Promise<CommandResult<WriteDetailView>> {
  return requestTyped(
    host,
    context,
    env,
    {
      method: "GET",
      path: specBasePath(context, slug),
      schema: writeDetailSchema,
      command,
    },
    json,
  );
}

function currentRevisionId(
  detail: WriteDetailView,
  command: string,
  json: boolean,
): CommandResult<string> {
  const id = detail.currentRevision?.revision.id;
  if (id !== undefined) return { ok: true, value: id };
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
  detail: WriteDetailView,
  json: boolean,
): CommandResult<string> {
  const approved = detail.revisions
    .filter((revision) => revision.state === "approved")
    .sort((left, right) => right.number - left.number)[0];
  if (approved !== undefined) return { ok: true, value: approved.id };
  return currentRevisionId(detail, "start", json);
}

function success(
  json: boolean,
  human: string,
  field: string,
  value: unknown,
): CliResult {
  logger.debug("cli.spec.write_complete", { command: field });
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${human}\n`, { ok: true, [field]: value }),
    stderr: "",
  };
}

function parseQualifiedTarget(
  input: string | undefined,
  expectedKind: "question" | "task",
  command: string,
  json: boolean,
): CommandResult<{ slug: string; handle: string }> {
  if (input === undefined) {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command} requires <slug>/${expectedKind === "task" ? "T7" : "Q2"}`,
        json,
      ),
    };
  }
  try {
    const parsed = parseElementHandle(input);
    if (parsed.kind !== expectedKind) throw new Error("wrong handle kind");
    return {
      ok: true,
      value: {
        slug: parsed.slug,
        handle: input.slice(input.indexOf("/") + 1),
      },
    };
  } catch {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: invalid ${expectedKind} handle ${JSON.stringify(input)}`,
        json,
      ),
    };
  }
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
    return invalidFileResult("create", filePath, "first element", json);
  }
  const resolved = await resolveConversationContext(flags, env, host);
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
  return success(
    json,
    `created spec ${response.value.spec.slug} from its first draft save — ${response.value.element.kind} at version ${response.value.version.elementVersion} in draft revision ${response.value.draft.number}`,
    "created",
    response.value,
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
  const rawBaseVersion = values["base-version"];
  if (filePath === undefined || rawBaseVersion === undefined) {
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
  const file = await readJsonObjectFile(host, filePath, "draft element", json);
  if (!file.ok) return file.result;
  const parsedFile = draftFileSchema.safeParse(file.value);
  if (!parsedFile.success) {
    return invalidFileResult("draft", filePath, "draft element", json);
  }
  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const detail = await readDetail(
    host,
    resolved.context,
    env,
    slug.value,
    "draft",
    json,
  );
  if (!detail.ok) return detail.result;
  const revisionId = currentRevisionId(detail.value, "draft", json);
  if (!revisionId.ok) return revisionId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "draft-upsert"),
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
  return success(
    json,
    `saved ${response.value.element.kind} at version ${response.value.version.elementVersion}`,
    "draft",
    response.value,
  );
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
  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const detail = await readDetail(
    host,
    resolved.context,
    env,
    slug.value,
    "propose",
    json,
  );
  if (!detail.ok) return detail.result;
  const revisionId = currentRevisionId(detail.value, "propose", json);
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
  return success(
    json,
    `proposed revision ${response.value.revision.number}`,
    "proposal",
    response.value,
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
  const resolved = await resolveConversationContext(flags, env, host);
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
      schema: specQuestionRowSchema,
      command: "answer",
    },
    json,
  );
  if (!response.ok) return response.result;
  return success(
    json,
    `answered ${target.value.handle}`,
    "question",
    response.value,
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
  context: ConversationContext,
  env: CliEnv,
  host: CliHost,
  json: boolean,
): Promise<CommandResult<string | null>> {
  if (rawElement === undefined) return { ok: true, value: null };
  let bareHandle: string;
  try {
    const handle = parseElementHandle(rawElement, slug);
    if (handle.slug !== slug) throw new Error("slug mismatch");
    if (handle.kind === "question" || handle.kind === "assumption") {
      return {
        ok: false,
        result: usageFailure(
          `spec ${command}: --element must reference a requirement, criterion, decision, or task handle, not ${JSON.stringify(rawElement)}`,
          json,
        ),
      };
    }
    bareHandle = rawElement.includes("/")
      ? rawElement.slice(rawElement.indexOf("/") + 1)
      : rawElement;
  } catch {
    return {
      ok: false,
      result: usageFailure(
        `spec ${command}: invalid element handle ${JSON.stringify(rawElement)}`,
        json,
      ),
    };
  }
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
  const resolved = await resolveConversationContext(flags, env, host);
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
      schema: specQuestionRowSchema,
      command: "question",
    },
    json,
  );
  if (!response.ok) return response.result;
  return success(
    json,
    `opened Q${response.value.number}`,
    "question",
    response.value,
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
  const resolved = await resolveConversationContext(flags, env, host);
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
      schema: specAssumptionRowSchema,
      command: "assume",
    },
    json,
  );
  if (!response.ok) return response.result;
  return success(json, "proposed assumption", "assumption", response.value);
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
  const resolved = await resolveConversationContext(flags, env, host);
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
  return success(
    json,
    `claimed ${target.value.handle} complete`,
    "claim",
    response.value,
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
  const subject = values["subject"] ?? gate.data;
  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const detail = await readDetail(
    host,
    resolved.context,
    env,
    slug.value,
    "request-approval",
    json,
  );
  if (!detail.ok) return detail.result;
  const revisionId = currentRevisionId(detail.value, "request-approval", json);
  if (!revisionId.ok) return revisionId.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "request-approval"),
      body: { revisionId: revisionId.value, gate: gate.data, subject },
      schema: approvalRequestReceiptSchema,
      command: "request-approval",
    },
    json,
  );
  if (!response.ok) return response.result;
  return success(
    json,
    `requested ${gate.data} approval`,
    "request",
    response.value,
  );
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
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("spec start requires --file <scope.json>", json);
  }
  const file = await readJsonObjectFile(host, filePath, "scope", json);
  if (!file.ok) return file.result;
  const scope = executionScopeSchema.safeParse(file.value);
  if (!scope.success) {
    return invalidFileResult("start", filePath, "scope", json);
  }
  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const detail = await readDetail(
    host,
    resolved.context,
    env,
    slug.value,
    "start",
    json,
  );
  if (!detail.ok) return detail.result;
  const revisionId = executionRevisionId(detail.value, json);
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
        sessionName: env["CC_SESSION"] ?? null,
      },
      schema: startResponseSchema,
      command: "start",
    },
    json,
  );
  if (!response.ok) return response.result;
  return success(
    json,
    `started execution ${response.value.execution.id}`,
    "execution",
    response.value,
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
    return invalidFileResult("capture", filePath, "discovered task", json);
  }
  const resolved = await resolveConversationContext(flags, env, host);
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
  const taskLabel =
    response.value.task.element.number === null
      ? "a task"
      : `T${response.value.task.element.number}`;
  const runOutcome = response.value.restartRequired
    ? "the blocked run was abandoned — restart from the amended revision once approved"
    : "the run continues on its pinned scope";
  return success(
    json,
    `captured discovered work as ${taskLabel} in draft revision ${response.value.revision.number}; ${runOutcome}`,
    "captured",
    response.value,
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
  const resolved = await resolveConversationContext(flags, env, host);
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
  return success(
    json,
    `renamed spec to ${response.value.spec.slug}; ${response.value.alias.slug} resolves as an alias`,
    "renamed",
    response.value,
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
  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const executionId = values["execution"];
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(
        resolved.context,
        slug.value,
        executionId === undefined ? "abandon-spec" : "abandon-execution",
      ),
      body: executionId === undefined ? { reason } : { executionId, reason },
      schema: abandonResponseSchema,
      command: "abandon",
    },
    json,
  );
  if (!response.ok) return response.result;
  return success(json, "abandoned spec target", "abandoned", response.value);
}
