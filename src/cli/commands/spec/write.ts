import { z } from "zod";

import { createLogger } from "@/lib/logging";
import {
  BATCH_WITHOUT_WORK_MESSAGE,
  batchCarriesWork,
  createAuthoringSpecInputSchema,
  createSpecInitialElementSchema,
  draftElementBatchDocumentSchema,
  draftElementDocumentSchema,
  type DraftElementBatchRemoval,
  type DraftElementInput,
} from "@/lib/specs/authoring-service";
import {
  explainInvalidElementHandle,
  formatBareElementHandle,
  formatElementHandle,
  isWellFormedElementHandle,
  parseElementHandle,
  specSlugSchema,
} from "@/lib/specs/handles";
import { LINT_SEVERITY_LABEL, draftHealth } from "@/lib/specs/draft-health";
import { postLaunchPathActs } from "@/lib/specs/delivery-plan";
import {
  deliveryPlanEditRequestSchema,
  deliveryPlanMutationViewSchema,
  deliveryPlanNextActSchema,
  deliveryPlanPreviewViewSchema,
  type DeliveryPlanMutationView,
} from "@/lib/specs/delivery-plan-views";
import { approvalRequestReceiptSchema } from "@/lib/specs/review-service";
import { projectSpecComment } from "@/lib/specs/comment-projection";
import {
  importBundleSchema,
  specAliasSchema,
  specCommentRowSchema,
  specElementSchema,
  specElementVersionSchema,
  specExecutionRowSchema,
  specGateSchema,
  specRevisionSchema,
  specRevisionSupersessionSchema,
  specSchema,
  specTaskClaimRowSchema,
  taskElementPayloadSchema,
} from "@/lib/specs/schemas";
import {
  lintFindingSchema,
  specAssumptionViewSchema,
  specEditContextViewSchema,
  specLintViewSchema,
  specProposeResultViewSchema,
  specQuestionViewSchema,
  specStartedExecutionViewSchema,
  type SpecEditContextView,
  type SpecProposeResultView,
} from "@/lib/specs/view-schemas";
import { flagNamesFor } from "../../help-registry";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
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
import { countOf, pendingBlockLines } from "./projection-text";

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
/**
 * Whether the write brought an element id the spec already owned back into the
 * revision. Optional for the same reason the handle is: a CLI newer than its
 * server still parses, and an absent flag reads as an ordinary save.
 */
const revivedSchema = z.boolean().optional();
const createResponseSchema = z
  .object({
    spec: specSchema,
    draft: specRevisionSchema,
    element: specElementSchema,
    version: specElementVersionSchema,
    revived: revivedSchema,
    handle: assignedHandleSchema,
  })
  .strict();
const draftResponseSchema = z
  .object({
    element: specElementSchema,
    version: specElementVersionSchema,
    revived: revivedSchema,
    handle: assignedHandleSchema,
  })
  .strict();
/**
 * The batch form of the same document: an array of the element writes a lone
 * `--file` object already is. Both forms are the server's own draft input
 * schema, so a document a batch accepts is one a single write accepts too.
 */
const draftBatchFileSchema = z.array(draftElementDocumentSchema).min(1);
/**
 * The keyed batch document: the array form plus the removals that can only
 * travel with it. A reference and its target have to leave together, so two
 * sequential documents have no legal order — which is why removal is a key in
 * this file rather than a second command. Removals are the server's own
 * removal schema verbatim: `{elementId, baseElementVersion}` and nothing else,
 * because a handle form here would be a second grammar the server never sees.
 */
