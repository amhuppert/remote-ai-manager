/**
 * `cctl conversation compact-context` and `cctl conversation checkpoint …` —
 * the CLI half of the checkpoint lifecycle (design §8; R8.2, R8.6, R8.7, R8.9,
 * R8.10).
 *
 * Two rules separate these leaves from the rest of the conversation group.
 *
 * SCOPE. `compact-context`, `checkpoint cancel` and `checkpoint reconcile` are
 * mutations, so they never go through `withScopeResolution`: a mutation that
 * discovered a different owning scope and retried there would write to a
 * conversation the caller did not address. A wrong-scope mutation is refused,
 * and `ownerScopeAdvice` turns that refusal into the explicit-scope command the
 * caller can run deliberately. The reads (`check`, `list`, `get`) keep the
 * group's id-only resolution.
 *
 * OWNERSHIP OF WORK. `--wait` observes a durable server-side operation; it does
 * not drive one. A client timeout or disconnect leaves the operation running and
 * prints the command that reads it, and nothing here cancels an operation
 * because its watcher went away.
 */

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { checkpointRefusalSchema } from "@/lib/conversation-checkpoints/admission";
import { MAX_CHECKPOINT_LIST_LIMIT } from "@/lib/conversation-checkpoints/repo";
import { dispatchGroup } from "../../dispatch";
import {
  boundedFailure,
  omissionSummary,
  pagedOmission,
  renderBounded,
  type Omission,
  type RecoveryFacts,
} from "../../disclosure";
import { awaitJob } from "../../job-wait";
import {
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type FailureInput,
  type GlobalFlags,
} from "../../shared";
import {
  conversationBasePath,
  isWrongScope404,
  ownerScopeAdvice,
  resolveConversationCommandTarget,
  scopeFlags,
  scopeMiss,
  withScopeResolution,
  type ConversationCommandTarget,
  type ScopeMiss,
} from "./target";
import {
  checkpointGetCommand,
  checkpointListCommand,
  checkpointReconcileCommand,
  checkpointRecoverCommand,
  checkpointRefusalFailure,
  checkpointRefusalRationale,
  checkpointRefusalRemedy,
  checkpointReceiptSchema,
  checkpointStartCommand,
  deliveryCorrelation,
  isWaitTerminalPhase,
  receiptDetailLines,
  receiptSummaryLine,
  refusalReceiptOf,
  WAIT_SUCCESS_PHASES,
  type CheckpointReceipt,
} from "./checkpoint-feedback";

import { runCheckpointFork } from "./checkpoint-fork";

const INTEGER_PATTERN = /^\d+$/;

/**
 * Client budget for `--wait`. It bounds the WATCHER only: a checkpoint that
 * outruns it keeps building, and the timeout names the command that reads it.
 */
const WAIT_BUDGET_MS = 900_000;
const WAIT_POLL_INTERVAL_MS = 2_000;

const startResponseSchema = z.object({
  outcome: z.enum(["admitted", "reused"]),
  receipt: checkpointReceiptSchema,
  statusUrl: z.string().min(1),
});

const receiptResponseSchema = z.object({ receipt: checkpointReceiptSchema });
const seedResponseSchema = z.object({
  receipt: checkpointReceiptSchema,
  seed: z
    .object({
      seedText: z.string(),
      seedSha256: z.string(),
      schemaVersion: z.number().int(),
      createdAt: z.string(),
    })
    .nullable(),
});
const listResponseSchema = z.object({
  receipts: z.array(checkpointReceiptSchema),
  nextBefore: z.number().int().nullable(),
});
const eligibilityResponseSchema = z.object({
  eligible: z.boolean(),
  refusals: z.array(checkpointRefusalSchema),
  active: checkpointReceiptSchema.nullable(),
  hosted: z.boolean(),
});

function checkpointsPath(target: ConversationCommandTarget): string {
  return `${conversationBasePath(target)}/checkpoints`;
}

function operationPath(
  target: ConversationCommandTarget,
  operationId: string,
): string {
  return `${checkpointsPath(target)}/${encodePathSegment(operationId)}`;
}

function requestParams(target: ConversationCommandTarget) {
  return {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
  };
}

