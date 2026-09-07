import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type {
  AgentCallUsageMetrics,
  AgentCallStructuredOutputParse,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type {
  AgentFailureClassification,
  ContinuationDisposition,
} from "@/lib/agent-backends/errors";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { BackendAdmissionRefusal } from "@/lib/agent-backends/execution-admission";
import type {
  ConversationContext,
  PromptActorResult,
  StructuredOutputGateRepair,
} from "./types";

import type { StructuredOutputFormat } from "./turn-spec";
import type { TurnCancelReason } from "./turn-spec";

export interface TurnInterruption {
  reason: TurnCancelReason;
  timeoutMs?: number;
}

export type TurnExecutionOutcome = (
  | { kind: "call_result"; result: AgentCallResult }
  | {
      kind: "not_started";
      reason:
        | "cancelled"
        | "query_slot_timeout"
        | "backend_admission"
        | "configuration";
      message: string;
      cancelReason?: TurnCancelReason;
      admission?: BackendAdmissionRefusal;
    }
  | {
      kind: "settlement_failed";
      code: "delivery_receipt" | "persistence" | "runtime_close";
      message: string;
      result: AgentCallResult | null;
    }
) & { interruption?: TurnInterruption };

export interface SettledConversationTurn {
  attemptId: string;
  outcome: TurnExecutionOutcome;
  status: ConversationContext["status"];
  pendingQuestion: ConversationContext["pendingQuestion"];
}

interface TurnPresentationOptions {
  suppressAbortError?: boolean;
  fallbackContentBlocks?: MessageContentBlock[];
  structuredOutputTextField?: string;
}

function turnPresentation(
  outcome: TurnExecutionOutcome,
  options: TurnPresentationOptions = {},
) {
  const result =
    outcome.kind === "call_result"
      ? outcome.result
      : outcome.kind === "settlement_failed"
        ? outcome.result
        : null;
  const call = result?.outcome;
  const failed = call?.kind === "failed" ? call.error : undefined;
  const completed = call?.kind === "completed" ? call : undefined;
  const field = completed ? options.structuredOutputTextField : undefined;
  const structured = completed?.structuredOutput;
  const fieldValue =
    field && typeof structured === "object" && structured !== null
      ? Reflect.get(structured, field)
      : undefined;
  const originalBlocks =
    call?.kind === "completed" || call?.kind === "failed"
      ? call.contentBlocks
      : undefined;
  const contentBlocks: MessageContentBlock[] =
    field !== undefined
      ? typeof fieldValue === "string" && fieldValue.length > 0
        ? [{ type: "text", text: fieldValue }]
        : []
      : (originalBlocks ??
        options.fallbackContentBlocks ??
        (completed?.text ? [{ type: "text", text: completed.text }] : []));
  const text =
    field !== undefined
      ? typeof fieldValue === "string"
        ? fieldValue
        : ""
      : (completed?.text ??
        contentBlocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""));
  const usage: TaskRunUsage = {
    costUsd: result?.usage.costUsd ?? null,
    durationMs: result?.usage.durationMs ?? null,
    contextTokens: result?.usage.contextTokens ?? null,
    contextWindowMax: result?.usage.contextWindowMax ?? null,
    inputTokens: result?.usage.inputTokens ?? null,
    outputTokens: result?.usage.outputTokens ?? null,
    cachedInputTokens: result?.usage.cachedInputTokens ?? null,
  };
  // A schema refusal is a verdict about the payload, not a broken turn: the
  // gate downgraded a COMPLETED outcome and carried the refused content and
  // its per-issue errors along. Forwarding both is what lets a caller retry
  // with feedback instead of treating the turn as infrastructure failure.
  const structuredOutputIssues =
    failed?.failureKind === "schema_validation"
      ? readStructuredOutputGateIssues(failed.backendDetails)
      : undefined;
  const structuredOutputRepair =
    failed?.failureKind === "schema_validation"
      ? readStructuredOutputGateRepair(failed.backendDetails)
      : undefined;
  const aborted =
    failed?.failureKind === "aborted" ||
    (outcome.kind === "not_started" && outcome.reason === "cancelled");
  const error =
    outcome.kind !== "call_result"
      ? outcome.message
      : call?.kind === "paused"
        ? "Turn produced unexpected paused outcome"
        : (failed?.message ?? null);
  const failure = failed
    ? {
        kind: failed.failureKind,
        message: failed.message,
        retryable: failed.retryable ?? false,
        ...(failed.code !== undefined ? { code: failed.code } : {}),
        ...(failed.retryAfterHint !== undefined
          ? { retryAfterHint: failed.retryAfterHint }
          : {}),
      }
    : undefined;
  return {
    result,
    call,
    completed,
    failed,
    contentBlocks,
    text,
    usage,
    error,
    aborted,
    failure,
    backendRef: result?.backendRef ?? null,
    // The facade preserves the adapter's continuation verdict through every
    // outcome projection. The fallback keeps tolerant injected facades safe
    // when they omit the optional field without inventing invalidation.
    continuationDisposition:
      result?.continuationDisposition ?? ("retain" as const),
    numTurns:
      call?.kind === "completed" || call?.kind === "failed"
        ? (call.numTurns ?? null)
        : null,
    ...(call?.kind !== "paused" && call?.transcript !== undefined
      ? { transcript: call.transcript }
      : {}),
    ...(structuredOutputIssues !== undefined ? { structuredOutputIssues } : {}),
    ...(structuredOutputRepair !== undefined ? { structuredOutputRepair } : {}),
  };
}

