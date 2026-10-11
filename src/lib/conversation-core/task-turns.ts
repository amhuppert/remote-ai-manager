import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import {
  conversationTargetLogFields,
  targetFromStoreSessionName,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { costSettlementFrame } from "@/lib/conversations/cost-settlement";
import { attributeTaskRunCost } from "@/lib/conversation-core/turn/task-run-cost";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { TranscriptDependencies } from "@/lib/conversation-core/turn/dependencies";
import { resolveFailureClassifierForBackend } from "@/lib/conversation-core/turn/failure-classification";
import { deriveTaskRunPermissions } from "@/lib/conversation-core/turn/task-run-permissions";
import {
  toPromptActorResult,
  toTaskRunResult,
  type TaskRunResult,
  type TurnExecutionOutcome,
  type TurnInterruption,
} from "@/lib/conversation-core/turn/turn-result";
import { taskTurnRequestSchema } from "@/lib/conversation-core/turn/turn-spec";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/conversation-core/turn/execute-workflow-task-run";
import type {
  AgentCallFacadeDeps,
  executeAgentCall as ExecuteAgentCall,
} from "@/lib/workflows/primitives/agent-call-facade";
import type { AgentCallRequest } from "@/lib/workflows/primitives/agent-call-vocabulary";
import {
  resumableRef,
  type ConversationRecordPort,
} from "./conversation-record";
import type { TaskTurn, TaskTurnPort } from "./executor";
import {
  failedTurn,
  recordedOutcome,
  recordedResult,
  runRecordedTurn,
  turnResultOf,
} from "./recorded-turn";
import type { RuntimeHost } from "./runtime-host";

export interface TaskTurnDeps {
  records: Pick<
    ConversationRecordPort,
    "read" | "beginTurn" | "settleTurn" | "admitProfile"
  >;
  host: Pick<RuntimeHost, "release">;
  /** Throws when the backend cannot run this task. */
  admit(input: { backend: AgentBackendId; turn: TaskTurn }): Promise<void>;
  preparePrompt(input: {
    projectPath: string;
    target: ConversationTarget;
    promptText: string;
  }): Promise<string>;
  /** The task's model and bounds: its own selection admitted for the project, else the backend's defaults. */
  resolveSettings(input: {
    projectPath: string;
    backend: AgentBackendId;
    modelSelection: BackendModelSelection | null;
    timeoutMs: number | undefined;
  }): Promise<{
    modelSelection: BackendModelSelection;
    timeoutMs?: number;
    stallTimeoutMs?: number;
  }>;
  executeAgentCall: typeof ExecuteAgentCall;
  getTaskRunner(backend: AgentBackendId): AgentTaskRunner;
  /** Where the conversation's agent works: its session's worktree, or the project root for a project conversation. */
  worktreeOf(projectPath: string, target: ConversationTarget): Promise<string>;
  transcript: Pick<
    TranscriptDependencies,
    "safeAppendTranscriptEntry" | "safeAppendTranscriptEntryOnce"
  >;
  projection(backend: AgentBackendId): {
    projectAssistantMetadata(ref: AgentSessionRef | null): unknown;
  };
  getProjectDisplayName(projectPath: string): string;
  /** The latest total the conversation's transcript records for a cost lineage, or null. */
  lineageCost(
    conversationId: string,
    lineageId: string,
  ): Promise<number | null>;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * A workflow's task (a commit message, a merge's conflict resolution) on a
 * conversation the core runs: the AgentCall task protocol, resuming the
 * conversation's own session unless the caller says otherwise, with its
 * completed output and its cost recorded on the conversation.
 */
export function createTaskTurns(deps: TaskTurnDeps): TaskTurnPort {
  return {
    async run({ conversationId, place, request, attemptId, signal }) {
      const identity = {
        projectPath: place.projectPath,
        storeSessionName: place.sessionName,
        conversationId,
      };
      const row = await deps.records.read(identity);
      if (row === null) {
        const message = `Conversation ${conversationId} no longer exists`;
        return {
          result: failedTurn(message),
          outcome: { kind: "not_started", reason: "configuration", message },
        };
      }
      const backend = request.backend ?? row.agentBackend;
      try {
        await deps.admit({ backend, turn: request });
      } catch (error) {
        const message = getErrorMessage(error);
        deps.log.warn("conversation_core.task_refused", {
          conversationId,
          backend,
          error: message,
        });
        return {
          result: failedTurn(message),
          outcome: { kind: "not_started", reason: "configuration", message },
        };
      }
      const projectName = deps.getProjectDisplayName(place.projectPath);
      const target = targetFromStoreSessionName(
        projectName,
        place.sessionName,
        conversationId,
      );
      const broadcast = {
        projectName,
        storeSessionName: place.sessionName,
      };

      const lifetime = taskLifetime(signal, request.timeoutMs);
      const recorded = await runRecordedTurn(
        deps,
        identity,
        "workflow",
        async () => {
          // Locked once any turn runs under it, as the conversation actor's admission locks it.
          await deps.records.admitProfile(identity);
          const settings = await deps.resolveSettings({
            projectPath: place.projectPath,
            backend,
            modelSelection: request.modelSelection,
            timeoutMs: request.timeoutMs,
          });
          const prompt = await deps.preparePrompt({
            projectPath: place.projectPath,
            target,
            promptText: request.promptText,
          });
          const worktreePath = await deps.worktreeOf(place.projectPath, target);
          const call = taskCall(deps, {
            request,
            backend,
            prompt,
            settings,
            worktreePath,
            // The caller decides continuity; by default the task continues the conversation's own session.
            resumeRef:
              request.resumeRef === undefined
                ? resumableRef(row, backend)
                : request.resumeRef,
            conversation: { target, projectName, conversationId },
            signal: lifetime.signal,
          });
          const result = await deps.executeAgentCall(call.request, call.facade);
          const charged = await recordTask(
            deps,
            { conversationId, attemptId, broadcast, backend, request },
            result,
          );
          // The conversation's totals add the run's own spend, not a resumed session's whole history.
          const accounted =
            charged === null
              ? result
              : { ...result, usage: { ...result.usage, costUsd: charged } };
          const interruption = lifetime.stoppedBy();
          const stopped: TurnExecutionOutcome = {
            kind: "call_result",
            result: accounted,
            ...(interruption !== null ? { interruption } : {}),
          };
          return stopped;
        },
      ).finally(() => lifetime.dispose());
      return {
        result: recordedResult(
          turnResultOf(recorded.outcome, request.outputFormat, null),
          recorded,
        ),
        outcome: recordedOutcome(recorded),
      };
    },
  };
}

type TaskSettings = Awaited<ReturnType<TaskTurnDeps["resolveSettings"]>>;

/**
 * A task's own lifetime: its caller's signal, cut at its deadline when it has
 * a positive one. The deadline is one budget for everything the task waits for
 * and does, every turn of its AgentCall included; the backend's own timeouts
 * still bound each turn.
 */
function taskLifetime(
  caller: AbortSignal | undefined,
  timeoutMs: number | undefined,
): {
  signal: AbortSignal | undefined;
  stoppedBy(): TurnInterruption | null;
  dispose(): void;
} {
  const byCaller = (): TurnInterruption | null =>
    caller?.aborted === true
      ? { reason: caller.reason === "shutdown" ? "shutdown" : "user" }
      : null;
  if (timeoutMs === undefined || timeoutMs <= 0)
    return { signal: caller, stoppedBy: byCaller, dispose: () => {} };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("timeout");
  }, timeoutMs);
  const forward = () => controller.abort(caller?.reason);
  if (caller?.aborted === true) forward();
  else caller?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    stoppedBy: () => (timedOut ? { reason: "timeout", timeoutMs } : byCaller()),
    dispose() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", forward);
    },
  };
}

