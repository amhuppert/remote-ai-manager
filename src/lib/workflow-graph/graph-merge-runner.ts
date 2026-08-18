import { createActor, toPromise } from "xstate";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";
import { observePhaseTransitions } from "@/lib/jobs/machine-host";
import type { AgentTurnDispatch } from "@/lib/workflows/conversation/execute-fresh-task-run";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import {
  mergeMachine,
  type MergeMachineType,
} from "@/lib/workflows/merge/machine";
import type {
  MergeContext,
  DeliveryGateEvaluator,
  MergeInput,
  MergeOutput,
  MergePhase,
} from "@/lib/workflows/merge/types";
import { createDeliveryGateActor } from "@/lib/workflows/merge/actors";
import { resolveDeliveredMergeSha } from "@/lib/workflows/merge/delivery-lifecycle-port";
import type { MergeValidationMode } from "@/lib/workflows/validation-fix/types";

const logger = createLogger("graph-workflow-merge-runner");

export interface GraphMergeRunnerInput {
  jobId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  contextId: string;
  branchName: string;
  featureWorktreePath: string;
  targetBranch: string;
  /** The lane worktree the target branch is checked out in. Forensic only —
   *  the publish rediscovers the checkout from the branch. */
  targetWorktreePath: string;
  message: string;
  /** The source lane's implementer conversation. Conflict-resolution and
   *  validation-fix agent turns bind to it so they run in the lane's
   *  worktree; omitted when the lane recorded no conversation, letting the
   *  machine fall back to the session's most-recently-active conversation. */
  conversationId?: string;
  /** How validation-fix turns execute; graph joins pass `fresh-run` because an
   *  enveloped implementer conversation cannot be resumed from the merge
   *  worktree (command-center#78). */
  agentTurnDispatch?: AgentTurnDispatch;
  /** Operator guidance for conflict resolution, threaded into the machine's
   *  resolver as per-file decisions. */
  decisions?: ConflictDecisionInput[];
  /** Lane-derived intent notes for the conflict resolver (what each side of
   *  the merge was building and why), assembled at join time. */
  resolutionContext?: string;
  /** Opaque graph-workflow execution identity supplied to the merge gate. */
  executionId?: string;
  /** Graph execution identity used only for validation-ledger attribution. */
  workflowExecutionId?: string;
  /** Whether this merge publishes the workflow's final joined result. */
  finalPublish?: boolean;
  /** Explicit validation behavior for this graph-owned merge. */
  validationMode: MergeValidationMode;
}

export interface GraphMergeRunner {
  run(input: GraphMergeRunnerInput): Promise<MergeOutput>;
}

/**
 * Forensic breadcrumb emitted each time the merge machine enters a new phase
 * during a join. A join can spend minutes inside a single phase (a slow
 * pre-merge validation, an auto-fix agent turn) with no other signal, so these
 * mark where the wall-clock is going without a schema/SSE/UI change.
 */
export interface GraphMergePhaseInfo {
  jobId: string;
  contextId: string;
  branchName: string;
  targetBranch: string;
  phase: MergePhase;
}

export interface GraphMergeRunnerDeps {
  /**
   * For tests: build a merge machine variant. Production omits this; the
   * runner uses the default machine and signals "do not finalize the
   * session on publish" via `finalizeSessionOnPublish: false` on the
   * machine input.
   */
  buildMachine?: () => MergeMachineType;
  /** General merge-domain port implementation, supplied by server composition. */
  deliveryGate?: DeliveryGateEvaluator;
  /** Final-publish lifecycle callback, supplied by server composition. */
  markDelivered?(workflowExecutionId: string, mergeHash: string): Promise<void>;
  /** Hosts the merge actor. Production registers it as a background job. */
  runMachine?(input: {
    machine: MergeMachineType;
    input: MergeInput;
    onPhase(phase: MergePhase): void;
  }): Promise<MergeOutput>;
  /** Invoked once per distinct merge phase. Defaults to a structured log. */
  onPhase?(info: GraphMergePhaseInfo): void;
}