export function toPromptActorResult(
  outcome: TurnExecutionOutcome,
  options: TurnPresentationOptions = {},
): PromptActorResult {
  const facts = turnPresentation(outcome, options);
  const interruption = outcome.interruption;
  const aborted =
    facts.aborted ||
    (options.suppressAbortError === true && interruption !== undefined);
  const { contextWindowMax, ...usage } = facts.usage;
  return {
    backendRef: facts.backendRef,
    ...usage,
    contextWindow: contextWindowMax,
    numTurns: facts.numTurns,
    contentBlocks: facts.contentBlocks,
    ...(facts.completed?.structuredOutput !== undefined
      ? { structuredOutput: facts.completed.structuredOutput }
      : {}),
    // Where the gate found the payload it accepted. Without this a caller
    // that records capture provenance has to assume `native`, which is a
    // false claim for every payload the gate extracted or repaired.
    ...(facts.completed?.parse !== undefined
      ? { structuredOutputParse: facts.completed.parse }
      : {}),
    ...(facts.structuredOutputIssues !== undefined
      ? { structuredOutputIssues: facts.structuredOutputIssues }
      : {}),
    ...(facts.structuredOutputRepair !== undefined
      ? { structuredOutputRepair: facts.structuredOutputRepair }
      : {}),
    ...(facts.transcript !== undefined ? { transcript: facts.transcript } : {}),
    aborted,
    ...(interruption?.reason === "timeout" || interruption?.reason === "stalled"
      ? {
          abortReason: interruption.reason,
          ...(interruption.timeoutMs !== undefined
            ? { timeoutMs: interruption.timeoutMs }
            : {}),
        }
      : {}),
    compacted: facts.result?.compacted ?? false,
    error:
      options.suppressAbortError && outcome.kind === "call_result" && aborted
        ? null
        : facts.error,
    continuationDisposition: facts.continuationDisposition,
    ...(facts.result?.backgroundWait !== undefined
      ? { backgroundWait: facts.result.backgroundWait }
      : {}),
    ...(facts.failure
      ? { failure: facts.failure }
      : outcome.kind === "not_started"
        ? {
            failure: {
              kind:
                outcome.reason === "cancelled"
                  ? ("aborted" as const)
                  : outcome.reason === "query_slot_timeout"
                    ? ("timeout" as const)
                    : ("backend_error" as const),
              message: outcome.message,
              retryable: false,
            },
          }
        : {}),
  };
}

