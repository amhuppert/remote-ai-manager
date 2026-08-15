import { createLogger } from "@/lib/logging";
import { transitionContextStatus } from "@/lib/workflow-graph/context-transitions";
import { parseLaneStateKey } from "@/lib/workflow-graph/lane-identity";
import { pendingUserInputEntries } from "@/lib/workflow-graph/pending-user-input";
import { concludeValidationRound } from "@/lib/workflow-graph/validation-round";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import type { GraphWorkflowEventDelivery } from "@/lib/workflow-graph/execution-events";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowLaneKind,
  GraphWorkflowPendingUserInput,
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
  /**
   * The lane's use-site key (`implementer` / `context_validator:<assignmentId>`).
   * Lane KIND no longer identifies a lane: a cohort's validators are several
   * lanes of one kind, each able to park on its own question.
   */
  laneKey?: string;
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
  /** Which lane is parking — `implementer` or `context_validator:<assignmentId>`. */
  laneKey: string;
  conversationId: string;
  questionBatchId: string;
  questions: AskQuestionItem[];
  /**
   * The validation round the asking validator is reviewing in. Omitted (null)
   * for an implementer park, which belongs to no round and therefore survives a
   * round being cleared.
   */
  roundSeq?: number | null;
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
  /** The lane the answers belong to; nothing else may be handed them. */
  laneKey: string;
  lane: LaneRole;
  answers: Record<string, AskQuestionAnswer>;
  questionBatchId: string;
  conversationId: string;
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

export interface WithdrawRoundQuestionsInput extends WithdrawAllInput {
  /**
   * The one context whose round is ending. Omitted means every open round —
   * the pause-to-edit case, where no context keeps its roster.
   */
  contextId?: string;
  /**
   * Where a context lands once nothing holds its park open. `ready` hands it
   * back to the scheduler (pause, which leaves no runner behind); `running`
   * keeps it with the iteration that is still driving it.
   */
  releaseTo?: "ready" | "running";
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
    ) =>
      | GraphWorkflowExecution
      | ({ execution: GraphWorkflowExecution } & GraphWorkflowEventDelivery),
  ): Promise<GraphWorkflowExecution>;
  /**
   * Derive the pure `graph-workflow-user-input-pending` delivery DATA. The gate
   * returns it from the parking reducer so the mutation seam appends the event
   * rows and boundary delivery in the same transaction as the parked state.
   */
  publishUserInputPending(
    input: PublishUserInputPendingInput,
  ): GraphWorkflowEventDelivery;
  /**
   * Derive the pure `graph-workflow-user-input-resolved` delivery DATA,
   * performed via {@link deliver} post-commit (see `publishUserInputPending`).
   */
  publishUserInputResolved(
    input: PublishUserInputResolvedInput,
  ): GraphWorkflowEventDelivery;
  /**
   * Perform a derived delivery's SSE broadcast + push dispatch. The gate calls
   * this only after its parking/resolution mutation has committed, so no event
   * reaches a client before the write persists (`post-commit-delivery`).
   */
  deliver(delivery: GraphWorkflowEventDelivery): void;
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
   * Park ONE lane: snapshot its questions into that lane's slot of
   * `pendingUserInputs`, flip the context to `awaiting_user_input`, and publish
   * the pending event. Several lanes may be parked at once — a park never
   * displaces a sibling's, and there is no per-context mutex. If answers were
   * already recorded for this lane's batch (fast answer /
   * upsert-before-park), no-op and return `"answers_ready"` so the caller
   * proceeds directly with the answer block.
   */
  enterAwaitingUserInput(
    input: EnterAwaitingUserInputInput,
  ): Promise<"parked" | "answers_ready">;
  /**
   * Record answers for a batch on the lane that asked it, creating the record
   * pre-park when the park has not landed yet (fast answer). Rejects a second
   * submission for the same batch as `already_answered`; a batch matching
   * neither the lane's parked token nor a live round is `not_found`.
   */
  recordAnswers(input: RecordAnswersInput): Promise<RecordAnswersResult>;
  /**
   * Resume bookkeeping: read every answered lane's answers and clear those
   * records. The context flips back to `running` only once no lane is left
   * parked — a sibling still waiting holds the park open. Returns the consumed
   * records in lane-key order (empty when nothing is answered).
   */
  consumeAnswers(input: ConsumeAnswersInput): Promise<ConsumeAnswersResult[]>;
  /**
   * Abort path: clear every parked record, dispatch `CLEAR_PENDING_QUESTION`
   * per parked conversation, and publish `resolved(withdrawn)`. Idempotent.
   *
   * Returns the execution the withdrawal committed, so the caller reports the
   * state it is actually leaving behind rather than re-reading it.
   */
  withdrawAll(input: WithdrawAllInput): Promise<GraphWorkflowExecution>;
  /**
   * Conclude an open validation round and withdraw exactly the validator
   * questions it parked. An implementer's parked question belongs to no round
   * and survives, as it does today.
   *
   * Two callers, one rule — a question outlives its round only if someone can
   * still act on the answer. Pause-to-edit ends every context's round because
   * the roster is about to change; a round replaced mid-iteration (its candidate
   * moved) ends only its own context's, because a sibling context's round is
   * still reviewing.
   *
   * The clear and the withdrawal happen in one mutation, so a racing answer
   * either lands before it or finds a token this call has already killed —
   * there is no window in which an answer resolves a question the next round
   * would otherwise inherit.
   *
   * Returns the execution the withdrawal committed, so the caller reports the
   * state it is actually leaving behind rather than re-reading it.
   */
  withdrawRoundQuestions(
    input: WithdrawRoundQuestionsInput,
  ): Promise<GraphWorkflowExecution>;
}

