import { createLogger } from "@/lib/logging";
import { transitionContextStatus } from "@/lib/workflow-graph/context-transitions";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowLaneKind,
} from "@/lib/workflow-graph/schemas";

const logger = createLogger("workflow-graph.user-input-gate");

/**
 * The two lane roles that can hold a real CC conversation and therefore ask.
 * Mirrors `GraphWorkflowLaneKind` — a lane whose `workflowConversationId` is set
 * (Claude implementer/validator, Codex implementer) qualifies; a Codex validator
 * lane never sets it and is denied by default.
 */
export type LaneRole = GraphWorkflowLaneKind;

export interface LaneAskPermission {
  allowed: boolean;
  executionId?: string;
  contextId?: string;
  lane?: LaneRole;
}

/**
 * Post-turn pending-question snapshot of a lane conversation. Read by the
 * implementer and context-validator park checks to decide whether a turn ended
 * with a question batch pending on its conversation. A null `pendingQuestionId`
 * (unknown conversation, read failure, or no question) means "no park".
 */
export interface LaneConversationPendingState {
  pendingQuestionId: string | null;
  pendingQuestions: AskQuestionItem[];
}

export type RecordAnswersResult =
  | { ok: true }
  | { ok: false; reason: "already_answered" | "not_found" };

export interface EnterAwaitingUserInputInput {
  projectPath: string;
  sessionName: string;
  contextId: string;
  lane: LaneRole;
  conversationId: string;
  questionBatchId: string;
  questions: AskQuestionItem[];
}

export interface RecordAnswersInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  questionBatchId: string;
  answers: Record<string, AskQuestionAnswer>;
}

export interface ConsumeAnswersInput {
  projectPath: string;
  sessionName: string;
  contextId: string;
}

export interface ConsumeAnswersResult {
  answers: Record<string, AskQuestionAnswer>;
  questionBatchId: string;
  conversationId: string;
  lane: LaneRole;
}

/**
 * A consumed answer record threaded from the execution loop into the resumed
 * iteration so the orchestrator can pin the asking conversation and embed the
 * answers block in the follow-up (pinned) or seed (rotated) prompt. Shaped
 * identically to `ConsumeAnswersResult` — the loop passes the consume result
 * straight through.
 */
export type ResumeUserInputContext = ConsumeAnswersResult;

export interface WithdrawAllInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
}

interface PublishUserInputPendingInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  conversationId: string;
  questionBatchId: string;
  requestedAt: string;
}

interface PublishUserInputResolvedInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  conversationId: string;
  questionBatchId: string;
  resolution: "answered" | "withdrawn";
  resolvedAt: string;
}

export interface UserInputGateServiceDeps {
  /** Read the merged active execution for a session, or null. */
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  /**
   * Serialized atomic mutation of the active execution (mirrors the approval
   * gate's `mutateActive` seam). The callback receives a cloned draft; the
   * returned execution is Zod-parsed and persisted in one write-queue section.
   */
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
  /** Publish the `graph-workflow-user-input-pending` SSE event (post-commit). */
  publishUserInputPending(
    input: PublishUserInputPendingInput,
  ): GraphWorkflowExecutionEvent[];
  /** Publish the `graph-workflow-user-input-resolved` SSE event (post-commit). */
  publishUserInputResolved(
    input: PublishUserInputResolvedInput,
  ): GraphWorkflowExecutionEvent[];
  /**
   * Dispatch a conversation-machine event to a lane conversation (used only to
   * send `CLEAR_PENDING_QUESTION` on withdraw). Returns false when the actor is
   * not live — a refusal is fine (the conversation self-heals on next touch).
   */
  sendConversationEvent(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    event: ConversationEvent,
  ): boolean;
  now(): string;
}

