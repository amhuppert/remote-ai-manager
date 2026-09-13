/**
 * How the CLI reads a checkpoint receipt and a checkpoint refusal back to an
 * agent (R8.3, R8.9, R8.10).
 *
 * Three rules shape everything here. Facts come first: an operation's phase,
 * the uncertainty blocking it and what a bounded view left out are primary
 * output, so a caller who ignores every hint still knows the state. Remedies
 * are registered commands built by code, never a coordinate an agent retypes.
 * And a refusal that enforces a deliberate constraint says WHY once, at the
 * refusal — the rationale table below is exactly that set, and successful
 * output never repeats it.
 *
 * The receipt shape is the server's own canonical projection, so nothing here
 * can widen it: the seed text and the provider references are not fields this
 * module could render even by mistake.
 */

import { z } from "zod";

import { checkpointRefusalSchema } from "@/lib/conversation-checkpoints/admission";
import {
  checkpointReceiptSchema,
  type CheckpointReceipt,
} from "@/lib/conversation-checkpoints/receipt";
import type { CheckpointPhase } from "@/lib/conversation-checkpoints/schemas";

import {
  boundedFailure,
  boundedItems,
  omissionSummary,
  pagedOmission,
  recoveryLines,
  type Omission,
  type RecoveryFacts,
} from "../../disclosure";
import {
  BUILD_SKEW_CODE,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  failureFromRequest,
  structuredErrorFields,
  type CliHost,
  type CliRequestResult,
  type CliResult,
} from "../../shared";

export { checkpointReceiptSchema };
export type { CheckpointReceipt };

/** Phases `--wait` stops on, and how each one exits (R8.9). */
export const WAIT_SUCCESS_PHASES: readonly CheckpointPhase[] = [
  "ready",
  "applied",
];
export const WAIT_FAILURE_PHASES: readonly CheckpointPhase[] = [
  "failed",
  "cancelled",
  "needs_reconciliation",
];

export function isWaitTerminalPhase(phase: CheckpointPhase): boolean {
  return (
    WAIT_SUCCESS_PHASES.includes(phase) || WAIT_FAILURE_PHASES.includes(phase)
  );
}

/**
 * How many seed omission categories one receipt names before pointing at the
 * saved payload, which carries the array in full.
 */
const MAX_RENDERED_OMISSIONS = 8;

// ---------------------------------------------------------------------------
// Commands the CLI hands back
// ---------------------------------------------------------------------------

export function checkpointGetCommand(
  conversationId: string,
  operationId: string,
  suffix = "",
): string {
  return `cctl conversation checkpoint get ${conversationId} ${operationId}${suffix}`;
}

export function checkpointListCommand(conversationId: string): string {
  return `cctl conversation checkpoint list ${conversationId}`;
}

export function checkpointCheckCommand(conversationId: string): string {
  return `cctl conversation checkpoint check ${conversationId}`;
}

/**
 * A mutation's explicit scope flags, appended only when the caller supplied
 * them. Every command below that WRITES takes this: a read may resolve another
 * project's conversation by id, and the mutation it then recommends would be
 * refused in the ambient scope — or, worse, would address the caller's own
 * conversation instead.
 */
function scopeSuffix(scope: string | undefined): string {
  return scope === undefined || scope.trim() === "" ? "" : ` ${scope}`;
}

export function checkpointReconcileCommand(
  conversationId: string,
  operationId: string,
  scope?: string,
): string {
  return `cctl conversation checkpoint reconcile ${conversationId} ${operationId}${scopeSuffix(scope)}`;
}

export function checkpointRecoverCommand(
  conversationId: string,
  operationId: string,
  scope?: string,
): string {
  return `cctl conversation compact-context ${conversationId} --recover ${operationId}${scopeSuffix(scope)}`;
}