/** The AgentCall a task makes, on a conversation or on none. */
function taskCall(
  deps: Pick<TaskTurnDeps, "getTaskRunner">,
  input: {
    request: TaskTurn;
    backend: AgentBackendId;
    prompt: string;
    settings: TaskSettings;
    worktreePath: string;
    resumeRef: AgentSessionRef | null;
    /** The conversation the task runs for; null for a task on no conversation. */
    conversation: {
      target: ConversationTarget;
      projectName: string;
      conversationId: string;
    } | null;
    signal: AbortSignal | undefined;
  },
): { request: AgentCallRequest; facade: AgentCallFacadeDeps } {
  const { request, settings, conversation } = input;
  const permissions = deriveTaskRunPermissions(request.fsWritePolicy);
  const profile = request.executionProfile ?? "standard";
  // An isolated one-shot task, or one on no conversation, acts for no conversation.
  const actsFor = profile === "isolated-one-shot" ? null : conversation;
  return {
    request: {
      kind: "task_run",
      executionClass: request.executionClass,
      executionProfile: profile,
      requiresPrivilegedInstructions: request.requiresPrivilegedInstructions,
      prompt: input.prompt,
      backend: input.backend,
      writeCapability: permissions.writeCapability,
      ...(request.fsWritePolicy !== undefined
        ? { fsWritePolicy: request.fsWritePolicy }
        : {}),
      modelSelection: settings.modelSelection,
      structuredOutputTurns: request.structuredOutputTurns,
      ...(request.outputFormat?.type === "json_schema"
        ? { outputSchema: request.outputFormat.schema }
        : {}),
      ...(request.systemInstructions !== undefined
        ? { systemInstructions: request.systemInstructions }
        : {}),
      ...(request.tooling !== undefined ? { tooling: request.tooling } : {}),
      ...(settings.timeoutMs !== undefined
        ? { timeoutMs: settings.timeoutMs }
        : {}),
    },
    facade: {
      taskExecution: {
        workingDirectory: input.worktreePath,
        ...(actsFor !== null ? { conversationTarget: actsFor.target } : {}),
        // A project conversation has no session for the agent's CC calls to act in.
        ...(actsFor !== null &&
        request.executionClass === "governed-execution" &&
        actsFor.target.scope === "session"
          ? {
              ccSessionScope: {
                project: actsFor.projectName,
                session: actsFor.target.sessionName,
                conversationId: actsFor.conversationId,
              },
            }
          : {}),
        autonomous: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(input.resumeRef !== null ? { resumeRef: input.resumeRef } : {}),
        ...(settings.timeoutMs !== undefined
          ? { defaultTimeoutMs: settings.timeoutMs }
          : {}),
        ...(settings.stallTimeoutMs !== undefined
          ? { stallTimeoutMs: settings.stallTimeoutMs }
          : {}),
        sandboxMode: permissions.sandboxMode,
        approvalPolicy: permissions.approvalPolicy,
        webSearchMode: permissions.webSearchMode,
        skipGitRepoCheck: permissions.skipGitRepoCheck,
        networkAccessEnabled: permissions.networkAccessEnabled,
      },
      getTaskRunner: (taskBackend) => deps.getTaskRunner(taskBackend),
      getFailureClassifier: resolveFailureClassifierForBackend,
    },
  };
}

