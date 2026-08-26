/**
 * The plan-repair supervisor (docs/design/cc-cli/08): after an execution loop
 * settles in a retry-exhaustion halt, run one bounded, audited repair round —
 * append the round (crash-safe accounting), run the repair agent, validate its
 * untrusted operations through the plan/controls split, apply them via the
 * shared live-edit core with the server-derived `plan-repair` source, and
 * resume. Declines and failures leave the run halted with the diagnosis in
 * `haltReason.summary`.
 *
 * NOT a fourth orchestration shape: this composes existing lifecycle verbs
 * (halt inspection, live edits, resume) exactly like an operator scripting
 * `cctl workflow live` — server-side, fenced, and bounded by the round caps.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  PLAN_REPAIR_DEFAULT_AGENT,
  PLAN_REPAIR_TURN_TIMEOUT_MS,
  type GraphWorkflowAgentConfig,
} from "../config-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  PlanRepairRound,
} from "../schemas";
import type {
  GraphWorkflowEventDelivery,
  PublishPlanRepairInput,
} from "../execution-events";
import {
  MutationRefusedError,
  mutateActiveOrRefuse,
  type MutateActiveResult,
} from "../execution-repository";
import type {
  LiveEditApplyOutcome,
  LiveEditApplyRequest,
} from "../live-edit-apply";
import {
  buildPlanRepairPrompt,
  type PlanRepairValidationVerdict,
} from "./prompt";
import {
  expandPlanRepairOperations,
  validatePlanRepairOperations,
  type PlanRepairLoopContext,
  type PlanRepairOperationIssue,
  type PlanRepairVerdict,
} from "./schemas";
import { evaluatePlanRepairTrigger } from "./trigger";

const logger = createLogger("workflow.plan-repair");

export interface PlanRepairAgentInvocation {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
  conversationId: string;
  worktreePath: string;
  prompt: string;
  agent: GraphWorkflowAgentConfig;
  timeoutMs: number;
}

export type PlanRepairAgentResult =
  | {
      kind: "verdict";
      verdict: PlanRepairVerdict;
      conversationId: string;
    }
  | { kind: "error"; message: string; conversationId: string };

/** Round-lifecycle payload emitted as a `graph-workflow-plan-repair` event. */
export type PlanRepairRoundConclusion = Omit<
  PublishPlanRepairInput,
  "projectPath" | "sessionName" | "executionId"
>;