export function createGraphWorkflowMergeRunner(
  deps: GraphMergeRunnerDeps = {},
): GraphMergeRunner {
  const buildMachine = deps.buildMachine ?? (() => mergeMachine);
  const onPhase =
    deps.onPhase ??
    ((info: GraphMergePhaseInfo) =>
      logger.info("graph_merge_phase", {
        jobId: info.jobId,
        contextId: info.contextId,
        branchName: info.branchName,
        targetBranch: info.targetBranch,
        phase: info.phase,
      }));
  const runMachine = deps.runMachine ?? runMergeMachineDirectly;

  return {
    async run(input: GraphMergeRunnerInput): Promise<MergeOutput> {
      logger.info("graph_merge_started", {
        jobId: input.jobId,
        contextId: input.contextId,
        branchName: input.branchName,
        targetBranch: input.targetBranch,
        featureWorktreePath: input.featureWorktreePath,
        targetWorktreePath: input.targetWorktreePath,
        executionId: input.executionId,
        finalPublish: input.finalPublish === true,
        validationMode: input.validationMode.mode,
        validationCoveredLaneIds:
          input.validationMode.mode === "run"
            ? (input.validationMode.coveredLaneIds ?? [])
            : [],
        validationCoveredContextIds:
          input.validationMode.mode === "run"
            ? (input.validationMode.coveredContextIds ?? [])
            : [],
      });

      const baseMachine = buildMachine();
      const machine = deps.deliveryGate
        ? baseMachine.provide({
            actors: {
              deliveryGate: createDeliveryGateActor(deps.deliveryGate),
            },
          })
        : baseMachine;
      const validationWorkflowExecutionId =
        input.workflowExecutionId ?? input.executionId;
      const mergeInput: MergeInput = {
        jobId: input.jobId,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        worktreePath: input.featureWorktreePath,
        branchName: input.branchName,
        message: input.message,
        ...(input.conversationId !== undefined
          ? { conversationId: input.conversationId }
          : {}),
        ...(input.agentTurnDispatch !== undefined
          ? { agentTurnDispatch: input.agentTurnDispatch }
          : {}),
        autoResolve: true,
        // Every graph-owned merge (join and fan-in alike) re-enters a worktree
        // only this machinery drives, so an unresolved merge found there is a
        // previous run's wreckage rather than an operator's work in progress.
        // The resolved-but-uncommitted tree is still refused by the machine
        // under this policy — that shape can only be a human's.
        staleMergePolicy: "abort",
        validationMode: input.validationMode,
        ...(input.decisions !== undefined
          ? { decisions: input.decisions }
          : {}),
        ...(input.resolutionContext !== undefined
          ? { resolutionContext: input.resolutionContext }
          : {}),
        targetBranch: input.targetBranch,
        finalizeSessionOnPublish: false,
        ...(input.executionId !== undefined
          ? { executionId: input.executionId }
          : {}),
        ...(validationWorkflowExecutionId !== undefined
          ? {
              validationWorkflow: {
                executionId: validationWorkflowExecutionId,
                contextId: input.contextId,
              },
            }
          : {}),
        ...(input.finalPublish !== undefined
          ? { finalPublish: input.finalPublish }
          : {}),
      };
      let lastEmittedPhase: MergePhase | undefined;
      const emitPhase = (phase: MergePhase) => {
        lastEmittedPhase = phase;
        onPhase({
          jobId: input.jobId,
          contextId: input.contextId,
          branchName: input.branchName,
          targetBranch: input.targetBranch,
          phase,
        });
      };
      const output = await runMachine({
        machine,
        input: mergeInput,
        onPhase: emitPhase,
      });

      // The shared observer only sees active snapshots, so a phase assigned
      // on entry to a final state never reaches it. readyToLand is the one
      // terminal state that retains a phase ("awaiting-land"); emit it here
      // so the breadcrumb sequence covers the full walk. Phase-clearing
      // terminals leave phase null and emit nothing.
      const terminalPhase = output.phase;
      if (terminalPhase !== null && terminalPhase !== lastEmittedPhase) {
        emitPhase(terminalPhase);
      }

      logger.info("graph_merge_finished", {
        jobId: input.jobId,
        contextId: input.contextId,
        status: output.status,
        mergeHash: output.mergeHash,
        conflictFiles: output.conflictFiles.length,
        validationCoveredLaneIds:
          input.validationMode.mode === "run"
            ? (input.validationMode.coveredLaneIds ?? [])
            : [],
        validationCoveredContextIds:
          input.validationMode.mode === "run"
            ? (input.validationMode.coveredContextIds ?? [])
            : [],
      });

      const deliveredSha = resolveDeliveredMergeSha(output);
      if (
        output.status === "completed" &&
        deliveredSha !== null &&
        input.executionId !== undefined &&
        input.finalPublish === true &&
        deps.markDelivered !== undefined
      ) {
        try {
          await deps.markDelivered(input.executionId, deliveredSha);
        } catch (err) {
          logger.error("graph_merge_mark_delivered_failed", {
            jobId: input.jobId,
            executionId: input.executionId,
            mergeHash: deliveredSha,
            error: getErrorMessage(err),
          });
        }
      }

      return output;
    },
  };
}

async function runMergeMachineDirectly(input: {
  machine: MergeMachineType;
  input: MergeInput;
  onPhase(phase: MergePhase): void;
}): Promise<MergeOutput> {
  const actor = createActor(input.machine, { input: input.input });
  observePhaseTransitions(
    actor,
    (context: MergeContext) => context.phase ?? undefined,
    (phase) => {
      if (phase !== undefined) input.onPhase(phase);
    },
  );
  actor.start();
  return toPromise(actor);
}
