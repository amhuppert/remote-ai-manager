import type {
  AgentFailureClassification,
  AgentFailureClassifier,
} from "../errors";
import {
  createClassifierWithDefaultContinuation,
  extractRetryAfterHint,
  failureMessage,
  isAbortFailure,
  isPromptNotDeliveredFailure,
  isTimeoutFailure,
} from "../errors";

/**
 * Cursor failure classification (spec D12).
 *
 * Classification keys on the SDK's stable `name`, `code`, and `status` rather
 * than `instanceof`: a failure raised inside the worker reaches the parent as a
 * rehydrated plain error whose class identity is gone but whose stable fields
 * survive. Reading fields instead of importing the SDK also keeps `@cursor/sdk`
 * out of the server process, where only the worker may load it.
 */

/** Failures Command Center detects itself; the SDK never raises them. */
const LOCAL_FAILURE_KINDS = [
  "worker_exit",
  "stream_stall",
  "invalid_ref",
  "binding_mismatch",
] as const;

export type CursorLocalFailureKind = (typeof LOCAL_FAILURE_KINDS)[number];

/**
 * Raised by the Cursor worker supervisor and conversation runtime for the
 * failure modes that have no SDK error: the worker died, the event stream went
 * silent past its bound, a persisted ref proved corrupt or bound to another
 * workspace, or the conversation's live worker belongs to another selection.
 */
export class CursorLocalFailure extends Error {
  readonly localKind: CursorLocalFailureKind;

  constructor(localKind: CursorLocalFailureKind, message: string) {
    super(message);
    this.name = "CursorLocalFailure";
    this.localKind = localKind;
  }
}

export interface CursorFailureDiagnostics {
  sdkErrorName: string | null;
  sdkCode: string | null;
  sdkStatus: number | null;
  localKind: CursorLocalFailureKind | null;
}

/**
 * Bounded prefix carrying the SDK's stable code into the neutral message, the
 * only field that survives into a persisted turn result. Recognized on the way
 * back in so re-classifying a reloaded failure reaches the same verdict.
 */
const ENCODED_CODE_PATTERN = /^cursor\[([a-z0-9_.-]+)\]\s/i;

/**
 * Property reads are wrapped because the input is untrusted: a rehydrated error
 * can carry a hostile getter, and `classify` must never throw.
 */
