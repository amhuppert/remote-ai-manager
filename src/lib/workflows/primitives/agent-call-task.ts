/**
 * Task-style dispatch path for the AgentCall primitive.
 *
 * Forwards a shared `task_run` request to an existing `AgentTaskRunner`
 * (the task-oriented runner path) and normalizes the runner's
 * `AgentTaskResult` into the same `AgentCallResult` shape returned by the
 * conversation path. This preserves backend-specific constraints — the task
 * path has no mid-turn ask-user, no streaming events, and applies portable
 * MCP tooling on the request itself rather than between turns.
 *
 * Workflow tooling and structured-output expectations are applied on the
 * task path identically to the conversation path: tooling becomes the
 * `portableMcp` slot of `ConversationToolingOverrides`; outputSchema is
 * forwarded to the runner verbatim.
 */

import { createLogger, type Logger } from "@/lib/logging";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type {
  AgentTaskRunner,
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import {
  buildAgentCallLogFields,
  type AgentCallRequest,
  type AgentCallResult,
  type ArtifactRef,
  type BackendCapabilityView,
  type AgentCallUsageMetrics,
} from "./agent-call-vocabulary";

const defaultLogger = createLogger("workflows.primitives.agent-call.task");

export interface DispatchTaskRunDeps {
  runner: AgentTaskRunner;
  capabilityView: BackendCapabilityView;
  workingDirectory: string;
  modelId?: string;
  reasoningEffort?: string;
  autonomous?: boolean;
  resumeRef?: AgentSessionRef | null;
  defaultTimeoutMs?: number;
  sandboxMode?: AgentTaskRequest["sandboxMode"];
  approvalPolicy?: AgentTaskRequest["approvalPolicy"];
  networkAccessEnabled?: boolean;
  webSearchMode?: AgentTaskRequest["webSearchMode"];
  additionalDirectories?: readonly string[];
  skipGitRepoCheck?: boolean;
  artifacts?: readonly ArtifactRef[];
  logger?: Logger;
}

export async function dispatchTaskRun(
  request: AgentCallRequest,
  deps: DispatchTaskRunDeps,
): Promise<AgentCallResult> {
  if (request.kind !== "task_run") {
    throw new Error(
      `dispatchTaskRun requires kind "task_run", got "${request.kind}"`,
    );
  }
  if (deps.runner.backend !== request.backend) {
    throw new Error(
      `dispatchTaskRun backend mismatch: runner is "${deps.runner.backend}" but request asks for "${request.backend}"`,
    );
  }

  const backend = deps.runner.backend;
  const log = deps.logger ?? defaultLogger;
  const artifactKinds = deriveArtifactKinds(deps.artifacts);
  const baseLogFields = buildAgentCallLogFields({
    requestKind: "task_run",
    backend,
    workflowId: request.laneRef?.workflowId,
    laneId: request.laneRef?.laneId,
    ...(artifactKinds !== undefined ? { artifactKinds } : {}),
  });

  log.debug("agent_call.task.dispatch_start", baseLogFields);

  const timeoutMs = request.timeoutMs ?? deps.defaultTimeoutMs ?? 0;
  log.debug("agent_call.task.timeout_resolved", {
    ...baseLogFields,
    timeoutMs,
    timeoutEnabled: timeoutMs > 0,
  });

  const taskRequest: AgentTaskRequest = {
    workingDirectory: deps.workingDirectory,
    prompt: request.prompt,
    autonomous: deps.autonomous ?? true,
    timeoutMs,
    ...(request.systemInstructions
      ? { systemInstructions: [request.systemInstructions] }
      : {}),
    ...(deps.modelId !== undefined ? { modelId: deps.modelId } : {}),
    ...(deps.reasoningEffort !== undefined
      ? { reasoningEffort: deps.reasoningEffort }
      : {}),
    ...(deps.resumeRef !== undefined ? { resumeRef: deps.resumeRef } : {}),
    ...(request.outputSchema !== undefined
      ? { outputSchema: request.outputSchema }
      : {}),
    ...(request.tooling
      ? { tooling: { portableMcp: request.tooling as PortableMcpConfig } }
      : {}),
    ...(deps.sandboxMode !== undefined
      ? { sandboxMode: deps.sandboxMode }
      : {}),
    ...(deps.approvalPolicy !== undefined
      ? { approvalPolicy: deps.approvalPolicy }
      : {}),
    ...(deps.networkAccessEnabled !== undefined
      ? { networkAccessEnabled: deps.networkAccessEnabled }
      : {}),
    ...(deps.webSearchMode !== undefined
      ? { webSearchMode: deps.webSearchMode }
      : {}),
    ...(deps.additionalDirectories !== undefined
      ? { additionalDirectories: [...deps.additionalDirectories] }
      : {}),
    ...(deps.skipGitRepoCheck !== undefined
      ? { skipGitRepoCheck: deps.skipGitRepoCheck }
      : {}),
  };

  let runResult: AgentTaskResult;
  try {
    runResult = await deps.runner.run(taskRequest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("agent_call.task.run_threw", {
      ...baseLogFields,
      outcome: "failed",
      message,
    });
    return buildFailureResult({
      backend,
      capabilityView: deps.capabilityView,
      backendRef: null,
      artifacts: deps.artifacts,
      failureKind: "backend_error",
      message,
    });
  }

  const usage = buildUsageMetrics(runResult);

  if (runResult.timedOut) {
    log.warn("agent_call.task.timed_out", {
      ...baseLogFields,
      outcome: "failed",
      timeoutMs: taskRequest.timeoutMs,
    });
    return buildFailureResult({
      backend,
      capabilityView: deps.capabilityView,
      backendRef: runResult.backendRef ?? null,
      artifacts: deps.artifacts,
      failureKind: "timeout",
      message: `task timed out after ${taskRequest.timeoutMs}ms`,
      usage,
      ...(runResult.transcript !== undefined
        ? { transcript: runResult.transcript }
        : {}),
    });
  }

  if (runResult.error) {
    log.warn("agent_call.task.runner_error", {
      ...baseLogFields,
      outcome: "failed",
      message: runResult.error,
    });
    return buildFailureResult({
      backend,
      capabilityView: deps.capabilityView,
      backendRef: runResult.backendRef ?? null,
      artifacts: deps.artifacts,
      failureKind: "backend_error",
      message: runResult.error,
      usage,
      ...(runResult.transcript !== undefined
        ? { transcript: runResult.transcript }
        : {}),
    });
  }

  log.debug("agent_call.task.dispatch_complete", {
    ...baseLogFields,
    outcome: "completed",
  });

  return {
    backend,
    backendRef: runResult.backendRef ?? null,
    capabilities: deps.capabilityView,
    usage,
    artifacts: [...(deps.artifacts ?? [])],
    outcome: {
      kind: "completed",
      text: runResult.text,
      ...(runResult.structuredOutput !== undefined
        ? { structuredOutput: runResult.structuredOutput }
        : {}),
      ...(runResult.transcript !== undefined
        ? { transcript: runResult.transcript }
        : {}),
    },
  };
}

interface BuildFailureResultInput {
  backend: BackendCapabilityView["backend"];
  capabilityView: BackendCapabilityView;
  backendRef: AgentCallResult["backendRef"];
  artifacts?: readonly ArtifactRef[];
  failureKind:
    | "timeout"
    | "schema_validation"
    | "backend_error"
    | "aborted"
    | "capability_unavailable";
  message: string;
  usage?: AgentCallUsageMetrics;
  transcript?: AgentTaskResult["transcript"];
}

function buildFailureResult(input: BuildFailureResultInput): AgentCallResult {
  return {
    backend: input.backend,
    backendRef: input.backendRef,
    capabilities: input.capabilityView,
    usage: input.usage ?? {},
    artifacts: [...(input.artifacts ?? [])],
    outcome: {
      kind: "failed",
      ...(input.transcript !== undefined
        ? { transcript: input.transcript }
        : {}),
      error: {
        failureKind: input.failureKind,
        backend: input.backend,
        message: input.message,
      },
    },
  };
}

function deriveArtifactKinds(
  artifacts: readonly ArtifactRef[] | undefined,
): readonly string[] | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  return artifacts.map((a) => a.kind);
}

function buildUsageMetrics(result: AgentTaskResult): AgentCallUsageMetrics {
  const usage: AgentCallUsageMetrics = {};
  const runnerUsage = result.usage;
  if (runnerUsage) {
    if (runnerUsage.inputTokens != null) {
      usage.inputTokens = runnerUsage.inputTokens;
    }
    if (runnerUsage.outputTokens != null) {
      usage.outputTokens = runnerUsage.outputTokens;
    }
    if (runnerUsage.cachedInputTokens != null) {
      usage.cachedInputTokens = runnerUsage.cachedInputTokens;
    }
  }
  return usage;
}