const draftKeyedBatchFileSchema = draftElementBatchDocumentSchema.refine(
  batchCarriesWork,
  { message: BATCH_WITHOUT_WORK_MESSAGE, path: ["elements"] },
);
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
    /**
     * Present only on a dangling-reference refusal. The handles are what the
     * author addressed the elements by; they are absent on a server that
     * predates them, and null for an element the batch had not yet named.
     */
    danglingReferences: z
      .array(
        z
          .object({
            sourceElementId: z.string().min(1),
            sourceHandle: z.string().min(1).nullable().optional(),
            targetId: z.string().min(1),
            targetHandle: z.string().min(1).nullable().optional(),
            relation: z.string().min(1),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const draftBatchRefusalsSchema = z
  .object({ refusals: z.array(draftBatchRefusalSchema).min(1) })
  .passthrough();
// Mutations answer with the same domain views the read path projects, so
// the CLI parses those views — a raw persistence row is a contract break.
const questionResponseSchema = specQuestionViewSchema;
const proposeResponseSchema = specProposeResultViewSchema;
/**
 * An amendment answers with the revision it opened and the withdrawn
 * revisions it could not carry — a withdrawal is terminal, so its content is
 * dropped rather than folded forward.
 */
const amendResponseSchema = z
  .object({
    revision: specRevisionSchema,
    skippedWithdrawnRevisions: z.array(specRevisionSchema),
  })
  .strict();
const withdrawProposalResponseSchema = z
  .object({ withdrawn: specRevisionSchema, draft: specRevisionSchema })
  .strict();
const dismissSupersededResponseSchema = z
  .object({
    withdrawn: specRevisionSchema,
    supersession: specRevisionSupersessionSchema,
  })
  .strict();
const advanceStageSchema = z.literal("requirements");
const advanceResponseSchema = z
  .object({ revision: specRevisionSchema })
  .strict();
const deliveryPlanCandidateSchema = z
  .object({
    attemptId: z.string().min(1),
    candidateId: z.string().min(1),
    planHash: z.string().min(1),
    compiledDefinitionHash: z.string().min(1),
  })
  .strict();
const parkedDeliveryPlanSchema = deliveryPlanCandidateSchema
  .extend({ nextAct: deliveryPlanNextActSchema })
  .strict();
/** A start either launches one identified candidate or parks one; no legacy shape exists. */
const startResponseSchema = z.union([
  z
    .object({
      execution: specStartedExecutionViewSchema,
      definition: z.object({ id: z.string().min(1) }).passthrough(),
      deliveryPlan: deliveryPlanCandidateSchema,
    })
    .strict(),
  z.object({ parked: parkedDeliveryPlanSchema }).strict(),
]);
// The discovered-task file is the server's own capture payload shape (minus
// the fixed kind), so local validation cannot drift from what the
// capture-scope-amendment action accepts.
const discoveredTaskFileSchema = taskElementPayloadSchema.omit({ kind: true });
const captureResponseSchema = z
  .object({
    discovery: z
      .object({
        id: z.string().min(1),
        executionId: z.string().min(1),
        attemptId: z.string().min(1).nullable(),
        title: z.string().min(1),
      })
      .strict(),
    restartRequired: z.boolean(),
    replacement: z
      .object({
        abandonedExecutionId: z.string().min(1),
        replacementAttemptId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();
const renameResponseSchema = z
  .object({ spec: specSchema, alias: specAliasSchema })
  .strict();
/** What the import counted into the spec it created, per element family. */
const importCountsSchema = z
  .object({
    sections: z.number().int().nonnegative(),
    requirements: z.number().int().nonnegative(),
    criteria: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    assumptions: z.number().int().nonnegative(),
  })
  .strict();
type ImportCountsView = z.infer<typeof importCountsSchema>;
const importReceiptSchema = z
  .object({
    spec: specSchema,
    revision: specRevisionSchema,
    counts: importCountsSchema,
  })
  .strict();
const importHandleEntrySchema = z
  .object({ handle: z.string().min(1), summary: z.string() })
  .strict();
const importPreviewSchema = z
  .object({
    dryRun: z.literal(true),
    preview: z
      .object({
        counts: importCountsSchema,
        handles: z
          .object({
            requirements: z.array(importHandleEntrySchema),
            criteria: z.array(importHandleEntrySchema),
            decisions: z.array(importHandleEntrySchema),
            questions: z.array(importHandleEntrySchema),
            assumptions: z.array(importHandleEntrySchema),
          })
          .strict(),
        findings: z.array(lintFindingSchema),
        blocking: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
/**
 * A rehearsal and a real import answer the same action, and the transport
 * unwraps the performed result to the receipt itself — so the two are told
 * apart by shape rather than by a discriminator the server never sends.
 */
const importResponseSchema = z.union([
  importPreviewSchema,
  importReceiptSchema,
]);
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
  /**
   * The one published document this file must match, when the command accepts
   * exactly one. Without it the caller is sent to the whole schema index and
   * has to work out which of its documents this verb reads.
   */
  schemaDocument?: string,
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
      schemaDocument === undefined
        ? "  run `cctl spec schema` for the accepted document shapes"
        : `  run \`cctl spec schema ${schemaDocument}\` for the accepted document shape`,
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
  return `  [${entry.index}] ${elementLabel(slug, entry.handle, entry.element.kind)} at version ${entry.version.elementVersion}${entry.revived ? " (revived)" : ""}`;
}

/**
 * A batch refuses as a whole, so the caller's question is never "did it fail?"
 * but "which element refused, and why?". Every refusal is printed against the
 * index the caller submitted, with the version a stale element is actually at.
 */
function batchRefusalLine(
  slug: string,
  refusal: z.infer<typeof draftBatchRefusalSchema>,
): string {
  const subject = refusal.elementId ?? "the revision";
  const version =
    refusal.currentElementVersion === null
      ? ""
      : ` (element is at version ${refusal.currentElementVersion})`;
  return [
    `  [${refusal.index}] ${subject}: ${refusal.code} — ${refusal.unmetConditions.join(" ")}${version}`,
    ...(refusal.danglingReferences ?? []).map(
      (reference) =>
        `      ${referenceEnd(slug, reference.sourceElementId, reference.sourceHandle)} ${reference.relation} ${referenceEnd(slug, reference.targetId, reference.targetHandle)}, which this revision would not carry`,
    ),
  ].join("\n");
}

/**
 * Address one end of a dangling reference the way the author wrote it. The id
 * is the fallback, not the answer: an author who removed `R1.1` should not
 * have to look up which opaque id that was to read the refusal.
 */
function referenceEnd(
  slug: string,
  elementId: string,
  handle: string | null | undefined,
): string {
  return handle === null || handle === undefined
    ? elementId
    : `${slug}/${handle}`;
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
  /** A handle or element id to resolve against the current revision. */
  element?: string,
): Promise<CommandResult<SpecEditContextView>> {
  return requestTyped(
    host,
    context,
    env,
    {
      method: "GET",
      path: `${specBasePath(context, slug)}/edit-context${element === undefined ? "" : `?element=${encodeURIComponent(element)}`}`,
      schema: specEditContextViewSchema,
      command,
    },
    json,
  );
}

/**
 * The draft's blocking finding count, or null when it cannot be read. A draft
 * receipt reports the count it moved, which means reading lint on both sides of
 * the write — but the delta only enriches the receipt, so a lint that refuses
 * (no draft yet, an older server) drops the line rather than the write.
 */
async function readBlockingCount(
  host: CliHost,
  context: ProjectConversationContext,
  env: CliEnv,
  slug: string,
): Promise<number | null> {
  const response = await requestTyped(
    host,
    context,
    env,
    {
      method: "GET",
      path: `${specBasePath(context, slug)}/lint`,
      schema: specLintViewSchema,
      command: "draft",
    },
    true,
  );
  // The same projection the lint verb prints and the propose refusal applies:
  // what counts as blocking is decided in one place.
  return response.ok ? draftHealth(response.value.findings).blocking : null;
}

/**
 * What the write did to the draft's proposability. Null on either side means
 * lint could not be read, and an unknown delta is reported as no delta rather
 * than as a zero — both renderings then simply omit it.
 */
interface LintDelta {
  readonly blockingBefore: number;
  readonly blockingAfter: number;
}

function lintDelta(
  before: number | null,
  after: number | null,
): LintDelta | undefined {
  if (before === null || after === null) return undefined;
  return { blockingBefore: before, blockingAfter: after };
}

/**
 * The one line that answers "did that help?" without a second command. The
 * `--json` receipt carries the same two numbers structurally, so a machine
 * reader never has to parse this sentence back apart.
 */
function lintDeltaLine(slug: string, delta: LintDelta | undefined): string[] {
  if (delta === undefined) return [];
  const summary = `lint: ${delta.blockingBefore} -> ${delta.blockingAfter} blocking`;
  return [
    delta.blockingAfter === 0
      ? `${summary} — nothing here refuses propose`
      : `${summary} — read them with cctl spec lint ${slug}`,
  ];
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
  /**
   * What the write did to the draft's blocking finding count. Rendered beside
   * the state it produced AND carried structurally in the `--json` receipt.
   * Absent when lint could not be read on both sides of the write. The slug
   * rides along because the text rendering points at `cctl spec lint <slug>`;
   * only the two counts reach the `--json` receipt.
   */
  readonly lint?: LintDelta & { readonly slug: string };
  /** Server-assigned addressing tokens, keyed machine-side in camelCase. */
  readonly tokens: Readonly<Record<string, string>>;
  readonly actsNext: "agent" | "human";
  /** What is blocked and on whom, or null when nothing is. */
  readonly blocked: string | null;
  /**
   * The structured detail behind `blocked` — the gates and conditions the
   * server named. Rendered between the position and the next action, because a
   * one-sentence blocker cannot carry a multi-gate, multi-condition block.
   */
  readonly detail?: readonly string[];
  /**
   * The act that takes this outcome back, named at the moment it becomes
   * relevant rather than left to be rediscovered from the schema docs. Only
   * outcomes with a real inverse carry one — it is not a second `next`.
   */
  readonly recovery?: string;
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
    ...(outcome.lint === undefined
      ? []
      : lintDeltaLine(outcome.lint.slug, outcome.lint)),
    ...(tokens.length === 0
      ? []
      : [
          "tokens:",
          ...tokens.map(([key, token]) => `  ${tokenLabel(key)}: ${token}`),
        ]),
    `acts next: ${outcome.actsNext}${outcome.blocked === null ? "" : ` — ${outcome.blocked}`}`,
    ...(outcome.detail ?? []),
    ...(outcome.recovery === undefined
      ? []
      : [`recovery: ${outcome.recovery}`]),
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
      ...(outcome.lint === undefined
        ? {}
        : {
            lint: {
              blockingBefore: outcome.lint.blockingBefore,
              blockingAfter: outcome.lint.blockingAfter,
            },
          }),
      tokens: outcome.tokens,
      actsNext: outcome.actsNext,
      blocked: outcome.blocked,
      ...(outcome.recovery === undefined ? {} : { recovery: outcome.recovery }),
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
  return `cctl spec draft ${slug} --file <element.json>`;
}

/**
 * The command that carries out the act the server's projection named. Which
 * act comes next — and at which gate, for which subject — is the server's
 * answer; this only turns it into an invocation. Sign-off and condition
 * resolution have no agent-callable verb, so both point back at the read that
 * reports them until a human acts.
 */
function nextActionCommand(
  slug: string,
  action: SpecProposeResultView["nextAction"],
): string {
  switch (action?.kind) {
    case "approve_gate":
      return `cctl spec request-approval ${slug} --gate ${action.gate}`;
    case "approve_subject":
      return `cctl spec request-approval ${slug} --gate ${action.gate}${
        action.subject === null ? "" : ` --subject ${action.subject}`
      }`;
    case "sign_off_revision":
    case "resolve_conditions":
      return `cctl spec status ${slug}`;
    case "propose":
      return `cctl spec propose ${slug}`;
    default:
      return `cctl spec amend ${slug}`;
  }
}

/**
 * What an amendment left behind. A withdrawn revision is terminal, so nothing
 * folds its content forward: the author only learns the new revision starts
 * short of the last thing written if the amendment names the drop.
 */
function skippedWithdrawnLine(
  skipped: readonly { readonly number: number }[],
  openedNumber: number,
): string {
  const numbers = skipped.map(({ number }) => number);
  const plural = numbers.length > 1;
  const joined =
    numbers.length <= 2
      ? numbers.join(" and ")
      : `${numbers.slice(0, -1).join(", ")}, and ${numbers.at(-1) ?? ""}`;
  return `${plural ? "revisions" : "revision"} ${joined} ${plural ? "were" : "was"} withdrawn and ${plural ? "their" : "its"} content is not carried into revision ${openedNumber} — re-author anything from ${plural ? "them" : "it"} that still applies`;
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
  // The create document, not the draft one: the revision this element opens
  // holds no version to compare against, so an explicit-null
  // `baseElementVersion` is tolerated and a numeric one is refused rather
  // than ignored.
  const parsedFile = createSpecInitialElementSchema.safeParse(file.value);
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

const IMPORT_SCHEMA_DOCUMENT = "import-bundle";

/**
 * The numbering the import allocated, read back from what it counted. A new
 * spec starts every counter at zero, so a family's count IS its handle range —
 * except criteria, which are numbered inside their requirement, and which no
 * single range could honestly report.
 */
function importHandleLines(counts: ImportCountsView): string[] {
  const requirement = (number: number) =>
    formatBareElementHandle({ kind: "requirement", requirementNumber: number });
  const numbered =
    (kind: "decision" | "question" | "assumption") => (number: number) =>
      formatBareElementHandle({ kind, number });
  const family = (
    label: string,
    count: number,
    handle: (number: number) => string,
  ) =>
    count === 0
      ? `  ${label}: 0`
      : count === 1
        ? `  ${label}: 1 (${handle(1)})`
        : `  ${label}: ${count} (${handle(1)}–${handle(count)})`;
  return [
    // Sections carry no handle at all: they are addressed by element id.
    `  sections: ${counts.sections}`,
    family("requirements", counts.requirements, requirement),
    `  criteria: ${counts.criteria}`,
    family("decisions", counts.decisions, numbered("decision")),
    family("questions", counts.questions, numbered("question")),
    family("assumptions", counts.assumptions, numbered("assumption")),
  ];
}

function importReceiptResult(
  receipt: z.infer<typeof importReceiptSchema>,
  sourceLabel: string,
  json: boolean,
): CliResult {
  const { spec, revision, counts } = receipt;
  const delivery = revision.externalDelivery;
  return mutationResult(
    json,
    {
      // Approved on provenance, never on an approval: the spec is born past its
      // authoring gates because an agent imported it, and no approval row was
      // written for anyone to mistake for a human one.
      changed: `imported spec ${spec.slug} from ${sourceLabel} — revision ${revision.number} is approved on import provenance, not on a human approval`,
      items: importHandleLines(counts),
      state:
        delivery === null
          ? `revision ${revision.number} is approved at the ${revision.authoringStage} stage; no external delivery recorded`
          : `revision ${revision.number} is approved at the ${revision.authoringStage} stage; external delivery recorded from ${delivery.source.label} at ${delivery.at} — provenance, not proof`,
      tokens: { spec: spec.slug, revision: revision.id },
      actsNext: "agent",
      blocked: null,
      // A source that already shipped owes nothing here; one that has not still
      // owes its delivery, which is authored as a plan.
      next:
        delivery === null
          ? `cctl spec plan open ${spec.slug}`
          : `cctl spec show ${spec.slug}`,
    },
    "import",
    receipt,
  );
}

/**
 * The step that ends the rehearsal. A bundle that declares its own `dryRun`
 * rehearses on every invocation of this command, so for that bundle the
 * terminating act is an edit to the document — offering the bare re-run would
 * advise a rehearsal that repeats forever.
 */
function importDryRunHint(
  blocking: number,
  filePath: string,
  declaredInBundle: boolean,
): string {
  const owed = [
    ...(blocking === 0
      ? []
      : [`fix the ${countOf(blocking, "blocking finding")} above`]),
    ...(declaredInBundle
      ? [`set "dryRun": false in ${filePath} (or drop the field)`]
      : []),
  ];
  const perform = `cctl spec import --file ${filePath}`;
  if (owed.length === 0) return `${perform} — nothing here refuses it`;
  return `${owed.join(" and ")}, then ${perform}${
    blocking === 0 ? " — nothing else here refuses it" : ""
  }`;
}

function importDryRunResult(
  preview: z.infer<typeof importPreviewSchema>["preview"],
  slug: string,
  filePath: string,
  declaredInBundle: boolean,
  json: boolean,
): CliResult {
  const health = draftHealth(preview.findings);
  const { handles } = preview;
  const allocated = [
    ...handles.requirements,
    ...handles.criteria,
    ...handles.decisions,
    ...handles.questions,
    ...handles.assumptions,
  ];
  // The numbering is what an agent authoring cross-references in the bundle
  // needs before any of it exists, so it is listed entry by entry rather than
  // summarized the way a performed import's receipt summarizes it.
  const lines = [
    `dry run — nothing was written. spec ${slug} would be created from this bundle`,
    ...(allocated.length === 0
      ? []
      : [
          "handles it would allocate:",
          ...allocated.map((entry) => `  ${entry.handle}  ${entry.summary}`),
        ]),
    ...importHandleLines(preview.counts),
    `findings: ${health.total}, ${health.blocking} blocking`,
    ...health.groups.flatMap((group) => [
      `${LINT_SEVERITY_LABEL[group.severity]} (${group.findings.length})${
        group.severity === "blocks_propose" ? " — would refuse the import" : ""
      }:`,
      ...group.findings.map(
        (finding) =>
          `  ${finding.elementHandle} [${finding.ruleId}]: ${finding.message}`,
      ),
    ]),
  ];
  logger.debug("cli.spec.import_dry_run", {
    findingCount: health.total,
    blockingCount: health.blocking,
  });
  return {
    exitCode: EXIT_OK,
    // The hint travels on the envelope alone: `render` owns the hint tier and
    // prints the `hint:` line itself in text mode.
    stdout: render(json, `${lines.join("\n")}\n`, {
      ok: true,
      dryRun: true,
      preview,
      hint: importDryRunHint(health.blocking, filePath, declaredInBundle),
    }),
    stderr: "",
  };
}

export async function runSpecImport(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec import"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 0, "import", json);
  if (extra) return extra;
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "spec import requires --file <bundle.json> — the bundle names the spec it creates, so this command takes no slug",
      json,
    );
  }
  const file = await readJsonObjectFile(host, filePath, "import bundle", json);
  if (!file.ok) return file.result;
  const parsed = importBundleSchema.safeParse(file.value);
  if (!parsed.success) {
    return invalidFileResult(
      "import",
      filePath,
      "import bundle",
      json,
      parsed.error,
      IMPORT_SCHEMA_DOCUMENT,
    );
  }
  const bundle = parsed.data;
  // The flag and the document can each ask for a rehearsal, and neither
  // cancels the other's ask: a bundle authored `"dryRun": true` must not be
  // performed for real because the flag was left off the invocation.
  const dryRun = bundle.dryRun || values["dry-run"] !== undefined;
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: `/api/specs/${encodePathSegment(resolved.context.project)}/actions/import`,
      body: { ...bundle, dryRun },
      schema: importResponseSchema,
      command: "import",
    },
    json,
  );
  if (!response.ok) return response.result;
  const result = response.value;
  return "dryRun" in result
    ? importDryRunResult(
        result.preview,
        bundle.slug,
        filePath,
        bundle.dryRun,
        json,
      )
    : importReceiptResult(result, bundle.source.label, json);
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
      schema: amendResponseSchema,
      command: "amend",
    },
    json,
  );
  if (!response.ok) return response.result;
  const opened = response.value.revision;
  const skipped = response.value.skippedWithdrawnRevisions;
  return mutationResult(
    json,
    {
      changed: `opened amendment revision ${opened.number} at ${opened.authoringStage} stage`,
      items:
        skipped.length === 0
          ? undefined
          : [skippedWithdrawnLine(skipped, opened.number)],
      state: `draft revision ${opened.number} at ${opened.authoringStage} stage`,
      tokens: { revision: opened.id },
      actsNext: "agent",
      blocked: null,
      next: draftNextCommand(slug.value),
    },
    "revision",
    opened,
    { skippedWithdrawnRevisions: skipped },
  );
}

interface DraftWriteRequest {
  readonly host: CliHost;
  readonly flags: GlobalFlags;
  readonly env: CliEnv;
  readonly slug: string;
  readonly json: boolean;
  /**
   * Bound the --json receipt to element identities. The full echo of every
   * committed payload is the default, but a large batch echoing itself back
   * through the ~64KB pipe cap forces a redirect-to-file dance (#60), and the
   * identities are all a caller needs to keep writing.
   */
  readonly quiet: boolean;
}

/** How a draft document states the version each of its elements replaces. */
const BASE_ELEMENT_VERSION_FIELD =
  '"baseElementVersion": <the version you last read, or null to create the element>';

const DRAFT_FILE_USAGE =
  'spec draft requires --file <element.json>, holding one element write document, a JSON array of them, or {"elements": [...], "removals": [...]}; each element states its own baseElementVersion';

/**
 * The batch a `--file` document asks for: the elements it writes and the
 * elements it takes out, which travel together because removing a reference
 * and its target in two documents has no legal order.
 */
interface DraftBatchDocument {
  readonly elements: readonly DraftElementInput[];
  readonly removals: readonly DraftElementBatchRemoval[];
}

type ParsedDraftDocument =
  | { readonly form: "single"; readonly element: DraftElementInput }
  | ({ readonly form: "batch" } & DraftBatchDocument);

/**
 * All three `--file` forms hold the same element document, so one schema
 * parses each of them and a lone element cannot be legal in a shape a batch
 * element is not. The forms are told apart by the file, not by a flag: the
 * array and the keyed object are parsed as themselves so a schema failure
 * still names the offending element's index and field, which a union parse
 * would flatten away. The keyed form is recognised by its keys — a lone
 * element document carries neither, since it is strict and has no such field.
 */
function parseDraftDocument(
  document: unknown,
  filePath: string,
  json: boolean,
):
  | ({ readonly ok: true } & ParsedDraftDocument)
  | { readonly ok: false; readonly result: CliResult } {
  const invalid = (error: z.ZodError) => ({
    ok: false as const,
    result: invalidFileResult("draft", filePath, "draft element", json, error),
  });
  if (Array.isArray(document)) {
    const parsed = draftBatchFileSchema.safeParse(document);
    return parsed.success
      ? { ok: true, form: "batch", elements: parsed.data, removals: [] }
      : invalid(parsed.error);
  }
  if (isKeyedBatchDocument(document)) {
    const parsed = draftKeyedBatchFileSchema.safeParse(document);
    return parsed.success
      ? {
          ok: true,
          form: "batch",
          elements: parsed.data.elements,
          removals: parsed.data.removals,
        }
      : invalid(parsed.error);
  }
  const parsed = draftElementDocumentSchema.safeParse(document);
  return parsed.success
    ? { ok: true, form: "single", element: parsed.data }
    : invalid(parsed.error);
}

function isKeyedBatchDocument(document: unknown): boolean {
  return (
    typeof document === "object" &&
    document !== null &&
    ("elements" in document || "removals" in document)
  );
}

/** The command `spec status` names as the next step after any draft save. */
function draftStatusNext(slug: string): string {
  return `cctl spec status ${slug} — reads the stages this draft still owes and the command that concludes the current one`;
}

async function draftSingleElement(
  request: DraftWriteRequest,
  element: DraftElementInput,
): Promise<CliResult> {
  const { host, flags, env, slug, json } = request;
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  // Concurrent with the write's own read: the "before" count costs no serial
  // round trip that the edit-context read does not already spend.
  const [editContext, blockingBefore] = await Promise.all([
    readEditContext(host, resolved.context, env, slug, "draft", json),
    readBlockingCount(host, resolved.context, env, slug),
  ]);
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
      body: { revisionId: revisionId.value, ...element },
      schema: draftResponseSchema,
      command: "draft",
    },
    json,
  );
  if (!response.ok) return response.result;
  const saved = response.value;
  const label = elementLabel(slug, saved.handle, saved.element.kind);
  const blockingAfter = await readBlockingCount(
    host,
    resolved.context,
    env,
    slug,
  );
  const delta = lintDelta(blockingBefore, blockingAfter);
  return mutationResult(
    json,
    {
      ...(delta === undefined ? {} : { lint: { ...delta, slug } }),
      // A revival is not a fresh save: the id was already the spec's, and the
      // address readers know it by came back with it.
      changed: saved.revived
        ? `revived ${label} at version ${saved.version.elementVersion} — the element kept the number and handle it was created with`
        : `saved ${label} at version ${saved.version.elementVersion}`,
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
    request.quiet
      ? {
          elementId: saved.element.id,
          handle: saved.handle,
          elementVersion: saved.version.elementVersion,
          revived: saved.revived,
        }
      : saved,
  );
}

/** One element a batch takes out, with the address the caller named it by. */
interface RemovedElement extends DraftElementBatchRemoval {
  /** Null when the caller addressed the element by id, as a file does. */
  readonly handle: string | null;
  readonly kind: string | null;
}

/**
 * Removal's exact inverse, named on the receipt that makes it relevant rather
 * than left in the schema docs: a historical id refuses an ordinary write, so
 * an author who does not learn the flag here learns it from a refusal.
 */
function reintroductionRecovery(slug: string): string {
  return `bring a removed element back with its original number and handle by re-saving it with "reintroduceHistorical": true and "baseElementVersion": null — ${draftNextCommand(slug)}`;
}

/**
 * Many elements, one transaction, still one compare-and-swap per element —
 * removals included. The batch is reported item by item: a whole-document
 * write would hide both which element refused and which version each landed
 * at (R7.3), and a removal reports no version because it leaves none behind.
 */
async function draftElementBatch(
  request: DraftWriteRequest,
  document: DraftBatchDocument,
  removedAddresses: readonly RemovedElement[],
): Promise<CliResult> {
  const { host, flags, env, slug, json } = request;
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
  return submitDraftBatch(
    request,
    resolved.context,
    revisionId.value,
    document,
    removedAddresses,
  );
}

/**
 * The one transport every removal takes — the file form and the `spec remove`
 * verb submit the identical document, so the two can never drift into
 * different atomicity or different refusals.
 */
async function submitDraftBatch(
  request: DraftWriteRequest,
  context: ProjectConversationContext,
  revisionId: string,
  document: DraftBatchDocument,
  removedAddresses: readonly RemovedElement[],
): Promise<CliResult> {
  const { host, env, slug, json } = request;
  const { elements, removals } = document;
  // Read here rather than in each caller so the batch file form and the
  // `spec remove` verb report the same delta over the same transaction.
  const blockingBefore = await readBlockingCount(host, context, env, slug);
  const response = await requestTyped(
    host,
    context,
    env,
    {
      method: "POST",
      path: actionPath(context, slug, "draft-batch"),
      body: {
        revisionId,
        elements,
        ...(removals.length === 0 ? {} : { removals }),
      },
      schema: draftBatchResponseSchema,
      command: "draft",
      onRefusal: (error) => {
        const refused = draftBatchRefusalsSchema.safeParse(error.details);
        if (!refused.success) return null;
        return failure({
          exitCode: EXIT_OPERATION_FAILED,
          message: error.error,
          detail: refused.data.refusals
            .map((refusal) => batchRefusalLine(slug, refusal))
            .join("\n"),
          ...structuredErrorFields(error),
          json,
        });
      },
    },
    json,
  );
  if (!response.ok) return response.result;
  const saved = response.value;
  const written = saved.written.length;
  const removed = removedAddresses.length;
  const changed = [
    ...(written === 0 ? [] : [`saved ${countOf(written, "element")}`]),
    ...(removed === 0 ? [] : [`removed ${countOf(removed, "element")}`]),
  ].join(" and ");
  const state = [
    ...(written === 0 ? [] : [`all ${countOf(written, "element")} current`]),
    ...(removed === 0 ? [] : [`${countOf(removed, "element")} no longer`]),
  ].join(" and ");
  const blockingAfter = await readBlockingCount(host, context, env, slug);
  const delta = lintDelta(blockingBefore, blockingAfter);
  return mutationResult(
    json,
    {
      changed: `${changed} in one transaction`,
      ...(delta === undefined ? {} : { lint: { ...delta, slug } }),
      items: [
        ...saved.written.map((entry) => batchWrittenLine(slug, entry)),
        ...removedAddresses.map(
          (entry, index) =>
            `  removed [${index}] ${entry.handle === null ? entry.elementId : elementLabel(slug, entry.handle, entry.kind ?? "element")}`,
        ),
      ],
      state: `${state} in the open draft`,
      tokens: { revision: saved.revisionId },
      actsNext: "agent",
      blocked: null,
      ...(removed === 0 ? {} : { recovery: reintroductionRecovery(slug) }),
      next: draftStatusNext(slug),
    },
    "batch",
    request.quiet
      ? {
          revisionId: saved.revisionId,
          written: saved.written.map((entry) => ({
            index: entry.index,
            elementId: entry.elementId,
            handle: entry.handle,
            elementVersion: entry.version.elementVersion,
            revived: entry.revived,
          })),
        }
      : saved,
    removed === 0
      ? {}
      : {
          removed: removedAddresses.map((entry) => ({
            elementId: entry.elementId,
            handle: entry.handle,
            baseElementVersion: entry.baseElementVersion,
          })),
        },
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
  // Checked ahead of the allowlist so the caller learns where the version
  // moved to, rather than reading a bare unknown-flag refusal.
  if (values["base-version"] !== undefined) {
    return usageFailure(
      `spec draft: --base-version was removed — state the compare-and-swap version in the file itself as ${BASE_ELEMENT_VERSION_FIELD}, the same field every element of a batch carries`,
      json,
    );
  }
  const denied = checkFlags(values, flagNamesFor("spec draft"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "draft", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "draft", json);
  if (!slug.ok) return slug.result;
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(DRAFT_FILE_USAGE, json);
  }
  const file = await readDraftFile(host, filePath, json);
  if (!file.ok) return file.result;
  const parsed = parseDraftDocument(file.value, filePath, json);
  if (!parsed.ok) return parsed.result;
  const request: DraftWriteRequest = {
    host,
    flags,
    env,
    slug: slug.value,
    json,
    quiet: values["quiet"] === "true",
  };
  // The document's own shape selects how the write is reported: a batch is
  // one transaction reported per index, a lone object is the element form
  // whose refusal carries the winning content back.
  return parsed.form === "single"
    ? draftSingleElement(request, parsed.element)
    : draftElementBatch(
        request,
        { elements: parsed.elements, removals: parsed.removals },
        // A file addresses removals by element id, which is the whole reason
        // `spec remove` exists: it is the same document with handles resolved.
        parsed.removals.map((removal) => ({
          ...removal,
          handle: null,
          kind: null,
        })),
      );
}

const REMOVE_USAGE =
  "spec remove requires <slug> and at least one <handle> — cctl spec remove <slug> <handle...>";

/**
 * Removal by the address the author writes in. Handles are resolved here,
 * against the write path's own read, rather than in the file contract: the
 * server's removal schema is `{elementId, baseElementVersion}`, and teaching
 * the transport a second grammar would put handle resolution on both sides of
 * the wire. One batch is still submitted, so a set of removals that only
 * resolves together lands together.
 */
export async function runSpecRemove(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec remove"), json);
  if (denied) return denied;
  const slug = validateSlug(rest[0], "remove", json);
  if (!slug.ok) return slug.result;
  const handles = rest.slice(1);
  if (handles.length === 0) return usageFailure(REMOVE_USAGE, json);
  const addressed = readRemovalHandles(handles, slug.value, json);
  if (!addressed.ok) return addressed.result;

  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const removals: RemovedElement[] = [];
  let revisionId: string | null = null;
  for (const handle of addressed.value) {
    const editContext = await readEditContext(
      host,
      resolved.context,
      env,
      slug.value,
      "remove",
      json,
      handle,
    );
    if (!editContext.ok) return editContext.result;
    const current = currentRevisionId(editContext.value, "remove", json);
    if (!current.ok) return current.result;
    // Every handle is resolved against one revision. A draft that moved mid
    // resolution would mix versions read from two revisions into one
    // compare-and-swap, which is the conflict the CAS exists to report.
    if (revisionId !== null && revisionId !== current.value) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `spec remove: the open draft changed to revision ${current.value} while ${slug.value}'s handles were being resolved`,
        code: "stale_revision",
        instruction: "Nothing was removed. Run the same command again.",
        json,
      });
    }
    revisionId = current.value;
    const element = editContext.value.element;
    if (element === null) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `spec remove: the open draft of ${slug.value} carries no ${slug.value}/${handle}`,
        code: "not_found",
        instruction: `Nothing was removed. Write the complete rendered draft with \`cctl spec show ${slug.value} --rendered\`, then remove the handles it lists.`,
        json,
      });
    }
    removals.push({
      elementId: element.elementId,
      baseElementVersion: element.elementVersion,
      handle: element.handle ?? handle,
      kind: element.kind,
    });
  }
  if (revisionId === null) return usageFailure(REMOVE_USAGE, json);
  return submitDraftBatch(
    { host, flags, env, slug: slug.value, json, quiet: false },
    resolved.context,
    revisionId,
    {
      elements: [],
      removals: removals.map(({ elementId, baseElementVersion }) => ({
        elementId,
        baseElementVersion,
      })),
    },
    removals,
  );
}