export interface UserInputGateService {
  /**
   * Ask-route helper: reverse-look-up the conversation over
   * `laneStates[…].workflowConversationId`, then require the resolved
   * `askUserQuestions` toggle to be enabled for that context. Any unresolvable
   * conversation, a lane without a real CC conversation, or a disabled toggle
   * returns `{ allowed: false }`.
   */
  resolveLaneAskPermission(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<LaneAskPermission>;
  /**
   * Park: snapshot the questions into `pendingUserInput`, flip the context to
   * `awaiting_user_input`, and publish the pending event. If answers were
   * already recorded (fast answer / upsert-before-park), no-op and return
   * `"answers_ready"` so the caller proceeds directly with the answer block.
   */
  enterAwaitingUserInput(
    input: EnterAwaitingUserInputInput,
  ): Promise<"parked" | "answers_ready">;
  /**
   * Record answers for a batch, creating the record pre-park when the park has
   * not landed yet (fast answer). Rejects a second submission for the same
   * batch as `already_answered`; a missing/mismatched batch is `not_found`.
   */
  recordAnswers(input: RecordAnswersInput): Promise<RecordAnswersResult>;
  /**
   * Resume bookkeeping: read the recorded answers, clear the record, and flip
   * the context back to `running`. Returns null when no answers are recorded.
   */
  consumeAnswers(
    input: ConsumeAnswersInput,
  ): Promise<ConsumeAnswersResult | null>;
  /**
   * Abort path: clear every parked record, dispatch `CLEAR_PENDING_QUESTION`
   * per parked conversation, and publish `resolved(withdrawn)`. Idempotent.
   */
  withdrawAll(input: WithdrawAllInput): Promise<void>;
}

/**
 * Find the (contextId, lane) that owns a conversation by reverse-looking-up the
 * engine-uniform `workflowConversationId` field across every lane state. A lane
 * that never set the field (Codex validator) is skipped, so it never resolves.
 */
function findLaneByConversationId(
  execution: GraphWorkflowExecution,
  conversationId: string,
): { contextId: string; lane: LaneRole } | null {
  for (const [contextId, laneByKind] of Object.entries(execution.laneStates)) {
    for (const lane of Object.values(laneByKind)) {
      if (lane.workflowConversationId === conversationId) {
        return { contextId, lane: lane.lane };
      }
    }
  }
  return null;
}

function resolveAskToggleEnabled(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  const resolvedContext = execution.workingDefinition.executionContexts.find(
    (context) => context.id === contextId,
  );
  return resolvedContext?.askUserQuestions.enabled === true;
}

function findContextByBatch(
  execution: GraphWorkflowExecution,
  conversationId: string,
  questionBatchId: string,
): {
  contextId: string;
  contextState: GraphWorkflowExecutionContextState;
} | null {
  for (const [contextId, contextState] of Object.entries(
    execution.contextStates,
  )) {
    const pending = contextState.pendingUserInput;
    if (
      pending &&
      pending.conversationId === conversationId &&
      pending.questionBatchId === questionBatchId
    ) {
      return { contextId, contextState };
    }
  }
  return null;
}

export function createUserInputGateService(
  deps: UserInputGateServiceDeps,
): UserInputGateService {
  async function resolveLaneAskPermission(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<LaneAskPermission> {
    const execution = await deps.getActive(projectPath, sessionName);
    if (!execution) {
      logger.warn("gate.permission_denied", {
        sessionName,
        conversationId,
        reason: "no_active_execution",
      });
      return { allowed: false };
    }

    const resolved = findLaneByConversationId(execution, conversationId);
    if (!resolved) {
      logger.warn("gate.permission_denied", {
        executionId: execution.id,
        sessionName,
        conversationId,
        reason: "conversation_not_a_lane",
      });
      return { allowed: false };
    }

    if (!resolveAskToggleEnabled(execution, resolved.contextId)) {
      logger.warn("gate.permission_denied", {
        executionId: execution.id,
        sessionName,
        conversationId,
        contextId: resolved.contextId,
        lane: resolved.lane,
        reason: "toggle_disabled",
      });
      return { allowed: false };
    }

    logger.info("gate.permission_allowed", {
      executionId: execution.id,
      sessionName,
      conversationId,
      contextId: resolved.contextId,
      lane: resolved.lane,
    });
    return {
      allowed: true,
      executionId: execution.id,
      contextId: resolved.contextId,
      lane: resolved.lane,
    };
  }

  async function enterAwaitingUserInput(
    input: EnterAwaitingUserInputInput,
  ): Promise<"parked" | "answers_ready"> {
    let answersReady = false;
    let requestedAt = deps.now();

    const execution = await deps.mutateActive(
      input.projectPath,
      input.sessionName,
      (draft) => {
        const contextState = draft.contextStates[input.contextId];
        if (!contextState) {
          throw new Error(
            `Cannot enter awaiting user input: unknown context "${input.contextId}"`,
          );
        }

        // A record for THIS batch may already exist from an upsert-before-park
        // (fast answer). Only that same-batch record carries over its answers /
        // requestedAt; any record for a different batch is irrelevant here.
        const existing = contextState.pendingUserInput;
        const sameBatch =
          existing !== null &&
          existing.questionBatchId === input.questionBatchId;

        // Fast answer: answers were recorded before the asking turn ended. Skip
        // parking so the caller proceeds directly with the answer block (5.4).
        if (sameBatch && existing.answers !== null) {
          answersReady = true;
          return draft;
        }

        requestedAt = sameBatch ? existing.requestedAt : deps.now();
        transitionContextStatus(draft, input.contextId, "awaiting_user_input", {
          reason: "user_input_gate.enter_awaiting_user_input",
        });
        contextState.pendingUserInput = {
          conversationId: input.conversationId,
          lane: input.lane,
          questionBatchId: input.questionBatchId,
          questions: input.questions,
          requestedAt,
          answers: sameBatch ? existing.answers : null,
        };
        return draft;
      },
    );

    if (answersReady) {
      logger.info("gate.enter_skipped_answers_ready", {
        executionId: execution.id,
        contextId: input.contextId,
        lane: input.lane,
        questionBatchId: input.questionBatchId,
      });
      return "answers_ready";
    }

    deps.publishUserInputPending({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution,
      contextId: input.contextId,
      conversationId: input.conversationId,
      questionBatchId: input.questionBatchId,
      requestedAt,
    });

    logger.info("gate.parked", {
      executionId: execution.id,
      contextId: input.contextId,
      lane: input.lane,
      conversationId: input.conversationId,
      questionBatchId: input.questionBatchId,
      questionCount: input.questions.length,
      requestedAt,
    });
    return "parked";
  }

  async function recordAnswers(
    input: RecordAnswersInput,
  ): Promise<RecordAnswersResult> {
    let guardFailureReason: "already_answered" | "not_found" | null = null;
    let resolvedContextId: string | null = null;
    const answeredAt = deps.now();

    const execution = await deps.mutateActive(
      input.projectPath,
      input.sessionName,
      (draft) => {
        const match = findContextByBatch(
          draft,
          input.conversationId,
          input.questionBatchId,
        );

        // Upsert-before-park: no record for this batch yet. Create it only when
        // the conversation resolves to a lane whose context has no pending
        // record at all — a record already present for a *different* batch means
        // this batch was never registered / was superseded (`not_found`).
        if (!match) {
          const lane = findLaneByConversationId(draft, input.conversationId);
          if (!lane) {
            guardFailureReason = "not_found";
            return draft;
          }
          const contextState = draft.contextStates[lane.contextId];
          if (!contextState || contextState.pendingUserInput !== null) {
            guardFailureReason = "not_found";
            return draft;
          }
          resolvedContextId = lane.contextId;
          contextState.pendingUserInput = {
            conversationId: input.conversationId,
            lane: lane.lane,
            questionBatchId: input.questionBatchId,
            questions: [],
            requestedAt: answeredAt,
            answers: {
              byQuestionId: input.answers,
              answeredAt,
            },
          };
          return draft;
        }

        const pending = match.contextState.pendingUserInput;
        if (pending && pending.answers !== null) {
          guardFailureReason = "already_answered";
          return draft;
        }

        resolvedContextId = match.contextId;
        if (pending) {
          pending.answers = {
            byQuestionId: input.answers,
            answeredAt,
          };
        }
        return draft;
      },
    );

    if (guardFailureReason !== null) {
      logger.warn("gate.record_guard_failed", {
        executionId: execution.id,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        questionBatchId: input.questionBatchId,
        reason: guardFailureReason,
      });
      return { ok: false, reason: guardFailureReason };
    }

    if (resolvedContextId !== null) {
      deps.publishUserInputResolved({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        execution,
        contextId: resolvedContextId,
        conversationId: input.conversationId,
        questionBatchId: input.questionBatchId,
        resolution: "answered",
        resolvedAt: answeredAt,
      });
    }

    logger.info("gate.answers_recorded", {
      executionId: execution.id,
      contextId: resolvedContextId,
      conversationId: input.conversationId,
      questionBatchId: input.questionBatchId,
      answerCount: Object.keys(input.answers).length,
    });
    return { ok: true };
  }

  async function consumeAnswers(
    input: ConsumeAnswersInput,
  ): Promise<ConsumeAnswersResult | null> {
    const holder: { consumed: ConsumeAnswersResult | null } = {
      consumed: null,
    };

    const execution = await deps.mutateActive(
      input.projectPath,
      input.sessionName,
      (draft) => {
        const contextState = draft.contextStates[input.contextId];
        if (!contextState) {
          throw new Error(
            `Cannot consume answers: unknown context "${input.contextId}"`,
          );
        }
        const pending = contextState.pendingUserInput;
        if (!pending || pending.answers === null) {
          return draft;
        }

        holder.consumed = {
          answers: pending.answers.byQuestionId,
          questionBatchId: pending.questionBatchId,
          conversationId: pending.conversationId,
          lane: pending.lane,
        };
        contextState.pendingUserInput = null;
        if (contextState.status === "awaiting_user_input") {
          transitionContextStatus(draft, input.contextId, "running", {
            reason: "user_input_gate.consume_answers",
          });
        }
        return draft;
      },
    );

    const result = holder.consumed;
    if (result === null) {
      return null;
    }

    logger.info("gate.answers_consumed", {
      executionId: execution.id,
      contextId: input.contextId,
      questionBatchId: result.questionBatchId,
      conversationId: result.conversationId,
    });
    return result;
  }

  async function withdrawAll(input: WithdrawAllInput): Promise<void> {
    const withdrawn: Array<{
      contextId: string;
      conversationId: string;
      questionBatchId: string;
    }> = [];

    const execution = await deps.mutateActive(
      input.projectPath,
      input.sessionName,
      (draft) => {
        for (const [contextId, contextState] of Object.entries(
          draft.contextStates,
        )) {
          const pending = contextState.pendingUserInput;
          if (!pending) {
            continue;
          }
          withdrawn.push({
            contextId,
            conversationId: pending.conversationId,
            questionBatchId: pending.questionBatchId,
          });
          contextState.pendingUserInput = null;
          if (contextState.status === "awaiting_user_input") {
            transitionContextStatus(draft, contextId, "running", {
              reason: "user_input_gate.withdraw_all",
            });
          }
        }
        return draft;
      },
    );

    const resolvedAt = deps.now();
    for (const entry of withdrawn) {
      deps.sendConversationEvent(
        input.projectPath,
        input.sessionName,
        entry.conversationId,
        { type: "CLEAR_PENDING_QUESTION" },
      );
      deps.publishUserInputResolved({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        execution,
        contextId: entry.contextId,
        conversationId: entry.conversationId,
        questionBatchId: entry.questionBatchId,
        resolution: "withdrawn",
        resolvedAt,
      });
    }

    logger.info("gate.withdrew", {
      executionId: input.executionId,
      withdrawnCount: withdrawn.length,
      contextIds: withdrawn.map((entry) => entry.contextId),
    });
  }

  return {
    resolveLaneAskPermission,
    enterAwaitingUserInput,
    recordAnswers,
    consumeAnswers,
    withdrawAll,
  };
}
