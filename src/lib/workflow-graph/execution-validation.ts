import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowExecutionSessionRef,
  GraphWorkflowTaskDefinition,
  GraphWorkflowValidationReviewArtifact,
  WorkflowAgentValidatorResult,
  WorkflowValidatorIssue,
} from "@/types";
import { validateWorkflowValidatorRemediation } from "./validation";
import type { ValidatorRunResult } from "./validator-runner";

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

export interface GraphWorkflowTaskValidationOutcome {
  pass: boolean;
  summary: string;
  feedback: string;
  issues: WorkflowValidatorIssue[];
  reopenTaskIds: string[];
  sessionRef?: GraphWorkflowExecutionSessionRef | null;
  reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
}

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

function normalizeValidatorResult(
  execution: GraphWorkflowExecution,
  contextId: string,
  result: WorkflowAgentValidatorResult,
): {
  pass: boolean;
  summary: string;
  feedback: string;
  issues: WorkflowValidatorIssue[];
  reopenTaskIds: string[];
} {
  const remediationValidation = validateWorkflowValidatorRemediation(
    contextId,
    execution,
    result,
  );
  if (!remediationValidation.ok) {
    const issues = remediationValidation.errors.map((error) => ({
      title: "Invalid validator remediation",
      description: error.message,
    }));
    const summary = "Validator returned invalid remediation directives";

    return {
      pass: false,
      summary,
      feedback: formatFeedback(
        "Task validation blocked completion.",
        summary,
        issues,
      ),
      issues,
      reopenTaskIds: [],
    };
  }

  const pass =
    result.pass &&
    result.issues.length === 0 &&
    result.reopenTaskIds.length === 0;

  return {
    pass,
    summary: result.summary,
    feedback: formatFeedback(
      pass ? "Task validation passed." : "Task validation blocked completion.",
      result.summary,
      result.issues,
    ),
    issues: result.issues,
    reopenTaskIds: result.reopenTaskIds,
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
        pass: true,
        summary: "Task validation is not enabled",
        feedback: "Task validation is not enabled.",
        issues: [],
        reopenTaskIds: [],
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

    const normalized = normalizeValidatorResult(
      input.execution,
      input.contextId,
      runResult.result,
    );

    execLogger?.validation(input.contextId, "task_validation.completed", {
      taskId: input.taskId,
      pass: normalized.pass,
      summary: normalized.summary,
      issueCount: normalized.issues.length,
      reopenTaskIds: normalized.reopenTaskIds,
    });
    validationLogger.info("graph-workflow.task_validation.completed", {
      executionId: input.execution.id,
      contextId: input.contextId,
      taskId: input.taskId,
      pass: normalized.pass,
    });

    return {
      ...normalized,
      sessionRef: runResult.metadata.sessionRef,
      reviewArtifact: runResult.metadata.reviewArtifact,
    };
  }

  return {
    validateTaskCompletion,
  };
}

export type GraphWorkflowValidationService = ReturnType<
  typeof createGraphWorkflowValidationService
>;