/**
 * The bare handles a removal names, refused before any read when one is not a
 * handle, addresses another spec, or repeats — a batch that removed the same
 * element twice would refuse on the second compare-and-swap, which reads as a
 * concurrency conflict rather than as the typo it is.
 */
function readRemovalHandles(
  handles: readonly string[],
  slug: string,
  json: boolean,
): CommandResult<string[]> {
  const bare: string[] = [];
  for (const raw of handles) {
    if (!isWellFormedElementHandle(raw, slug)) {
      return {
        ok: false,
        result: usageFailure(
          `spec remove: ${explainInvalidElementHandle(raw)}`,
          json,
        ),
      };
    }
    const parsed = parseElementHandle(raw, slug);
    if (parsed.slug !== slug) {
      return {
        ok: false,
        result: usageFailure(
          `spec remove: ${JSON.stringify(raw)} addresses spec ${parsed.slug}, not ${slug}`,
          json,
        ),
      };
    }
    if (parsed.kind === "question" || parsed.kind === "assumption") {
      return {
        ok: false,
        result: usageFailure(
          `spec remove: ${JSON.stringify(raw)} is a ${parsed.kind}, which is a spec-scoped record rather than a draft element — answer or dispose of it instead`,
          json,
        ),
      };
    }
    const formatted = formatElementHandle(parsed, "bare");
    if (bare.includes(formatted)) {
      return {
        ok: false,
        result: usageFailure(
          `spec remove: ${slug}/${formatted} is named twice; name each handle once`,
          json,
        ),
      };
    }
    bare.push(formatted);
  }
  return { ok: true, value: bare };
}

