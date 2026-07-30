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
import type { GraphWorkflowAgentConfig } from "../config-schemas";
import type {
  GraphWorkflowExecution,
  PlanRepairRound,
} from "../schemas";
import type {
  GraphWorkflowEventDelivery,
  PublishPlanRepairInput,
} from "../execution-events";
import type { MutateActiveResult } from "../execution-repository";
import type {
  LiveEditApplyOutcome,
  LiveEditApplyRequest,
} from "../live-edit-apply";
import {
  buildPlanRepairPrompt,
  type PlanRepairValidationVerdict,
} from "./prompt";
import {
  validatePlanRepairOperations,
  type PlanRepairVerdict,
} from "./schemas";
import { evaluatePlanRepairTrigger } from "./trigger";

const logger = createLogger("workflow.plan-repair");

/** Bounded turn for the one-shot repair agent. */
export const PLAN_REPAIR_TURN_TIMEOUT_MS = 15 * 60_000;

/** Rare, high-stakes invocations — default to the strongest configuration. */
export const PLAN_REPAIR_DEFAULT_AGENT: GraphWorkflowAgentConfig = {
  backend: "claude",
  model: "opus",
  reasoningEffort: "high",
};

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

/** Round-conclusion payload emitted as a `graph-workflow-plan-repair` event. */
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
  /** normalize → resume → kick off the loop (the RESUME handler trio). */
  resumeExecution(input: {
    projectPath: string;
    sessionName: string;
    projectName: string;
  }): Promise<void>;
  getValidationHistory(
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

    const { contextId, haltType, attempt, policy } = trigger;
    const executionId = execution.id;
    logger.info("plan_repair.triggered", {
      executionId,
      contextId,
      haltType,
      attempt,
    });

    // Append the round BEFORE the agent runs (crash-safe accounting, R4). The
    // trigger is re-evaluated inside the serialized mutation: a user resume or
    // abort between the read and this write withdraws without a trace.
    let appended: PlanRepairRound | null = null;
    let priorRounds: PlanRepairRound[] = [];
    await deps.mutateActive(projectPath, sessionName, (current) => {
      const recheck = evaluatePlanRepairTrigger(current);
      if (
        !recheck.eligible ||
        recheck.contextId !== contextId ||
        current.id !== executionId
      ) {
        return current;
      }
      const next = structuredClone(current);
      priorRounds = current.planRepairRounds;
      appended = {
        seq: (current.planRepairRounds.at(-1)?.seq ?? 0) + 1,
        contextId,
        haltType,
        startedAt: deps.now(),
        settledAt: null,
        outcome: null,
        planningDefect: null,
        diagnosis: null,
        operationCount: 0,
        resumed: false,
        conversationId: null,
      };
      next.planRepairRounds = [...next.planRepairRounds, appended];
      return next;
    });
    if (appended === null) {
      logger.info("plan_repair.superseded_before_start", { executionId });
      return { ran: false, reason: "superseded" };
    }
    const round: PlanRepairRound = appended;

    const worktreePath = await deps.getSessionWorktreePath(
      projectPath,
      sessionName,
    );
    if (worktreePath === null) {
      await settleRound(input, round.seq, {
        outcome: "failed",
        diagnosis: "plan repair could not resolve the session worktree",
      });
      await populateHaltSummary(
        input,
        contextId,
        "Plan repair failed: no session worktree available for the repair agent.",
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
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
      executionId,
      contextId,
    );
    const conversationId = repairConversationId(
      executionId,
      contextId,
      round.seq,
    );
    const prompt = buildPlanRepairPrompt({
      execution,
      contextId,
      haltReason: execution.haltReason!,
      attempt,
      validationHistory,
      priorRounds,
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
      await settleRound(input, round.seq, {
        outcome: "failed",
        diagnosis: `repair agent turn failed: ${agentResult.message}`,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        contextId,
        `Plan repair attempt ${attempt} failed: ${agentResult.message}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
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
      await settleRound(input, round.seq, {
        outcome: "declined",
        planningDefect: verdict.planningDefect,
        diagnosis: verdict.diagnosis,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        contextId,
        `Plan repair declined (attempt ${attempt}): ${verdict.diagnosis}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
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

    const validated = validatePlanRepairOperations(verdict.operations);
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
      await settleRound(input, round.seq, {
        outcome: "failed",
        planningDefect: true,
        diagnosis: `${verdict.diagnosis} — repair operations rejected: ${issueSummary}`,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        contextId,
        `Plan repair attempt ${attempt} produced disallowed operations: ${issueSummary}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
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
    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
      const fresh = await deps.getActiveExecution(projectPath, sessionName);
      if (!fresh || fresh.id !== executionId || fresh.status !== "halted") {
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
          operations: validated.operations,
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
      await settleRound(input, round.seq, {
        outcome: "superseded",
        planningDefect: true,
        diagnosis: verdict.diagnosis,
        conversationId: agentResult.conversationId,
      });
      // Audit-only conclusion — the publisher suppresses the push.
      await emitRound(input, executionId, {
        contextId,
        haltType,
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
      await settleRound(input, round.seq, {
        outcome: "failed",
        planningDefect: true,
        diagnosis: `${verdict.diagnosis} — apply rejected: ${failure}`,
        conversationId: agentResult.conversationId,
      });
      await populateHaltSummary(
        input,
        contextId,
        `Plan repair attempt ${attempt} was rejected by the live-edit gates: ${failure}`,
      );
      await emitRound(input, executionId, {
        contextId,
        haltType,
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
    await settleRound(input, round.seq, {
      outcome: "repaired",
      planningDefect: true,
      diagnosis: verdict.diagnosis,
      operationCount: validated.operations.length,
      conversationId: agentResult.conversationId,
    });

    let resumed = false;
    try {
      await deps.resumeExecution(input);
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
      await settleRound(input, round.seq, { resumed: true });
      logger.info("plan_repair.resumed", { executionId, contextId, attempt });
    }

    await emitRound(input, executionId, {
      contextId,
      haltType,
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

  async function settleRound(
    input: MaybeRunPlanRepairInput,
    seq: number,
    patch: Partial<PlanRepairRound>,
  ): Promise<void> {
    await deps.mutateActive(input.projectPath, input.sessionName, (current) => {
      const index = current.planRepairRounds.findIndex(
        (round) => round.seq === seq,
      );
      if (index === -1) return current;
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
   * Record the repair verdict on the halt reason so the halt UI explains
   * itself (R8). Guarded: only while still halted on the same retry-exhaustion
   * halt for the same context — a user resume/abort wins.
   */
  async function populateHaltSummary(
    input: MaybeRunPlanRepairInput,
    contextId: string,
    summary: string,
  ): Promise<void> {
    await deps.mutateActive(input.projectPath, input.sessionName, (current) => {
      if (current.status !== "halted" || current.haltReason === null) {
        return current;
      }
      const haltReason = current.haltReason;
      if (
        (haltReason.type !== "circuit_breaker" &&
          haltReason.type !== "max_iterations") ||
        haltReason.contextId !== contextId
      ) {
        return current;
      }
      const next = structuredClone(current);
      const nextReason = next.haltReason;
      if (
        nextReason?.type === "circuit_breaker" ||
        nextReason?.type === "max_iterations"
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
      haltReason?.type !== "max_iterations"
    ) {
      return;
    }
    // Only announce exhaustion once per halt — a summary is already the
    // durable marker that repair has spoken.
    if (haltReason.summary !== null) return;
    const contextId = haltReason.contextId;
    const attempts = execution.planRepairRounds.filter(
      (round) => round.contextId === contextId,
    ).length;
    logger.info("plan_repair.exhausted", {
      executionId: execution.id,
      contextId,
      reason,
      attempts,
    });
    await populateHaltSummary(
      input,
      contextId,
      `Plan repair attempts exhausted (${attempts} round(s) for this context). Human review required — see the plan-repair rounds for the diagnoses.`,
    );
    // Event-only outcome (`exhausted` never appears in the round log): the
    // audit row + warning push for "repair has given up on this halt".
    await emitRound(input, execution.id, {
      contextId,
      haltType: haltReason.type,
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
   */
  async function emitRound(
    input: MaybeRunPlanRepairInput,
    executionId: string,
    conclusion: PlanRepairRoundConclusion,
  ): Promise<void> {
    try {
      await deps.mutateActive(
        input.projectPath,
        input.sessionName,
        (current) => ({
          execution: current,
          ...deps.publishPlanRepairRound({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            executionId,
            ...conclusion,
          }),
        }),
      );
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
