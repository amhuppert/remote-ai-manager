import {
  executeRepoValidationCommand,
  type RepoValidationCommandResult,
} from "@/lib/repo-config";
import type {
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowAgentValidatorResult,
  WorkflowValidatorIssue,
} from "@/types";
import { validateWorkflowValidatorRemediation } from "./validation";

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

export interface GraphWorkflowContextAgentValidatorInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  context: GraphWorkflowExecutionContextDefinition;
  validator: GraphWorkflowAgentValidatorConfig;
}

export interface GraphWorkflowContextScriptValidatorInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  timeoutMs?: number;
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
}

export interface GraphWorkflowContextValidationInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  branchName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  timeoutMs?: number;
}

export interface GraphWorkflowContextValidationOutcome {
  pass: boolean;
  summary: string;
  feedback: string;
  issues: WorkflowValidatorIssue[];
  reopenTaskIds: string[];
  agentResult: WorkflowAgentValidatorResult | null;
  scriptResult: RepoValidationCommandResult | null;
}

export interface GraphWorkflowValidationServiceDeps {
  runTaskValidator(
    input: GraphWorkflowTaskValidatorInput,
  ): Promise<WorkflowAgentValidatorResult>;
  runContextAgentValidator(
    input: GraphWorkflowContextAgentValidatorInput,
  ): Promise<WorkflowAgentValidatorResult>;
  runContextScriptValidator(
    input: GraphWorkflowContextScriptValidatorInput,
  ): Promise<RepoValidationCommandResult>;
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
  async runTaskValidator() {
    throw new Error("Task validator runner is not configured");
  },
  async runContextAgentValidator() {
    throw new Error("Context validator runner is not configured");
  },
  async runContextScriptValidator(input) {
    return executeRepoValidationCommand(input);
  },
};

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

    if (!validator?.enabled) {
      return {
        pass: true,
        summary: "Task validation is not enabled",
        feedback: "Task validation is not enabled.",
        issues: [],
        reopenTaskIds: [],
      };
    }

    const result = await resolvedDeps.runTaskValidator({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: input.execution,
      context,
      task,
      conversationId: input.conversationId,
      summary: input.summary,
      validator,
    });

    return normalizeValidatorResult(input.execution, input.contextId, result);
  }

  async function validateContextCompletion(
    input: GraphWorkflowContextValidationInput,
  ): Promise<GraphWorkflowContextValidationOutcome> {
    const context = getContextDefinition(input.execution, input.contextId);
    const validation = context.contextValidation;
    const agentValidator = validation?.agentValidator;
    const scriptValidator = validation?.scriptValidator;

    let agentResult: WorkflowAgentValidatorResult | null = null;
    let normalizedAgent: {
      pass: boolean;
      summary: string;
      feedback: string;
      issues: WorkflowValidatorIssue[];
      reopenTaskIds: string[];
    } | null = null;

    if (agentValidator?.enabled) {
      agentResult = await resolvedDeps.runContextAgentValidator({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        execution: input.execution,
        context,
        validator: agentValidator,
      });
      normalizedAgent = normalizeValidatorResult(
        input.execution,
        input.contextId,
        agentResult,
      );
    }

    let scriptResult: RepoValidationCommandResult | null = null;
    if (scriptValidator?.enabled) {
      scriptResult = await resolvedDeps.runContextScriptValidator({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        timeoutMs: input.timeoutMs,
      });
    }

    if (scriptValidator?.enabled && scriptResult && !scriptResult.executed) {
      return {
        pass: false,
        summary: "Project pre-merge validation command is not configured",
        feedback: "Project pre-merge validation command is not configured.",
        issues: normalizedAgent?.issues ?? [],
        reopenTaskIds: normalizedAgent?.reopenTaskIds ?? [],
        agentResult,
        scriptResult,
      };
    }

    const agentPass = normalizedAgent?.pass ?? true;
    const scriptPass =
      scriptResult === null || (scriptResult.executed && scriptResult.pass);
    const pass = agentPass && scriptPass;

    if (pass) {
      return {
        pass: true,
        summary:
          normalizedAgent?.summary ?? "Execution context validation passed",
        feedback:
          normalizedAgent?.feedback ?? "Execution context validation passed.",
        issues: [],
        reopenTaskIds: [],
        agentResult,
        scriptResult,
      };
    }

    if (scriptResult && !scriptPass) {
      return {
        pass: false,
        summary: scriptResult.message ?? "Pre-merge validation failed",
        feedback:
          scriptResult.output ||
          scriptResult.message ||
          "Pre-merge validation failed",
        issues: normalizedAgent?.issues ?? [],
        reopenTaskIds: normalizedAgent?.reopenTaskIds ?? [],
        agentResult,
        scriptResult,
      };
    }

    return {
      pass: false,
      summary:
        normalizedAgent?.summary ?? "Execution context validation failed",
      feedback:
        normalizedAgent?.feedback ?? "Execution context validation failed.",
      issues: normalizedAgent?.issues ?? [],
      reopenTaskIds: normalizedAgent?.reopenTaskIds ?? [],
      agentResult,
      scriptResult,
    };
  }

  return {
    validateTaskCompletion,
    validateContextCompletion,
  };
}

export type GraphWorkflowValidationService = ReturnType<
  typeof createGraphWorkflowValidationService
>;
