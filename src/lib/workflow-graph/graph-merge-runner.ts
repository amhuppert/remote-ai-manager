import { createActor, toPromise } from "xstate";
import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";
import { observePhaseTransitions } from "@/lib/jobs/machine-host";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import { createMergeIntentsRepo } from "@/lib/merge-intents/repo";
import type { RecordMergeIntentInput } from "@/lib/merge-intents/repo";
import { getStateDb } from "@/lib/state-store/store";
import {
  mergeMachine,
  type MergeMachineType,
} from "@/lib/workflows/merge/machine";
import type {
  MergeContext,
  MergeOutput,
  MergePhase,
} from "@/lib/workflows/merge/types";

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
  targetWorktreePath: string;
  message: string;
  /** The source lane's implementer conversation. Conflict-resolution and
   *  validation-fix agent turns bind to it so they run in the lane's
   *  worktree; omitted when the lane recorded no conversation, letting the
   *  machine fall back to the session's most-recently-active conversation. */
  conversationId?: string;
  /** Operator guidance for conflict resolution, threaded into the machine's
   *  resolver as per-file decisions. */
  decisions?: ConflictDecisionInput[];
  /** Lane-derived intent notes for the conflict resolver (what each side of
   *  the merge was building and why), assembled at join time. */
  resolutionContext?: string;
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
   * machine input — that's the only difference from a user-driven Smart
   * Merge.
   */
  buildMachine?: () => MergeMachineType;
  /** Persists the intent brief against the landed squash commit. */
  recordMergeIntent?(input: RecordMergeIntentInput): void;
  /** Invoked once per distinct merge phase. Defaults to a structured log. */
  onPhase?(info: GraphMergePhaseInfo): void;
}

export function createGraphWorkflowMergeRunner(
  deps: GraphMergeRunnerDeps = {},
): GraphMergeRunner {
  const buildMachine = deps.buildMachine ?? (() => mergeMachine);
  const recordMergeIntent =
    deps.recordMergeIntent ??
    ((input: RecordMergeIntentInput) =>
      createMergeIntentsRepo(getStateDb()).recordMergeIntent(input));
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

  return {
    async run(input: GraphMergeRunnerInput): Promise<MergeOutput> {
      logger.info("graph_merge_started", {
        jobId: input.jobId,
        contextId: input.contextId,
        branchName: input.branchName,
        targetBranch: input.targetBranch,
        featureWorktreePath: input.featureWorktreePath,
        targetWorktreePath: input.targetWorktreePath,
      });

      const machine = buildMachine();
      const actor = createActor(machine, {
        input: {
          jobId: input.jobId,
          projectPath: input.projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          worktreePath: input.featureWorktreePath,
          branchName: input.branchName,
          message: input.message,
          conversationId: input.conversationId,
          autoResolve: true,
          decisions: input.decisions,
          resolutionContext: input.resolutionContext,
          targetBranch: input.targetBranch,
          targetWorktreePath: input.targetWorktreePath,
          finalizeSessionOnPublish: false,
        },
      });
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
      observePhaseTransitions(
        actor,
        (context: MergeContext) => context.phase ?? undefined,
        (phase) => {
          if (phase === undefined) return;
          emitPhase(phase);
        },
      );
      actor.start();
      const output = await toPromise(actor);

      // The shared observer only sees active snapshots, so a phase assigned
      // on entry to a final state never reaches it. readyToLand is the one
      // terminal state that retains a phase ("awaiting-land"); emit it here
      // so the breadcrumb sequence covers the full walk. Phase-clearing
      // terminals leave phase null and emit nothing.
      const terminalPhase = actor.getSnapshot().context.phase;
      if (terminalPhase !== null && terminalPhase !== lastEmittedPhase) {
        emitPhase(terminalPhase);
      }

      logger.info("graph_merge_finished", {
        jobId: input.jobId,
        contextId: input.contextId,
        status: output.status,
        mergeHash: output.mergeHash,
        conflictFiles: output.conflictFiles.length,
      });

      // Attach the lane-derived intent brief to the landed squash commit so
      // later merges that pull this commit in can explain it to their
      // conflict resolvers. Non-throwing.
      if (
        output.status === "completed" &&
        output.mergeHash &&
        input.resolutionContext
      ) {
        try {
          recordMergeIntent({
            projectPath: input.projectPath,
            commitSha: output.mergeHash,
            intent: input.resolutionContext,
            source: "graph-join",
          });
        } catch (err) {
          logger.error("graph_merge_record_intent_failed", {
            jobId: input.jobId,
            mergeHash: output.mergeHash,
            error: getErrorMessage(err),
          });
        }
      }

      return output;
    },
  };
}
