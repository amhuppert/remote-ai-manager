import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getErrorMessage } from "@/lib/errors";
import { SHARED_DOCUMENT_DIRECTORY } from "@/lib/workflow-graph/shared-documents";
import {
  emit as defaultEmitStreamFrame,
  type GraphWorkflowStreamFrame,
} from "@/lib/workflow-graph/stream-registry";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionSessionRef,
  GraphWorkflowHaltReason,
  GraphWorkflowValidationReviewArtifact,
  SessionState,
  WorkflowValidatorIssue,
} from "@/types";
import type {
  GraphWorkflowContextValidationOutcome,
  GraphWorkflowValidationService,
} from "@/lib/workflow-graph/execution-validation";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";

export interface GraphWorkflowExecutionLoopInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
}

export interface GraphWorkflowExecutionLoopDeps {
  workflowManager: {
    scheduleNextContext(
      projectPath: string,
      sessionName: string,
    ): Promise<GraphWorkflowExecution>;
    recordContextValidationResult(
      projectPath: string,
      sessionName: string,
      result: {
        contextId: string;
        pass: boolean;
        summary?: string | null;
        issues?: WorkflowValidatorIssue[];
        reopenTaskIds?: string[];
        scriptOutput?: string;
        scriptOutputDocumentPath?: string;
        sessionRef?: GraphWorkflowExecutionSessionRef | null;
        reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
      },
    ): Promise<GraphWorkflowExecution>;
    send(
      projectPath: string,
      sessionName: string,
      event:
        | { type: "complete" }
        | { type: "halt"; reason: GraphWorkflowHaltReason },
    ): Promise<GraphWorkflowExecution>;
  };
  iterationOrchestrator: {
    runIteration(input: {
      projectPath: string;
      projectName: string;
      sessionName: string;
      contextId: string;
    }): Promise<GraphWorkflowIterationResult>;
  };
  validationService: Pick<
    GraphWorkflowValidationService,
    "validateContextCompletion"
  >;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  emitStreamFrame?(
    projectPath: string,
    sessionName: string,
    frame: GraphWorkflowStreamFrame,
  ): void;
  /** Write script validation output to disk. Returns relative path on success, null on failure. */
  persistScriptOutput?(
    worktreePath: string,
    contextId: string,
    output: string,
  ): Promise<string | null>;
}

function emitDone(
  deps: GraphWorkflowExecutionLoopDeps,
  projectPath: string,
  sessionName: string,
  reason: string,
): void {
  (deps.emitStreamFrame ?? defaultEmitStreamFrame)(projectPath, sessionName, {
    type: "done",
    reason,
  });
}

async function defaultPersistScriptOutput(
  worktreePath: string,
  contextId: string,
  output: string,
): Promise<string | null> {
  const relativePath = path.join(
    SHARED_DOCUMENT_DIRECTORY,
    `validation-output-${contextId}.txt`,
  );
  const absolutePath = path.join(worktreePath, relativePath);
  try {
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, output, "utf-8");
    return relativePath;
  } catch {
    return null;
  }
}

async function validateActiveContext(input: {
  deps: GraphWorkflowExecutionLoopDeps;
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
}): Promise<GraphWorkflowContextValidationOutcome> {
  const session = await input.deps.getSession(
    input.projectPath,
    input.sessionName,
  );
  if (!session) {
    throw new Error(
      "Session not found while validating graph workflow context",
    );
  }

  return input.deps.validationService.validateContextCompletion({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    worktreePath: session.worktreePath,
    branchName: session.branchName,
    execution: input.execution,
    contextId: input.contextId,
  });
}

// -- Active loop registry -----------------------------------------------------

const activeLoops = new Set<string>();

function loopKey(projectPath: string, sessionName: string): string {
  return `${projectPath}::${sessionName}`;
}

/** Check if an execution loop is currently running for the given session. */
export function isExecutionLoopActive(
  projectPath: string,
  sessionName: string,
): boolean {
  return activeLoops.has(loopKey(projectPath, sessionName));
}

/** Reset the active loop registry (for testing only). */
export function _resetActiveLoopsForTesting(): void {
  activeLoops.clear();
}

// -- Helpers ------------------------------------------------------------------

function areAllContextTasksCompleted(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  const contextTasks = execution.workingDefinition.tasks.filter(
    (t) => t.contextId === contextId,
  );
  return (
    contextTasks.length > 0 &&
    contextTasks.every(
      (t) => execution.taskStates[t.id]?.status === "completed",
    )
  );
}

// -- Execution loop -----------------------------------------------------------