/**
 * Find the (contextId, laneKey) that owns a conversation by reverse-looking-up
 * the engine-uniform `workflowConversationId` field across every lane state. A
 * lane that never set the field (a task-strategy validator, which has no ask
 * transport at all) is skipped, so it never resolves.
 */
function findLaneByConversationId(
  execution: GraphWorkflowExecution,
  conversationId: string,
): { contextId: string; laneKey: string; lane: LaneRole } | null {
  for (const [contextId, laneByKey] of Object.entries(execution.laneStates)) {
    for (const [laneKey, lane] of Object.entries(laneByKey)) {
      if (lane.workflowConversationId === conversationId) {
        return { contextId, laneKey, lane: lane.lane };
      }
    }
  }
  return null;
}

/** The lane kind a lane key encodes; throws on a key no lane could have. */
function laneKindOf(laneKey: string): LaneRole {
  const identity = parseLaneStateKey(laneKey);
  if (identity === null) {
    throw new Error(`Not a lane key: "${laneKey}"`);
  }
  return identity.lane;
}

/**
 * The round a validator ask in this context belongs to, or null when the
 * context has no open round.
 *
 * This is the other half of a validator's token: two rounds of one context can
 * ask indistinguishable batches, so the batch id alone cannot tell a live
 * question from one a superseded round left behind.
 */
function openValidationRoundSeq(
  contextState: GraphWorkflowExecutionContextState,
): number | null {
  const round = contextState.validationRound;
  if (!round || round.phase === "concluded") return null;
  return round.seq;
}

/**
 * Whether the round a validator was asking in has ENDED — the pause-to-edit
 * case. Distinct from "no round at all", which is an ask that was never
 * round-scoped and is not the round's to kill.
 */