function invalidResponse(what: string, json: boolean): CliResult {
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message: `unexpected ${what} response from the server`,
    json,
  });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface OperationArguments {
  conversationId: string;
  operationId: string;
}

/**
 * `<conversation-id> <operation-id>`, both required. The two ids are the same
 * shape, so an omitted one cannot be inferred from position — demanding both is
 * what keeps `cancel <operation-id>` from cancelling nothing and reporting a
 * conversation that was never addressed.
 */
function takeOperationArguments(
  rest: string[],
  command: string,
  json: boolean,
): { ok: true; value: OperationArguments } | { ok: false; result: CliResult } {
  const [conversationId, operationId, ...extra] = rest;
  if (
    conversationId === undefined ||
    operationId === undefined ||
    extra.length > 0
  ) {
    return {
      ok: false,
      result: usageFailure(
        `${command} takes <conversation-id> <operation-id>`,
        json,
      ),
    };
  }
  return { ok: true, value: { conversationId, operationId } };
}

function takeOptionalId(
  rest: string[],
  command: string,
  json: boolean,
): { ok: true; id: string | undefined } | { ok: false; result: CliResult } {
  if (rest.length > 1) {
    return {
      ok: false,
      result: usageFailure(
        `${command} takes a single <conversation-id> argument`,
        json,
      ),
    };
  }
  return { ok: true, id: rest[0] };
}

/** `--recover <operation-id>`; an empty value is a local usage failure. */
function recoverFlag(
  values: Record<string, string>,
  json: boolean,
): { ok: true; value: string | null } | { ok: false; result: CliResult } {
  const raw = values["recover"];
  if (raw === undefined) return { ok: true, value: null };
  if (raw.trim() === "") {
    return {
      ok: false,
      result: usageFailure(
        "--recover must name the operation id being superseded",
        json,
      ),
    };
  }
  return { ok: true, value: raw };
}

/**
 * A positive integer flag, optionally capped. The cap is checked LOCALLY
 * because the documented range is part of the command's own contract: sending
 * `--limit 500` to learn it is refused spends a request on a mistake the
 * parser already knows about (R8.9).
 */