function readProperty(value: unknown, key: string): unknown {
  if (value === null) return undefined;
  if (typeof value !== "object" && typeof value !== "function")
    return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function readString(value: unknown, key: string): string | null {
  const read = readProperty(value, key);
  return typeof read === "string" && read.length > 0 ? read : null;
}

function readLocalKind(error: unknown): CursorLocalFailureKind | null {
  const read = readProperty(error, "localKind");
  if (typeof read !== "string") return null;
  return LOCAL_FAILURE_KINDS.find((kind) => kind === read) ?? null;
}

function safeMessage(error: unknown): string {
  try {
    return failureMessage(error);
  } catch {
    return "cursor failure with an unreadable message";
  }
}

export function cursorFailureDiagnostics(
  error: unknown,
): CursorFailureDiagnostics {
  const status = readProperty(error, "status");
  return {
    sdkErrorName: readString(error, "name"),
    sdkCode: readString(error, "code"),
    sdkStatus:
      typeof status === "number" && Number.isFinite(status) ? status : null,
    localKind: readLocalKind(error),
  };
}

/**
 * The neutral verdict for one failure class, before the message is attached.
 * `retryable` follows the delivery contract the retry gate reads: a failure
 * that may already have produced side effects is not retryable even when a
 * fresh runtime is available.
 */
interface Verdict {
  kind: AgentFailureClassification["kind"];
  retryable: boolean;
  /** Rate limits carry a display-only "capacity returns at" hint. */
  withRetryAfterHint?: true;
}

const AUTHENTICATION: Verdict = { kind: "backend_error", retryable: false };
const RATE_LIMIT: Verdict = {
  kind: "quota_exhausted",
  retryable: false,
  withRetryAfterHint: true,
};
const CONFIGURATION: Verdict = { kind: "backend_error", retryable: false };
const AGENT_BUSY: Verdict = { kind: "backend_error", retryable: false };
const NETWORK: Verdict = { kind: "backend_error", retryable: true };
const AGENT_NOT_FOUND: Verdict = { kind: "stale_resume_ref", retryable: true };
const UNKNOWN_AGENT: Verdict = { kind: "backend_error", retryable: false };

/**
 * The SDK's stable error-class names. `IntegrationNotConnectedError` extends
 * `ConfigurationError` and reaches the parent under its own name, so it is
 * listed rather than left to the unknown fallback.
 */
const VERDICT_BY_SDK_NAME: ReadonlyMap<string, Verdict> = new Map([
  ["AuthenticationError", AUTHENTICATION],
  ["RateLimitError", RATE_LIMIT],
  ["ConfigurationError", CONFIGURATION],
  ["IntegrationNotConnectedError", CONFIGURATION],
  ["UnsupportedRunOperationError", CONFIGURATION],
  ["AgentBusyError", AGENT_BUSY],
  ["NetworkError", NETWORK],
  ["AgentNotFoundError", AGENT_NOT_FOUND],
  ["UnknownAgentError", UNKNOWN_AGENT],
]);

/** Stable backend codes, which outlive any class-name change. */
const VERDICT_BY_SDK_CODE: ReadonlyMap<string, Verdict> = new Map([
  ["agent_not_found", AGENT_NOT_FOUND],
  ["agent_busy", AGENT_BUSY],
  ["unauthenticated", AUTHENTICATION],
  ["rate_limit", RATE_LIMIT],
]);

const VERDICT_BY_STATUS: ReadonlyMap<number, Verdict> = new Map([
  [400, CONFIGURATION],
  [401, AUTHENTICATION],
  [404, CONFIGURATION],
  [409, AGENT_BUSY],
  [429, RATE_LIMIT],
  [503, NETWORK],
  [504, NETWORK],
]);

/**
 * A dead worker is a dead session. Retryability is the delivery question, not
 * the liveness one: only a prompt that provably never reached the agent is safe
 * to re-dispatch, which is exactly what the neutral delivery mark records.
 */
function workerExitVerdict(error: unknown): Verdict {
  return {
    kind: "session_died",
    retryable: isPromptNotDeliveredFailure(error),
  };
}

function localVerdict(
  localKind: CursorLocalFailureKind,
  error: unknown,
): Verdict {
  switch (localKind) {
    case "worker_exit":
      return workerExitVerdict(error);
    case "stream_stall":
      return { kind: "timeout", retryable: false };
    case "invalid_ref":
      // A corrupt or cross-workspace ref is a genuinely invalid session: the
      // only class besides agent-not-found that clears the persisted ref.
      return { kind: "stale_resume_ref", retryable: true };
    case "binding_mismatch":
      return { kind: "backend_error", retryable: false };
  }
}

function resolveVerdict(error: unknown, message: string): Verdict | null {
  const localKind = readLocalKind(error);
  if (localKind !== null) return localVerdict(localKind, error);

  const name = readString(error, "name");
  if (name !== null) {
    const byName = VERDICT_BY_SDK_NAME.get(name);
    if (byName !== undefined) return byName;
  }

  const code = readString(error, "code");
  if (code !== null) {
    const byCode = VERDICT_BY_SDK_CODE.get(code);
    if (byCode !== undefined) return byCode;
  }

  const status = readProperty(error, "status");
  if (typeof status === "number") {
    const byStatus = VERDICT_BY_STATUS.get(status);
    if (byStatus !== undefined) return byStatus;
  }

  // A reloaded turn result carries only the enriched message; the code encoded
  // into it is the same stable seam the live error offered.
  const encoded = ENCODED_CODE_PATTERN.exec(message)?.[1];
  if (encoded !== undefined) {
    const byEncodedCode = VERDICT_BY_SDK_CODE.get(encoded);
    if (byEncodedCode !== undefined) return byEncodedCode;
  }

  return null;
}

/** Encodes the stable code into the message without stacking prefixes. */
function enrichMessage(message: string, code: string | null): string {
  if (code === null || ENCODED_CODE_PATTERN.test(message)) return message;
  return `cursor[${code}] ${message}`;
}

/**
 * Cursor failure classifier: maps the SDK's typed error taxonomy, plus the two
 * local failure modes the SDK cannot report, onto the neutral vocabulary.
 *
 * Continuation disposition comes from the shared default policy, which clears
 * the ref for `stale_resume_ref` and retains it otherwise. That is exactly the
 * designed matrix — agent-not-found and corrupt/cross-cwd refs are the only
 * classes that reach `stale_resume_ref` — so this adapter adds no second owner
 * of the kind-to-disposition mapping.
 */
export function createCursorFailureClassifier(): AgentFailureClassifier {
  function classify(error: unknown): AgentFailureClassification {
    const rawMessage = safeMessage(error);

    if (isAbortFailure(error)) {
      return { kind: "aborted", message: rawMessage, retryable: false };
    }

    const verdict = resolveVerdict(error, rawMessage);
    if (verdict === null) {
      // Timeout shapes are recognized only after the typed taxonomy, so an SDK
      // error whose text happens to say "timed out" keeps its own verdict.
      if (isTimeoutFailure(error)) {
        return { kind: "timeout", message: rawMessage, retryable: false };
      }
      return { kind: "backend_error", message: rawMessage, retryable: false };
    }

    const message = enrichMessage(rawMessage, readString(error, "code"));
    const retryAfterHint =
      verdict.withRetryAfterHint === true
        ? extractRetryAfterHint(message)
        : undefined;

    return {
      kind: verdict.kind,
      message,
      retryable: verdict.retryable,
      ...(retryAfterHint !== undefined ? { retryAfterHint } : {}),
    };
  }

  return createClassifierWithDefaultContinuation(classify);
}