/** Task presentation consumes the original outcome, preserving refused output and usage. */
export function toTaskRunResult(
  outcome: TurnExecutionOutcome,
  outputFormat?: StructuredOutputFormat,
  options: TurnPresentationOptions = {},
): TaskRunResult {
  const facts = turnPresentation(outcome, options);
  const base = {
    usage: facts.usage,
    backendRef: facts.backendRef,
    continuationDisposition: facts.continuationDisposition,
    ...(facts.transcript !== undefined ? { transcript: facts.transcript } : {}),
  };
  if (facts.error !== null)
    return {
      kind: "error",
      error: facts.error,
      text: facts.text,
      aborted: facts.aborted,
      ...(outcome.kind === "not_started" ? { notStarted: outcome } : {}),
      ...(outcome.kind === "settlement_failed"
        ? {
            settlementFailure: { code: outcome.code, message: outcome.message },
          }
        : {}),
      ...(outcome.interruption ? { interruption: outcome.interruption } : {}),
      ...(facts.failure
        ? { failure: facts.failure }
        : outcome.kind === "not_started" && outcome.reason === "cancelled"
          ? {
              failure: {
                kind: "aborted" as const,
                message: outcome.message,
                retryable: false,
              },
            }
          : {}),
      ...(facts.structuredOutputIssues !== undefined
        ? { structuredOutputIssues: facts.structuredOutputIssues }
        : {}),
      ...(facts.structuredOutputRepair !== undefined
        ? { structuredOutputRepair: facts.structuredOutputRepair }
        : {}),
      ...base,
    };
  if (
    facts.completed?.structuredOutput !== undefined &&
    outputFormat !== undefined
  )
    return {
      kind: "structured",
      structuredOutput: facts.completed.structuredOutput,
      text: facts.text,
      ...(facts.completed.parse ? { parse: facts.completed.parse } : {}),
      ...base,
    };
  return { kind: "text", text: facts.text, ...base };
}

export function toPromptStreamResult(
  outcome: TurnExecutionOutcome,
  conversationId: string,
): PromptStreamResult {
  const facts = turnPresentation(outcome);
  const interruption = outcome.interruption;
  const aborted = facts.aborted || interruption !== undefined;
  return {
    conversationId,
    contextTokens: facts.usage.contextTokens,
    contextWindowMax: facts.usage.contextWindowMax,
    structuredOutput: facts.completed?.structuredOutput,
    aborted,
    compacted: facts.result?.compacted ?? false,
    error: outcome.kind === "call_result" && aborted ? null : facts.error,
    backgroundWait: facts.result?.backgroundWait,
    ...(interruption?.reason === "timeout" || interruption?.reason === "stalled"
      ? {
          abortReason: interruption.reason,
          ...(interruption.timeoutMs !== undefined
            ? { timeoutMs: interruption.timeoutMs }
            : {}),
        }
      : {}),
  };
}

/**
 * Pull the structured-output gate's per-issue errors out of a normalized
 * failure's opaque `backendDetails`. Returns undefined when the details carry
 * no usable issue list, so the caller falls back to the joined `error` message
 * instead of surfacing a partially-decoded array.
 */
function readStructuredOutputGateIssues(
  backendDetails: unknown,
): string[] | undefined {
  if (typeof backendDetails !== "object" || backendDetails === null) {
    return undefined;
  }
  const errors = Reflect.get(backendDetails, "errors");
  if (!Array.isArray(errors)) return undefined;
  const issues = errors.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return issues.length > 0 ? issues : undefined;
}

/**
 * Pull the structured-output gate's bounded-repair spend out of the same opaque
 * `backendDetails`. This is the gate's OWN repair turn — the one
 * `applyStructuredOutputGate` runs before it refuses — and it is the only
 * repair provenance a schema refusal has. Returns undefined when the details
 * carry neither number, so a caller reports no repair rather than an invented
 * zero.
 */
