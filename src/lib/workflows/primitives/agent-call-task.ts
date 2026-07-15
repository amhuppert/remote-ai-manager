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
import { getErrorMessage } from "@/lib/shared/errors";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { refValueForBackend } from "@/lib/agent-backends/continuity";
import type {
  AgentTaskRunner,
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import type { AgentFailureWithContinuation } from "@/lib/agent-backends/errors";
import {
  buildAgentCallLogFields,
  type AgentCallRequest,
  type AgentCallResult,
  type ArtifactRef,
  type BackendCapabilityView,
  type AgentCallUsageMetrics,
  type NormalizedAgentCallFailureKind,
} from "./agent-call-vocabulary";

const defaultLogger = createLogger("workflows.primitives.agent-call.task");

export interface DispatchTaskRunDeps {
  runner: AgentTaskRunner;
  capabilityView: BackendCapabilityView;
  workingDirectory: string;
  modelId?: string;
  reasoningEffort?: string;
  imagePaths?: readonly string[];
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
  /** External cancellation signal, forwarded to the runner so a live run can
   * be torn down (e.g. workflow abort cancelling a validator task-run). */
  signal?: AbortSignal;
  /**
   * Backend failure classifier for thrown runner errors (the registered
   * descriptor's `errors.classify`). When absent, a thrown error normalizes
   * to `backend_error`.
   */
  classifyFailure?(error: unknown): AgentFailureWithContinuation;
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
    ...(deps.imagePaths !== undefined ? { imagePaths: deps.imagePaths } : {}),
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
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
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
    const decision = deps.classifyFailure?.(err);
    const classification = decision?.failure;
    const message = classification?.message ?? getErrorMessage(err);
    log.warn("agent_call.task.run_threw", {
      ...baseLogFields,
      outcome: "failed",
      ...(classification !== undefined
        ? { failureKind: classification.kind }
        : {}),
      message,
    });
    const resumeRefValue = refValueForBackend(deps.resumeRef, backend);
    const continuationDisposition =
      decision?.continuationDisposition ?? "retain";
    return buildFailureResult({
      backend,
      capabilityView: deps.capabilityView,
      backendRef:
        continuationDisposition === "clear" || resumeRefValue === undefined
          ? null
          : { backend, ref: resumeRefValue },
      artifacts: deps.artifacts,
      failureKind: classification?.kind ?? "backend_error",
      message,
      continuationDisposition,
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
      continuationDisposition: runResult.continuationDisposition,
      ...(runResult.transcript !== undefined
        ? { transcript: runResult.transcript }
        : {}),
    });
  }

  if (runResult.error) {
    const classification = runResult.failure ?? {
      kind: "backend_error" as const,
      message: runResult.error,
      retryable: false,
    };
    if (runResult.failure === null) {
      log.error("agent_call.task.adapter_failure_contract_violated", {
        ...baseLogFields,
        message: runResult.error,
      });
    }
    log.warn("agent_call.task.runner_error", {
      ...baseLogFields,
      outcome: "failed",
      failureKind: classification.kind,
      message: runResult.error,
    });
    return buildFailureResult({
      backend,
      capabilityView: deps.capabilityView,
      backendRef: runResult.backendRef ?? null,
      artifacts: deps.artifacts,
      failureKind: classification.kind,
      message: runResult.error,
      usage,
      continuationDisposition: runResult.continuationDisposition,
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
    continuationDisposition: runResult.continuationDisposition,
  };
}

interface BuildFailureResultInput {
  backend: BackendCapabilityView["backend"];
  capabilityView: BackendCapabilityView;
  backendRef: AgentCallResult["backendRef"];
  artifacts?: readonly ArtifactRef[];
  failureKind: NormalizedAgentCallFailureKind;
  message: string;
  usage?: AgentCallUsageMetrics;
  transcript?: AgentTaskResult["transcript"];
  continuationDisposition?: AgentCallResult["continuationDisposition"];
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
    ...(input.continuationDisposition !== undefined
      ? { continuationDisposition: input.continuationDisposition }
      : {}),
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