function validationRoundIsOver(
  contextState: GraphWorkflowExecutionContextState,
): boolean {
  return contextState.validationRound?.phase === "concluded";
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

/**
 * The parked record for a (conversation, batch) pair, wherever it is standing.
 *
 * Looked up from the records rather than from `laneStates` because the record
 * is the durable fact: a park survives restarts and lane-state rebuilds, and an
 * answer to a standing question must land whatever the lane registry currently
 * says.
 */
function findParkedBatch(
  execution: GraphWorkflowExecution,
  conversationId: string,
  questionBatchId: string,
): {
  contextId: string;
  contextState: GraphWorkflowExecutionContextState;
  record: GraphWorkflowPendingUserInput;
} | null {
  for (const [contextId, contextState] of Object.entries(
    execution.contextStates,
  )) {
    for (const entry of pendingUserInputEntries(contextState)) {
      if (
        entry.record.conversationId === conversationId &&
        entry.record.questionBatchId === questionBatchId
      ) {
        return { contextId, contextState, record: entry.record };
      }
    }
  }
  return null;
}

/**
 * Return a context to the schedulable set once nothing holds its park open.
 *
 * `awaiting_user_input` describes a context waiting on a human. With no lane
 * left parked that claim is false, and leaving it standing would strand the
 * context: the loop's wait exits immediately and the scheduler never re-enters
 * a context that is not `ready`.
 *
 * Exported because per-assignment reset clears a lane's parked record outside
 * this service and must apply the same rule rather than a copy of it.
 */
export function releaseParkedContext(
  draft: GraphWorkflowExecution,
  contextId: string,
  next: "running" | "ready",
  reason: string,
): void {
  const contextState = draft.contextStates[contextId];
  if (!contextState || contextState.status !== "awaiting_user_input") return;
  if (Object.keys(contextState.pendingUserInputs).length > 0) return;
  transitionContextStatus(draft, contextId, next, { reason });
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
      laneKey: resolved.laneKey,
    });
    return {
      allowed: true,
      executionId: execution.id,
      contextId: resolved.contextId,
      lane: resolved.lane,
      laneKey: resolved.laneKey,
    };
  }

  async function enterAwaitingUserInput(
    input: EnterAwaitingUserInputInput,
  ): Promise<"parked" | "answers_ready"> {
    const lane = laneKindOf(input.laneKey);
    let answersReady = false;
    let alreadyStanding = false;
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

        // A record for THIS lane's batch may already exist from an
        // upsert-before-park (fast answer). Only that same-batch record carries
        // over its answers / requestedAt; a record for a different batch on the
        // same lane is a superseded ask and is replaced. Sibling lanes are
        // never touched.
        const existing = contextState.pendingUserInputs[input.laneKey];
        const sameBatch =
          existing !== undefined &&
          existing.questionBatchId === input.questionBatchId;

        // Fast answer: answers were recorded before the asking turn ended. Skip
        // parking so the caller proceeds directly with the answer block (5.4).
        if (sameBatch && existing.answers !== null) {
          answersReady = true;
          return draft;
        }

        // The same batch, still unanswered: this park RE-asserts a question the
        // human is already looking at — a resumed cohort carrying a lane that
        // never stopped waiting. The record is written unchanged; what the
        // caller must not do is announce it again (below), because a second
        // pending event would surface an existing question as a new one.
        alreadyStanding = sameBatch;
        requestedAt = sameBatch ? existing.requestedAt : deps.now();
        transitionContextStatus(draft, input.contextId, "awaiting_user_input", {
          reason: "user_input_gate.enter_awaiting_user_input",
        });
        contextState.pendingUserInputs[input.laneKey] = {
          conversationId: input.conversationId,
          lane,
          questionBatchId: input.questionBatchId,
          questions: input.questions,
          requestedAt,
          roundSeq: input.roundSeq ?? null,
          answers: sameBatch ? existing.answers : null,
        };
        if (alreadyStanding) return draft;
        const delivery = deps.publishUserInputPending({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: draft,
          contextId: input.contextId,
          conversationId: input.conversationId,
          questionBatchId: input.questionBatchId,
          requestedAt,
        });
        return { execution: draft, ...delivery };
      },
    );

    if (answersReady) {
      logger.info("gate.enter_skipped_answers_ready", {
        executionId: execution.id,
        contextId: input.contextId,
        laneKey: input.laneKey,
        questionBatchId: input.questionBatchId,
      });
      return "answers_ready";
    }

    if (alreadyStanding) {
      logger.info("gate.park_reasserted", {
        executionId: execution.id,
        contextId: input.contextId,
        laneKey: input.laneKey,
        questionBatchId: input.questionBatchId,
        requestedAt,
      });
      return "parked";
    }

    logger.info("gate.parked", {
      executionId: execution.id,
      contextId: input.contextId,
      laneKey: input.laneKey,
      conversationId: input.conversationId,
      questionBatchId: input.questionBatchId,
      questionCount: input.questions.length,
      roundSeq: input.roundSeq ?? null,
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
        // An answer is routed to the lane that asked, never to a context: the
        // parked record itself names the conversation and the batch, so a
        // standing question is answerable from the record alone.
        const parked = findParkedBatch(
          draft,
          input.conversationId,
          input.questionBatchId,
        );

        if (parked !== null) {
          const { contextState, record } = parked;
          // The token's other half: a batch parked in a round the context has
          // since left (superseded, or concluded by pause-to-edit) describes a
          // question nobody is waiting on any more.
          if (
            record.lane === "context_validator" &&
            record.roundSeq !== openValidationRoundSeq(contextState)
          ) {
            guardFailureReason = "not_found";
            return draft;
          }
          if (record.answers !== null) {
            guardFailureReason = "already_answered";
            return draft;
          }
          resolvedContextId = parked.contextId;
          record.answers = { byQuestionId: input.answers, answeredAt };
          return draft;
        }

        // Upsert-before-park: no record for this batch, so the answer may have
        // beaten the park. The batch is the asking lane's current in-flight ask
        // (the answer route refuses anything else against the conversation's
        // marker), and a validator's ask is only live while its round is: a
        // round already concluded leaves a dead token nothing may resolve.
        const resolved = findLaneByConversationId(draft, input.conversationId);
        if (!resolved) {
          guardFailureReason = "not_found";
          return draft;
        }
        const contextState = draft.contextStates[resolved.contextId];
        // A record already standing for this lane on ANOTHER batch means this
        // batch was superseded or re-asked; it is not the lane's live ask.
        if (
          !contextState ||
          contextState.pendingUserInputs[resolved.laneKey] !== undefined ||
          (resolved.lane === "context_validator" &&
            validationRoundIsOver(contextState))
        ) {
          guardFailureReason = "not_found";
          return draft;
        }
        resolvedContextId = resolved.contextId;
        contextState.pendingUserInputs[resolved.laneKey] = {
          conversationId: input.conversationId,
          lane: resolved.lane,
          questionBatchId: input.questionBatchId,
          questions: [],
          requestedAt: answeredAt,
          roundSeq:
            resolved.lane === "context_validator"
              ? openValidationRoundSeq(contextState)
              : null,
          answers: {
            byQuestionId: input.answers,
            answeredAt,
          },
        };
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
      deps.deliver(
        deps.publishUserInputResolved({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution,
          contextId: resolvedContextId,
          conversationId: input.conversationId,
          questionBatchId: input.questionBatchId,
          resolution: "answered",
          resolvedAt: answeredAt,
        }),
      );
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
  ): Promise<ConsumeAnswersResult[]> {
    const consumed: ConsumeAnswersResult[] = [];

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
        for (const entry of pendingUserInputEntries(contextState)) {
          const answers = entry.record.answers;
          if (answers === null) continue;
          consumed.push({
            laneKey: entry.laneKey,
            lane: entry.record.lane,
            answers: answers.byQuestionId,
            questionBatchId: entry.record.questionBatchId,
            conversationId: entry.record.conversationId,
          });
          delete contextState.pendingUserInputs[entry.laneKey];
        }
        // A sibling still waiting keeps the context parked: resuming the
        // iteration now would re-dispatch its lane and throw away the question
        // the human is still looking at.
        releaseParkedContext(
          draft,
          input.contextId,
          "running",
          "user_input_gate.consume_answers",
        );
        return draft;
      },
    );

    if (consumed.length === 0) return consumed;

    logger.info("gate.answers_consumed", {
      executionId: execution.id,
      contextId: input.contextId,
      laneKeys: consumed.map((entry) => entry.laneKey),
      questionBatchIds: consumed.map((entry) => entry.questionBatchId),
    });
    return consumed;
  }

  interface WithdrawnQuestion {
    contextId: string;
    conversationId: string;
    questionBatchId: string;
  }

  /**
   * Deliver the withdrawal of a set of parked questions: clear each asking
   * conversation's marker and publish `resolved(withdrawn)`.
   *
   * Post-commit by construction — the caller has already removed the records,
   * so a client can never see a question withdrawn that the store still holds.
   */
  function deliverWithdrawals(
    input: WithdrawAllInput,
    execution: GraphWorkflowExecution,
    withdrawn: readonly WithdrawnQuestion[],
  ): void {
    const resolvedAt = deps.now();
    for (const entry of withdrawn) {
      deps.sendConversationEvent(
        input.projectPath,
        input.sessionName,
        entry.conversationId,
        { type: "CLEAR_PENDING_QUESTION" },
      );
      deps.deliver(
        deps.publishUserInputResolved({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution,
          contextId: entry.contextId,
          conversationId: entry.conversationId,
          questionBatchId: entry.questionBatchId,
          resolution: "withdrawn",
          resolvedAt,
        }),
      );
    }
  }

  async function withdrawAll(
    input: WithdrawAllInput,
  ): Promise<GraphWorkflowExecution> {
    const withdrawn: WithdrawnQuestion[] = [];

    const execution = await deps.mutateActive(
      input.projectPath,
      input.sessionName,
      (draft) => {
        for (const [contextId, contextState] of Object.entries(
          draft.contextStates,
        )) {
          for (const entry of pendingUserInputEntries(contextState)) {
            withdrawn.push({
              contextId,
              conversationId: entry.record.conversationId,
              questionBatchId: entry.record.questionBatchId,
            });
            delete contextState.pendingUserInputs[entry.laneKey];
          }
          releaseParkedContext(
            draft,
            contextId,
            "running",
            "user_input_gate.withdraw_all",
          );
        }
        return draft;
      },
    );

    deliverWithdrawals(input, execution, withdrawn);

    logger.info("gate.withdrew", {
      executionId: input.executionId,
      withdrawnCount: withdrawn.length,
      contextIds: withdrawn.map((entry) => entry.contextId),
    });

    return execution;
  }

  async function withdrawRoundQuestions(
    input: WithdrawRoundQuestionsInput,
  ): Promise<GraphWorkflowExecution> {
    const withdrawn: WithdrawnQuestion[] = [];

    const execution = await deps.mutateActive(
      input.projectPath,
      input.sessionName,
      (draft) => {
        for (const [contextId, contextState] of Object.entries(
          draft.contextStates,
        )) {
          if (input.contextId !== undefined && contextId !== input.contextId) {
            continue;
          }
          const round = contextState.validationRound;
          if (!round || round.phase === "concluded") continue;
          // The round is over: what it was reviewing is about to be frozen
          // again, and nothing it collected may be recorded. Concluded rather
          // than erased — `seq` is what tells the next round apart from this
          // one, so it has to outlive the round it numbers.
          contextState.validationRound = concludeValidationRound(round, null);
          for (const entry of pendingUserInputEntries(contextState)) {
            // Exactly the round's questions. An implementer's park belongs to
            // no round, and neither a pause nor a moved candidate is the
            // operator's cue to lose it.
            if (entry.record.lane !== "context_validator") continue;
            withdrawn.push({
              contextId,
              conversationId: entry.record.conversationId,
              questionBatchId: entry.record.questionBatchId,
            });
            delete contextState.pendingUserInputs[entry.laneKey];
          }
          releaseParkedContext(
            draft,
            contextId,
            input.releaseTo ?? "ready",
            "user_input_gate.withdraw_round_questions",
          );
        }
        return draft;
      },
    );

    deliverWithdrawals(input, execution, withdrawn);

    logger.info("gate.withdrew_round_questions", {
      executionId: input.executionId,
      withdrawnCount: withdrawn.length,
      contextIds: withdrawn.map((entry) => entry.contextId),
    });
    return execution;
  }

  return {
    resolveLaneAskPermission,
    enterAwaitingUserInput,
    recordAnswers,
    consumeAnswers,
    withdrawAll,
    withdrawRoundQuestions,
  };
}
