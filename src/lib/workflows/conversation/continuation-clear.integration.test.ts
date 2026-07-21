/**
 * Integration: a stale Codex resume must clear the persisted continuation ref
 * everywhere before the next turn.
 *
 * Drives a REAL `CodexConversationRuntime` (fake SDK deps: `resumeThread`
 * rejects with the provider's no-rollout message) to produce a real
 * `continuationDisposition: "clear"` turn result, feeds it through the real
 * conversation machine, and asserts — against a real-store persistence
 * fixture — that both the conversation row and the persisted machine snapshot
 * dropped the stale ref. A retained ref here means every following turn
 * retries the same missing rollout forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createActor, fromPromise, type AnyActorRef } from "xstate";

// Infrastructure mock — createLogger is called at module level
vi.mock("@/lib/logging", () => ({
  captureTraceContext: () => null,
  runAsTrace: (_name: string, fn: () => unknown) => fn(),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { conversationMachine } from "./machine";
import {
  persistSnapshotAfterTransition,
  setPersistenceDeps,
  _resetForTesting as resetPersistenceForTesting,
} from "./persistence";
import { applySyncDerivedFields } from "./manager";
import {
  runStaleCodexResumeTurn,
  STALE_CODEX_RESUME_REF,
} from "@/lib/agent-backends/testing/codex-stale-resume-fixture";
import {
  runStaleClaudePumpResumeTurn,
  STALE_CLAUDE_RESUME_REF,
} from "@/lib/agent-backends/testing/claude-stale-resume-pump-fixture";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import { turnContinuationSchema } from "@/lib/agent-backends/errors";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type {
  ConversationInput,
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "./types";

const PROJECT_PATH = "/test/project";
const PROJECT_NAME = "test-project";
const SESSION_NAME = "test-session";
const CONVERSATION_ID = "conv-stale-resume";
const STALE_REF = STALE_CODEX_RESUME_REF;

async function realStaleCodexResumeResult(): Promise<ConversationBackendTurnResult> {
  return runStaleCodexResumeTurn({
    conversationId: CONVERSATION_ID,
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    sessionName: SESSION_NAME,
    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
  });
}

/** The field mapping the production bridges apply to an adapter turn result
 *  (see `external-turn-handler.ts` and the actor's result construction). */
function toPromptActorResult(
  result: ConversationBackendTurnResult,
): PromptActorResult {
  return {
    backendRef: result.backendRef,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    numTurns: result.numTurns,
    contextTokens: result.contextTokens,
    contextWindow: result.contextWindowMax,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    contentBlocks: result.contentBlocks,
    structuredOutput: result.structuredOutput,
    aborted: result.aborted,
    compacted: result.compacted,
    error: result.failure?.message ?? null,
    continuationDisposition: result.continuationDisposition,
  };
}

// ============================================================
// Machine + persistence wiring
// ============================================================

const machineInput: ConversationInput = {
  projectPath: PROJECT_PATH,
  projectName: PROJECT_NAME,
  sessionName: SESSION_NAME,
  worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
  conversationId: CONVERSATION_ID,
  createdAt: "2026-01-01T00:00:00Z",
  forkedFrom: null,
  role: null,
  transcriptPath: "/tmp/transcript.jsonl",
  agentBackend: "codex",
  backendRef: STALE_REF,
  promptCount: 1,
  persistence: "durable",
};