function positiveIntegerFlag(
  values: Record<string, string>,
  name: string,
  json: boolean,
  max?: number,
): { ok: true; value: number | null } | { ok: false; result: CliResult } {
  const raw = values[name];
  if (raw === undefined) return { ok: true, value: null };
  if (!INTEGER_PATTERN.test(raw) || Number(raw) < 1) {
    return {
      ok: false,
      result: usageFailure(`--${name} must be a positive integer`, json),
    };
  }
  const value = Number(raw);
  if (max !== undefined && value > max) {
    return {
      ok: false,
      result: usageFailure(`--${name} must be between 1 and ${max}`, json),
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Group dispatch
// ---------------------------------------------------------------------------

export async function runConversationCheckpoint(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["conversation", "checkpoint"],
    rest,
    json: flags.json,
    noun: "verb",
    handlers: {
      fork: (r) => runCheckpointFork(r, flags, values, env, host, "fork"),
      "fork-check": (r) =>
        runCheckpointFork(r, flags, values, env, host, "fork-check"),
      check: (r) => runCheckpointCheck(r, flags, values, env, host),
      list: (r) => runCheckpointList(r, flags, values, env, host),
      get: (r) => runCheckpointGet(r, flags, values, env, host),
      cancel: (r) =>
        runCheckpointLifecycle(r, flags, values, env, host, "cancel"),
      reconcile: (r) =>
        runCheckpointLifecycle(r, flags, values, env, host, "reconcile"),
    },
  });
}

// ---------------------------------------------------------------------------
// compact-context
// ---------------------------------------------------------------------------

export async function runConversationCompactContext(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation compact-context", json);
  if (denied) return denied;

  const positional = takeOptionalId(rest, "conversation compact-context", json);
  if (!positional.ok) return positional.result;
  const recover = recoverFlag(values, json);
  if (!recover.ok) return recover.result;

  const resolved = await resolveConversationCommandTarget(
    positional.id,
    flags,
    env,
    host,
  );
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;

  // ONE request UUID for this invocation, minted before any request is built.
  // It is the operation's identity and its idempotency key: a value recomputed
  // per attempt would open a second operation instead of rejoining this one.
  const requestId = randomUUID();

  const result = await cliRequest(host, {
    ...requestParams(target),
    method: "POST",
    path: checkpointsPath(target),
    body: {
      requestId,
      ...(recover.value === null ? {} : { recoversOperationId: recover.value }),
    },
  });

  if (result.kind !== "ok") {
    // A mutation never re-scopes. It may still say where the conversation
    // lives, because the lookup behind that sentence is a read and the command
    // it prints is one the caller runs deliberately.
    const advice = isWrongScope404(result)
      ? await ownerScopeAdvice(host, target, flags)
      : null;
    return checkpointRefusalFailure(host, {
      result,
      json,
      command: "conversation compact-context",
      conversationId: target.target.conversationId,
      mutationScope: scopeFlags(target.target),
      ...(advice === null
        ? {}
        : {
            scopedRemedy: {
              reason: "this conversation lives elsewhere",
              // The remedy must be the action that was ASKED for. Dropping
              // `--recover` here would send the caller into the recovery gate
              // instead of performing the recovery they requested.
              command:
                recover.value === null
                  ? checkpointStartCommand(target.target.conversationId, advice)
                  : checkpointRecoverCommand(
                      target.target.conversationId,
                      recover.value,
                      advice,
                    ),
            },
          }),
    });
  }

  const parsed = startResponseSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponse("checkpoint start", json);
  const started = parsed.data;

  if (values["wait"] === undefined) {
    return admissionResult(host, target, started, requestId, json);
  }
  return waitForCheckpoint(host, target, started, requestId, json);
}

/**
 * Durable admission WITHOUT `--wait`. It reports the phase the operation
 * actually holds — `building` for a fresh one — and never says ready: a caller
 * that reads "started" as "the next message will be checkpointed" would send
 * that message into a context the operation has not retired yet.
 */
async function admissionResult(
  host: CliHost,
  target: ConversationCommandTarget,
  started: z.infer<typeof startResponseSchema>,
  requestId: string,
  json: boolean,
): Promise<CliResult> {
  const receipt = started.receipt;
  const conversationId = target.target.conversationId;
  return renderBounded(host, {
    command: "conversation compact-context",
    json,
    humanBody: `checkpoint ${started.outcome}: ${receipt.operationId} ordinal ${receipt.ordinal} phase=${receipt.phase}\n`,
    namePrefix: `checkpoint-admission-${receipt.operationId}`,
    envelope: {
      ok: true,
      outcome: started.outcome,
      requestId,
      receipt,
      hint: `follow it with: ${checkpointGetCommand(conversationId, receipt.operationId, ` ${scopeFlags(target.target)}`)}`,
    },
  });
}

/**
 * Observe the durable operation to `ready`/`applied` or a terminal failure.
 *
 * Exit 0 covers exactly the two states in which the checkpoint did its job;
 * everything else — failed, cancelled, needs_reconciliation, and the client's
 * own budget running out — exits 1 while keeping the operation's identity and
 * its last observed phase in the output.
 */
async function waitForCheckpoint(
  host: CliHost,
  target: ConversationCommandTarget,
  started: z.infer<typeof startResponseSchema>,
  requestId: string,
  json: boolean,
): Promise<CliResult> {
  const conversationId = target.target.conversationId;
  const operationId = started.receipt.operationId;
  const mutationScope = scopeFlags(target.target);
  // The follow-up carries explicit scope so it works from any worktree, not
  // only from the one whose ambient scope happens to match.
  const followUp = checkpointGetCommand(
    conversationId,
    operationId,
    ` ${mutationScope}`,
  );

  /**
   * The newest receipt any poll actually read. A timeout that reported no
   * phase would throw away the one fact R8.9 requires it to keep — an
   * operation observed `retiring` and an operation never observed at all are
   * different states to come back to.
   */
  let observed: CheckpointReceipt | null = null;

  /**
   * The timeout's failure, kept so it can be emitted under the shared budget.
   * `onTimeout` is synchronous and the spill is not, so the waiter renders the
   * failure and this re-renders it bounded — the observed receipt it reports
   * carries the same unbounded omission list every other receipt does.
   */
  const timedOut: {
    failure: FailureInput | null;
    facts: RecoveryFacts;
  } = { failure: null, facts: {} };

  const outcome = await awaitJob<PollStatus>(host, {
    json,
    timeoutMs: WAIT_BUDGET_MS,
    pollIntervalMs: WAIT_POLL_INTERVAL_MS,
    async poll() {
      const result = await cliRequest(host, {
        ...requestParams(target),
        method: "GET",
        path: operationPath(target, operationId),
      });
      // `parseError` is reserved for a body this command cannot read. A
      // refusal, an auth failure, a dead connection and a build mismatch each
      // carry their own exit class, and folding them into the waiter's
      // parse-failure streak would report every one of them as exit 1.
      if (result.kind !== "ok") {
        return { ok: true, status: { kind: "transport", result } };
      }
      const parsed = receiptResponseSchema.safeParse(result.body);
      return parsed.success
        ? {
            ok: true,
            status: { kind: "receipt", receipt: parsed.data.receipt },
          }
        : { ok: false, parseError: "unexpected checkpoint response" };
    },
    async classify(status) {
      if (status.kind === "transport") {
        return {
          terminal: true,
          result: await pollTransportFailure(
            host,
            status.result,
            conversationId,
            json,
          ),
        };
      }
      observed = status.receipt;
      if (!isWaitTerminalPhase(status.receipt.phase))
        return { terminal: false };
      return {
        terminal: true,
        result: await waitOutcome(host, {
          receipt: status.receipt,
          conversationId,
          mutationScope,
          followUp,
          requestId,
          json,
        }),
      };
    },
    onTimeout() {
      const last = observed ?? started.receipt;
      const source = observed === null ? "admission" : "polled";
      const failureInput: FailureInput = {
        exitCode: EXIT_OPERATION_FAILED,
        message: `timed out observing checkpoint ${operationId}; the server still owns it`,
        detail: [
          `operation: ${operationId}`,
          `phase: ${last.phase} (last observed, from the ${source} receipt)`,
        ].join("\n"),
        hint: `read its current phase with: ${followUp}`,
        code: "checkpoint_wait_timeout",
        details: {
          operationId,
          conversationId,
          // Flat alongside `lastObserved` because it is the fact the caller
          // comes back with, and it must survive a spill as a retained field.
          phase: last.phase,
          requestId,
          followUp,
          lastObserved: {
            operationId: last.operationId,
            ordinal: last.ordinal,
            phase: last.phase,
            lastStablePhase: last.lastStablePhase,
            updatedAt: last.updatedAt,
            source,
          },
          receipt: last,
        },
        json,
      };
      timedOut.failure = failureInput;
      timedOut.facts = {
        operationId,
        phase: last.phase,
        requestId,
        followUp,
        ...deliveryCorrelation(last),
      };
      return failureInput;
    },
  });

  const timeoutFailure = timedOut.failure;
  if (timeoutFailure === null) return outcome;
  return boundedFailure(host, {
    command: "conversation compact-context --wait",
    namePrefix: `checkpoint-wait-timeout-${operationId}`,
    retain: timedOut.facts,
    failure: timeoutFailure,
  });
}

/** One poll's outcome: a readable receipt, or a transport refusal to report. */
type PollStatus =
  | { kind: "receipt"; receipt: CheckpointReceipt }
  | {
      kind: "transport";
      result: Exclude<CliRequestResult, { kind: "ok" }>;
    };

/**
 * A failed poll, reported in the class the transport assigned it. The read is a
 * GET against an operation that already exists, so a checkpoint refusal reaches
 * it too — a cancelled operation deleted underneath the watcher, for one.
 */
async function pollTransportFailure(
  host: CliHost,
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  conversationId: string,
  json: boolean,
): Promise<CliResult> {
  return checkpointRefusalFailure(host, {
    result,
    json,
    command: "conversation compact-context --wait",
    conversationId,
  });
}

async function waitOutcome(
  host: CliHost,
  input: {
    receipt: CheckpointReceipt;
    conversationId: string;
    mutationScope: string;
    followUp: string;
    requestId: string;
    json: boolean;
  },
): Promise<CliResult> {
  const { receipt, conversationId, mutationScope, followUp, requestId, json } =
    input;
  const detail = receiptDetailLines(receipt);
  if (WAIT_SUCCESS_PHASES.includes(receipt.phase)) {
    return renderBounded(host, {
      command: "conversation compact-context --wait",
      json,
      humanBody: `${detail.lines.join("\n")}\n`,
      namePrefix: `checkpoint-wait-${receipt.operationId}`,
      envelope: {
        ok: true,
        requestId,
        receipt,
        seedOmissions: detail.jsonOmission,
        hint:
          receipt.phase === "ready"
            ? "ready — the next ordinary message to this conversation accepts the seed once"
            : "applied — an ordinary turn already accepted this seed",
      },
    });
  }

  const remedy = terminalRemedy(receipt, conversationId, mutationScope);
  return boundedFailure(host, {
    command: "conversation compact-context --wait",
    namePrefix: `checkpoint-wait-${receipt.operationId}`,
    retain: {
      operationId: receipt.operationId,
      phase: receipt.phase,
      requestId,
      followUp,
      // Which attempt carried the seed and which queued entry it came from is
      // the whole basis for resolving an uncertain delivery. A spill that kept
      // only the phase would leave the caller unable to review that entry.
      ...deliveryCorrelation(receipt),
    },
    failure: {
      exitCode: EXIT_OPERATION_FAILED,
      message: `checkpoint ${receipt.operationId} ended in ${receipt.phase}`,
      detail: detail.lines.join("\n"),
      code: receipt.failure?.code ?? `checkpoint_${receipt.phase}`,
      details: {
        operationId: receipt.operationId,
        phase: receipt.phase,
        requestId,
        followUp,
        // The whole receipt, not a chosen subset: the delivery binding and the
        // acceptance evidence the text body prints are exactly what a JSON
        // reader needs to correlate an uncertain attempt, and a field added to
        // the projection cannot reach one format while missing the other.
        receipt,
        ...(receipt.failure === null ? {} : { failure: receipt.failure }),
      },
      ...(receipt.phase === "needs_reconciliation"
        ? {
            rationale:
              "the operation's outcome is unresolved, and CC never continues or replays it automatically",
          }
        : {}),
      hint: remedy,
      json,
    },
  });
}

/**
 * The next command for a checkpoint that ended badly, built from its phase.
 * Every one of them is a MUTATION, so each carries the conversation it is about
 * and the scope that conversation lives in — a bare `compact-context` would
 * checkpoint whichever conversation the caller happens to be running in.
 */
function terminalRemedy(
  receipt: CheckpointReceipt,
  conversationId: string,
  mutationScope: string,
): string {
  switch (receipt.phase) {
    case "needs_reconciliation":
      return `repair the deterministic half first: ${checkpointReconcileCommand(conversationId, receipt.operationId, mutationScope)}`;
    case "cancelled":
      return `start a new checkpoint when you want one: ${checkpointStartCommand(conversationId, mutationScope)}`;
    default:
      return `read the failure and retry when it is addressed: ${checkpointGetCommand(conversationId, receipt.operationId, ` ${mutationScope}`)}`;
  }
}

// ---------------------------------------------------------------------------
// checkpoint check
// ---------------------------------------------------------------------------

type CheckpointTransition = "compact_context" | "recovery";

async function runCheckpointCheck(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation checkpoint check", json);
  if (denied) return denied;
  const positional = takeOptionalId(
    rest,
    "conversation checkpoint check",
    json,
  );
  if (!positional.ok) return positional.result;
  const recover = recoverFlag(values, json);
  if (!recover.ok) return recover.result;

  const resolved = await resolveConversationCommandTarget(
    positional.id,
    flags,
    env,
    host,
  );
  if (!resolved.ok) return resolved.result;

  const transition: CheckpointTransition =
    recover.value === null ? "compact_context" : "recovery";

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    checkBody(host, target, recover.value, transition, json),
  );
}