/** Start a fresh checkpoint on one NAMED conversation, in its own scope. */
export function checkpointStartCommand(
  conversationId: string,
  scope?: string,
): string {
  return `cctl conversation compact-context ${conversationId}${scopeSuffix(scope)}`;
}

// ---------------------------------------------------------------------------
// Receipt rendering
// ---------------------------------------------------------------------------

function number(value: number | null): string {
  return value === null ? "unavailable" : String(value);
}

/** One receipt as a list row: identity, phase, and the seed size if frozen. */
export function receiptSummaryLine(receipt: CheckpointReceipt): string {
  const seed =
    receipt.checkpoint === null
      ? "no seed"
      : `seed ${receipt.checkpoint.sectionBytes.total}B`;
  const accepted = receipt.hasAcceptedContinuation ? " accepted" : "";
  return `${receipt.operationId}\tordinal ${receipt.ordinal}\tphase=${receipt.phase}\t${seed}${accepted}\trequested ${receipt.requestedAt}`;
}

export interface ReceiptDetail {
  lines: string[];
  /**
   * What the RENDERED omission rows left out. Text is the only serialization
   * this caps, so this is the accounting the text body states.
   */
  textOmission: Omission;
  /**
   * What the JSON envelope leaves out. The envelope carries the receipt's own
   * `omissions` array whole, so this is never truncated — reporting the text
   * cap here would claim a JSON reader was missing rows it already has.
   */
  jsonOmission: Omission;
}

export interface ReceiptDetailOptions {
  /**
   * Render every omission row instead of the bounded index. Set by the
   * explicit `--detail seed` disclosure, which is exactly what the bounded
   * index's reveal command names — a cap whose reveal re-applies the same cap
   * discloses nothing.
   */
  readonly revealOmissions?: boolean;
}

/**
 * The receipt in full, minus nothing the projection carries. Usage counters a
 * backend does not report render as `unavailable` rather than `0`: a checkpoint
 * that cost nothing and a checkpoint whose cost nobody measured are different
 * claims.
 */
