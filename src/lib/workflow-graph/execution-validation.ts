import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  GraphWorkflowValidationReviewArtifact,
  WorkflowValidatorIssue,
} from "@/types";
import type { AgentSessionRef } from "@/lib/agent-backends/types";
import type { ValidatorOutcome, ValidatorRunResult } from "./validator-runner";

export interface GraphWorkflowTaskValidatorInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  context: GraphWorkflowExecutionContextDefinition;
  task: GraphWorkflowTaskDefinition;
  conversationId: string;
  summary: string;
  validator: GraphWorkflowAgentValidatorConfig;
}

export interface GraphWorkflowTaskValidationInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  taskId: string;
  conversationId: string;
  summary: string;
}

export type GraphWorkflowTaskValidationOutcome =
  | {
      kind: "pass";
      summary: string;
      feedback: string;
      issues: WorkflowValidatorIssue[];
      sessionRef?: AgentSessionRef | null;
      reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
    }
  | {
      kind: "fail";
      summary: string;
      feedback: string;
      issues: WorkflowValidatorIssue[];
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
  runTaskValidator(
    input: GraphWorkflowTaskValidatorInput,
  ): Promise<ValidatorRunResult>;
}

function getContextDefinition(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowExecutionContextDefinition {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(`Execution context "${contextId}" was not found`);
  }

  return context;
}

function getTaskDefinition(
  execution: GraphWorkflowExecution,
  taskId: string,
): GraphWorkflowTaskDefinition {
  const task = execution.workingDefinition.tasks.find(
    (entry) => entry.id === taskId,
  );
  if (!task) {
    throw new Error(`Task "${taskId}" was not found`);
  }

  return task;
}

function formatFeedback(
  prefix: string,
  summary: string,
  issues: WorkflowValidatorIssue[],
): string {
  return [
    prefix,
    summary,
    ...issues.map((issue) => `- ${issue.title}: ${issue.description}`),
  ].join("\n");
}

function mapRunnerOutcomeToTaskOutcome(
  outcome: ValidatorOutcome,
  metadata: ValidatorRunResult["metadata"],
): GraphWorkflowTaskValidationOutcome {
  if (outcome.kind === "pass") {
    return {
      kind: "pass",
      summary: outcome.summary,
      feedback: formatFeedback("Task validation passed.", outcome.summary, []),
      issues: [],
      sessionRef: metadata.sessionRef,
      reviewArtifact: metadata.reviewArtifact,
    };
  }

  if (outcome.kind === "fail") {
    return {
      kind: "fail",
      summary: outcome.summary,
      feedback: formatFeedback(
        "Task validation blocked completion.",
        outcome.summary,
        outcome.issues,
      ),
      issues: outcome.issues,
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
  async runTaskValidator(): Promise<ValidatorRunResult> {
    throw new Error("Task validator runner is not configured");
  },
};

const validationLogger = createLogger("graph-workflow-validation");

export function createGraphWorkflowValidationService(
  deps: Partial<GraphWorkflowValidationServiceDeps> = {},
) {
  const resolvedDeps = { ...defaultDeps, ...deps };

  async function validateTaskCompletion(
    input: GraphWorkflowTaskValidationInput,
  ): Promise<GraphWorkflowTaskValidationOutcome> {
    const context = getContextDefinition(input.execution, input.contextId);
    const task = getTaskDefinition(input.execution, input.taskId);
    const validator = context.taskValidation;

    const execLogger = getExecutionLogger(input.execution.id);

    if (!validator?.enabled) {
      execLogger?.validation(input.contextId, "task_validation.skipped", {
        taskId: input.taskId,
        reason: "not_enabled",
      });
      return {
        kind: "pass",
        summary: "Task validation is not enabled",
        feedback: "Task validation is not enabled.",
        issues: [],
      };
    }

    execLogger?.validation(input.contextId, "task_validation.started", {
      taskId: input.taskId,
      validatorType: validator.type,
      summaryPreview: input.summary.slice(0, 200),
    });

    const runResult = await resolvedDeps.runTaskValidator({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: input.execution,
      context,
      task,
      conversationId: input.conversationId,
      summary: input.summary,
      validator,
    });

    const outcome = mapRunnerOutcomeToTaskOutcome(
      runResult.result,
      runResult.metadata,
    );

    if (outcome.kind === "infra_error") {
      execLogger?.validation(input.contextId, "task_validation.completed", {
        taskId: input.taskId,
        kind: outcome.kind,
        reason: outcome.reason,
        engine: outcome.engine,
        message: outcome.message,
      });
      validationLogger.warn("graph-workflow.task_validation.completed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        taskId: input.taskId,
        kind: outcome.kind,
        reason: outcome.reason,
        engine: outcome.engine,
      });
    } else {
      execLogger?.validation(input.contextId, "task_validation.completed", {
        taskId: input.taskId,
        kind: outcome.kind,
        summary: outcome.summary,
        issueCount: outcome.issues.length,
      });
      validationLogger.info("graph-workflow.task_validation.completed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        taskId: input.taskId,
        kind: outcome.kind,
      });
    }

    return outcome;
  }

  return {
    validateTaskCompletion,
  };
}

export type GraphWorkflowValidationService = ReturnType<
  typeof createGraphWorkflowValidationService
>;
