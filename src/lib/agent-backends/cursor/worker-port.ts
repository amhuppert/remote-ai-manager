import type { CursorCapabilitySnapshot } from "./capability-delivery";
import type { InTurnQuestionReply } from "@/lib/conversations/in-turn-question-schemas";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { BackendModelSelection } from "../schemas";
import type {
  CursorPreflightDiagnostics,
  CursorPreflightFailureCode,
} from "./preflight";
import type {
  CursorPreflightFailureReason,
  CursorWorkerFrame,
} from "./worker/ipc";
import type { CursorWorkerMcpServer } from "./worker/entry";

/**
 * `CursorWorkerTransport`: the dependency-injected seam between the Cursor
 * conversation runtime and the supervised worker process (spec D19).
 *
 * Production binds the supervisor; tests bind scripted fakes and drive the real
 * runtime, classifier, projection, and continuity logic through them. Nothing
 * above this port knows a process exists — and nothing below it knows what a
 * conversation is.
 */

export interface CursorWorkerStartInput {
  conversationId: string;
  /** Identity the spawned worker's cctl environment is built from. */
  target: ConversationTarget | null;
  executionProfile?: "standard" | "isolated-one-shot";
  /** The conversation's Command Center worktree; the worker's cwd. */
  cwd: string;
  /** Command Center-owned root for the SDK's local agent store. */
  storePath: string;
  /**
   * The already-resolved complete model selection for this conversation.
   * Validated against the project's effective catalog before start and
   * restated on each attach.
   */
  modelSelection: BackendModelSelection;
  /**
   * Process-local identity of the runtime that owns this worker's callbacks.
   * Stable across retries by one runtime and distinct across runtime instances.
   */
  ownerToken: object;
  /**
   * Every worker→parent frame, in arrival order. Registered at start rather
   * than subscribed afterwards so no frame can be missed in between.
   */
  onFrame(frame: CursorWorkerFrame): void;
  /** The worker process ended — expectedly or not. */
  onExit(info: CursorWorkerExitInfo): void;
  workflowExecutionId?: string;
  workflowContextId?: string;
  workflowCallerConversationId?: string;
}

export interface CursorWorkerExitInfo {
  conversationId: string;
  workerId: string;
  pid: number;
  code: number | null;
  signal: string | null;
  /** True when the exit followed a close this supervisor requested. */
  expected: boolean;
}

export type CursorWorkerStartResult =
  | { kind: "ready"; session: CursorWorkerSession }
  /** A worker already serves this conversation; its session is returned. */
  | { kind: "already_active"; session: CursorWorkerSession }
  /** The conversation slot is live under a different complete selection. */
  | { kind: "binding_mismatch"; message: string }
  /**
   * Preflight layer 1 (D3): the static runtime checks that run in the server
   * before a process exists. Distinct from the credential layer below because
   * the remedy is different — install or pin the SDK, not fix a key.
   */
  | {
      kind: "runtime_preflight_failed";
      code: CursorPreflightFailureCode;
      message: string;
      diagnostics: CursorPreflightDiagnostics;
    }
  | {
      kind: "preflight_failed";
      reason: CursorPreflightFailureReason;
      message: string;
    }
  | { kind: "spawn_failed"; message: string };

export interface CursorAttachInput {
  agents?: CursorCapabilitySnapshot["agents"];
  mode: "create" | "resume";
  /** Required for resume; ignored for create. */
  ref: string | null;
  modelSelection: BackendModelSelection;
  mcpServers: Record<string, CursorWorkerMcpServer>;
  /** Granted only after the parent verifies this worker owns the conversation. */
  recoverAbandonedRun?: boolean;
}

export interface CursorTurnInput {
  allowQuestions?: boolean;
  runId: string;
  promptText: string;
  images: readonly { data: string; mimeType: string }[];
  structuredOutputInstruction: string | null;
  modelSelection: BackendModelSelection;
  mcpServers: Record<string, CursorWorkerMcpServer>;
  /**
   * Expire the agent's active persisted run before this one starts. The
   * busy-agent recovery path (D12), never a default: it is set only after the
   * active-worker registry has proven no live local worker owns the ref.
   */
  forceExpirePersistedRun: boolean;
  /**
   * Fetch billed usage once the turn settles. Off only after the provider
   * refused the feature for this account; re-armed once per attach so a
   * later-enabled account is noticed.
   */
  queryBilling?: boolean;
}

/**
 * How close ended. `verified` means no supervised process remains and the
 * escalation rung it took to get there; `cleanup_failed` is the bounded typed
 * failure that is recorded when teardown could not be proven (D9) — it still
 * resolves, because a caller waiting forever is worse than a recorded failure.
 */
export type CursorWorkerCloseOutcome =
  | { kind: "verified"; escalation: "orderly" | "sigterm" | "sigkill" }
  | {
      kind: "cleanup_failed";
      reason: "ownership_unverified" | "group_survived";
      message: string;
    };

export interface CursorWorkerSession {
  readonly conversationId: string;
  readonly workerId: string;
  readonly pid: number;
  /**
   * Establish the agent. The full non-persisted option set (D11) is applied by
   * the supervisor, not the caller, so a resume cannot silently drop the policy.
   */
  attach(input: CursorAttachInput): void;
  startTurn(input: CursorTurnInput): void;
  steer(runId: string, requestId: string, text: string): void;
  answerQuestion(
    runId: string,
    requestId: string,
    reply: InTurnQuestionReply,
  ): void;
  cancel(runId: string): void;
  /** Fetch billed usage outside a turn; answered by one `billing` frame. */
  queryUsage(queryId: string): void;
  /**
   * Run the verified teardown ladder. Resolves only once no supervised process
   * remains or a bounded cleanup failure has been recorded (D9, D20). Repeated
   * calls return the same settlement.
   */
  close(): Promise<CursorWorkerCloseOutcome>;
}

export interface CursorWorkerTransport {
  start(input: CursorWorkerStartInput): Promise<CursorWorkerStartResult>;
  /** The live worker for a conversation, or null. */
  find(conversationId: string): CursorWorkerSession | null;
  /** Close every live worker; resolves when each has settled. */
  closeAll(): Promise<void>;
}
