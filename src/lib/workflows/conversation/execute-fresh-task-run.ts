import {
  runAdmittedTask,
  assertBackendExecution,
} from "@/lib/agent-backends/task-execution";
/**
 * One-shot agent turn with the `TaskRunResult` contract of
 * {@link executeWorkflowTaskRun}, but no conversation.
 *
 * Graph-join merge sub-turns (validation fixes, conflict analysis and
 * resolution) cannot resume the source lane's implementer conversation:
 * enveloped implementers run with cwd = a per-context scratch directory, so
 * their backend session transcripts are filed under that munged project path,
 * and a resume from the merge worktree never finds them (command-center#78).
 * This entrypoint runs the same prompt as a fresh backend task in the merge
 * worktree instead, so callers keep their result mapping unchanged.
 *
 * The conversation is still consulted — as a RECORD, never a runtime: its
 * `agentBackend` decides which agent runs the turn, so the fix or resolution
 * runs as the same kind of agent that wrote the lane's code.
 */

import { createLogger } from "@/lib/logging";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import type { StructuredOutputFormat } from "./types";
import type { TaskRunResult, TaskRunUsage } from "./execute-workflow-task-run";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

const logger = createLogger("conversation.execute-fresh-task-run");

/**
 * How a merge agent sub-turn executes. `conversation` resumes the bound
 * conversation actor (user-driven Smart Merge / Smart Commit, whose
 * conversations share the session worktree). `fresh-run` executes a one-shot
 * backend task in the merge worktree — required for graph joins
 * (command-center#78).
 */
export type AgentTurnDispatch = "conversation" | "fresh-run";

/**
 * Generous because merge sub-turns legitimately read files, run scoped
 * checks, and iterate; matches the conversation actor's turn budget the same
 * work previously ran under.
 */
const DEFAULT_FRESH_TASK_TIMEOUT_MS = 900_000;

export interface FreshTurnAgentIdentity {
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
}

export interface ExecuteFreshTaskRunInput {
  projectPath: string;
  sessionName: string;
  /** Preferred identity source (graph joins pass the source lane's
   *  implementer conversation). Falls back to the session's most recent
   *  conversation record; no record at all fails loudly. */
  identityConversationId?: string;
  worktreePath: string;
  prompt: string;
  systemInstructions?: string;
  outputFormat?: StructuredOutputFormat;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecuteFreshTaskRunDeps {
  runTask?(
    backend: AgentBackendId,
    request: AgentTaskRequest,
  ): Promise<AgentTaskResult>;
  resolveIdentity?(input: {
    projectPath: string;
    sessionName: string;
    conversationId?: string;
  }): Promise<FreshTurnAgentIdentity>;
}

async function defaultRunTask(
  backend: AgentBackendId,
  request: AgentTaskRequest,
): Promise<AgentTaskResult> {
  return runAdmittedTask(backend, request);
}

async function defaultResolveIdentity(input: {
  projectPath: string;
  sessionName: string;
  conversationId?: string;
}): Promise<FreshTurnAgentIdentity> {
  const { getSessionConversations } = await import("@/lib/state-store");
  const conversations = await getSessionConversations(
    input.projectPath,
    input.sessionName,
  );
  const record =
    input.conversationId !== undefined
      ? conversations.find((c) => c.id === input.conversationId)
      : conversations[0];
  if (!record) {
    throw new Error(
      `No conversation found for session ${input.projectPath}::${input.sessionName}; cannot resolve an agent identity for a fresh task run`,
    );
  }
  const { readConfig } = await import("@/lib/config/loader");
  const config = await readConfig();
  return {
    backend: record.agentBackend,
    modelSelection: config.agentBackends[record.agentBackend].modelSelection,
  };
}

function toTaskRunResult(
  result: AgentTaskResult,
  timeoutMs: number,
  externallyAborted: boolean,
): TaskRunResult {
  const usage: TaskRunUsage = {
    costUsd: result.usage?.costUsd ?? null,
    durationMs: null,
    contextTokens: null,
    contextWindowMax: null,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    cachedInputTokens: result.usage?.cachedInputTokens ?? null,
  };
  const base = {
    usage,
    backendRef: result.backendRef ?? null,
    continuationDisposition: result.continuationDisposition,
  };
  if (result.timedOut) {
    // The task layer reports an external abort through the same timedOut
    // teardown path a real timeout uses; the signal tells them apart.
    return {
      kind: "error",
      error: externallyAborted
        ? "Fresh task run was aborted"
        : `Fresh task run timed out after ${timeoutMs}ms`,
      aborted: externallyAborted,
      ...(result.failure !== null ? { failure: result.failure } : {}),
      ...base,
    };
  }
  if (result.error !== null) {
    return {
      kind: "error",
      error: result.error,
      aborted: false,
      ...(result.failure !== null ? { failure: result.failure } : {}),
      ...base,
    };
  }
  if (result.structuredOutput !== undefined) {
    return {
      kind: "structured",
      structuredOutput: result.structuredOutput,
      text: result.text ?? "",
      ...base,
    };
  }
  return { kind: "text", text: result.text ?? "", ...base };
}

export async function executeFreshTaskRun(
  input: ExecuteFreshTaskRunInput,
  deps: ExecuteFreshTaskRunDeps = {},
): Promise<TaskRunResult> {
  const resolveIdentity = deps.resolveIdentity ?? defaultResolveIdentity;
  const runTask = deps.runTask ?? defaultRunTask;
  const timeoutMs = input.timeoutMs ?? DEFAULT_FRESH_TASK_TIMEOUT_MS;

  const identity = await resolveIdentity({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    ...(input.identityConversationId !== undefined
      ? { conversationId: input.identityConversationId }
      : {}),
  });

  logger.info("fresh_task_run.dispatch", {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    worktreePath: input.worktreePath,
    backend: identity.backend,
    identityConversationId: input.identityConversationId ?? null,
    structured: input.outputFormat !== undefined,
    timeoutMs,
  });

  await assertBackendExecution(identity.backend, {
    facet: "tasks",
    operation: "fresh-task-run",
    executionClass: "governed-execution",
    executionProfile: "standard",
    requiresPrivilegedInstructions: true,
  });
  const result = await runTask(identity.backend, {
    executionClass: "governed-execution",
    executionProfile: "standard",
    requiresPrivilegedInstructions: true,
    workingDirectory: input.worktreePath,
    prompt: input.prompt,
    ...(input.systemInstructions !== undefined
      ? { systemInstructions: [input.systemInstructions] }
      : {}),
    modelSelection: identity.modelSelection,
    ...(input.outputFormat !== undefined
      ? { outputSchema: input.outputFormat.schema }
      : {}),
    timeoutMs,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    autonomous: true,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
    networkAccessEnabled: true,
    webSearchMode: "disabled",
  });

  return toTaskRunResult(result, timeoutMs, input.signal?.aborted === true);
}