/**
 * The proposal's disposition document, read whole from the file the author
 * edits between rounds. It is a file rather than a flag value because it is
 * markdown — headings, lists, fenced blocks — which no shell argument carries
 * intact.
 *
 * The size cap is the server's, not this reader's: a limit enforced here would
 * be a second answer to the same question, and a CLI older than its server
 * would refuse documents the server accepts.
 */
async function readProposalNotesFile(
  host: CliHost,
  filePath: string | undefined,
  json: boolean,
): Promise<CommandResult<string | null>> {
  if (filePath === undefined || filePath.trim() === "") {
    return { ok: true, value: null };
  }
  const raw = await host.readTextFile(filePath);
  if (raw === null) {
    return {
      ok: false,
      result: usageFailure(
        `cannot read proposal notes file ${JSON.stringify(filePath)}`,
        json,
      ),
    };
  }
  if (raw.trim() === "") {
    return {
      ok: false,
      result: usageFailure(
        `proposal notes file ${JSON.stringify(filePath)} is empty — write the round's disposition into it, or propose without --notes`,
        json,
      ),
    };
  }
  return { ok: true, value: raw };
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
  const notes = await readProposalNotesFile(host, values["notes"], json);
  if (!notes.ok) return notes.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "propose"),
      body: {
        revisionId: revisionId.value,
        ...(notes.value === null ? {} : { notes: notes.value }),
      },
      schema: proposeResponseSchema,
      command: "propose",
    },
    json,
  );
  if (!response.ok) return response.result;
  const proposed = response.value.revision;
  // The server's post-transition projection is the only account of what the
  // revision still owes. A blocker derived here from `proposed.authoringStage`
  // names the stage rather than the gate, which is the wrong gate whenever an
  // earlier stage is also consulted — and it cannot name the subject at all.
  const block = response.value.pendingBlock;
  return mutationResult(
    json,
    {
      changed: `proposed revision ${proposed.number}`,
      state: `revision ${proposed.number} is ${proposed.state}`,
      tokens: { revision: proposed.id },
      actsNext: block?.actsNext ?? "agent",
      blocked: block?.display ?? null,
      ...(block === null ? {} : { detail: pendingBlockLines(block) }),
      next: nextActionCommand(slug.value, response.value.nextAction),
      ...(block === null ? {} : { instruction: block.instruction }),
    },
    "proposal",
    response.value,
  );
}

