import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type {
  AgentFailureClassification,
  ContinuationDisposition,
} from "@/lib/agent-backends/errors";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type { CheckpointActorProjection } from "@/lib/conversation-checkpoints/schemas";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type {
  AskQuestionItem,
  ConversationRole,
  ForkedFrom,
  MessageContentBlock,
} from "@/lib/conversations/schemas";
import type { RuntimeDebugModeState } from "@/lib/debug-log/schemas";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { AgentCallStructuredOutputParse } from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { ConversationTurnSpec } from "./turn-spec";

// The input and outcome of one conversation turn, whichever engine runs it.

/**
 * The construction-time persistence choice for a conversation runtime.
 * `durable` runs the full persistence facet (derived-field sync, snapshot
 * persistence, read/unread transitions); `ephemeral` is inert — a synthetic
 * lane with no `ConversationState` record (compaction, workflow-graph
 * validator) writes nothing to the state store. Required with no default, so a
 * runtime cannot be constructed without deciding.
 */
export type ConversationPersistenceMode = "durable" | "ephemeral";

/** A question the agent asked its person, waiting for an answer. */
export interface PendingConversationQuestion {
  questionId: string;
  questions: AskQuestionItem[];
}

/** Registers or clears the question a conversation's row shows its person. */
export type QuestionCommand =
  | ({ kind: "register_question" } & PendingConversationQuestion)
  | { kind: "clear_question"; questionId: string };

/**
 * The structured-output gate's bounded-repair spend on a refused turn.
 *
 * `attempts` is repair turns actually run (0 when the gate refused the first
 * answer outright); `maxAttempts` is the budget in force for that call, which
 * is the facade default unless the request declared its own.
 */
export interface StructuredOutputGateRepair {
  attempts: number;
  maxAttempts: number;
}

/** Output from the executePrompt actor. */
export interface PromptActorResult {
  backendRef: AgentSessionRef | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  /** Backend-reported per-turn token usage (forwarded from AgentCallUsageMetrics).
   *  Null when the backend does not report token counts. */
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  contentBlocks: MessageContentBlock[];
  structuredOutput?: unknown;
  /**
   * Where the shared structured-output gate found the payload it accepted.
   * Present only when the gate ran AND passed; forwarded verbatim from the
   * AgentCall outcome so callers that persist an output can record its
   * provenance without re-deriving it.
   */
  structuredOutputParse?: AgentCallStructuredOutputParse;
  /**
   * The gate's per-issue validator errors when it REFUSED the turn (each
   * prefixed with the failing instance path). Present only for a
   * `schema_validation` failure — `error` carries the same information as one
   * joined sentence, which callers that need to address individual issues
   * cannot use.
   */
  structuredOutputIssues?: string[];
  /**
   * What the gate's own bounded repair spent before refusing, and the budget it
   * was spent against. Present only for a `schema_validation` failure whose
   * details carried both. A caller reporting why an output was refused needs
   * this to distinguish "the model missed once" from "the gate re-asked and the
   * model missed again".
   */
  structuredOutputRepair?: StructuredOutputGateRepair;
  /**
   * Full backend-native turn transcript, forwarded from the AgentCall result.
   * Present only for completed `task_run` turns whose backend surfaced
   * intermediate items; consumed by the graph-workflow validator path.
   */
  transcript?: AgentTranscriptEntry[];
  aborted: boolean;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted: boolean;
  abortReason?: "timeout" | "stalled" | "user" | "shutdown";
  timeoutMs?: number;
  error: string | null;
  /**
   * Neutral classification of the failure named by `error`, as the backend
   * classified the error VALUE. Present whenever the turn failed through the
   * AgentCall boundary; absent for a clean turn and for failures projected
   * without one. Callers must prefer it over re-classifying `error`, which no
   * longer carries the facts the verdict was made from (an undelivered prompt,
   * a provider error code).
   */
  failure?: AgentFailureClassification;
  /**
   * Whether the machine may keep falling back to its prior `backendRef` when
   * this turn surfaced none. Backend continuation policy (whether a failed
   * turn invalidates the persisted ref) is decided where the turn executed by
   * the adapter's turn result, never by backend identity in the machine.
   */
  continuationDisposition: ContinuationDisposition;
  /**
   * Summary of the bounded background-task wait this turn performed. Present
   * only when a wait actually occurred; absent for every other turn.
   */
  backgroundWait?: BackgroundWaitSummary;
}

/** Input for the executePrompt actor. */
export interface ExecutePromptInput {
  executionAttemptId?: string;
  turn: ConversationTurnSpec;
  /**
   * The runtime's construction-time persistence choice, threaded from
   * {@link ConversationInput.persistence} into every invoked actor so an actor
   * running for a synthetic (`ephemeral`) lane cannot perform a durable
   * state-store write. Required (no default) so a newly added actor input must
   * decide, exactly like the runtime constructor.
   */
  persistence: ConversationPersistenceMode;
  target: ConversationTarget;

  projectPath: string;

  worktreePath: string;

  transcriptPath: string;
  agentBackend: AgentBackendId;
  backendRef: AgentSessionRef | null;
  /** Completed prior turns. A fresh runtime with `promptCount > 0` but no
   *  `backendRef` cannot resume — the agent starts with no memory of the
   *  transcript, which is worth a loud log signal. */
  promptCount: number;
  forkedFrom: ForkedFrom;
  role: ConversationRole;
  streamId: string | null;
  /**
   * The manager's checkpoint projection at dispatch. A `ready` projection
   * makes this turn the checkpoint's delivery: a fresh runtime with no resume
   * handle, seeded from the frozen payload ahead of the user's input. Absent
   * or null for every other turn.
   */
  checkpoint?: CheckpointActorProjection | null;
  /** Report the final admitted selection before provider dispatch so the
   *  machine can make restart replay independent of mutable defaults. */
  onModelSelectionResolved(
    modelSelection: BackendModelSelection,
  ): Promise<void>;
  debugMode: RuntimeDebugModeState | null;
}