/**
 * A task leaves no result frame of its own in the conversation transcript, so
 * its cost is recorded as a settlement frame (on the session it resumed, when
 * its backend reports the session's total), and it returns the run's own cost.
 */
async function recordTask(
  deps: TaskTurnDeps,
  input: {
    conversationId: string;
    attemptId: string;
    broadcast: { projectName: string; storeSessionName: string };
    backend: AgentBackendId;
    request: TaskTurn;
  },
  result: Awaited<ReturnType<typeof ExecuteAgentCall>>,
): Promise<number | null> {
  const sessionRef = result.backendRef ?? null;
  const cost = attributeTaskRunCost({
    usage: result.usage,
    sessionRef,
    runLineageId: `task_run:${input.attemptId}`,
    previousCumulativeUsd:
      sessionRef === null
        ? null
        : await deps.lineageCost(input.conversationId, sessionRef.ref),
  });
  if (cost !== null) {
    await deps.transcript.safeAppendTranscriptEntryOnce(
      input.conversationId,
      costSettlementFrame(input.conversationId, cost.settlement),
      input.broadcast,
    );
  }
  await recordTaskOutput(deps, input, result);
  return cost?.costUsd ?? null;
}

/** Only completed output joins the conversation as an assistant message. */
async function recordTaskOutput(
  deps: TaskTurnDeps,
  input: {
    conversationId: string;
    broadcast: { projectName: string; storeSessionName: string };
    backend: AgentBackendId;
    request: TaskTurn;
  },
  result: Awaited<ReturnType<typeof ExecuteAgentCall>>,
): Promise<void> {
  if (result.outcome.kind !== "completed") return;
  const projected = toPromptActorResult(
    { kind: "call_result", result },
    input.request.structuredOutputTextField !== undefined
      ? { structuredOutputTextField: input.request.structuredOutputTextField }
      : {},
  );
  if (projected.contentBlocks.length === 0) return;
  const raw = deps
    .projection(input.backend)
    .projectAssistantMetadata(projected.backendRef);
  await deps.transcript.safeAppendTranscriptEntry(
    input.conversationId,
    {
      timestamp: new Date().toISOString(),
      type: "assistant",
      role: "assistant",
      content: projected.contentBlocks,
      ...(raw !== undefined ? { raw } : {}),
      ...(input.request.origin !== undefined
        ? { origin: input.request.origin }
        : {}),
    },
    input.broadcast,
  );
}

/** What a task lane needs: the task protocol's admission, settings and AgentCall, and model capacity. */
export type TaskLaneDeps = Pick<
  TaskTurnDeps,
  "admit" | "resolveSettings" | "executeAgentCall" | "getTaskRunner" | "log"