export async function runSpecWithdrawProposal(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor("spec withdraw-proposal"),
    json,
  );
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "withdraw-proposal", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "withdraw-proposal", json);
  if (!slug.ok) return slug.result;
  // The revision is the caller's compare-and-swap token, so it is never read
  // from the server's current state: a replacement proposal that landed since
  // the propose must fail this call, not be withdrawn by it.
  const revisionId = values["revision"];
  if (revisionId === undefined || revisionId.trim() === "") {
    return usageFailure(
      "spec withdraw-proposal requires --revision <revision-id> — the token `cctl spec propose` returned for the proposal you are taking back",
      json,
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
      path: actionPath(resolved.context, slug.value, "withdraw-proposal"),
      body: { revisionId },
      schema: withdrawProposalResponseSchema,
      command: "withdraw-proposal",
    },
    json,
  );
  if (!response.ok) return response.result;
  const { withdrawn, draft } = response.value;
  return mutationResult(
    json,
    {
      changed: `withdrew proposed revision ${withdrawn.number} and reopened its content as draft revision ${draft.number}`,
      state: `draft revision ${draft.number} at ${draft.authoringStage} stage`,
      tokens: { revision: draft.id, withdrawnRevision: withdrawn.id },
      actsNext: "agent",
      blocked: null,
      next: draftNextCommand(slug.value),
    },
    "withdrawal",
    response.value,
  );
}