async function checkBody(
  host: CliHost,
  target: ConversationCommandTarget,
  recover: string | null,
  transition: CheckpointTransition,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const query =
    recover === null
      ? ""
      : `?recoversOperationId=${encodeURIComponent(recover)}`;
  const result = await cliRequest(host, {
    ...requestParams(target),
    method: "GET",
    path: `${checkpointsPath(target)}/eligibility${query}`,
  });
  if (result.kind !== "ok") {
    const failed = await checkpointRefusalFailure(host, {
      result,
      json,
      command: "conversation checkpoint check",
      conversationId: target.target.conversationId,
    });
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const parsed = eligibilityResponseSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponse("checkpoint eligibility", json);
  const check = parsed.data;
  const conversationId = target.target.conversationId;
  // The preflight is a READ and may have re-scoped to the conversation's real
  // owner; the transition it clears is a MUTATION, so the command it names
  // carries that owner's scope or it would be refused where the caller runs it.
  const mutationScope = scopeFlags(target.target);
  const blocks =
    transition === "recovery" ? "blocks_recovery" : "blocks_compact_context";

  const activeLines =
    check.active === null
      ? []
      : [
          `active operation: ${check.active.operationId} phase=${check.active.phase} ordinal ${check.active.ordinal}`,
        ];
  const hostLine = `host: ${check.hosted ? "running" : "dormant"}`;

  if (check.eligible) {
    return renderBounded(host, {
      command: "conversation checkpoint check",
      json,
      humanBody: `${["eligible: " + transition, ...activeLines, hostLine].join("\n")}\n`,
      namePrefix: `checkpoint-check-${conversationId}`,
      envelope: {
        ok: true,
        eligible: true,
        transition,
        findings: [],
        active: check.active,
        hosted: check.hosted,
        hint:
          recover === null
            ? `start it with: ${checkpointStartCommand(conversationId, mutationScope)}`
            : `start it with: ${checkpointRecoverCommand(conversationId, recover, mutationScope)}`,
      },
    });
  }

  const findings = check.refusals.map((refusal) => {
    const rationale = checkpointRefusalRationale(refusal.code);
    return {
      code: refusal.code,
      reason: refusal.reason,
      blocks,
      operationId: refusal.operationId,
      phase: refusal.phase,
      remedy: checkpointRefusalRemedy(refusal, {
        conversationId,
        mutationScope,
      }),
      ...(rationale === undefined ? {} : { rationale }),
    };
  });
  const findingLines = findings.map(
    (finding) =>
      `  ${finding.code}\t${blocks}\t${finding.reason}\n    remedy: ${finding.remedy}`,
  );
  const primary = findings[0];
  const primaryRationale =
    primary === undefined
      ? undefined
      : checkpointRefusalRationale(primary.code);

  return boundedFailure(host, {
    command: "conversation checkpoint check",
    namePrefix: `checkpoint-check-${conversationId}`,
    retain: {
      eligible: false,
      transition,
      ...(primary === undefined ? {} : { code: primary.code }),
      // The operation already holding the conversation is the one fact that
      // explains most blockers, and the handle every remedy names.
      ...(check.active === null
        ? {}
        : {
            activeOperationId: check.active.operationId,
            activePhase: check.active.phase,
            ...deliveryCorrelation(check.active),
          }),
    },
    failure: {
      exitCode: EXIT_OPERATION_FAILED,
      message: `blocked: ${transition} — ${findings.length} blocker${findings.length === 1 ? "" : "s"}`,
      detail: [...findingLines, ...activeLines, hostLine].join("\n"),
      code: primary?.code ?? "checkpoint_blocked",
      details: {
        eligible: false,
        transition,
        findings,
        active: check.active,
        hosted: check.hosted,
      },
      ...(primaryRationale === undefined
        ? {}
        : { rationale: primaryRationale }),
      ...(primary ? { hint: primary.remedy } : {}),
      json,
    },
  });
}

// ---------------------------------------------------------------------------
// checkpoint list
// ---------------------------------------------------------------------------

async function runCheckpointList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation checkpoint list", json);
  if (denied) return denied;
  const positional = takeOptionalId(rest, "conversation checkpoint list", json);
  if (!positional.ok) return positional.result;
  const before = positiveIntegerFlag(values, "before", json);
  if (!before.ok) return before.result;
  const limit = positiveIntegerFlag(
    values,
    "limit",
    json,
    MAX_CHECKPOINT_LIST_LIMIT,
  );
  if (!limit.ok) return limit.result;

  const resolved = await resolveConversationCommandTarget(
    positional.id,
    flags,
    env,
    host,
  );
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    listBody(host, target, before.value, limit.value, json),
  );
}

