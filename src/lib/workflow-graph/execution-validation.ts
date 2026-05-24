import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowResolvedContext,
  GraphWorkflowValidationReviewArtifact,
  WorkflowValidatorIssue,
} from "@/lib/workflows/schemas";
import type { AgentSessionRef } from "@/lib/agent-backends/types";
import type { ValidatorOutcome, ValidatorRunResult } from "./validator-runner";
import type { ExecutionTarget } from "./execution-target-resolver";

export interface GraphWorkflowContextValidatorInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  context: GraphWorkflowResolvedContext;
  validator: GraphWorkflowAgentValidatorConfig;
  /**
   * When supplied, the validator runs against this resolved target's
   * worktree instead of the session worktree resolved by
   * `deps.resolveWorktreePath`. Solo-eligible contexts leave this undefined,
   * preserving the pre-parallelization behavior.
   */
  executionTarget?: ExecutionTarget;
}

export interface GraphWorkflowContextValidationInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  /**
   * Resolved per-context execution target. Forwarded to the validator runner
   * so context validation in a parallel batch runs against the per-context
   * worktree, matching where the implementer turn ran.
   */
  executionTarget?: ExecutionTarget;
}

export type GraphWorkflowContextValidationOutcome =
  | {
      kind: "pass";
      summary: string;
      feedback: string;
      issues: WorkflowValidatorIssue[];
      reopenTaskIds: string[];
      sessionRef?: AgentSessionRef | null;
      reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
    }
  | {
      kind: "fail";
      summary: string;
      feedback: string;
      issues: WorkflowValidatorIssue[];
      reopenTaskIds: string[];
      sessionRef?: AgentSessionRef | null;
      reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
    }
  | {
      kind: "infra_error";
      reason: "exception" | "unparseable" | "schema_mismatch";
      message: string;
      engine: "claude" | "codex";
      sessionRef: null;
      reviewArtifact: null;
    };

export interface GraphWorkflowValidationServiceDeps {
  runContextValidator(
    input: GraphWorkflowContextValidatorInput,
  ): Promise<ValidatorRunResult>;
}

function getContextDefinition(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowResolvedContext {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(`Execution context "${contextId}" was not found`);
  }

  return context;
}

function formatFeedback(
  prefix: string,
  summary: string,
  issues: WorkflowValidatorIssue[],
  reopenTaskIds: string[],
): string {
  return [
    prefix,
    summary,
    ...(reopenTaskIds.length > 0
      ? ["Reopened tasks:", ...reopenTaskIds.map((taskId) => `- ${taskId}`)]
      : []),
    ...issues.map((issue) => `- ${issue.title}: ${issue.description}`),
  ].join("\n");
}

function mapRunnerOutcomeToContextOutcome(
  outcome: ValidatorOutcome,
  metadata: ValidatorRunResult["metadata"],
): GraphWorkflowContextValidationOutcome {
  if (outcome.kind === "pass") {
    return {
      kind: "pass",
      summary: outcome.summary,
      feedback: formatFeedback(
        "Context validation passed.",
        outcome.summary,
        [],
        [],
      ),
      issues: [],
      reopenTaskIds: [],
      sessionRef: metadata.sessionRef,
      reviewArtifact: metadata.reviewArtifact,
    };
  }

  if (outcome.kind === "fail") {
    return {
      kind: "fail",
      summary: outcome.summary,
      feedback: formatFeedback(
        "Context validation blocked completion.",
        outcome.summary,
        outcome.issues,
        outcome.reopenTaskIds,
      ),
      issues: outcome.issues,
      reopenTaskIds: outcome.reopenTaskIds,
      sessionRef: metadata.sessionRef,
      reviewArtifact: metadata.reviewArtifact,
    };
  }

  return {
    kind: "infra_error",
    reason: outcome.reason,
    message: outcome.message,
    engine: outcome.engine,
    sessionRef: null,
    reviewArtifact: null,
  };
}

const defaultDeps: GraphWorkflowValidationServiceDeps = {
  async runContextValidator(): Promise<ValidatorRunResult> {
    throw new Error("Context validator runner is not configured");
  },
};

const validationLogger = createLogger("graph-workflow-validation");

export function createGraphWorkflowValidationService(
  deps: Partial<GraphWorkflowValidationServiceDeps> = {},
) {
  const resolvedDeps = { ...defaultDeps, ...deps };

  async function validateContextCompletion(
    input: GraphWorkflowContextValidationInput,
  ): Promise<GraphWorkflowContextValidationOutcome> {
    const context = getContextDefinition(input.execution, input.contextId);
    const validator = context.contextValidator;
    const execLogger = getExecutionLogger(input.execution.id);

    if (!validator || !validator.enabled) {
      execLogger?.validation(input.contextId, "context_validation.skipped", {
        reason: "not_enabled",
      });
      return {
        kind: "pass",
        summary: "Context validation is not enabled",
        feedback: "Context validation is not enabled.",
        issues: [],
        reopenTaskIds: [],
      };
    }

    execLogger?.validation(input.contextId, "context_validation.started", {
      validatorType: validator.type,
      acceptanceCriteriaPreview: context.acceptanceCriteria.slice(0, 200),
    });
    validationLogger.info("graph-workflow.context_validation.started", {
      executionId: input.execution.id,
      contextId: input.contextId,
      validatorType: validator.type,
    });

    const runResult = await resolvedDeps.runContextValidator({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: input.execution,
      context,
      validator,
      executionTarget: input.executionTarget,
    });

    const outcome = mapRunnerOutcomeToContextOutcome(
      runResult.result,
      runResult.metadata,
    );

    if (outcome.kind === "infra_error") {
      execLogger?.validation(input.contextId, "context_validation.completed", {
        kind: outcome.kind,
        reason: outcome.reason,
        engine: outcome.engine,
        message: outcome.message,
      });
      validationLogger.warn("graph-workflow.context_validation.completed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        kind: outcome.kind,
        reason: outcome.reason,
        engine: outcome.engine,
      });
      validationLogger.warn("graph-workflow.context_validation.infra_error", {
        executionId: input.execution.id,
        contextId: input.contextId,
        reason: outcome.reason,
        engine: outcome.engine,
      });
    } else {
      execLogger?.validation(input.contextId, "context_validation.completed", {
        kind: outcome.kind,
        summary: outcome.summary,
        issueCount: outcome.issues.length,
        reopenTaskIds: outcome.reopenTaskIds,
      });
      validationLogger.info("graph-workflow.context_validation.completed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        kind: outcome.kind,
        reopenTaskIds: outcome.reopenTaskIds,
      });
    }

    return outcome;
  }

  return {
    validateContextCompletion,
  };
}

export type GraphWorkflowValidationService = ReturnType<
  typeof createGraphWorkflowValidationService
>;
