/**
 * Named entrypoint workflow callers use to drive a single `task_run` turn
 * through the conversation actor.
 *
 * Responsibilities:
 *  - Ensure a conversation actor exists (idempotent) via `manager.ts`.
 *  - Serialize concurrent calls per `(projectPath, sessionName, conversationId)`
 *    so the conversation-scoped lock is observably held for the duration of a
 *    call and a follow-up call only starts after the previous one settles.
 *  - Dispatch a `SUBMIT_TASK_RUN` event and await the actor's transition into
 *    `finalizingTurn`, where the machine has captured `lastResult` in context.
 *  - Resolve to the parsed structured output when `outputFormat` is set;
 *    otherwise to the raw final text. Errors and aborts surface as a
 *    distinct `TaskRunResult` variant so callers can branch deterministically.
 *
 * The entrypoint NEVER calls `executeAgentCall` directly — every turn is
 * routed through the actor and the existing `runTaskRun` actor implementation.
 */

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ContinuationDisposition } from "@/lib/agent-backends/errors";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type { TranscriptMessageOrigin } from "@/lib/conversations/schemas";
import { createLogger, type Logger } from "@/lib/logging";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";
import type { ConversationActorRef } from "./machine";
import { ensureConversationActor, type EnsureActorInputData } from "./manager";
import { conversationRuntimeKey } from "./runtime-state";
import type {
  ConversationContext,
  PromptActorResult,
  StructuredOutputFormat,
} from "./types";

const logger = createLogger("conversation.execute-workflow-task-run");

export interface ExecuteWorkflowTaskRunInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  kind: "task_run";
  prompt: string;
  systemInstructions?: string;
  outputFormat?: StructuredOutputFormat;
  tooling?: PortableMcpConfig;
  timeoutMs?: number;
  /** Override the agent model on this turn. */
  modelId?: string;
  /** Override the agent reasoning effort / verbosity on this turn. */
  effort?: string;
  /**
   * Pin the conversation actor to this worktree for the turn. Merge sub-turns
   * (conflict resolution, validation fixes) MUST pass the merge's feature
   * worktree: the selected conversation may be bound to a different lane's
   * worktree in a parallel graph workflow, and running the agent there
   * corrupts the wrong tree. An idle actor bound elsewhere is rebound; a
   * running one makes the call fail loudly instead of executing in the wrong
   * worktree. Omit to use the conversation's existing binding.
   */
  worktreePath?: string;
  /** Persist this validated structured-output string field as the assistant
   *  transcript text, keeping backend transport JSON out of the UI. */
  structuredOutputTextField?: string;
  /**
   * Optional explicit actor input. When provided, the conversation actor is
   * created (or matched) using this data directly instead of being loaded
   * from the state store. Used by transient workflow lanes (e.g. graph
   * validator turns) that do not correspond to a user-visible CC conversation.
   */
  actorInput?: EnsureActorInputData;
  /**
   * Provenance stamp for the persisted assistant TranscriptMessage. Workflow
   * callers should pass `{ source: "workflow", workflow?: { executionId,
   * nodeId, iterationIndex } }` so the shared JSONL transcript distinguishes
   * workflow-driven turns from user-driven turns. Omit on non-workflow
   * task-runs to leave the entry unmarked.
   */
  origin?: TranscriptMessageOrigin;
}

