import type { Logger } from "@/lib/logging";
import type { ValidationRunResult } from "@/lib/validation/schemas";
import {
  waitForSystemValidationCompletion,
  type ValidationService,
  type ValidationSubmission,
} from "@/lib/validation/service";
import type { CheckRunResult, WorkspaceExecutorDeps } from "./executor";

export interface ValidationCheckDeps {
  service: Pick<
    ValidationService,
    "submitSystem" | "waitForCompletion" | "cancelSystemOwned"
  >;
  branchOf(
    projectPath: string,
    sessionName: string,
  ): Promise<{ branchName: string | null; targetBranch: string | null }>;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/** Enough of a failing command's output to name the failure without flooding facts. */
const DETAIL_LIMIT = 4_000;

function tail(output: string): string {
  return output.length <= DETAIL_LIMIT
    ? output
    : `…${output.slice(-DETAIL_LIMIT)}`;
}

function fromSubmission(
  command: string,
  submission: Exclude<ValidationSubmission, { kind: "accepted" }>,
): CheckRunResult {
  if (submission.kind === "invalid")
    return { status: "unavailable", detail: submission.message };
  const result = submission.result;
  switch (result.kind) {
    case "command_not_found":
      return {
        status: "unavailable",
        detail: `Command "${command}" is not registered; registered commands: ${result.knownCommands.join(", ")}`,
      };
    case "cost_exceeds_limit":
      return {
        status: "unavailable",
        detail: `Command "${command}" costs ${result.cost}, above the limit ${result.limit}`,
      };
    case "skipped_by_policy":
      return { status: "unavailable", detail: result.message };
    case "capacity_unavailable":
      return {
        status: "unavailable",
        detail: `Command "${command}" could not get validation capacity`,
      };
  }
}

function fromRun(command: string, result: ValidationRunResult): CheckRunResult {
  switch (result.kind) {
    case "passed":
      return { status: "passed" };
    case "failed":
      return { status: "failed", detail: tail(result.output) };
    case "timed_out":
      return {
        status: "failed",
        detail: `Command "${command}" timed out after ${result.timeoutMs}ms\n${tail(result.output)}`,
      };
    default:
      return {
        status: "unavailable",
        detail: `Command "${command}" ended without a verdict (${result.kind})`,
      };
  }
}

/**
 * Acceptance checks run as system-owned validation in the binding's worktree,
 * queueing for capacity rather than failing while the service is busy.
 */
export function createValidationCheckRunner(
  deps: ValidationCheckDeps,
): WorkspaceExecutorDeps["runCheck"] {
  return async ({ binding, bindingId, command, signal }) => {
    if (signal.aborted)
      return {
        status: "unavailable",
        detail: `Command "${command}" was cancelled before it started`,
      };
    const { branchName, targetBranch } = await deps.branchOf(
      binding.projectPath,
      binding.sessionName,
    );
    // The validation ledger's source and workflow stamp keep their current
    // names until the old engine's gate retires them.
    const submission = await deps.service.submitSystem({
      source: "graph_script_validator",
      command: { kind: "registered", name: command },
      scope: "changed",
      projectPath: binding.projectPath,
      workflow: { executionId: bindingId, contextId: bindingId },
      target: {
        worktreePath: binding.worktreePath,
        sessionName: binding.sessionName,
        branchName,
        targetBranch,
        contextId: bindingId,
      },
    });
    if (submission.kind !== "accepted") {
      const refused = fromSubmission(command, submission);
      deps.log.warn("workspace.check_not_started", {
        bindingId,
        command,
        detail: refused.detail,
      });
      return refused;
    }
    // An abort cancels the system-owned run, which then settles as cancelled.
    const result = await waitForSystemValidationCompletion(
      deps.service,
      submission.runId,
      signal,
    );
    deps.log.info("workspace.check_completed", {
      bindingId,
      command,
      runId: submission.runId,
      verdict: result.kind,
    });
    return fromRun(command, result);
  };
}