async function listBody(
  host: CliHost,
  target: ConversationCommandTarget,
  before: number | null,
  limit: number | null,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const query = new URLSearchParams();
  if (before !== null) query.set("before", String(before));
  if (limit !== null) query.set("limit", String(limit));
  const suffix = query.toString();

  const result = await cliRequest(host, {
    ...requestParams(target),
    method: "GET",
    path: `${checkpointsPath(target)}${suffix === "" ? "" : `?${suffix}`}`,
  });
  if (result.kind !== "ok") {
    const failed = await checkpointRefusalFailure(host, {
      result,
      json,
      command: "conversation checkpoint list",
      conversationId: target.target.conversationId,
    });
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const parsed = listResponseSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponse("checkpoint list", json);
  const page = parsed.data;
  const conversationId = target.target.conversationId;

  // Ordinals are dense and increase from 1 within a conversation, so the
  // newest ordinal on the page is exactly how many operations sit at or below
  // it — the honest total for the window this page addresses.
  const omission: Omission = pagedOmission({
    total: page.receipts[0]?.ordinal ?? 0,
    returned: page.receipts.length,
    reveal:
      page.nextBefore === null
        ? null
        : `${checkpointListCommand(conversationId)} --before ${page.nextBefore}${limit === null ? "" : ` --limit ${limit}`}`,
  });

  const humanBody = `${[
    `checkpoints: ${omissionSummary(omission)}`,
    ...page.receipts.map(receiptSummaryLine),
  ].join("\n")}\n`;

  return renderBounded(host, {
    command: "conversation checkpoint list",
    json,
    humanBody,
    namePrefix: `checkpoint-list-${conversationId}`,
    envelope: {
      ok: true,
      receipts: page.receipts,
      nextBefore: page.nextBefore,
      ...omission,
      hint:
        page.receipts.length === 0
          ? `no checkpoint operations yet — start one with: ${checkpointStartCommand(conversationId, scopeFlags(target.target))}`
          : `read one in full with: ${checkpointGetCommand(conversationId, page.receipts[0]?.operationId ?? "<operation-id>")}`,
    },
  });
}

// ---------------------------------------------------------------------------
// checkpoint get
// ---------------------------------------------------------------------------

async function runCheckpointGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, "conversation checkpoint get", json);
  if (denied) return denied;
  const args = takeOperationArguments(
    rest,
    "conversation checkpoint get",
    json,
  );
  if (!args.ok) return args.result;

  const detail = values["detail"] ?? "receipt";
  if (detail !== "receipt" && detail !== "seed") {
    return usageFailure("--detail must be receipt or seed", json);
  }

  const resolved = await resolveConversationCommandTarget(
    args.value.conversationId,
    flags,
    env,
    host,
  );
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    getBody(host, target, args.value.operationId, detail, json),
  );
}