export interface TaskRunUsage {
  costUsd: number | null;
  durationMs: number | null;
  contextTokens: number | null;
  contextWindowMax: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

export type TaskRunResult =
  | {
      kind: "structured";
      structuredOutput: unknown;
      /** Joined text blocks emitted alongside the structured payload, when
       *  the runner returned both. May be the empty string. */
      text: string;
      /** Full backend-native turn transcript, when the backend surfaced one. */
      transcript?: AgentTranscriptEntry[];
      usage: TaskRunUsage;
      backendRef: AgentSessionRef | null;
      continuationDisposition: ContinuationDisposition;
    }
  | {
      kind: "text";
      text: string;
      /** Full backend-native turn transcript, when the backend surfaced one. */
      transcript?: AgentTranscriptEntry[];
      usage: TaskRunUsage;
      backendRef: AgentSessionRef | null;
      continuationDisposition: ContinuationDisposition;
    }
  | {
      kind: "error";
      error: string;
      aborted: boolean;
      /** Full backend-native turn transcript, when the backend surfaced one. */
      transcript?: AgentTranscriptEntry[];
      usage: TaskRunUsage;
      backendRef: AgentSessionRef | null;
      continuationDisposition: ContinuationDisposition;
    };

/**
 * Per-conversation in-flight chain. Each call is serialized against other
 * calls for the same `(projectPath, sessionName, conversationId)` so a second
 * concurrent caller observes the conversation lock being held by the first
 * and runs only after the first turn finalizes.
 */
let dispatchMutex = createKeyedMutex();

/** Reset for testing — clears the per-key chain. */
export function _resetExecuteWorkflowTaskRunForTesting(): void {
  dispatchMutex = createKeyedMutex();
}

export function _getExecuteWorkflowTaskRunInFlightCountForTesting(): number {
  return dispatchMutex.activeKeyCount();
}

/**
 * Diagnostic sinks for one task run. Injectable because log FIELDS are a public
 * identity surface (R1.3): project compaction and ticket generation address this
 * entrypoint with the project store key, and a test can only prove the emitted
 * identity is scope-discriminated if the sink is a dependency.
 */
export interface ExecuteWorkflowTaskRunDeps {
  log?: Logger;
}

export function executeWorkflowTaskRun(
  input: ExecuteWorkflowTaskRunInput,
  deps: ExecuteWorkflowTaskRunDeps = {},
): Promise<TaskRunResult> {
  const key = conversationRuntimeKey(
    input.projectPath,
    input.sessionName,
    input.conversationId,
  );
  return dispatchMutex.run(key, () => runOnce(input, deps.log ?? logger));
}

async function runOnce(
  input: ExecuteWorkflowTaskRunInput,
  log: Logger,
): Promise<TaskRunResult> {
  // `input.sessionName` is the session-keyed store/runtime name — the sentinel
  // for a project conversation. It addresses the actor below but never names a
  // session in a log field.
  const scopeRef = scopeRefFromStoreSessionName(input.sessionName);
  const actor = await ensureConversationActor(
    input.projectPath,
    input.sessionName,
    input.conversationId,
    {
      ...(input.actorInput !== undefined
        ? { actorInput: input.actorInput }
        : {}),
      ...(input.worktreePath !== undefined
        ? { executionTarget: { worktreePath: input.worktreePath } }
        : {}),
    },
  );

  log.info("conversation.execute_workflow_task_run.dispatch", {
    projectPath: input.projectPath,
    ...scopeRef,
    conversationId: input.conversationId,
    kind: input.kind,
    hasOutputFormat: input.outputFormat !== undefined,
    hasSystemInstructions: input.systemInstructions !== undefined,
    hasTooling: input.tooling !== undefined,
    timeoutMs: input.timeoutMs ?? null,
  });

  const completion = waitForTaskRunCompletion(actor, input);

  actor.send({
    type: "SUBMIT_TASK_RUN",
    promptText: input.prompt,
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.outputFormat !== undefined
      ? { outputFormat: input.outputFormat }
      : {}),
    ...(input.systemInstructions !== undefined
      ? { systemInstructions: input.systemInstructions }
      : {}),
    ...(input.tooling !== undefined ? { tooling: input.tooling } : {}),
    ...(input.structuredOutputTextField !== undefined
      ? { structuredOutputTextField: input.structuredOutputTextField }
      : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });

  const { result, error, timedOut } = await completion;

  log.info("conversation.execute_workflow_task_run.finalized", {
    projectPath: input.projectPath,
    ...scopeRef,
    conversationId: input.conversationId,
    kind: input.kind,
    hadError: error !== null || result?.error != null,
    aborted: result?.aborted === true,
    timedOut,
  });

  if (timedOut) {
    const timeoutMs = input.timeoutMs ?? 0;
    return {
      kind: "error",
      error:
        `executeWorkflowTaskRun: timed out after ${timeoutMs}ms ` +
        `(conversation ${input.conversationId})`,
      aborted: false,
      usage: {
        costUsd: null,
        durationMs: null,
        contextTokens: null,
        contextWindowMax: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
      },
      backendRef: null,
      continuationDisposition: "retain",
    };
  }

  return mapToTaskRunResult(result, error, input.outputFormat);
}

interface TurnCompletion {
  result: PromptActorResult | null;
  error: string | null;
  timedOut: boolean;
}

function valueIncludesFinalizingTurn(value: unknown): boolean {
  if (typeof value === "string") return value === "finalizingTurn";
  if (typeof value === "object" && value !== null) {
    return "finalizingTurn" in (value as Record<string, unknown>);
  }
  return false;
}

function waitForTaskRunCompletion(
  actor: ConversationActorRef,
  input: ExecuteWorkflowTaskRunInput,
): Promise<TurnCompletion> {
  return new Promise<TurnCompletion>((resolve) => {
    let observedActiveTaskRun = false;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: TurnCompletion): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      subscription.unsubscribe();
      resolve(value);
    };

    const subscription = actor.subscribe(
      (snapshot: { value: unknown; context: ConversationContext }) => {
        const ctx = snapshot.context;
        if (ctx.activeTurn?.kind === "task_run") {
          observedActiveTaskRun = true;
        }

        if (
          observedActiveTaskRun &&
          valueIncludesFinalizingTurn(snapshot.value)
        ) {
          finish({
            result: ctx.lastResult,
            error: ctx.lastError,
            timedOut: false,
          });
          return;
        }

        // Fallback: XState's always-transitions may pass through
        // `finalizingTurn` faster than the subscriber receives it. Detect
        // completion by observing the turn being cleared after we previously
        // saw it active.
        if (observedActiveTaskRun && ctx.activeTurn === null) {
          finish({
            result: ctx.lastResult,
            error: ctx.lastError,
            timedOut: false,
          });
        }
      },
    );

    const timeoutMs = input.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        finish({ result: null, error: null, timedOut: true });
      }, timeoutMs);
    }
  });
}