function waitForState(
  actor: AnyActorRef,
  stateName: string,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for state "${stateName}", current: ${JSON.stringify(actor.getSnapshot().value)}`,
          ),
        ),
      timeoutMs,
    );
    const check = (value: unknown) => {
      const flat = typeof value === "string" ? value : JSON.stringify(value);
      return flat.includes(stateName);
    };
    if (check(actor.getSnapshot().value)) {
      clearTimeout(timer);
      resolve();
      return;
    }
    actor.subscribe((snapshot) => {
      if (check(snapshot.value)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

describe("stale Codex resume clears the continuation ref end-to-end", () => {
  let fixture: ReturnType<typeof createPersistenceFixture>;
  let syncWrites: Promise<unknown>[];
  const actors: AnyActorRef[] = [];

  beforeEach(async () => {
    fixture = createPersistenceFixture();
    setPersistenceDeps({
      getConversationMachineSnapshot:
        fixture.store.getConversationMachineSnapshot,
      upsertConversationMachineSnapshot:
        fixture.store.upsertConversationMachineSnapshot,
      deleteConversationMachineSnapshot:
        fixture.store.deleteConversationMachineSnapshot,
    });
    syncWrites = [];

    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversationStateSchema.parse({
        id: CONVERSATION_ID,
        transcriptPath: "/tmp/transcript.jsonl",
        status: "awaiting",
        promptCount: 1,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        agentBackend: "codex",
        backendRef: STALE_REF,
      }),
    );
  });

  afterEach(() => {
    for (const actor of actors) {
      try {
        actor.stop();
      } catch {
        /* already stopped */
      }
    }
    actors.length = 0;
    resetPersistenceForTesting();
    fixture.close();
  });

  function makeProvidedMachine(promptResult: PromptActorResult) {
    return conversationMachine.provide({
      actors: {
        prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
          async () => ({ transcriptPath: "/tmp/transcript.jsonl" }),
        ),
        executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
          async () => promptResult,
        ),
      },
      actions: {
        // Production persistence (shadow codec + post-macrostep capture)
        // over the real store; debounceMs 0 keeps the test deterministic.
        persistSnapshot: ({ context, self }) => {
          persistSnapshotAfterTransition(context, self, { debounceMs: 0 });
        },
        syncDerivedFields: ({ context }) => {
          syncWrites.push(
            fixture.deps.mutateConversation(
              context.projectPath,
              context.sessionName,
              context.conversationId,
              "test.syncDerived",
              (c) => applySyncDerivedFields(context, c),
            ),
          );
        },
      },
    });
  }

  it("adapter result declares clear with no ref and satisfies the continuation refinement", async () => {
    const result = await realStaleCodexResumeResult();

    expect(result.failure?.kind).toBe("stale_resume_ref");
    expect(result.continuationDisposition).toBe("clear");
    expect(result.backendRef).toBeNull();
    expect(
      turnContinuationSchema.safeParse({
        backendRef: result.backendRef,
        continuationDisposition: result.continuationDisposition,
      }).success,
    ).toBe(true);
  });

  it("clears the ref from the machine snapshot and the conversation row after a prompted turn", async () => {
    const promptResult = toPromptActorResult(
      await realStaleCodexResumeResult(),
    );
    const actor = createActor(makeProvidedMachine(promptResult), {
      input: machineInput,
    });
    actors.push(actor);
    actor.start();

    actor.send({
      type: "SUBMIT_PROMPT",
      promptText: "Continue where we left off",
      streamId: "s1",
    });
    await waitForState(actor, "idle");

    // Machine snapshot — the ref the NEXT turn resumes with.
    expect(actor.getSnapshot().context.backendRef).toBeNull();

    // Persisted conversation row (syncDerivedFields).
    await Promise.all(syncWrites);
    const row = await fixture.deps.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(row?.backendRef).toBeNull();

    // Durable machine snapshot — persistSnapshotAfterTransition samples the
    // actor after the macrostep settles, so the persisted resume token (now in
    // the sidecar) must also have dropped the stale ref (an in-action capture
    // would have persisted the previous macrostep, which still held it).
    await vi.waitFor(() => {
      const blob = fixture.store.getConversationMachineSnapshot(
        "session",
        CONVERSATION_ID,
      ) as { context?: { backendRef?: unknown } } | null;
      expect(blob?.context).toBeDefined();
      expect(blob?.context?.backendRef).toBeNull();
    });
  });

  it("clears the ref when the stale result arrives via the external-turn path", async () => {
    const externalResult = toPromptActorResult(
      await realStaleCodexResumeResult(),
    );
    const actor = createActor(makeProvidedMachine(externalResult), {
      input: machineInput,
    });
    actors.push(actor);
    actor.start();

    actor.send({ type: "EXTERNAL_TURN_STARTED" });
    await waitForState(actor, "externalExecuting");
    actor.send({ type: "EXTERNAL_TURN_COMPLETED", result: externalResult });
    await waitForState(actor, "idle");

    expect(actor.getSnapshot().context.backendRef).toBeNull();

    await Promise.all(syncWrites);
    const row = await fixture.deps.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(row?.backendRef).toBeNull();
  });

  it("clears a Claude ref when stale provider evidence arrives on a QuerySession pump rejection", async () => {
    const conversationId = "conv-stale-claude-pump";
    const runtimeResult = await runStaleClaudePumpResumeTurn({
      conversationId,
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    });
    expect(runtimeResult.failure?.kind, runtimeResult.failure?.message).toBe(
      "stale_resume_ref",
    );
    expect(runtimeResult.continuationDisposition).toBe("clear");
    expect(runtimeResult.backendRef).toBeNull();

    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversationStateSchema.parse({
        id: conversationId,
        transcriptPath: "/tmp/claude-pump-transcript.jsonl",
        status: "awaiting",
        promptCount: 1,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        agentBackend: "claude",
        backendRef: STALE_CLAUDE_RESUME_REF,
      }),
    );

    const actor = createActor(
      makeProvidedMachine(toPromptActorResult(runtimeResult)),
      {
        input: {
          ...machineInput,
          conversationId,
          transcriptPath: "/tmp/claude-pump-transcript.jsonl",
          agentBackend: "claude",
          backendRef: STALE_CLAUDE_RESUME_REF,
        },
      },
    );
    actors.push(actor);
    actor.start();
    actor.send({
      type: "SUBMIT_PROMPT",
      promptText: "Continue where we left off",
      streamId: "s-claude",
    });
    await waitForState(actor, "idle");

    expect(actor.getSnapshot().context.backendRef).toBeNull();
    await Promise.all(syncWrites);
    const row = await fixture.deps.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversationId,
    );
    expect(row?.backendRef).toBeNull();
  });
});