/**
 * The agent-side attempt at the human-only dismissal (#50). It exists so an
 * agent that finds a stranded proposal learns the act and its surface from a
 * typed refusal instead of concluding the state has no exit.
 */
export async function runSpecDismissSuperseded(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(
    values,
    flagNamesFor("spec dismiss-superseded"),
    json,
  );
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "dismiss-superseded", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "dismiss-superseded", json);
  if (!slug.ok) return slug.result;
  const revisionId = values["revision"];
  if (revisionId === undefined || revisionId.trim() === "") {
    return usageFailure(
      "spec dismiss-superseded requires --revision <revision-id> — the stranded proposal `cctl spec status` reports",
      json,
    );
  }
  const reason = values["reason"];
  if (reason === undefined || reason.trim() === "") {
    return usageFailure(
      "spec dismiss-superseded requires --reason <text> — the durable marker records why reviewed work was disposed of",
      json,
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
      path: actionPath(resolved.context, slug.value, "dismiss-superseded"),
      body: { revisionId, reason },
      schema: dismissSupersededResponseSchema,
      command: "dismiss-superseded",
    },
    json,
  );
  if (!response.ok) return response.result;
  const { withdrawn, supersession } = response.value;
  return mutationResult(
    json,
    {
      changed: `dismissed proposed revision ${withdrawn.number} as superseded`,
      state: `revision ${withdrawn.number} is withdrawn; no draft was opened`,
      tokens: {
        revision: withdrawn.id,
        supersededByRevision: supersession.supersededByRevisionId,
      },
      actsNext: "agent",
      blocked: null,
      next: `cctl spec status ${slug.value}`,
    },
    "dismissal",
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
  if (values["from"] === "design") {
    return usageFailure(
      `spec advance --from design is retired: design is the final evergreen stage. Run \`cctl spec propose ${slug.value}\`; after sign-off, open delivery planning with \`cctl spec plan open ${slug.value}\`.`,
      json,
    );
  }
  const expectedStage = advanceStageSchema.safeParse(values["from"]);
  if (!expectedStage.success) {
    return usageFailure("spec advance requires --from requirements", json);
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

export async function runSpecReply(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec reply"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "reply", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "reply", json);
  if (!slug.ok) return slug.result;
  const threadId = values["thread"];
  if (threadId === undefined) {
    return usageFailure("spec reply requires --thread <threadId>", json);
  }
  const body = values["body"];
  if (body === undefined || body.trim() === "") {
    return usageFailure("spec reply requires --body <text>", json);
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await requestTyped(
    host,
    resolved.context,
    env,
    {
      method: "POST",
      path: actionPath(resolved.context, slug.value, "reply"),
      body: { threadId, body },
      schema: specCommentRowSchema,
      command: "reply",
    },
    json,
  );
  if (!response.ok) return response.result;
  // The receipt carries the projected view: the write returns the persisted
  // row, and raw row shape must not leak into an agent-facing envelope. The
  // reply's element handle and revision number are not resolvable without a
  // second read, so the receipt leaves them null — the thread already told
  // the caller where it is anchored.
  const reply = projectSpecComment(response.value, {
    handleByElementId: new Map(),
    revisionNumberById: new Map(),
  });
  return mutationResult(
    json,
    {
      changed: `replied to thread ${threadId}`,
      state: `comment ${reply.id} joined thread ${threadId}`,
      tokens: { thread: threadId, comment: reply.id },
      actsNext: "human",
      blocked: null,
      next: `cctl spec comments ${slug.value} --open`,
    },
    "reply",
    reply,
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
  // An omitted --subject travels as an omission and means the whole gate; the
  // CLI never substitutes a subject of its own, because the ask a request
  // records is what a human is later shown.
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
  const asked =
    receipt.scope === "gate"
      ? `the ${gate.data} gate`
      : `${gate.data} approval for ${receipt.subject}`;
  const outstanding =
    receipt.scope === "item"
      ? ""
      : receipt.outstandingSubjects.length > 0
        ? ` — ${receipt.outstandingSubjects.length} outstanding: ${receipt.outstandingSubjects.join(", ")}`
        : receipt.signOffOutstanding
          ? " — every subject is approved; the revision awaits sign-off"
          : "";
  return mutationResult(
    json,
    {
      // An ask that was already open issued no second Needs You entry, so
      // saying "requested" would report an escalation that did not happen.
      changed: receipt.alreadyRequested
        ? `the request for ${asked} was already open — no second request was created${outstanding}`
        : `requested ${asked}${outstanding}`,
      state: `${gate.data} approval request is pending`,
      tokens: {
        attention: receipt.attentionId,
        revision: receipt.revisionId,
        scope: receipt.scope,
        ...(receipt.elementId === null ? {} : { elementId: receipt.elementId }),
      },
      actsNext: "human",
      blocked:
        receipt.scope === "gate" && receipt.signOffOutstanding
          ? `a human admits the ${gate.data} gate by signing the revision off in Spec Studio — agents request, never approve`
          : `a human approves the ${gate.data} gate in Spec Studio — agents request, never approve`,
      next: `cctl spec status ${slug.value} — reports the request until it is approved`,
    },
    "request",
    receipt,
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
  if (values["file"] !== undefined) {
    return failure({
      exitCode: EXIT_USAGE,
      message:
        "spec start --file is retired: the approved delivery plan is the execution graph.",
      instruction: `Nothing was started. Import legacy planning with \`cctl spec plan open ${slug.value} --seed-from last\`, then propose and sign off that candidate before starting.`,
      json,
    });
  }
  // `spec start` is the one session-only spec verb: the approved candidate is
  // launched into, and its merge is pinned to, that concrete session.
  const resolved = await resolveConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const park = values["park"] !== undefined;
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
        sessionName: resolved.context.session,
        ...(park ? { park: true } : {}),
      },
      schema: startResponseSchema,
      command: "start",
    },
    json,
  );
  if (!response.ok) return response.result;
  if ("parked" in response.value) {
    const parked = response.value.parked;
    return mutationResult(
      json,
      {
        changed: `parked plan attempt ${parked.attemptId} for prelaunch review — candidate ${parked.candidateId} (compiled ${parked.compiledDefinitionHash})`,
        state:
          "attempt parked, no workflow execution created and no session slot taken",
        tokens: {
          planAttempt: parked.attemptId,
          planHash: parked.planHash,
          compiledDefinitionHash: parked.compiledDefinitionHash,
        },
        actsNext: parked.nextAct.actor,
        blocked:
          parked.nextAct.actor === "human" ? parked.nextAct.reason : null,
        detail: [
          `cctl spec plan preview ${slug.value} --stage proposed reads exactly the bytes a launch will run`,
          `tuning the parked plan with \`cctl spec plan reopen ${slug.value} --reason <why>\` changes the candidate hash and demands a fresh sign-off before launch`,
        ],
        next: `${parked.nextAct.command} — ${parked.nextAct.reason}`,
      },
      "plan",
      response.value,
    );
  }
  const { deliveryPlan, execution } = response.value;
  return mutationResult(
    json,
    {
      changed: `launched execution ${execution.id} from plan attempt ${deliveryPlan.attemptId} — the approved candidate ${deliveryPlan.candidateId} ran unchanged`,
      state: `execution ${execution.state}, workflow definition ${response.value.definition.id} at compiled hash ${deliveryPlan.compiledDefinitionHash}`,
      tokens: {
        execution: execution.id,
        workflowDefinition: response.value.definition.id,
        planAttempt: deliveryPlan.attemptId,
        compiledDefinitionHash: deliveryPlan.compiledDefinitionHash,
      },
      actsNext: "agent",
      blocked: null,
      next: `cctl spec status ${slug.value} — reports the run's lane position`,
    },
    "execution",
    response.value,
    {
      workflowDefinitionId: response.value.definition.id,
      workflowLaunched: true,
      executionState: execution.state,
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
  // `--execution` is optional: the spec's live attempt already knows the run
  // it launched, and naming one matters only for a legacy compiled run.
  const executionId = values["execution"];
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "spec capture requires --file <task.json> (add --execution <execution-id> only for a legacy run with no delivery plan attempt)",
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
        ...(executionId === undefined ? {} : { executionId }),
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
  const { discovery, replacement } = captured;
  // The three post-launch paths, side by side and bounded to three, so a
  // receipt never leaves the operator to guess which exits exist (design §11).
  const paths = postLaunchPathActs({
    slug: slug.value,
    executionId: discovery.executionId,
  });
  const nonBlockingGuidance = `The run keeps its pinned scope — no capture form mutates it. The three post-launch paths are: ${paths.join(
    "; ",
  )}. Only the third, \`cctl workflow live amend\`, adds this work to the CURRENT run: it is the dedicated audited amendment, and nothing else may change a launched definition.`;
  if (replacement === null) {
    return mutationResult(
      json,
      {
        changed: `recorded discovery ${discovery.id} ("${discovery.title}") against running execution ${discovery.executionId}`,
        state: `the discovery is queued for the next plan; execution ${discovery.executionId} keeps its pinned scope`,
        tokens: {
          discovery: discovery.id,
          execution: discovery.executionId,
          ...(discovery.attemptId === null
            ? {}
            : { attempt: discovery.attemptId }),
        },
        actsNext: "agent",
        blocked: null,
        next: `cctl spec plan open ${slug.value} --seed-from last`,
        instruction: nonBlockingGuidance,
      },
      "captured",
      captured,
    );
  }
  return mutationResult(
    json,
    {
      changed: `recorded discovery ${discovery.id} ("${discovery.title}"), abandoned execution ${replacement.abandonedExecutionId}, and opened seeded replacement attempt ${replacement.replacementAttemptId}`,
      state: `execution ${replacement.abandonedExecutionId} is retired; attempt ${replacement.replacementAttemptId} carries the discovery as planned work`,
      tokens: {
        discovery: discovery.id,
        execution: replacement.abandonedExecutionId,
        attempt: replacement.replacementAttemptId,
      },
      actsNext: "agent",
      blocked: null,
      next: `cctl spec plan get ${slug.value}`,
      // The other two paths are named rather than re-offered: the run they
      // address is retired, so re-listing them as live options would send the
      // operator at an execution that no longer exists.
      instruction: `This took the second of the three post-launch paths — ${paths[1]}. The other two — ${paths[0]} and ${paths[2]} — addressed execution ${replacement.abandonedExecutionId}, which is now retired, so neither remains available for it. Do not continue the retired run's work: review attempt ${replacement.replacementAttemptId}, edit it with \`cctl spec plan edit ${slug.value} --file <plan.json>\`, then propose and sign it off to launch the replacement.`,
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

/**
 * The delivery-plan mutation receipt. Every plan write reports the same three
 * things — what it produced, what it did to the draft's proposability, and the
 * act that comes next — because the four verbs are one lifecycle and an author
 * reading a receipt is deciding what to do next, not admiring a state.
 */
function planMutationResult(
  json: boolean,
  slug: string,
  changed: string,
  view: DeliveryPlanMutationView,
  extra: { recovery?: string } = {},
): CliResult {
  const attempt = view.attempt;
  return mutationResult(
    json,
    {
      changed,
      state: `attempt ${attempt.status}, draft revision ${attempt.draftRevision}, ${attempt.pinnedRevisionId} pinned`,
      ...(view.previousHealth === null
        ? {}
        : {
            lint: {
              slug,
              blockingBefore: view.previousHealth.blocking,
              blockingAfter: view.health.blocking,
            },
          }),
      tokens: {
        planAttempt: attempt.id,
        ...(attempt.planHash === null ? {} : { planHash: attempt.planHash }),
        ...(attempt.compiledDefinitionHash === null
          ? {}
          : { compiledDefinitionHash: attempt.compiledDefinitionHash }),
      },
      actsNext: view.nextAct.actor,
      blocked:
        view.health.blocking === 0
          ? null
          : `${view.health.blocking} finding${view.health.blocking === 1 ? "" : "s"} refuse propose`,
      detail: planReceiptDetail(slug, view),
      ...(extra.recovery === undefined ? {} : { recovery: extra.recovery }),
      next: `${view.nextAct.command} — ${view.nextAct.reason}`,
    },
    "plan",
    view,
  );
}

/**
 * The lines between the position and the next act: the dispositions that still
 * owe a human act, and the approval a reopen took away. Both are things the
 * caller cannot act on without being told the id.
 */
function planReceiptDetail(
  slug: string,
  view: DeliveryPlanMutationView,
): string[] {
  const unresolved = view.unresolved.slice(0, PLAN_RECEIPT_ROWS);
  const omitted = view.unresolved.length - unresolved.length;
  return [
    ...legacyImportDetail(view.legacyImport),
    ...(view.attempt.compiledDefinitionHash === null
      ? []
      : [
          `cctl spec plan preview ${slug} --stage proposed reads the stored candidate exactly as a launch will run it`,
        ]),
    ...(view.invalidatedApproval === null
      ? []
      : [
          `the approval of snapshot ${view.invalidatedApproval.snapshotId} (${view.invalidatedApproval.planHash}) no longer stands; a re-propose needs a new one`,
        ]),
    ...prelaunchDetail(slug, view.prelaunch),
    ...(view.unresolved.length === 0
      ? []
      : [
          `unresolved dispositions: ${view.unresolved.length}`,
          ...unresolved.map((row) => `  ${row.handle}: ${row.resolution}`),
          ...(omitted > 0
            ? [`  …and ${omitted} more — cctl spec plan status ${slug}`]
            : []),
        ]),
  ];
}

/**
 * What a parked attempt is holding. The two compiled hashes are printed side
 * by side once tuning has moved the candidate, because the text receipt is the
 * inventory a CLI caller actually reads — carrying them only in the JSON view
 * would leave the re-approval unexplained on the default surface.
 */
function prelaunchDetail(
  slug: string,
  prelaunch: DeliveryPlanMutationView["prelaunch"],
): string[] {
  if (prelaunch === null) return [];
  if (!prelaunch.candidateChanged) {
    return [
      `parked for prelaunch review at compiled hash ${prelaunch.parkedCompiledDefinitionHash}`,
    ];
  }
  return [
    `parked for prelaunch review at compiled hash ${prelaunch.parkedCompiledDefinitionHash}`,
    `tuning moved the candidate to ${prelaunch.currentCompiledDefinitionHash ?? "no frozen candidate"}, so the parked approval no longer covers it`,
    `sign the new candidate off with \`cctl spec plan sign-off ${slug}\` before \`cctl spec start ${slug}\``,
  ];
}

/** How many unresolved rows a receipt names before pointing at the status verb. */
const PLAN_RECEIPT_ROWS = 5;

/**
 * What a seeded open lifted out of a legacy compiled plan. Every split entry is
 * named rather than capped: an unowned criterion already refuses propose, and a
 * receipt that hid one would send the author to a blocking finding with no
 * explanation of where it came from.
 */
function legacyImportDetail(
  legacyImport: DeliveryPlanMutationView["legacyImport"],
): string[] {
  if (legacyImport === null) return [];
  return [
    `imported the legacy plan of execution ${legacyImport.sourceExecutionId} (revision ${legacyImport.sourceRevisionId}): ${legacyImport.contextCount} context${legacyImport.contextCount === 1 ? "" : "s"}, ${legacyImport.taskCount} task${legacyImport.taskCount === 1 ? "" : "s"}`,
    ...legacyImport.notes.map((note) => `  ${note}`),
    ...(legacyImport.requiresHumanSplit.length === 0
      ? []
      : [
          `${legacyImport.requiresHumanSplit.length} criterion${legacyImport.requiresHumanSplit.length === 1 ? "" : "a"} spanned more than one context and no context owns them:`,
          ...legacyImport.requiresHumanSplit.map(
            (entry) => `  ${entry.handle}: ${entry.resolution}`,
          ),
        ]),
  ];
}

async function postPlanAction(
  host: CliHost,
  context: ProjectConversationContext,
  env: CliEnv,
  slug: string,
  action: string,
  body: unknown,
  command: string,
  json: boolean,
): Promise<CommandResult<DeliveryPlanMutationView>> {
  return requestTyped(
    host,
    context,
    env,
    {
      method: "POST",
      path: actionPath(context, slug, action),
      body,
      schema: deliveryPlanMutationViewSchema,
      command,
    },
    json,
  );
}

export async function runSpecPlanOpen(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec plan open"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "plan open", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "plan open", json);
  if (!slug.ok) return slug.result;
  const seedFrom = values["seed-from"];
  if (seedFrom !== undefined && seedFrom !== "last") {
    return usageFailure(
      `spec plan open: --seed-from takes "last" (the previous delivery), not ${JSON.stringify(seedFrom)}. Omit it to author from an empty plan.`,
      json,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;

  const response = await postPlanAction(
    host,
    resolved.context,
    env,
    slug.value,
    "plan-open",
    { seedFromLast: seedFrom === "last" },
    "plan open",
    json,
  );
  if (!response.ok) return response.result;
  const view = response.value;
  return planMutationResult(
    json,
    slug.value,
    seedFrom === "last"
      ? `opened plan attempt ${view.attempt.id}, seeded from the last delivery: every one of the ${view.document.dispositions.length} criteria on ${view.attempt.pinnedRevisionId} carries exactly one disposition`
      : `opened an empty plan attempt ${view.attempt.id} against ${view.attempt.pinnedRevisionId}`,
    view,
  );
}

export async function runSpecPlanEdit(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec plan edit"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "plan edit", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "plan edit", json);
  if (!slug.ok) return slug.result;
  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure(
      "spec plan edit requires --file <plan.json> — read the current document with `cctl spec plan get <slug> --json`, edit it, and send it back with the draftRevision you read",
      json,
    );
  }
  const raw = await host.readTextFile(filePath);
  if (raw === null) {
    return usageFailure(
      `spec plan edit: cannot read plan file ${JSON.stringify(filePath)}`,
      json,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return usageFailure(
      `spec plan edit: plan file ${JSON.stringify(filePath)} is not valid JSON`,
      json,
    );
  }
  const parsed = deliveryPlanEditRequestSchema.safeParse(decoded);
  if (!parsed.success) {
    return invalidFileResult(
      "plan edit",
      filePath,
      "plan edit",
      json,
      parsed.error,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;

  const response = await postPlanAction(
    host,
    resolved.context,
    env,
    slug.value,
    "plan-edit",
    parsed.data,
    "plan edit",
    json,
  );
  if (!response.ok) return response.result;
  return planMutationResult(
    json,
    slug.value,
    `wrote the plan document at draft revision ${parsed.data.expectedDraftRevision}`,
    response.value,
  );
}

export async function runSpecPlanPropose(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec plan propose"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "plan propose", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "plan propose", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;

  const response = await postPlanAction(
    host,
    resolved.context,
    env,
    slug.value,
    "plan-propose",
    {},
    "plan propose",
    json,
  );
  if (!response.ok) return response.result;
  const view = response.value;
  // One act freezes both: the snapshot an approval is granted against and the
  // compiled candidate that approval binds to. Naming the compiled hash here
  // is what lets a reader check that a launch ran the bytes they approved.
  return planMutationResult(
    json,
    slug.value,
    `froze plan snapshot ${view.attempt.proposedSnapshotId ?? "(none)"} at ${view.attempt.planHash ?? "(no hash)"} and compiled candidate ${view.attempt.compiledDefinitionHash ?? "(no hash)"}`,
    view,
    {
      recovery: `cctl spec plan reopen ${slug.value} --reason <why> — returns the attempt to draft and invalidates any approval of this snapshot`,
    },
  );
}

export async function runSpecPlanReopen(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec plan reopen"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "plan reopen", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "plan reopen", json);
  if (!slug.ok) return slug.result;
  const reason = values["reason"];
  if (reason === undefined) {
    return usageFailure(
      "spec plan reopen requires --reason <why> — the reason lands in the durable audit row beside the approval it invalidates",
      json,
    );
  }
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;

  const response = await postPlanAction(
    host,
    resolved.context,
    env,
    slug.value,
    "plan-reopen",
    { reason },
    "plan reopen",
    json,
  );
  if (!response.ok) return response.result;
  const view = response.value;
  return planMutationResult(
    json,
    slug.value,
    `returned plan attempt ${view.attempt.id} to draft at revision ${view.attempt.draftRevision}`,
    view,
  );
}

/**
 * The one default approval. It names the candidate identity rather than "the
 * current proposal" so a re-propose landing between the read and the sign-off
 * refuses instead of quietly approving different bytes (`exact-approval`); the
 * three ids come straight off `spec plan preview --stage proposed`.
 */
export async function runSpecPlanSignOff(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("spec plan sign-off"), json);
  if (denied) return denied;
  const extra = noExtraPositionals(rest, 1, "plan sign-off", json);
  if (extra) return extra;
  const slug = validateSlug(rest[0], "plan sign-off", json);
  if (!slug.ok) return slug.result;
  const resolved = await resolveProjectConversationContext(flags, env, host);
  if (!resolved.ok) return resolved.result;

  // Resolve the candidate from the stored proposal, then state it back on the
  // write. The caller may pin it explicitly; omitting the flags is the common
  // case and still binds, because the read and the write are one command.
  const stated = {
    candidateId: values["candidate"],
    planHash: values["plan-hash"],
    compiledDefinitionHash: values["compiled-hash"],
  };
  let candidate: {
    candidateId: string;
    planHash: string;
    compiledDefinitionHash: string;
  };
  if (
    stated.candidateId !== undefined &&
    stated.planHash !== undefined &&
    stated.compiledDefinitionHash !== undefined
  ) {
    candidate = {
      candidateId: stated.candidateId,
      planHash: stated.planHash,
      compiledDefinitionHash: stated.compiledDefinitionHash,
    };
  } else if (
    stated.candidateId !== undefined ||
    stated.planHash !== undefined ||
    stated.compiledDefinitionHash !== undefined
  ) {
    return usageFailure(
      "spec plan sign-off takes all three of --candidate, --plan-hash, and --compiled-hash together, or none of them: a partial identity would bind an approval to bytes nobody named. Run `cctl spec plan preview <slug> --stage proposed` to read all three.",
      json,
    );
  } else {
    const preview = await requestTyped(
      host,
      resolved.context,
      env,
      {
        method: "GET",
        path: `${specBasePath(resolved.context, slug.value)}/plan-preview?stage=proposed`,
        schema: deliveryPlanPreviewViewSchema,
        command: "plan sign-off",
      },
      json,
    );
    if (!preview.ok) return preview.result;
    const candidateId = preview.value.candidateId;
    if (candidateId === null) {
      return usageFailure(
        `spec plan sign-off: ${slug.value} has frozen no candidate. Run \`cctl spec plan propose ${slug.value}\` first.`,
        json,
      );
    }
    candidate = {
      candidateId,
      planHash: preview.value.planHash,
      compiledDefinitionHash: preview.value.compiledDefinitionHash,
    };
  }

  const response = await postPlanAction(
    host,
    resolved.context,
    env,
    slug.value,
    "plan-sign-off",
    candidate,
    "plan sign-off",
    json,
  );
  if (!response.ok) return response.result;
  const view = response.value;
  const admission = view.executionStartAdmission;
  return planMutationResult(
    json,
    slug.value,
    admission === null || admission.basis === "human_approval"
      ? `signed off candidate ${candidate.candidateId} (compiled ${candidate.compiledDefinitionHash}) and admitted the execution_start gate`
      : `signed off candidate ${candidate.candidateId} (compiled ${candidate.compiledDefinitionHash}); the execution_start dial is ${admission.dial}, so admission ${admission.admissionId} was recorded on a ${admission.basis} basis`,
    view,
    {
      recovery: `cctl spec plan reopen ${slug.value} --reason <why> — returns the attempt to draft and invalidates this approval`,
    },
  );
}
