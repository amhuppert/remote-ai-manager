import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import { targetFromStoreSessionName, type ConversationTarget } from "@/lib/conversations/conversation-target";
import { costSettlementFrame } from "@/lib/conversations/cost-settlement";
import { attributeTaskRunCost } from "@/lib/workflows/conversation/task-run-cost";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { TranscriptDependencies } from "@/lib/workflows/conversation/actor-dependencies";
import { resolveFailureClassifierForBackend } from "@/lib/workflows/conversation/failure-classification";
import { deriveTaskRunPermissions } from "@/lib/workflows/conversation/task-run-permissions";
import { toPromptActorResult, type TurnExecutionOutcome } from "@/lib/workflows/conversation/turn-result";
import type { executeAgentCall as ExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { AgentCallRequest } from "@/lib/workflows/primitives/agent-call-vocabulary";
import { QUEUE_REVIEW_REQUIRED_MESSAGE, type ConversationRecordPort } from "./conversation-record";
import type { TaskTurn, TaskTurnPort } from "./executor";
import { failedTurn, runRecordedTurn, turnResultOf, withCollection } from "./recorded-turn";
import type { RuntimeHost } from "./runtime-host";

export interface TaskTurnDeps {
  records: Pick<ConversationRecordPort, "read" | "beginTurn" | "settleTurn" | "admitProfile">;
  host: Pick<RuntimeHost, "release">;
  /** Throws when the backend cannot run this task. */
  admit(input: { backend: AgentBackendId; turn: TaskTurn }): Promise<void>;
  preparePrompt(input: { projectPath: string; target: ConversationTarget; promptText: string }): Promise<string>;
  /** The task's model and bounds: its own selection admitted for the project, else the backend's defaults. */
  resolveSettings(input: {
    projectPath: string;
    backend: AgentBackendId;
    modelSelection: BackendModelSelection | null;
    timeoutMs: number | undefined;
  }): Promise<{ modelSelection: BackendModelSelection; timeoutMs?: number; stallTimeoutMs?: number }>;
  executeAgentCall: typeof ExecuteAgentCall;
  getTaskRunner(backend: AgentBackendId): AgentTaskRunner;
  /** Where the conversation's agent works: its session's worktree, or the project root for a project conversation. */
  worktreeOf(projectPath: string, target: ConversationTarget): Promise<string>;
  transcript: Pick<TranscriptDependencies, "safeAppendTranscriptEntry" | "safeAppendTranscriptEntryOnce">;
  projection(backend: AgentBackendId): { projectAssistantMetadata(ref: AgentSessionRef | null): unknown };
  getProjectDisplayName(projectPath: string): string;
  /** The latest total the conversation's transcript records for a cost lineage, or null. */
  lineageCost(conversationId: string, lineageId: string): Promise<number | null>;
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
    async run({ conversationId, enrollment, request, attemptId, signal }) {
      const identity = { projectPath: enrollment.projectPath, storeSessionName: enrollment.sessionName, conversationId };
      const row = await deps.records.read(identity);
      if (row === null) {
        const message = `Conversation ${conversationId} no longer exists`;
        return { result: failedTurn(message), outcome: { kind: "not_started", reason: "configuration", message } };
      }
      // The actor made such a task wait until debug mode ended, with no bound; the core refuses it at once.
      if (row.debugMode?.active === true) {
        deps.log.warn("conversation_core.task_refused_in_debug_mode", { conversationId });
        const message = "Exit debug mode first";
        return { result: failedTurn(message), outcome: { kind: "not_started", reason: "configuration", message } };
      }
      if (row.queueReviewRequired) {
        deps.log.warn("conversation_core.task_held_for_queue_review", { conversationId });
        return {
          result: failedTurn(QUEUE_REVIEW_REQUIRED_MESSAGE),
          outcome: { kind: "not_started", reason: "configuration", message: QUEUE_REVIEW_REQUIRED_MESSAGE },
        };
      }
      const backend = request.backend ?? row.agentBackend;
      try {
        await deps.admit({ backend, turn: request });
      } catch (error) {
        const message = getErrorMessage(error);
        deps.log.warn("conversation_core.task_refused", { conversationId, backend, error: message });
        return { result: failedTurn(message), outcome: { kind: "not_started", reason: "configuration", message } };
      }
      const projectName = deps.getProjectDisplayName(enrollment.projectPath);
      const target = targetFromStoreSessionName(projectName, enrollment.sessionName, conversationId);
      const broadcast = { projectName, storeSessionName: enrollment.sessionName };

      const { outcome, uncollected } = await runRecordedTurn(deps, identity, "workflow", async () => {
        // Locked once any turn runs under it, as the conversation actor's admission locks it.
        await deps.records.admitProfile(identity);
        const settings = await deps.resolveSettings({
          projectPath: enrollment.projectPath,
          backend,
          modelSelection: request.modelSelection,
          timeoutMs: request.timeoutMs,
        });
        const prompt = await deps.preparePrompt({ projectPath: enrollment.projectPath, target, promptText: request.promptText });
        const worktreePath = await deps.worktreeOf(enrollment.projectPath, target);
        const permissions = deriveTaskRunPermissions(request.fsWritePolicy);
        const profile = request.executionProfile ?? "standard";
        const agentRequest: AgentCallRequest = {
          kind: "task_run",
          executionClass: request.executionClass,
          executionProfile: profile,
          requiresPrivilegedInstructions: request.requiresPrivilegedInstructions,
          prompt,
          backend,
          writeCapability: permissions.writeCapability,
          ...(request.fsWritePolicy !== undefined ? { fsWritePolicy: request.fsWritePolicy } : {}),
          modelSelection: settings.modelSelection,
          structuredOutputTurns: request.structuredOutputTurns,
          ...(request.outputFormat?.type === "json_schema" ? { outputSchema: request.outputFormat.schema } : {}),
          ...(request.systemInstructions !== undefined ? { systemInstructions: request.systemInstructions } : {}),
          ...(request.tooling !== undefined ? { tooling: request.tooling } : {}),
          ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
        };
        // The caller decides continuity; by default the task continues the conversation's own session.
        const resumeRef =
          request.resumeRef === undefined
            ? row.backendRef !== null && row.backendRef.backend === backend
              ? row.backendRef
              : null
            : request.resumeRef;
        const isolated = profile === "isolated-one-shot";
        const result = await deps.executeAgentCall(agentRequest, {
          taskExecution: {
            workingDirectory: worktreePath,
            ...(isolated ? {} : { conversationTarget: target }),
            // A project conversation has no session for the agent's CC calls to act in.
            ...(!isolated && request.executionClass === "governed-execution" && target.scope === "session"
              ? { ccSessionScope: { project: projectName, session: target.sessionName, conversationId } }
              : {}),
            autonomous: true,
            signal,
            ...(resumeRef !== null ? { resumeRef } : {}),
            ...(settings.timeoutMs !== undefined ? { defaultTimeoutMs: settings.timeoutMs } : {}),
            ...(settings.stallTimeoutMs !== undefined ? { stallTimeoutMs: settings.stallTimeoutMs } : {}),
            sandboxMode: permissions.sandboxMode,
            approvalPolicy: permissions.approvalPolicy,
            webSearchMode: permissions.webSearchMode,
            skipGitRepoCheck: permissions.skipGitRepoCheck,
            networkAccessEnabled: permissions.networkAccessEnabled,
          },
          getTaskRunner: (taskBackend) => deps.getTaskRunner(taskBackend),
          getFailureClassifier: resolveFailureClassifierForBackend,
        });
        const charged = await recordTask(deps, { conversationId, attemptId, broadcast, backend, request }, result);
        // The conversation's totals add the run's own spend, not a resumed session's whole history.
        const accounted = charged === null ? result : { ...result, usage: { ...result.usage, costUsd: charged } };
        const stopped: TurnExecutionOutcome = {
          kind: "call_result",
          result: accounted,
          ...(signal.aborted ? { interruption: { reason: signal.reason === "shutdown" ? "shutdown" : "user" } } : {}),
        };
        return stopped;
      });
      return { result: withCollection(turnResultOf(outcome, request.outputFormat, null), uncollected), outcome };
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
    previousCumulativeUsd: sessionRef === null ? null : await deps.lineageCost(input.conversationId, sessionRef.ref),
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
  const raw = deps.projection(input.backend).projectAssistantMetadata(projected.backendRef);
  await deps.transcript.safeAppendTranscriptEntry(
    input.conversationId,
    {
      timestamp: new Date().toISOString(),
      type: "assistant",
      role: "assistant",
      content: projected.contentBlocks,
      ...(raw !== undefined ? { raw } : {}),
      ...(input.request.origin !== undefined ? { origin: input.request.origin } : {}),
    },
    input.broadcast,
  );
}