function mapToTaskRunResult(
  result: PromptActorResult | null,
  error: string | null,
  outputFormat: StructuredOutputFormat | undefined,
): TaskRunResult {
  const usage: TaskRunUsage = {
    costUsd: result?.costUsd ?? null,
    durationMs: result?.durationMs ?? null,
    contextTokens: result?.contextTokens ?? null,
    contextWindowMax: result?.contextWindow ?? null,
    inputTokens: result?.inputTokens ?? null,
    outputTokens: result?.outputTokens ?? null,
    cachedInputTokens: result?.cachedInputTokens ?? null,
  };
  const backendRef: AgentSessionRef | null = result?.backendRef ?? null;
  const continuationDisposition =
    result?.continuationDisposition ?? ("retain" as const);
  const transcriptFields =
    result?.transcript !== undefined ? { transcript: result.transcript } : {};

  if (error !== null && (result === null || result.error !== null)) {
    return {
      kind: "error",
      error: error ?? result?.error ?? "task_run failed",
      aborted: result?.aborted === true,
      ...transcriptFields,
      usage,
      backendRef,
      continuationDisposition,
    };
  }

  if (result === null) {
    return {
      kind: "error",
      error: "task_run produced no result",
      aborted: false,
      usage,
      backendRef,
      continuationDisposition,
    };
  }

  if (result.error !== null) {
    return {
      kind: "error",
      error: result.error,
      aborted: result.aborted,
      ...transcriptFields,
      usage,
      backendRef,
      continuationDisposition,
    };
  }

  const text = result.contentBlocks
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("");

  if (outputFormat !== undefined && result.structuredOutput !== undefined) {
    return {
      kind: "structured",
      structuredOutput: result.structuredOutput,
      text,
      ...transcriptFields,
      usage,
      backendRef,
      continuationDisposition,
    };
  }

  return {
    kind: "text",
    text,
    ...transcriptFields,
    usage,
    backendRef,
    continuationDisposition,
  };
}
