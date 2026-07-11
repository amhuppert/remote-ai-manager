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
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type { AgentTranscriptEntry } from "@/lib/agent-backends/transcript";
import type { TranscriptMessageOrigin } from "@/lib/conversations/schemas";
import { createLogger } from "@/lib/logging";
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
  timeoutMs: number;
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
  /**
   * When true, the post-dispatch structured-output gate in the AgentCall
   * facade is bypassed. Use this when the caller maintains its own
   * response-parsing chain (e.g. the graph-workflow validator's
   * raw-JSON / fenced-JSON fallback) and needs the raw text to remain
   * available even when a structured payload was requested.
   */
  skipStructuredOutputGate?: boolean;
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
    }
  | {
      kind: "text";
      text: string;
      /** Full backend-native turn transcript, when the backend surfaced one. */
      transcript?: AgentTranscriptEntry[];
      usage: TaskRunUsage;
      backendRef: AgentSessionRef | null;
    }
  | {
      kind: "error";
      error: string;
      aborted: boolean;
      /** Full backend-native turn transcript, when the backend surfaced one. */
      transcript?: AgentTranscriptEntry[];
      usage: TaskRunUsage;
      backendRef: AgentSessionRef | null;
    };

/**
 * Per-conversation in-flight chain. Each call appends to the chain so a second
 * concurrent caller observes the conversation lock being held by the first
 * and runs only after the first turn finalizes.
 */
const inFlightByKey = new Map<string, Promise<unknown>>();

/** Reset for testing — clears the per-key chain. */
export function _resetExecuteWorkflowTaskRunForTesting(): void {
  inFlightByKey.clear();
}

export async function executeWorkflowTaskRun(
  input: ExecuteWorkflowTaskRunInput,
): Promise<TaskRunResult> {
  const key = conversationRuntimeKey(
    input.projectPath,
    input.sessionName,
    input.conversationId,
  );

  const previous = inFlightByKey.get(key) ?? Promise.resolve();
  const ours: Promise<TaskRunResult> = previous
    .catch(() => undefined)
    .then(() => runOnce(input));

  inFlightByKey.set(
    key,
    ours.finally(() => {
      if (inFlightByKey.get(key) === ours) {
        inFlightByKey.delete(key);
      }
    }),
  );

  return ours;
}

async function runOnce(
  input: ExecuteWorkflowTaskRunInput,
): Promise<TaskRunResult> {
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

  logger.info("conversation.execute_workflow_task_run.dispatch", {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId: input.conversationId,
    kind: input.kind,
    hasOutputFormat: input.outputFormat !== undefined,
    hasSystemInstructions: input.systemInstructions !== undefined,
    hasTooling: input.tooling !== undefined,
    timeoutMs: input.timeoutMs,
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
    ...(input.skipStructuredOutputGate !== undefined
      ? { skipStructuredOutputGate: input.skipStructuredOutputGate }
      : {}),
    ...(input.structuredOutputTextField !== undefined
      ? { structuredOutputTextField: input.structuredOutputTextField }
      : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    timeoutMs: input.timeoutMs,
  });

  const { result, error, timedOut } = await completion;

  logger.info("conversation.execute_workflow_task_run.finalized", {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId: input.conversationId,
    kind: input.kind,
    hadError: error !== null || result?.error != null,
    aborted: result?.aborted === true,
    timedOut,
  });

  if (timedOut) {
    return {
      kind: "error",
      error:
        `executeWorkflowTaskRun: timed out after ${input.timeoutMs}ms ` +
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

    if (input.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        finish({ result: null, error: null, timedOut: true });
      }, input.timeoutMs);
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
    };
  }

  if (result === null) {
    return {
      kind: "error",
      error: "task_run produced no result",
      aborted: false,
      usage,
      backendRef,
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
    };
  }

  return { kind: "text", text, ...transcriptFields, usage, backendRef };
}
