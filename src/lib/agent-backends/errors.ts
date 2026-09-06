import { z } from "zod";
import { backendAdmissionRefusalSchema } from "./execution-admission";

export const agentFailureKindSchema = z.enum([
  "timeout",
  "aborted",
  "schema_validation",
  "structured_output_exhausted",
  "stale_resume_ref",
  "session_died",
  "capability_unavailable",
  "quota_exhausted",
  "backend_error",
]);
export type AgentFailureKind = z.infer<typeof agentFailureKindSchema>;

export const agentFailureClassificationSchema = z.object({
  code: backendAdmissionRefusalSchema.shape.code.optional(),
  kind: agentFailureKindSchema,
  message: z.string(),
  retryable: z.boolean(),
  /**
   * Opaque provider text naming when capacity returns (e.g. "Aug 19th, 2026
   * 11:29 PM"). Display-only: it is a provider sentence in a provider's own
   * format and timezone, so no scheduler may parse it into a retry time.
   */
  retryAfterHint: z.string().optional(),
});
export type AgentFailureClassification = z.infer<
  typeof agentFailureClassificationSchema
>;

export const continuationDispositionSchema = z.enum(["retain", "clear"]);
export type ContinuationDisposition = z.infer<
  typeof continuationDispositionSchema
>;

export interface AgentFailureWithContinuation {
  failure: AgentFailureClassification;
  continuationDisposition: ContinuationDisposition;
}

/**
 * Normalizes arbitrary backend failures into the neutral classification the
 * orchestration layer acts on. Implementations must never throw — an
 * unclassifiable input maps to `backend_error`. Thrown execution failures use
 * `classifyWithContinuation` so the adapter returns classification and
 * continuation policy together rather than making orchestration infer it.
 */
export interface AgentFailureClassifier {
  classify(error: unknown): AgentFailureClassification;
  classifyWithContinuation(error: unknown): AgentFailureWithContinuation;
}

/**
 * Continuation contract every adapter turn result must satisfy: "clear"
 * declares the persisted continuation ref unusable, so the same result cannot
 * also surface a ref to persist — that pair would make the orchestrator keep
 * retrying the continuation the adapter just declared dead.
 *
 * The ref is validated structurally (any registered backend id, not the
 * canonical id enum): this contract constrains the disposition pair only, and
 * a third backend's ref must pass through it untouched. Backend-id vocabulary
 * is owned by `agentSessionRefSchema`.
 */
export const turnContinuationSchema = z
  .object({
    backendRef: z
      .object({ backend: z.string().min(1), ref: z.string().min(1) })
      .nullable(),
    continuationDisposition: continuationDispositionSchema,
  })
  .refine(
    (r) => r.continuationDisposition !== "clear" || r.backendRef === null,
    { message: 'continuationDisposition "clear" implies backendRef: null' },
  );

/**
 * Property key for the neutral "prompt not delivered" fact on a thrown turn
 * failure: the prompt never reached the agent, so re-dispatching it on a
 * fresh runtime cannot double-deliver. Adapters set it at their capture point
 * (e.g. the Claude QuerySession promptNotDelivered tag); the conversation
 * actor's retry loop consumes it without knowing any provider error type.
 */
const PROMPT_NOT_DELIVERED_MARK = "ccPromptNotDelivered";

export function markPromptNotDelivered<T extends Error>(error: T): T {
  Reflect.set(error, PROMPT_NOT_DELIVERED_MARK, true);
  return error;
}

export function isPromptNotDeliveredFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    Reflect.get(error, PROMPT_NOT_DELIVERED_MARK) === true
  );
}

/** Extracts a human-readable message from any thrown/returned failure value. */
export function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** True for DOM-convention abort failures (`Error` with name "AbortError"). */
export function isAbortFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * True for timeout failures: DOM-convention `TimeoutError` names or the
 * "timed out" message shape both task runners and the actor's safety-net
 * timeout produce.
 */
export function isTimeoutFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  return /\btimed out\b/i.test(failureMessage(error));
}

/**
 * Message-shape heuristic for a resume attempt against a provider session that
 * no longer exists (expired, garbage-collected, or unknown to the provider).
 * The provider SDKs report this as an unstructured message, so classification
 * requires both a continuity noun (resume/session/thread) and a
 * missing/expired marker. Consumed exclusively by the backend failure
 * classifiers (`claude/failure-classifier.ts`, `codex/failure-classifier.ts`)
 * — staleness detection has no other home; runtimes and orchestration consume
 * the classifier's typed `stale_resume_ref` output, never this heuristic.
 */
export function isLikelyStaleResumeMessage(message: string): boolean {
  return (
    // Marker-first provider shapes: Claude's resume rejection ("No
    // conversation found with session ID: …") and Codex's garbage-collected
    // rollout ("no rollout found for thread …").
    /\bno (?:conversation|session|thread|rollout) found\b/i.test(message) ||
    // Continuity noun followed in the same clause by a missing/expired
    // predicate ("session abc not found", "thread expired", "cannot resume:
    // transcript not found"). Noun-first and clause-bound so expiry text that
    // merely mentions a session afterwards ("OAuth token expired for this
    // session") keeps its valid continuation.
    /\b(?:resume|session|thread|conversation)\b[^.\n]{0,80}?\b(?:not found|does not exist|no longer exists|expired|no rollout)\b/i.test(
      message,
    )
  );
}