async function getBody(
  host: CliHost,
  target: ConversationCommandTarget,
  operationId: string,
  detail: "receipt" | "seed",
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const result = await cliRequest(host, {
    ...requestParams(target),
    method: "GET",
    path: `${operationPath(target, operationId)}?detail=${detail}`,
  });
  if (result.kind !== "ok") {
    const failed = await checkpointRefusalFailure(host, {
      result,
      json,
      command: "conversation checkpoint get",
      conversationId: target.target.conversationId,
    });
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const parsed = receiptResponseSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponse("checkpoint", json);
  const receipt = parsed.data.receipt;

  let seed: z.infer<typeof seedResponseSchema>["seed"] = null;
  if (detail === "seed") {
    const parsedSeed = seedResponseSchema.safeParse(result.body);
    if (!parsedSeed.success) return invalidResponse("checkpoint seed", json);
    seed = parsedSeed.data.seed;
  }
  // `--detail seed` is the explicit disclosure the receipt-level omission cap
  // points at, so it renders every omission row: a reveal command that
  // re-applied the cap would leave the ninth category unreachable in text.
  const rendered = receiptDetailLines(receipt, {
    revealOmissions: detail === "seed",
  });

  // A read of a FAILED operation is a successful read (R8.9): the phase and the
  // failure are output, not an exit code, so a caller can inspect what happened
  // without the command pretending its own request went wrong.
  const lines = [...rendered.lines];
  if (detail === "seed") {
    lines.push(
      "",
      seed === null
        ? "seed: not frozen — this operation has no saved payload"
        : `--- seed (${seed.seedSha256}) ---\n${seed.seedText}`,
    );
  }

  return renderBounded(host, {
    command: "conversation checkpoint get",
    json,
    humanBody: `${lines.join("\n")}\n`,
    namePrefix: `checkpoint-${operationId}`,
    envelope: {
      ok: true,
      receipt,
      detail,
      ...(detail === "seed" ? { seed } : {}),
      seedOmissions: rendered.jsonOmission,
      ...(receipt.failure === null
        ? {}
        : {
            hint: `this operation failed (${receipt.failure.code}); its phase is ${receipt.phase}`,
          }),
    },
  });
}

// ---------------------------------------------------------------------------
// checkpoint cancel / reconcile
// ---------------------------------------------------------------------------

const lifecycleResponseSchema = z.object({
  outcome: z.enum(["cancelled", "completed", "repaired", "unchanged"]),
  receipt: checkpointReceiptSchema,
});

async function runCheckpointLifecycle(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
  verb: "cancel" | "reconcile",
): Promise<CliResult> {
  const json = flags.json;
  const command = `conversation checkpoint ${verb}`;

  const denied = checkFlags(values, command, json);
  if (denied) return denied;
  const args = takeOperationArguments(rest, command, json);
  if (!args.ok) return args.result;

  const resolved = await resolveConversationCommandTarget(
    args.value.conversationId,
    flags,
    env,
    host,
  );
  if (!resolved.ok) return resolved.result;
  const target = resolved.target;

  const result = await cliRequest(host, {
    ...requestParams(target),
    method: "POST",
    path: `${operationPath(target, args.value.operationId)}/${verb}`,
  });

  if (result.kind !== "ok") {
    const advice = isWrongScope404(result)
      ? await ownerScopeAdvice(host, target, flags)
      : null;
    const blockedReceipt = refusalReceiptOf(result);
    const detailLines =
      blockedReceipt === null ? [] : receiptDetailLines(blockedReceipt).lines;
    return checkpointRefusalFailure(host, {
      result,
      json,
      command,
      conversationId: target.target.conversationId,
      mutationScope: scopeFlags(target.target),
      ...(detailLines.length > 0 ? { detailLines } : {}),
      ...(advice === null
        ? {}
        : {
            scopedRemedy: {
              reason: "this conversation lives elsewhere",
              command: `cctl conversation checkpoint ${verb} ${target.target.conversationId} ${args.value.operationId} ${advice}`,
            },
          }),
    });
  }

  const parsed = lifecycleResponseSchema.safeParse(result.body);
  if (!parsed.success) return invalidResponse(command, json);
  const receipt = parsed.data.receipt;
  const rendered = receiptDetailLines(receipt);

  return renderBounded(host, {
    command,
    json,
    humanBody: `${[`outcome: ${parsed.data.outcome}`, ...rendered.lines].join("\n")}\n`,
    namePrefix: `checkpoint-${verb}-${args.value.operationId}`,
    envelope: {
      ok: true,
      outcome: parsed.data.outcome,
      receipt,
      seedOmissions: rendered.jsonOmission,
      hint: nextActionAfter(
        verb,
        receipt,
        target.target.conversationId,
        scopeFlags(target.target),
      ),
    },
  });
}

/**
 * The supported next action once a lifecycle verb settled. Reconcile is
 * deterministic repair, so a settled repair that left the operation in
 * `needs_reconciliation` still needs an EXPLICIT recovery build — the two are
 * different actions and the output must not blur them.
 */
function nextActionAfter(
  verb: "cancel" | "reconcile",
  receipt: CheckpointReceipt,
  conversationId: string,
  mutationScope: string,
): string {
  if (verb === "cancel") {
    return `start a new checkpoint when you want one: ${checkpointStartCommand(conversationId, mutationScope)}`;
  }
  if (receipt.phase === "needs_reconciliation") {
    return `deterministic repair is done; supersede it explicitly with: ${checkpointRecoverCommand(conversationId, receipt.operationId, mutationScope)}`;
  }
  return `re-read the operation with: ${checkpointGetCommand(conversationId, receipt.operationId)}`;
}