export function receiptDetailLines(
  receipt: CheckpointReceipt,
  options: ReceiptDetailOptions = {},
): ReceiptDetail {
  const lines = [
    `checkpoint ${receipt.operationId}\tordinal ${receipt.ordinal}\tphase=${receipt.phase}`,
    `conversation ${receipt.conversationId}\tscope=${receipt.scope}\tmechanism=${receipt.mechanism}`,
    `boundary: capturedThroughSeq=${receipt.boundary.capturedThroughSeq} sourceHash=${receipt.boundary.sourceHash}`,
  ];
  if (receipt.forkOrigin) {
    const origin = receipt.forkOrigin;
    lines.push(
      `fork source: ${origin.source.conversationId} checkpoint ${origin.sourceOperationId} ordinal ${origin.ordinal}`,
      `related work: ${JSON.stringify(origin.relatedWork)}`,
      `fork framing: ${receipt.forkFramingBytes ?? "unavailable"} bytes in addition to the unchanged saved seed`,
      `source checkpoint: cctl conversation checkpoint get ${origin.source.conversationId} ${origin.sourceOperationId}`,
      `original evidence: cctl conversation read ${origin.evidenceSource.conversationId} --outline`,
    );
  }
  if (receipt.lastStablePhase !== null) {
    lines.push(`last stable phase: ${receipt.lastStablePhase}`);
  }

  const omissions = receipt.checkpoint?.omissions ?? [];
  const bounded = boundedItems(
    omissions,
    options.revealOmissions === true
      ? Math.max(omissions.length, 1)
      : MAX_RENDERED_OMISSIONS,
    checkpointGetCommand(
      receipt.conversationId,
      receipt.operationId,
      " --detail seed",
    ),
  );
  const jsonOmission = pagedOmission({
    total: omissions.length,
    returned: omissions.length,
    reveal: null,
  });
  if (receipt.checkpoint === null) {
    lines.push("seed: not frozen");
  } else {
    const bytes = receipt.checkpoint.sectionBytes;
    lines.push(
      `seed: ${bytes.total} bytes (working-state ${bytes.workingState}, recent-dialogue ${bytes.recentDialogue}, recovery-framing ${bytes.recoveryFraming}) sha256=${receipt.checkpoint.seedSha256}`,
      `seed versions: generator=${receipt.checkpoint.versions.generatorVersion} builder=${receipt.checkpoint.versions.builderVersion} normalizer=${receipt.checkpoint.versions.normalizerVersion}`,
      `seed omissions: ${omissionSummary(bounded.omission)}`,
      ...bounded.items.map(
        (entry) => `  ${entry.category}: ${entry.detail || "(no detail)"}`,
      ),
    );
    if (receipt.checkpoint.artifactProvenance !== null) {
      lines.push(
        `reused reading artifact: ${receipt.checkpoint.artifactProvenance.artifactId}`,
      );
    }
  }

  const usage = receipt.compactionUsage;
  lines.push(
    `compaction passes: ${number(receipt.generationPassCount)}`,
    `compaction usage: input=${number(usage.inputTokens)} cached=${number(usage.cachedInputTokens)} output=${number(usage.outputTokens)} costUsd=${usage.costUsd === null ? "unavailable" : usage.costUsd} durationMs=${number(usage.durationMs)}`,
    `seed token estimate: ${receipt.seedTokenEstimate === null ? "unavailable" : `${receipt.seedTokenEstimate.tokens} (${receipt.seedTokenEstimate.estimator})`}`,
    `context occupancy: ${receipt.contextOccupancy === null ? "unavailable" : `${receipt.contextOccupancy.usedTokens}/${receipt.contextOccupancy.maxTokens} reported by ${receipt.contextOccupancy.reportedBy}`}`,
  );

  if (receipt.delivery !== null) {
    const queued =
      receipt.delivery.queuedMessageId === null
        ? ""
        : ` (queued attempt ${receipt.delivery.queuedAttemptId ?? "-"} message ${receipt.delivery.queuedMessageId})`;
    lines.push(`delivery: attempt ${receipt.delivery.attemptId}${queued}`);
  }
  // Three states, not two. An operation with a delivery binding and no
  // acceptance was ATTEMPTED: whether the provider received that input is
  // exactly what needs_reconciliation exists to say is unknown, and calling it
  // "not delivered" is the claim that would authorize an unsafe replay.
  lines.push(
    receipt.acceptance !== null
      ? `acceptance: attempt ${receipt.acceptance.attemptId} at ${receipt.acceptance.acceptedAt} (seed ${receipt.acceptance.seedHash})`
      : receipt.delivery === null
        ? "acceptance: none — the seed has not been delivered to a turn yet"
        : `acceptance: unconfirmed — the seed is bound to attempt ${receipt.delivery.attemptId} and no acceptance was recorded; whether that input reached the provider is unresolved`,
    `accepted continuation: ${receipt.hasAcceptedContinuation ? "yes" : "no"}`,
  );
  if (receipt.recoversOperationId !== null) {
    lines.push(`recovers operation: ${receipt.recoversOperationId}`);
  }
  if (receipt.supersededByOperationId !== null) {
    lines.push(`superseded by operation: ${receipt.supersededByOperationId}`);
  }
  if (receipt.failure !== null) {
    lines.push(`failure: ${receipt.failure.code} — ${receipt.failure.message}`);
  }
  lines.push(`requested ${receipt.requestedAt}\tupdated ${receipt.updatedAt}`);

  return { lines, textOmission: bounded.omission, jsonOmission };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type CheckpointRefusalFacts = z.infer<typeof checkpointRefusalSchema>;

const refusalDetailsSchema = z.object({ refusal: checkpointRefusalSchema });

/**
 * The typed refusal the server attached, when it attached one. A pre-admission
 * refusal (an unknown conversation, a malformed request) carries none, and this
 * returning null is what keeps the CLI from inventing an operation or a phase
 * for it.
 */
export function checkpointRefusalOf(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
): CheckpointRefusalFacts | null {
  if (result.kind !== "error" || result.details === undefined) return null;
  const parsed = refusalDetailsSchema.safeParse(result.details);
  return parsed.success ? parsed.data.refusal : null;
}

/**
 * The correlations recovery turns on: which attempt carried the seed, which
 * queued entry it came from, and whether an acceptance was ever recorded.
 *
 * Three acceptance states, not two. An operation with a delivery binding and
 * no acceptance was ATTEMPTED — calling that "not delivered" is the claim that
 * would authorize an unsafe replay, so the projection names it `unconfirmed`.
 */
export function deliveryCorrelation(
  receipt: CheckpointReceipt | null,
): RecoveryFacts {
  if (receipt === null) return {};
  return {
    ...(receipt.delivery === null
      ? {}
      : {
          deliveryAttemptId: receipt.delivery.attemptId,
          ...(receipt.delivery.queuedAttemptId === null
            ? {}
            : { queuedAttemptId: receipt.delivery.queuedAttemptId }),
          ...(receipt.delivery.queuedMessageId === null
            ? {}
            : { queuedMessageId: receipt.delivery.queuedMessageId }),
        }),
    acceptance:
      receipt.acceptance !== null
        ? "accepted"
        : receipt.delivery === null
          ? "not_delivered"
          : "unconfirmed",
    ...(receipt.acceptance === null
      ? {}
      : { acceptedAttemptId: receipt.acceptance.attemptId }),
  };
}

/** The receipt a blocked repair answered with, when it answered with one. */
export function refusalReceiptOf(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
): CheckpointReceipt | null {
  if (result.kind !== "error" || result.details === undefined) return null;
  const parsed = z
    .object({ receipt: checkpointReceiptSchema })
    .safeParse(result.details);
  return parsed.success ? parsed.data.receipt : null;
}

/**
 * The refusals that enforce a DELIBERATE constraint, and the one sentence each
 * one owes the caller. Everything absent from this table is a state, not a
 * policy — "a turn is running" explains itself, and adding prose to it would
 * bury the refusals that genuinely need a reason.
 */
const REFUSAL_RATIONALE: Readonly<Partial<Record<string, string>>> = {
  queue_review_required:
    "a queued delivery may or may not have reached the provider, and CC never replays uncertain input automatically",
  recovery_required:
    "an operation whose outcome is unresolved is superseded explicitly, never continued in place",
  recovery_target_mismatch:
    "recovery addresses one named operation, so a mismatched id is refused rather than applied to whichever operation is active",
  conversation_owned:
    "a workflow or collaboration owns this conversation's turns, and a checkpoint would retire context it is mid-way through using",
  not_cancellable:
    "the operation already retired the conversation's context, and cancelling cannot restore a provider session",
};

export function checkpointRefusalRationale(code: string): string | undefined {
  return REFUSAL_RATIONALE[code];
}

export interface RemedyContext {
  conversationId: string;
  /** Explicit scope flags a mutation needs, when the caller must supply them. */
  mutationScope?: string;
}

/**
 * The next command for one refusal code, built from the refusal's own
 * identifiers. Every command named here is a registered leaf, so a remedy
 * cannot point at a verb the binary does not have.
 */
export function checkpointRefusalRemedy(
  refusal: CheckpointRefusalFacts,
  context: RemedyContext,
): string {
  const id = context.conversationId;
  const operationId = refusal.operationId;
  const scope = context.mutationScope ?? "";
  switch (refusal.code) {
    case "conversation_transient":
      return "checkpoint a persisted conversation; a transient one has no durable continuity to retire";
    case "conversation_archived":
      return (
        "unarchive the conversation in Command Center, then re-check: " +
        checkpointCheckCommand(id)
      );
    case "conversation_owned":
      return "act through the owning workflow or collaboration; CC offers no override here";
    case "backend_unsupported":
      return "this conversation's agent backend declares no checkpoint capability — use `cctl conversation compact` for a reading artifact instead";
    case "no_recorded_history":
      return "send at least one turn first; there is no recorded history to build a seed from";
    case "debug_mode":
      return `leave debug mode, then re-check: ${checkpointCheckCommand(id)}`;
    case "question_pending":
      return `answer the pending question, then re-check: ${checkpointCheckCommand(id)}`;
    case "turn_active":
    case "background_work":
    case "conversation_busy":
      return `wait for the conversation to settle, then re-check: ${checkpointCheckCommand(id)}`;
    case "checkpoint_pending":
      return operationId === null
        ? `read the operation holding the slot: ${checkpointListCommand(id)}`
        : `read the operation holding the slot: ${checkpointGetCommand(id, operationId)}`;
    case "recovery_required":
      return operationId === null
        ? `find the operation needing recovery: ${checkpointListCommand(id)}`
        : `supersede it explicitly: ${checkpointRecoverCommand(id, operationId, scope)}`;
    case "recovery_target_mismatch":
      return `--recover must name the operation that requires recovery; list them with: ${checkpointListCommand(id)}`;
    case "queue_review_required":
      return operationId === null
        ? "resolve the uncertain queued messages (retry or discard each one) in Command Center, then re-check: " +
            checkpointCheckCommand(id)
        : `resolve the uncertain queued messages (retry or discard each one) in Command Center, then supersede: ${checkpointRecoverCommand(id, operationId, scope)}`;
    case "reconciliation_failed":
      return operationId === null
        ? `re-read the operation: ${checkpointListCommand(id)}`
        : `retry the deterministic repair: ${checkpointReconcileCommand(id, operationId, scope)}`;
    case "not_cancellable":
    case "not_owned":
    case "illegal_transition":
    case "stale_operation":
      return operationId === null
        ? `re-read the conversation's operations: ${checkpointListCommand(id)}`
        : `re-read the operation's actual phase: ${checkpointGetCommand(id, operationId)}`;
    case "checkpoint_not_found":
      return `list this conversation's operations: ${checkpointListCommand(id)}`;
    case "request_id_conflict":
      return "that request id belongs to another conversation; run compact-context again to mint a fresh one";
    case "conversation_not_found":
    case "target_conversation_missing":
      return "check the conversation id, and pass --project/--session when it lives in another scope";
    default:
      return `re-read the conversation's checkpoint state: ${checkpointListCommand(id)}`;
  }
}

/**
 * Translate a refused checkpoint request into the CLI's outcome classes.
 *
 * Connection, auth and both forms of build skew keep the classes the transport
 * already assigned them. A 400 is the caller's own malformed request (exit 2),
 * as is a conversation this scope does not have. Everything else is a real
 * server "no" about a real conversation — a lifecycle or backend blocker — and
 * exits 1, which is why this cannot delegate to `failureFromRequest`: that maps
 * 422 to usage, and `backend_unsupported` is not a usage mistake.
 *
 * The rendering goes through the shared byte budget like every other output:
 * the error string, the refusal reason and a blocked repair's receipt are all
 * server-sized, and a failure is not the one path allowed to flood a pipe.
 */
export async function checkpointRefusalFailure(
  host: CliHost,
  input: {
    result: Exclude<CliRequestResult, { kind: "ok" }>;
    json: boolean;
    conversationId: string;
    command: string;
    mutationScope?: string;
    /** Extra fact lines printed before the remedy, e.g. a blocked repair's receipt. */
    detailLines?: string[];
    /**
     * A remedy that runs in a DIFFERENT scope than the one addressed. Passed
     * structurally rather than as a detail line because a JSON caller never
     * reads stderr, and a remedy it cannot see is a remedy it cannot follow.
     */
    scopedRemedy?: { readonly reason: string; readonly command: string };
  },
): Promise<CliResult> {
  const { result, json } = input;
  // Connection, auth, header-skew AND the server's own pre-execution
  // `build_skew` refusal keep the transport's classes. The skew refusal arrives
  // as an ordinary 409 body, so recognizing it by code is the only way exit 4
  // survives: it is the one refusal that means the handler never ran.
  if (result.kind !== "error" || result.code === BUILD_SKEW_CODE) {
    return failureFromRequest(result, json);
  }

  const refusal = checkpointRefusalOf(result);
  // One value, two renderings: the human sentence a text caller reads and the
  // exact command a JSON caller runs. Built here so they cannot name different
  // commands.
  const scopedLine =
    input.scopedRemedy === undefined
      ? []
      : [
          `${input.scopedRemedy.reason} — re-run with: ${input.scopedRemedy.command}`,
        ];
  const scopedFact: RecoveryFacts =
    input.scopedRemedy === undefined
      ? {}
      : { scopedRemedy: input.scopedRemedy.command };

  const unknownConversation =
    result.status === 404 &&
    refusal === null &&
    result.code !== "checkpoint_not_found";
  if (result.status === 400 || unknownConversation) {
    const usageDetail = [...(input.detailLines ?? []), ...scopedLine];
    return boundedFailure(host, {
      command: input.command,
      namePrefix: `checkpoint-refusal-${input.conversationId}`,
      retain: {
        ...(result.code === undefined ? {} : { code: result.code }),
        ...scopedFact,
      },
      failure: {
        exitCode: EXIT_USAGE,
        message: result.error,
        ...(usageDetail.length > 0 ? { detail: usageDetail.join("\n") } : {}),
        ...structuredErrorFields(result),
        json,
      },
    });
  }

  // Phase, operation AND code come from the refusal alone. A pre-admission
  // refusal has none of them, and printing a placeholder would be an invented
  // fact. The code is stated in the text body rather than only in the JSON
  // envelope: it is the stable identifier a remedy is chosen by, and a text
  // caller that never sees it cannot act on the refusal it was given.
  //
  // This ONE projection produces the text lines and the JSON `details`, and it
  // is what a spill keeps after the body moves to a file.
  const identity: RecoveryFacts = {
    ...(refusal === null
      ? {}
      : {
          code: refusal.code,
          operation:
            refusal.operationId ?? "none — refused before an operation existed",
          phase: refusal.phase ?? "none",
        }),
    // A blocked repair answers with the receipt whose delivery correlations
    // decide whether the seed may be replayed at all.
    ...deliveryCorrelation(refusalReceiptOf(result)),
  };
  const projection: RecoveryFacts = { ...identity, ...scopedFact };
  // The scoped remedy is not repeated here: its own sentence follows below,
  // and a spill re-renders the whole projection anyway.
  const facts = recoveryLines(identity);
  const remedy = refusal
    ? checkpointRefusalRemedy(refusal, {
        conversationId: input.conversationId,
        ...(input.mutationScope === undefined
          ? {}
          : { mutationScope: input.mutationScope }),
      })
    : undefined;
  const rationale = refusal
    ? checkpointRefusalRationale(refusal.code)
    : undefined;
  const detail = [...facts, ...(input.detailLines ?? []), ...scopedLine];

  return boundedFailure(host, {
    command: input.command,
    namePrefix: `checkpoint-refusal-${input.conversationId}`,
    retain: {
      ...(result.code === undefined ? {} : { code: result.code }),
      ...projection,
    },
    failure: {
      exitCode: EXIT_OPERATION_FAILED,
      message: result.error,
      ...(detail.length > 0 ? { detail: detail.join("\n") } : {}),
      ...structuredErrorFields(result),
      ...(rationale ? { rationale } : {}),
      ...(remedy ? { hint: remedy } : {}),
      json,
    },
  });
}