function readStructuredOutputGateRepair(
  backendDetails: unknown,
): StructuredOutputGateRepair | undefined {
  if (typeof backendDetails !== "object" || backendDetails === null) {
    return undefined;
  }
  const attempts = readIntegerField(backendDetails, "repairAttempts");
  const maxAttempts = readIntegerField(backendDetails, "repairMaxAttempts");
  if (attempts === undefined || maxAttempts === undefined) {
    return undefined;
  }
  return { attempts, maxAttempts };
}

function readIntegerField(source: object, key: string): number | undefined {
  const value = Reflect.get(source, key);
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

export type TaskRunUsage = {
  [K in keyof Pick<
    AgentCallUsageMetrics,
    | "costUsd"
    | "durationMs"
    | "contextTokens"
    | "contextWindowMax"
    | "inputTokens"
    | "outputTokens"
    | "cachedInputTokens"
  >]-?: NonNullable<AgentCallUsageMetrics[K]> | null;
};

export type TaskRunResult =
  | {
      kind: "structured";
      structuredOutput: unknown;
      /** Where the shared gate found the accepted payload. Absent when the
       *  backend returned it natively without the gate recording provenance. */
      parse?: AgentCallStructuredOutputParse;
      /** Joined text blocks emitted alongside the structured payload, when
       *  the runner returned both. May be the empty string. */
      text: string;
      /** Full backend-native turn transcript, when the backend surfaced one. */
      transcript?: AgentTranscriptEntry[];
      usage: TaskRunUsage;
      backendRef: AgentSessionRef | null;
      continuationDisposition: ContinuationDisposition;
    }
  | {
      kind: "text";
      text: string;
      /** Full backend-native turn transcript, when the backend surfaced one. */
      transcript?: AgentTranscriptEntry[];
      usage: TaskRunUsage;
      backendRef: AgentSessionRef | null;
      continuationDisposition: ContinuationDisposition;
    }
  | {
      kind: "error";
      notStarted?: Extract<TurnExecutionOutcome, { kind: "not_started" }>;
      settlementFailure?: {
        code: "delivery_receipt" | "persistence" | "runtime_close";
        message: string;
      };
      interruption?: TurnInterruption;
      error: string;
      aborted: boolean;
      /**
       * Neutral classification of why the turn failed, so callers branch on
       * `retryable` and `kind` instead of pattern-matching `error` prose — a
       * backend that never ran (quota, transport) and an agent that ran and
       * failed are indistinguishable as strings. Present whenever the
       * conversation layer produced one; absent for callers that project a
       * `TaskRunResult` without a classifier.
       */
      failure?: AgentFailureClassification;
      /** Set when the structured-output gate refused the turn: its per-issue
       *  validator errors, each prefixed with the failing instance path. */
      structuredOutputIssues?: string[];
      /** The gate's own bounded-repair spend and budget for the refused turn,
       *  when its details reported both. */
      structuredOutputRepair?: StructuredOutputGateRepair;
      /** The assistant text the gate refused, when the turn produced one. */
      text?: string;
      /** Full backend-native turn transcript, when the backend surfaced one. */
      transcript?: AgentTranscriptEntry[];
      usage: TaskRunUsage;
      backendRef: AgentSessionRef | null;
      continuationDisposition: ContinuationDisposition;
    };

export interface PromptStreamResult {
  conversationId: string;
  contextTokens: number | null;
  contextWindowMax: number | null;
  structuredOutput?: unknown;
  aborted?: boolean;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted: boolean;
  abortReason?: "timeout" | "stalled" | "user" | "shutdown";
  timeoutMs?: number;
  error?: string | null;
  /**
   * Summary of the bounded background-task wait the turn performed. Present
   * only when a wait actually occurred (the turn opted in and waitable tasks
   * were in flight); absent otherwise.
   */
  backgroundWait?: BackgroundWaitSummary;
}