export function createGraphWorkflowExecutionLoop(
  deps: GraphWorkflowExecutionLoopDeps,
) {
  async function runAndRecordContextValidation(input: {
    projectPath: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
    contextId: string;
  }): Promise<GraphWorkflowExecution> {
    const validation = await validateActiveContext({
      deps,
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: input.execution,
      contextId: input.contextId,
    });

    let scriptOutput: string | undefined;
    let scriptOutputDocumentPath: string | undefined;

    if (
      !validation.pass &&
      validation.scriptResult &&
      validation.scriptResult.output
    ) {
      scriptOutput = validation.scriptResult.output;
      const session = await deps.getSession(
        input.projectPath,
        input.sessionName,
      );
      if (session) {
        const persist = deps.persistScriptOutput ?? defaultPersistScriptOutput;
        const docPath = await persist(
          session.worktreePath,
          input.contextId,
          scriptOutput,
        );
        if (docPath) {
          scriptOutputDocumentPath = docPath;
        }
      }
    }

    return deps.workflowManager.recordContextValidationResult(
      input.projectPath,
      input.sessionName,
      {
        contextId: input.contextId,
        pass: validation.pass,
        summary: validation.summary,
        issues: validation.issues,
        reopenTaskIds: validation.reopenTaskIds,
        scriptOutput,
        scriptOutputDocumentPath,
        sessionRef: validation.sessionRef,
        reviewArtifact: validation.reviewArtifact,
      },
    );
  }

  async function run(
    input: GraphWorkflowExecutionLoopInput,
  ): Promise<GraphWorkflowExecution> {
    const key = loopKey(input.projectPath, input.sessionName);
    activeLoops.add(key);
    let execution = input.execution;

    try {
      while (execution.status === "running") {
        if (!execution.activeContextId) {
          execution = await deps.workflowManager.scheduleNextContext(
            input.projectPath,
            input.sessionName,
          );

          if (!execution.activeContextId) {
            execution = await deps.workflowManager.send(
              input.projectPath,
              input.sessionName,
              { type: "complete" },
            );
            emitDone(deps, input.projectPath, input.sessionName, "completed");
            return execution;
          }
        }

        const contextId = execution.activeContextId;
        if (!contextId) {
          continue;
        }

        // If all tasks for the active context are already completed (e.g.
        // after resuming from a recovery_error that occurred during
        // validation), skip iteration and go straight to validation.
        if (areAllContextTasksCompleted(execution, contextId)) {
          execution = await runAndRecordContextValidation({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution,
            contextId,
          });
          if (execution.status !== "running") {
            emitDone(
              deps,
              input.projectPath,
              input.sessionName,
              execution.haltReason?.type ?? execution.status,
            );
            return execution;
          }
          continue;
        }

        const iterationResult = await deps.iterationOrchestrator.runIteration({
          projectPath: input.projectPath,
          projectName: input.projectName,
          sessionName: input.sessionName,
          contextId,
        });
        execution = iterationResult.execution;

        if (execution.status !== "running") {
          emitDone(
            deps,
            input.projectPath,
            input.sessionName,
            execution.haltReason?.type ?? execution.status,
          );
          return execution;
        }

        const contextState = execution.contextStates[contextId];
        const contextDef = execution.workingDefinition.executionContexts.find(
          (c) => c.id === contextId,
        );
        if (
          contextState &&
          contextDef &&
          contextState.iterationCount >=
            contextDef.iterationPolicy.maxIterations
        ) {
          execution = await deps.workflowManager.send(
            input.projectPath,
            input.sessionName,
            {
              type: "halt",
              reason: {
                type: "max_iterations",
                contextId,
                iterationCount: contextState.iterationCount,
              },
            },
          );
          emitDone(
            deps,
            input.projectPath,
            input.sessionName,
            "max_iterations",
          );
          return execution;
        }

        if (iterationResult.shouldContinueInContext) {
          continue;
        }

        if (iterationResult.shouldValidateContext) {
          execution = await runAndRecordContextValidation({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution,
            contextId,
          });

          if (execution.status !== "running") {
            emitDone(
              deps,
              input.projectPath,
              input.sessionName,
              execution.haltReason?.type ?? execution.status,
            );
            return execution;
          }
        }
      }

      emitDone(
        deps,
        input.projectPath,
        input.sessionName,
        execution.haltReason?.type ?? execution.status,
      );
      return execution;
    } catch (error) {
      const haltedExecution = await deps.workflowManager.send(
        input.projectPath,
        input.sessionName,
        {
          type: "halt",
          reason: {
            type: "recovery_error",
            message: getErrorMessage(error),
          },
        },
      );
      emitDone(
        deps,
        input.projectPath,
        input.sessionName,
        haltedExecution.haltReason?.type ?? "recovery_error",
      );
      return haltedExecution;
    } finally {
      activeLoops.delete(key);
    }
  }

  return { run };
}