export interface PlanRepairSupervisorDeps {
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
  /** The shared live-edit apply core — the ONLY mutation path for repairs. */
  applyLiveEdits(input: {
    projectPath: string;
    sessionName: string;
    request: LiveEditApplyRequest;
  }): Promise<LiveEditApplyOutcome>;
  runRepairAgent(
    invocation: PlanRepairAgentInvocation,
  ): Promise<PlanRepairAgentResult>;
  /**
   * normalize → resume → kick off the loop (the RESUME handler trio), fenced
   * on the round's execution identity: the trio addresses the SESSION, and the
   * run this round examined may have been abandoned and replaced while its
   * agent turn was open.
   */
  resumeExecution(input: {
    projectPath: string;
    sessionName: string;
    projectName: string;
    executionId: string;
  }): Promise<void>;
  getValidationHistory(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<PlanRepairValidationVerdict[]>;
  getSessionWorktreePath(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;
  /**
   * Derive the round-conclusion event (+ its push descriptors). Appended and
   * broadcast through the serialized mutation, like every other graph
   * workflow event; the dispatcher derives the outcome pushes from it.
   */
  publishPlanRepairRound(
    input: PublishPlanRepairInput,
  ): GraphWorkflowEventDelivery;
  now(): string;
}

export interface MaybeRunPlanRepairInput {
  projectPath: string;
  sessionName: string;
  projectName: string;
}

export type PlanRepairRunResult =
  | { ran: false; reason: string }
  | {
      ran: true;
      outcome: "repaired" | "declined" | "failed" | "superseded";
      seq: number;
    };

function repairConversationId(
  executionId: string,
  contextId: string,
  seq: number,
): string {
  return `__plan_repair__:${executionId}:${contextId}:${seq}`;
}

/**
 * Raised INSIDE a concluding reducer when the session's active row is no
 * longer the run this round examined, which aborts the mutation.
 *
 * Returning the row unchanged would not do: the mutation seam stamps its
 * staging fences on every committed write, so a "no-op" settle still advances
 * the successor's `executionStateRevision` — and any event the reducer carried
 * would still land in the successor's ledger. Refusing the write is the fence;
 * writing the same bytes back is not.
 */
class PlanRepairExecutionFenceError extends MutationRefusedError {
  constructor(
    write: string,
    readonly expectedExecutionId: string,
    readonly activeExecutionId: string,
  ) {
    super(write);
    this.name = "PlanRepairExecutionFenceError";
    this.message = `Plan repair ${write} belongs to execution ${expectedExecutionId}, but ${activeExecutionId} holds the session's execution lease`;
  }
}

/**
 * Whether a halt is still the one a round was triggered by. Loop halts key on
 * the loop group (the pass instance in `contextId` changes across a
 * re-decision); context halts key on the context.
 */
function haltMatchesSubject(
  haltReason: GraphWorkflowHaltReason,
  subject: { contextId: string; loopGroupId: string | null },
): boolean {
  if (haltReason.type === "loop_limit_reached") {
    return haltReason.loopGroupId === subject.loopGroupId;
  }
  if (
    haltReason.type !== "circuit_breaker" &&
    haltReason.type !== "max_iterations" &&
    haltReason.type !== "plan_defect" &&
    haltReason.type !== "candidate_unstable" &&
    haltReason.type !== "ownership_violation"
  ) {
    return false;
  }
  return (
    subject.loopGroupId === null && haltReason.contextId === subject.contextId
  );
}

export function createPlanRepairSupervisor(deps: PlanRepairSupervisorDeps) {
  const inFlight = new Set<string>();

  async function maybeRunPlanRepair(
    input: MaybeRunPlanRepairInput,
  ): Promise<PlanRepairRunResult> {
    const key = `${input.projectPath}::${input.sessionName}`;
    if (inFlight.has(key)) {
      return { ran: false, reason: "in_flight" };
    }
    inFlight.add(key);
    try {
      return await runOnce(input);
    } catch (error) {
      // The supervisor is invoked fire-and-forget after a loop settles; it
      // must never propagate. The halt state is untouched on an internal
      // failure, so the execution stays operator-recoverable.
      logger.error("plan_repair.supervisor_error", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        error: getErrorMessage(error),
      });
      return { ran: false, reason: "internal_error" };
    } finally {
      inFlight.delete(key);
    }
  }

  async function runOnce(
    input: MaybeRunPlanRepairInput,
  ): Promise<PlanRepairRunResult> {
    const { projectPath, sessionName } = input;

    // Always evaluate against a FRESH read — the loop's returned snapshot can
    // be stale when the loop was fenced out (design R1).
    const execution = await deps.getActiveExecution(projectPath, sessionName);
    if (!execution) {
      return { ran: false, reason: "no_execution" };
    }

    const trigger = evaluatePlanRepairTrigger(execution);
    if (!trigger.eligible) {
      if (
        trigger.reason === "context_attempts_exhausted" ||
        trigger.reason === "execution_rounds_exhausted"
      ) {
        await handleExhaustion(input, execution, trigger.reason);
      } else {
        logger.info("plan_repair.not_triggered", {
          executionId: execution.id,
          reason: trigger.reason,
        });
      }
      return { ran: false, reason: trigger.reason };
    }

    const { contextId, haltType, loopGroupId, attempt, policy } = trigger;
    const executionId = execution.id;
    // The halted loop, threaded into the op validator. Null for a context halt,
    // which is what keeps the loop-control ops refused there.
    const loop: PlanRepairLoopContext | null =
      loopGroupId !== null && trigger.loopScope !== null
        ? { loopGroupId, scope: trigger.loopScope }
        : null;
    logger.info("plan_repair.triggered", {
      executionId,
      contextId,
      haltType,
      loopGroupId,
      attempt,
    });

    // Append the round BEFORE the agent runs (crash-safe accounting, R4). The
    // trigger is re-evaluated inside the serialized mutation: a user resume or
    // abort between the read and this write withdraws without a trace.
    let appended: PlanRepairRound | null = null;
    let priorRounds: PlanRepairRound[] = [];
    await mutateFenced(input, executionId, "append_round", (current) => {
      const recheck = evaluatePlanRepairTrigger(current);
      if (
        !recheck.eligible ||
        recheck.contextId !== contextId ||
        recheck.loopGroupId !== loopGroupId
      ) {
        // Withdrawn, not merely unchanged: a resume or abort landed between the
        // trigger read and this write, and the round it authorized no longer
        // has a subject. Returning `current` would commit for a round that
        // never starts.
        throw new MutationRefusedError("append_round");
      }
      const next = structuredClone(current);
      priorRounds = current.planRepairRounds;
      const seq = (current.planRepairRounds.at(-1)?.seq ?? 0) + 1;
      appended = {
        seq,
        contextId,
        haltType,
        loopGroupId,
        startedAt: deps.now(),
        settledAt: null,
        outcome: null,
        planningDefect: null,
        diagnosis: null,
        operationCount: 0,
        resumed: false,
        // Filed with the round rather than at settle: the handle is derived
        // from identity the reducer already holds, and it is the only way to
        // check the claim that an agent is working — which is a question that
        // stops mattering the moment the round concludes.
        conversationId: repairConversationId(executionId, contextId, seq),
      };
      next.planRepairRounds = [...next.planRepairRounds, appended];
      return next;
    });
    if (appended === null) {
      logger.info("plan_repair.superseded_before_start", { executionId });
      return { ran: false, reason: "superseded" };
    }
    const round: PlanRepairRound = appended;

    // Announced before the turn opens, never after it: the append changes no
    // status, no active context and no halt reason, so this is the only thing
    // that leaves the server while the agent works — and a UI told only at the
    // conclusion reports an inert halt for the whole of a minutes-long repair.
    await emitRound(input, executionId, {
      contextId,
      haltType,
      loopGroupId,
      attempt,
      outcome: "started",
      planningDefect: null,
      diagnosis: null,
      operationCount: 0,
      resumed: false,
      conversationId: round.conversationId,
    });

    const worktreePath = await deps.getSessionWorktreePath(
      projectPath,
      sessionName,
    );
    if (worktreePath === null) {
      await settleRound(input, executionId, round.seq, {
        outcome: "failed",
        diagnosis: "plan repair could not resolve the session worktree",
        // The handle the round was filed with never became a conversation —
        // the turn was refused before the agent ran. Cleared rather than left
        // pointing at a transcript that does not exist.
        conversationId: null,
      });
      await populateHaltSummary(
        input,
        executionId,
        { contextId, loopGroupId },
        "Plan repair failed: no session worktree available for the repair agent.",
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
        loopGroupId,
        attempt,
        outcome: "failed",
        planningDefect: null,
        diagnosis: "plan repair could not resolve the session worktree",
        operationCount: 0,
        resumed: false,
        conversationId: null,
      });
      return { ran: true, outcome: "failed", seq: round.seq };
    }

    const validationHistory = await deps.getValidationHistory(
      input.projectPath,
      input.sessionName,
      executionId,
      contextId,
    );
    // The handle the round was filed with, so the transcript an operator opens
    // mid-turn is the one the agent is writing.
    const conversationId =
      round.conversationId ??
      repairConversationId(executionId, contextId, round.seq);
    const prompt = buildPlanRepairPrompt({
      execution,
      contextId,
      haltReason: execution.haltReason!,
      attempt,
      validationHistory,
      priorRounds,
      ...(loop ? { loop } : {}),
    });

    const agentResult = await deps.runRepairAgent({
      projectPath,
      sessionName,
      executionId,
      contextId,
      conversationId,
      worktreePath,
      prompt,
      agent: policy.agent ?? PLAN_REPAIR_DEFAULT_AGENT,
      timeoutMs: PLAN_REPAIR_TURN_TIMEOUT_MS,
    });

    if (agentResult.kind === "error") {
      logger.warn("plan_repair.agent_failed", {
        executionId,
        contextId,
        attempt,
        error: agentResult.message,
      });
      await settleRound(input, executionId, round.seq, {
        outcome: "failed",
        diagnosis: `repair agent turn failed: ${agentResult.message}`,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        executionId,
        { contextId, loopGroupId },
        `Plan repair attempt ${attempt} failed: ${agentResult.message}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
        loopGroupId,
        attempt,
        outcome: "failed",
        planningDefect: null,
        diagnosis: agentResult.message,
        operationCount: 0,
        resumed: false,
        conversationId: agentResult.conversationId,
      });
      return { ran: true, outcome: "failed", seq: round.seq };
    }

    const { verdict } = agentResult;
    logger.info("plan_repair.verdict", {
      executionId,
      contextId,
      attempt,
      planningDefect: verdict.planningDefect,
      operationCount: verdict.operations.length,
    });

    if (!verdict.planningDefect || verdict.operations.length === 0) {
      await settleRound(input, executionId, round.seq, {
        outcome: "declined",
        planningDefect: verdict.planningDefect,
        diagnosis: verdict.diagnosis,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        executionId,
        { contextId, loopGroupId },
        `Plan repair declined (attempt ${attempt}): ${verdict.diagnosis}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
        loopGroupId,
        attempt,
        outcome: "declined",
        planningDefect: verdict.planningDefect,
        diagnosis: verdict.diagnosis,
        operationCount: 0,
        resumed: false,
        conversationId: agentResult.conversationId,
      });
      return { ran: true, outcome: "declined", seq: round.seq };
    }

    // Judged against the same snapshot the prompt was built from — the agent's
    // output is diagnosed against what the agent was shown, while loop-control
    // operations are constrained to the loop and budget scope that halted.
    // Narrowings stay in repair vocabulary here; the cohort they are written
    // onto is decided at apply time, below.
    const validated = validatePlanRepairOperations(
      verdict.operations,
      execution.workingDefinition.executionContexts,
      loop,
    );
    if (!validated.ok) {
      const issueSummary = validated.issues
        .map((issue) => `[${issue.index}] ${issue.message}`)
        .join("; ");
      logger.warn("plan_repair.operations_rejected", {
        executionId,
        contextId,
        attempt,
        issues: issueSummary,
      });
      await settleRound(input, executionId, round.seq, {
        outcome: "failed",
        planningDefect: true,
        diagnosis: `${verdict.diagnosis} — repair operations rejected: ${issueSummary}`,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        executionId,
        { contextId, loopGroupId },
        `Plan repair attempt ${attempt} produced disallowed operations: ${issueSummary}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
        loopGroupId,
        attempt,
        outcome: "failed",
        planningDefect: true,
        diagnosis: verdict.diagnosis,
        operationCount: verdict.operations.length,
        resumed: false,
        conversationId: agentResult.conversationId,
      });
      return { ran: true, outcome: "failed", seq: round.seq };
    }

    // Apply through the shared core. One re-read retry on a revision conflict;
    // any other rejection means the operator got there first (superseded) or
    // the batch is invalid against current state (failed).
    let applyOutcome: LiveEditApplyOutcome | null = null;
    let staleIssues: PlanRepairOperationIssue[] | null = null;
    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      const fresh = await deps.getActiveExecution(projectPath, sessionName);
      if (!fresh || fresh.id !== executionId || fresh.status !== "halted") {
        applyOutcome = null;
        break;
      }
      // Expanded from the SAME snapshot `baseLiveRevision` pins below, not from
      // the one the agent was shown: a narrowing is carried out as a whole-
      // cohort write, so expanding it from the older roster would revert any
      // cohort edit an operator made during the agent's turn. Anything that
      // lands between this read and the apply trips the revision conflict and
      // re-expands on the retry.
      const expanded = expandPlanRepairOperations(
        validated.operations,
        fresh.workingDefinition.executionContexts,
      );
      if (!expanded.ok) {
        staleIssues = expanded.issues;
        applyOutcome = null;
        break;
      }
      applyOutcome = await deps.applyLiveEdits({
        projectPath,
        sessionName,
        request: {
          executionId,
          baseLiveRevision: fresh.liveRevision,
          source: "plan-repair",
          operations: expanded.operations,
        },
      });
      if (
        !applyOutcome.ok &&
        applyOutcome.kind === "rejected" &&
        applyOutcome.failure.code === "revision_conflict"
      ) {
        continue;
      }
      break;
    }

    // The repair still parses, but it no longer describes the plan in front of
    // it — an operator removed what it named. Fail closed: a narrowing may only
    // ever take authority away from a seat that exists, never re-create one.
    if (staleIssues !== null) {
      const issueSummary = staleIssues
        .map((issue) => `[${issue.index}] ${issue.message}`)
        .join("; ");
      logger.warn("plan_repair.operations_stale", {
        executionId,
        contextId,
        attempt,
        issues: issueSummary,
      });
      await settleRound(input, executionId, round.seq, {
        outcome: "failed",
        planningDefect: true,
        diagnosis: `${verdict.diagnosis} — repair operations no longer match the current plan: ${issueSummary}`,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        executionId,
        { contextId, loopGroupId },
        `Plan repair attempt ${attempt} no longer matches the current plan (it was edited while the repair ran): ${issueSummary}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
        loopGroupId,
        attempt,
        outcome: "failed",
        planningDefect: true,
        diagnosis: verdict.diagnosis,
        operationCount: validated.operations.length,
        resumed: false,
        conversationId: agentResult.conversationId,
      });
      return { ran: true, outcome: "failed", seq: round.seq };
    }

    const supersededOutcome =
      applyOutcome !== null &&
      applyOutcome.ok === false &&
      (applyOutcome.kind === "no_active_execution" ||
        (applyOutcome.kind === "rejected" &&
          (applyOutcome.failure.code === "not_editable" ||
            applyOutcome.failure.code === "execution_mismatch")));
    if (applyOutcome === null || supersededOutcome) {
      logger.info("plan_repair.superseded_before_apply", {
        executionId,
        contextId,
        attempt,
      });
      await settleRound(input, executionId, round.seq, {
        outcome: "superseded",
        planningDefect: true,
        diagnosis: verdict.diagnosis,
        conversationId: agentResult.conversationId,
      });
      // Audit-only conclusion — the publisher suppresses the push.
      await emitRound(input, executionId, {
        contextId,
        haltType,
        loopGroupId,
        attempt,
        outcome: "superseded",
        planningDefect: true,
        diagnosis: verdict.diagnosis,
        operationCount: 0,
        resumed: false,
        conversationId: agentResult.conversationId,
      });
      return { ran: true, outcome: "superseded", seq: round.seq };
    }

    if (!applyOutcome.ok) {
      const failure =
        applyOutcome.kind === "rejected"
          ? `${applyOutcome.failure.code}: ${applyOutcome.failure.error}`
          : applyOutcome.kind;
      logger.warn("plan_repair.apply_rejected", {
        executionId,
        contextId,
        attempt,
        failure,
      });
      await settleRound(input, executionId, round.seq, {
        outcome: "failed",
        planningDefect: true,
        diagnosis: `${verdict.diagnosis} — apply rejected: ${failure}`,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        executionId,
        { contextId, loopGroupId },
        `Plan repair attempt ${attempt} was rejected by the live-edit gates: ${failure}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
        loopGroupId,
        attempt,
        outcome: "failed",
        planningDefect: true,
        diagnosis: verdict.diagnosis,
        operationCount: validated.operations.length,
        resumed: false,
        conversationId: agentResult.conversationId,
      });
      return { ran: true, outcome: "failed", seq: round.seq };
    }

    logger.info("plan_repair.applied", {
      executionId,
      contextId,
      attempt,
      operationCount: validated.operations.length,
      liveRevision: applyOutcome.liveRevision,
    });

    // Resume last: settle the round first so the applied repair is durable
    // even if resume fails (e.g. the user aborted underneath us).
    await settleRound(input, executionId, round.seq, {
      outcome: "repaired",
      planningDefect: true,
      diagnosis: verdict.diagnosis,
      operationCount: validated.operations.length,
      conversationId: agentResult.conversationId,
    });

    let resumed = false;
    try {
      await deps.resumeExecution({ ...input, executionId });
      resumed = true;
    } catch (error) {
      logger.warn("plan_repair.resume_failed", {
        executionId,
        contextId,
        attempt,
        error: getErrorMessage(error),
      });
    }
    if (resumed) {
      await settleRound(input, executionId, round.seq, { resumed: true });
      logger.info("plan_repair.resumed", { executionId, contextId, attempt });
    }

    await emitRound(input, executionId, {
      contextId,
      haltType,
      loopGroupId,
      attempt,
      outcome: "repaired",
      planningDefect: true,
      diagnosis: verdict.diagnosis,
      operationCount: validated.operations.length,
      resumed,
      conversationId: agentResult.conversationId,
    });
    return { ran: true, outcome: "repaired", seq: round.seq };
  }

  /**
   * `executionId` is the identity captured at round start, and every
   * concluding write is fenced on it (D7 decision D5). These writes address the
   * SESSION's active row, which an abandon-plus-relaunch turns over mid-round:
   * a successor relaunched from the same plan carries the same context ids and
   * restarts its round numbering at 1, so a seq or halt-subject match on the
   * successor is exactly the collision that would otherwise let a concluded
   * round settle itself onto a run it never examined.
   */
  async function settleRound(
    input: MaybeRunPlanRepairInput,
    executionId: string,
    seq: number,
    patch: Partial<PlanRepairRound>,
  ): Promise<void> {
    await mutateFenced(input, executionId, "settle_round", (current) => {
      const index = current.planRepairRounds.findIndex(
        (round) => round.seq === seq,
      );
      if (index === -1) throw new MutationRefusedError("settle_round");
      const next = structuredClone(current);
      const existing = next.planRepairRounds[index]!;
      next.planRepairRounds[index] = {
        ...existing,
        ...patch,
        settledAt: existing.settledAt ?? deps.now(),
      };
      return next;
    });
  }

  /**
   * Every concluding write goes through here so the identity check is part of
   * the serialized mutation rather than a read that precedes it: the row can
   * turn over between an advisory read and the write it authorizes, and only a
   * check inside the reducer sees the row the commit will actually replace.
   */
  async function mutateFenced(
    input: MaybeRunPlanRepairInput,
    executionId: string,
    write: string,
    reduce: (
      current: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution | null> {
    // Holder rather than a bare `let`: TS flow analysis does not see the
    // closure assignment, so a local would narrow to `never` at the read below.
    const fenced: { rejection: PlanRepairExecutionFenceError | null } = {
      rejection: null,
    };
    const written = await mutateActiveOrRefuse(() =>
      deps.mutateActive(input.projectPath, input.sessionName, (current) => {
        if (current.id !== executionId) {
          const rejected = new PlanRepairExecutionFenceError(
            write,
            executionId,
            current.id,
          );
          fenced.rejection = rejected;
          throw rejected;
        }
        return reduce(current);
      }),
    );
    // Logged out here, never in the reducer: `createLogger` appends to disk
    // synchronously and the reducer runs inside the write queue.
    const rejection = fenced.rejection;
    if (rejection !== null) {
      logger.warn("plan_repair.write_fenced", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        write,
        expectedExecutionId: rejection.expectedExecutionId,
        activeExecutionId: rejection.activeExecutionId,
      });
    }
    return written;
  }

  /**
   * Record the repair verdict on the halt reason so the halt UI explains
   * itself (R8). Guarded: only while still halted on the SAME halt this round
   * was triggered by — a user resume/abort wins. A loop halt is identified by
   * its loop group, not its context: the context is a pass instance, and a
   * resume that re-decides and re-halts names a different one.
   */
  async function populateHaltSummary(
    input: MaybeRunPlanRepairInput,
    executionId: string,
    subject: { contextId: string; loopGroupId: string | null },
    summary: string,
  ): Promise<void> {
    await mutateFenced(input, executionId, "halt_summary", (current) => {
      if (current.status !== "halted" || current.haltReason === null) {
        throw new MutationRefusedError("halt_summary");
      }
      if (!haltMatchesSubject(current.haltReason, subject)) {
        throw new MutationRefusedError("halt_summary");
      }
      const next = structuredClone(current);
      const nextReason = next.haltReason;
      if (
        nextReason?.type === "circuit_breaker" ||
        nextReason?.type === "max_iterations" ||
        nextReason?.type === "loop_limit_reached" ||
        nextReason?.type === "plan_defect" ||
        nextReason?.type === "candidate_unstable" ||
        nextReason?.type === "ownership_violation"
      ) {
        nextReason.summary = summary;
      }
      return next;
    });
  }

  async function handleExhaustion(
    input: MaybeRunPlanRepairInput,
    execution: GraphWorkflowExecution,
    reason: "context_attempts_exhausted" | "execution_rounds_exhausted",
  ): Promise<void> {
    const haltReason = execution.haltReason;
    if (
      haltReason?.type !== "circuit_breaker" &&
      haltReason?.type !== "max_iterations" &&
      haltReason?.type !== "loop_limit_reached" &&
      haltReason?.type !== "plan_defect" &&
      haltReason?.type !== "candidate_unstable" &&
      haltReason?.type !== "ownership_violation"
    ) {
      return;
    }
    // Only announce exhaustion once per halt — a summary is already the
    // durable marker that repair has spoken.
    if (haltReason.summary !== null) return;
    const contextId = haltReason.contextId;
    const loopGroupId =
      haltReason.type === "loop_limit_reached" ? haltReason.loopGroupId : null;
    // Counted exactly the way the trigger counts them, so the number the
    // operator reads is the budget that actually ran out.
    const attempts = execution.planRepairRounds.filter((round) =>
      loopGroupId === null
        ? round.loopGroupId === null && round.contextId === contextId
        : round.loopGroupId === loopGroupId,
    ).length;
    logger.info("plan_repair.exhausted", {
      executionId: execution.id,
      contextId,
      loopGroupId,
      reason,
      attempts,
    });
    await populateHaltSummary(
      input,
      execution.id,
      { contextId, loopGroupId },
      `Plan repair attempts exhausted (${attempts} round(s) for ${loopGroupId === null ? "this context" : "this loop"}). Human review required — see the plan-repair rounds for the diagnoses.`,
    );
    // Event-only outcome (`exhausted` never appears in the round log): the
    // audit row + warning push for "repair has given up on this halt".
    await emitRound(input, execution.id, {
      contextId,
      haltType: haltReason.type,
      loopGroupId,
      attempt: attempts,
      outcome: "exhausted",
      planningDefect: null,
      diagnosis: null,
      operationCount: 0,
      resumed: false,
      conversationId: null,
    });
  }

  /**
   * Append + broadcast the round-conclusion event through the serialized
   * mutation (the repository persists delivery events atomically with the
   * execution write and dispatches pushes post-commit). Best-effort: the round
   * log is the durable record; a failed emit never fails the run.
   *
   * Fenced like every other concluding write: the event is filed against the
   * SESSION's active row, so an unfenced emit records this run's repair round
   * in the ledger of whichever successor took the slot.
   */
  async function emitRound(
    input: MaybeRunPlanRepairInput,
    executionId: string,
    conclusion: PlanRepairRoundConclusion,
  ): Promise<void> {
    try {
      await mutateFenced(input, executionId, "round_event", (current) => ({
        execution: current,
        ...deps.publishPlanRepairRound({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          executionId,
          ...conclusion,
        }),
      }));
    } catch (error) {
      logger.warn("plan_repair.event_emit_failed", {
        executionId,
        outcome: conclusion.outcome,
        error: getErrorMessage(error),
      });
    }
  }

  return { maybeRunPlanRepair };
}

export type PlanRepairSupervisor = ReturnType<
  typeof createPlanRepairSupervisor
>;
