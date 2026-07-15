import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  GraphWorkflowValidationEventSessionRef,
  GraphWorkflowValidationReviewArtifact,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowAgentValidatorConfig } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowResolvedContext,
  WorkflowValidatorIssue,
} from "@/lib/workflow-graph/definition-schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type { ValidatorOutcome, ValidatorRunResult } from "./validator-runner";
import type { ExecutionTarget } from "./execution-target-resolver";
import type { ResumeUserInputContext } from "./user-input-gate";

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
  /**
   * When set, this validator run is a resume after the asking validator's
   * question was answered. The runner pins the asking conversation (rotation
   * still outranks) and embeds the answers block in the validation prompt so
   * the re-run validator sees the answers before rendering its verdict (5.1,
   * 5.3, 5.5).
   */
  resumeUserInput?: ResumeUserInputContext;
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
  /**
   * Set on a validator resume so the runner pins the asking conversation and
   * delivers the answers block into the re-run validator's prompt (5.1, 5.3).
   */
  resumeUserInput?: ResumeUserInputContext;
}

export type GraphWorkflowContextValidationOutcome =
  | {
      kind: "pass";
      summary: string;
      feedback: string;
      issues: WorkflowValidatorIssue[];
      reopenTaskIds: string[];
      sessionRef?: GraphWorkflowValidationEventSessionRef | null;
      reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
    }
  | {
      kind: "fail";
      summary: string;
      feedback: string;
      issues: WorkflowValidatorIssue[];
      reopenTaskIds: string[];
      sessionRef?: GraphWorkflowValidationEventSessionRef | null;
      reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
    }
  | {
      kind: "infra_error";
      reason: "exception" | "unparseable" | "schema_mismatch";
      message: string;
      engine: AgentBackendId;
      sessionRef: null;
      reviewArtifact: null;
    }
  // The validator asked the user a question and rendered no verdict. Propagated
  // unchanged so the orchestrator maps it to the awaiting-user-input park path,
  // never to the validation-failure accounting (Req 3.2, 3.3).
  | {
      kind: "asked_user";
      conversationId: string;
      questionBatchId: string;
      questions: AskQuestionItem[];
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

  if (outcome.kind === "asked_user") {
    return {
      kind: "asked_user",
      conversationId: outcome.conversationId,
      questionBatchId: outcome.questionBatchId,
      questions: outcome.questions,
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
      resumeUserInput: input.resumeUserInput,
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
    } else if (outcome.kind === "asked_user") {
      execLogger?.validation(input.contextId, "context_validation.completed", {
        kind: outcome.kind,
        questionBatchId: outcome.questionBatchId,
        questionCount: outcome.questions.length,
      });
      validationLogger.info("graph-workflow.context_validation.completed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        kind: outcome.kind,
        questionBatchId: outcome.questionBatchId,
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