/**
 * Marker-first message shapes for a provider capacity refusal: the account's
 * usage quota or rate limit is exhausted, so the turn never reached the agent.
 * A capacity noun (usage/rate/quota/credit/token) must sit in the same clause
 * as an exhaustion verb, or the provider's own status/error code must appear,
 * so ordinary text that merely says "usage" or "limit reached" keeps its
 * `backend_error` classification. Both providers emit both families (Codex
 * returns 429s; Claude Code prints "usage limit reached"), so the vocabulary is
 * shared rather than per-provider.
 *
 * Consumed exclusively by the backend failure classifiers
 * (`claude/failure-classifier.ts`, `codex/failure-classifier.ts`) — like
 * {@link isLikelyStaleResumeMessage}, orchestration consumes the typed
 * `quota_exhausted` output, never this heuristic.
 */
const QUOTA_EXHAUSTED_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\b(?:usage|rate|quota|credit|token)[- ]?limits?\b[^.\n]{0,30}?\b(?:reached|exceeded|hit|exhausted)\b/i,
  /\b(?:hit|reached|exceeded|exhausted)\b[^.\n]{0,30}?\b(?:usage|rate|quota|credit|token)[- ]?limits?\b/i,
  /\b(?:quota|credits?)\b[^.\n]{0,20}?\b(?:exceeded|exhausted|depleted)\b/i,
  /\bout of (?:credits|quota|tokens)\b/i,
  /\btoo many requests\b/i,
  /\brate[_ ]limit_?error\b/i,
  /\boverloaded_error\b/i,
  /^overloaded\b/i,
  // HTTP 429 in a provider status shape ("API Error: 429", "HTTP 429",
  // "status code 429"). A bare number is never evidence on its own: commit
  // SHAs (`e429fa1`), byte counts, and `file:line:column` coordinates all carry
  // one, and the merge path quotes all three. The token boundary excludes
  // embedded digits AND embedded letters; the status noun must sit in the same
  // clause.
  /\b(?:http|https|status|code|error)\b[^.\n]{0,20}?(?<![\w:.\-/])429(?![\w:.\-/])/i,
  /(?<![\w:.\-/])429(?![\w:.\-/])[^.\n]{0,20}?\b(?:too many requests|rate[-_ ]?limits?)\b/i,
];

export function isLikelyQuotaExhaustedMessage(message: string): boolean {
  return QUOTA_EXHAUSTED_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

/**
 * Provider clauses naming when capacity returns. The captured text is opaque —
 * a display hint carried on {@link AgentFailureClassification.retryAfterHint},
 * never a parsed schedule.
 */
const RETRY_AFTER_HINT_PATTERNS: readonly RegExp[] = [
  /\btry again (?:at|in|after)\s+([^.\n]+)/i,
  /\bresets?\s+(?:at|in|on)\s+([^.\n]+)/i,
  /\bretry[-_ ]?after[:=]?\s*([^.\n]+)/i,
  /\bavailable again (?:at|in)\s+([^.\n]+)/i,
];

export function extractRetryAfterHint(message: string): string | undefined {
  for (const pattern of RETRY_AFTER_HINT_PATTERNS) {
    const captured = pattern.exec(message)?.[1];
    if (captured === undefined) continue;
    // Trailing separators only: a closing bracket can belong to the hint
    // itself ("10pm (America/New_York)").
    const hint = captured
      .trim()
      .replace(/[,;:]+$/, "")
      .trim();
    if (hint.length > 0) return hint;
  }
  return undefined;
}

/**
 * Builds a full classifier from a `classify` function using the shared
 * default continuation policy: only provider evidence that the resumed
 * continuation no longer exists (`stale_resume_ref`) invalidates the ref;
 * every other failure retains it. This is the single owner of the
 * kind→disposition mapping — adapters whose disposition genuinely depends on
 * more than the failure kind (e.g. the Codex conversation runtime's
 * first-turn-crash clause) derive it at their own capture point instead.
 */
export function createClassifierWithDefaultContinuation(
  classify: (error: unknown) => AgentFailureClassification,
): AgentFailureClassifier {
  return {
    classify,
    classifyWithContinuation(error: unknown): AgentFailureWithContinuation {
      const failure = classify(error);
      return {
        failure,
        continuationDisposition:
          failure.kind === "stale_resume_ref" ? "clear" : "retain",
      };
    },
  };
}

/**
 * Minimal classifier recognizing only aborts; every other input maps to a
 * non-retryable `backend_error`. For wiring test descriptors that need no
 * provider-specific classification; production descriptors register their own
 * classifier (`claude/failure-classifier.ts`, `codex/failure-classifier.ts`).
 */
export function createStubFailureClassifier(): AgentFailureClassifier {
  return createClassifierWithDefaultContinuation((error) => {
    if (isAbortFailure(error)) {
      return {
        kind: "aborted",
        message: failureMessage(error),
        retryable: false,
      };
    }
    return {
      kind: "backend_error",
      message: failureMessage(error),
      retryable: false,
    };
  });
}
