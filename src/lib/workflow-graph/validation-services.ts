import { type GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

import {
  freezeValidationCandidate,
  type ValidationCandidateTreeResolution,
} from "@/lib/workflow-graph/validation-round";
import { resolveContextReviewOrigin } from "./review-origin";
import type { CandidateScope } from "@/lib/git/diff";
import type {
  GraphWorkflowContextOutput,
  GraphWorkflowValidationCandidate,
} from "@/lib/workflow-graph/schemas";

import type { ScriptValidatorOutcome } from "@/lib/workflow-graph/script-validator-runner";

import type { GraphWorkflowIterationInput } from "./context-outcome";
import type { IterationOrchestratorValidationRoundService } from "./context-validation-coordinator";
import type { SessionState } from "@/lib/sessions/schemas";
import { type ScriptValidatorInput } from "./script-validator-runner";
import { type IterationOrchestratorScriptValidatorInput } from "@/lib/workflow-graph/context-validation-coordinator";

export interface GraphWorkflowValidationRoundServiceDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  /** The base commit the patch is read against; null when git cannot answer. */
  readHeadSha(worktreePath: string): Promise<string | null>;
  /** The candidate's identity under `scope`; null when it cannot be read. */
  computeCandidateIdentity(
    worktreePath: string,
    scope: CandidateScope,
  ): Promise<string | null>;
}

/**
 * Resolves a validation round's candidate identity from the worktree the cohort
 * will inspect: the per-context target when the context is worktree-isolated,
 * the session worktree otherwise.
 *
 * The identity is read under the caller's candidate scope, and the scope is
 * reported back as part of the resolution. The caller owns the scope because only
 * it knows the reviewed context's placement; this service owns reading it, so the
 * freeze and every later re-read go through one implementation and cannot differ
 * in how they computed the same thing.
 *
 * A failure is reported as `unavailable` with its reason, never as a partial
 * identity. The engine treats an unreadable candidate as an infrastructure
 * outcome — a round that cannot name what it reviewed cannot certify it — so
 * degrading to "some components are missing" here would let a semantic verdict be
 * published on a candidate nobody could pin down.
 */
export function createGraphWorkflowValidationRoundService(
  deps: GraphWorkflowValidationRoundServiceDeps,
): IterationOrchestratorValidationRoundService {
  return {
    async resolveCandidateTree(
      input,
    ): Promise<ValidationCandidateTreeResolution> {
      const worktreePath =
        input.executionTarget?.worktreePath ??
        (await deps.getSession(input.projectPath, input.sessionName))
          ?.worktreePath;
      if (worktreePath === undefined) {
        return {
          kind: "unavailable",
          reason: `no worktree resolved for session "${input.sessionName}"`,
        };
      }

      const [head, candidateTreeHash] = await Promise.all([
        deps.readHeadSha(worktreePath),
        deps.computeCandidateIdentity(worktreePath, input.candidateScope),
      ]);

      if (head === null || candidateTreeHash === null) {
        return {
          kind: "unavailable",
          reason: `git could not resolve ${head === null ? "HEAD" : "the candidate tree"} in ${worktreePath}`,
        };
      }

      return {
        kind: "resolved",
        identityScope:
          input.candidateScope.mode === "wholeTree" ? "wholeTree" : "owned",
        headSha: head,
        candidateTreeHash,
      };
    },
  };
}

export interface GraphWorkflowScriptValidatorServiceDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  readConfig(): Promise<{ preMergeTimeoutMs?: number }>;
  runScriptValidator(
    input: ScriptValidatorInput,
  ): Promise<ScriptValidatorOutcome>;
}

export function createGraphWorkflowScriptValidatorService(
  deps: GraphWorkflowScriptValidatorServiceDeps,
) {
  return {
    async runScriptValidator(
      input: IterationOrchestratorScriptValidatorInput,
    ): Promise<ScriptValidatorOutcome> {
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (!session) {
        throw new Error("Session not found");
      }

      const config = await deps.readConfig();
      const timeoutMs = config.preMergeTimeoutMs ?? 300_000;

      // Scope validation to the diff against where this context's work lands.
      // A worktree-isolated context branch fans into the session branch; a solo
      // context runs on the session branch itself, so its base is the session's
      // own merge target (using the session branch would yield an empty diff and
      // skip checks).
      const scopingTargetBranch = input.executionTarget
        ? session.branchName
        : session.targetBranch;
      const context = input.execution.workingDefinition.executionContexts.find(
        (candidate) => candidate.id === input.contextId,
      );
      if (!context) {
        throw new Error(
          `Execution context "${input.contextId}" was not found for script validation`,
        );
      }

      return deps.runScriptValidator({
        projectPath: input.projectPath,
        worktreePath: session.worktreePath,
        sessionName: input.sessionName,
        branchName: session.branchName,
        executionId: input.execution.id,
        contextId: input.contextId,
        targetBranch: scopingTargetBranch,
        timeoutMs,
        commands: context.scriptValidator.commands,
        purpose: context.scriptValidator.purpose,
        executionTarget: input.executionTarget,
        signal: input.signal,
      });
    },
  };
}

/**
 * Resolve the candidate identity as it is RIGHT NOW: the git identity the
 * validators would inspect, plus the context's current task-state generation.
 * Called at the freeze and again at each re-verification point, so the two
 * observations are produced by identical means and a difference between them
 * is a real move rather than an artefact of how each was computed.
 *
 * The scope comes from the context's own placement (R15), which is what makes
 * this identity stable for a context sharing a lane worktree: an enveloped
 * context is identified by its owned subset, so a sibling's writes and landed
 * commits are not its drift.
 */
export async function observeContextValidationCandidate(
  service: IterationOrchestratorValidationRoundService,
  input: GraphWorkflowIterationInput,
  execution: GraphWorkflowExecution,
  outputCandidate?: GraphWorkflowContextOutput,
): Promise<
  | { kind: "resolved"; candidate: GraphWorkflowValidationCandidate }
  | { kind: "unavailable"; reason: string }
> {
  // Looked up without throwing: an observation reports unavailability as its
  // own result, and a context that has left the working definition is exactly
  // the infrastructure outcome the caller is equipped to conclude on.
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === input.contextId,
  );
  if (context === undefined) {
    return {
      kind: "unavailable",
      reason: `execution context "${input.contextId}" is not in the working definition`,
    };
  }

  const review = resolveContextReviewOrigin(execution, input.contextId);
  if (review.kind === "unavailable") return review;

  const tree: ValidationCandidateTreeResolution =
    await service.resolveCandidateTree({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      contextId: input.contextId,
      candidateScope: review.candidateScope,
      ...(input.executionTarget
        ? { executionTarget: input.executionTarget }
        : {}),
    });

  if (tree.kind === "unavailable") return tree;

  return {
    kind: "resolved",
    candidate: freezeValidationCandidate({
      tree,
      taskStates: execution.taskStates,
      contextId: input.contextId,
      outputSchema: context.outputSchema,
      outputValue: (
        outputCandidate ??
        execution.contextStates[input.contextId]?.validationRound
          ?.outputCandidate ??
        execution.contextOutputs[input.contextId]
      )?.value,
    }),
  };
}