> & {
  /** Waits in line for model capacity and resolves with its release; rejects when `signal` aborts or the wait expires. */
  acquireSlot(
    label: string,
    signal: AbortSignal | undefined,
  ): Promise<() => void>;
};

/** Runs tasks on no conversation; see `createTaskLane`. */
export type TaskLane = (
  input: ExecuteWorkflowTaskRunInput,
) => Promise<TaskRunResult>;

/**
 * Tasks on no conversation, such as a checkpoint build's generation passes:
 * the task protocol in the lane's worktree, with no conversation's context and
 * nothing recorded on one. A task starts a fresh session unless the caller
 * names one to resume, and waits for model capacity like any other turn. The
 * lane keeps the running totals of the sessions its tasks ran in, so a run
 * that resumed one is charged only what it added; one lane serves one sequence
 * of related tasks.
 */
export function createTaskLane(deps: TaskLaneDeps): TaskLane {
  const sessionTotals = new Map<string, number>();
  return async (input) => {
    const { binding } = input;
    if (binding.kind !== "ephemeral")
      throw new Error(
        "A task lane runs tasks on no conversation, and this task names one",
      );
    const request = taskTurnRequestSchema
      .strip()
      .parse({ ...input, promptText: input.prompt });
    const presentation =
      input.structuredOutputTextField !== undefined
        ? { structuredOutputTextField: input.structuredOutputTextField }
        : {};
    const notStarted = (
      reason: "cancelled" | "configuration" | "query_slot_timeout",
      message: string,
      stopped?: TurnInterruption,
    ) =>
      toTaskRunResult(
        {
          kind: "not_started",
          reason,
          message,
          ...(stopped !== undefined ? { cancelReason: stopped.reason } : {}),
        },
        request.outputFormat,
        presentation,
      );
    if (input.signal?.aborted === true)
      return notStarted(
        "cancelled",
        "The task was cancelled before it started",
      );
    const lifetime = taskLifetime(input.signal, request.timeoutMs);
    try {
      const backend = binding.backend;
      const fields = {
        ...conversationTargetLogFields(binding.address.target),
        backend,
      };
      let settings: TaskSettings;
      try {
        await deps.admit({ backend, turn: request });
        settings = await deps.resolveSettings({
          projectPath: binding.address.projectPath,
          backend,
          modelSelection: request.modelSelection,
          timeoutMs: request.timeoutMs,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        deps.log.warn("conversation_core.lane_task_refused", {
          ...fields,
          error: message,
        });
        return notStarted("configuration", message);
      }
      const call = taskCall(deps, {
        request,
        backend,
        prompt: request.promptText,
        settings,
        worktreePath: binding.worktreePath,
        resumeRef: request.resumeRef ?? null,
        conversation: null,
        signal: lifetime.signal,
      });
      let release: () => void;
      try {
        release = await deps.acquireSlot(
          `task:${binding.address.target.conversationId}`,
          lifetime.signal,
        );
      } catch (error) {
        const stopped = lifetime.stoppedBy();
        if (stopped !== null)
          return notStarted(
            "cancelled",
            stopped.reason === "timeout"
              ? "The task timed out before it started"
              : "The task was cancelled before it started",
            stopped,
          );
        // Its wait for capacity expired: nothing ran.
        deps.log.warn("conversation_core.lane_task_refused", {
          ...fields,
          error: getErrorMessage(error),
        });
        return notStarted("query_slot_timeout", getErrorMessage(error));
      }
      let result: Awaited<ReturnType<typeof ExecuteAgentCall>>;
      try {
        result = await deps.executeAgentCall(call.request, call.facade);
      } finally {
        release();
      }
      // A run that reports its session's running total is charged only what it added to it.
      const sessionRef = result.backendRef ?? null;
      const cumulative = result.usage.cumulativeCostUsd;
      const cost = attributeTaskRunCost({
        usage: result.usage,
        sessionRef,
        runLineageId: "task_run:lane",
        previousCumulativeUsd:
          sessionRef === null
            ? null
            : (sessionTotals.get(sessionRef.ref) ?? null),
      });
      if (sessionRef !== null && cumulative !== undefined)
        sessionTotals.set(sessionRef.ref, cumulative);
      const accounted =
        cost === null
          ? result
          : { ...result, usage: { ...result.usage, costUsd: cost.costUsd } };
      deps.log.info("conversation_core.lane_task_settled", {
        ...fields,
        outcome: result.outcome.kind,
      });
      const interruption = lifetime.stoppedBy();
      return toTaskRunResult(
        {
          kind: "call_result",
          result: accounted,
          ...(interruption !== null ? { interruption } : {}),
        },
        request.outputFormat,
        presentation,
      );
    } finally {
      lifetime.dispose();
    }
  };
}
