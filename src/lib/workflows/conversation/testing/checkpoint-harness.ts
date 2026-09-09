/**
 * A checkpoint harness over the lifecycle fixture: the actual provided
 * manager and machine, real SQLite rows, the real checkpoint repository and
 * the real generator driven by a canned task runner. Only the provider
 * runtime is a fake, and every runtime it creates carries its own reference
 * so a resumed continuation and a fresh one are distinguishable.
 */

import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";

import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ReadyResult,
} from "@/lib/agent-backends/conversation";
import type {
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";
import {
  compactionEnvelopeSchema,
  type CompactionEnvelope,
} from "@/lib/context-artifacts/schemas";
import { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import type { CheckpointScopeKey } from "@/lib/conversation-checkpoints/schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";

import { checkpointScopeKeyForStoreIdentity } from "../actor-input-loader";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "../runtime-state";
import { createMockBackendRuntime } from "./actor-deps-fixture";
import {
  createLifecycleFixture,
  type LifecycleFixtureOptions,
} from "./lifecycle-fixture";

export const CHECKPOINT_TRANSCRIPT = "/lifecycle-fixture/transcripts/c.jsonl";

export function transcriptText(
  seq: number,
  role: "user" | "assistant",
  body: string,
): TranscriptEntryWithSeq {
  return {
    seq,
    entryId: `entry-${seq}`,
    role,
    timestamp: "2026-01-01T00:00:00Z",
    content: [{ type: "text", text: body }],
  };
}

export const CHECKPOINT_ENTRIES: TranscriptEntryWithSeq[] = [
  transcriptText(
    0,
    "user",
    "the deploy key lives in vault path ops/deploy-2026",
  ),
  transcriptText(1, "assistant", "acknowledged, using the vault path"),
  transcriptText(2, "user", "build the checkpoint seed next"),
  transcriptText(3, "assistant", "starting on the builder"),
];

const WORKING_STATE = {
  objective: {
    text: "deliver the bounded checkpoint seed",
    sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
  },
  latestRequest: {
    text: "build the checkpoint seed next",
    sourceRefs: [{ messageIndex: 2, seqStart: 2, seqEnd: 2 }],
  },
  outstandingRequests: [],
  constraints: [],
  decisions: [],
  failedApproaches: [],
  openQuestions: [],
  blockers: [],
  nextActions: [
    {
      text: "freeze the rendered bytes",
      sourceRefs: [{ messageIndex: 3, seqStart: 3, seqEnd: 3 }],
    },
  ],
};

function envelopeFor(
  conversationId: string,
  endSeq: number,
): CompactionEnvelope {
  return compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "proj",
      sessionName: "sess",
      conversationId,
      coveredStartSeq: 0,
      coveredEndSeq: endSeq,
      messageCount: endSeq + 1,
      sourceHash: "envelope-hash",
    },
    agentBrief: "brief",
    currentState: {
      status: "in_progress",
      latestUserGoal: "build the checkpoint seed",
      nextBestActions: ["write the builder"],
    },
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
  });
}

/** Echo the `source` block the compaction prompt tells the model to copy. */
function envelopeFromPrompt(prompt: string) {
  const marker =
    "## Source metadata (copy `kind` and `source` verbatim)\n```json\n";
  const start = prompt.indexOf(marker);
  if (start === -1) throw new Error("prompt has no source metadata section");
  const jsonStart = start + marker.length;
  const meta = JSON.parse(
    prompt.slice(jsonStart, prompt.indexOf("\n```", jsonStart)),
  ) as { kind: string; source: CompactionEnvelope["source"] };
  return {
    ...envelopeFor(meta.source.conversationId, meta.source.coveredEndSeq),
    source: meta.source,
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
  };
}

/** The generation lane's model: envelope for the compaction pass, working state for the seed pass. */
export function cannedCheckpointRunner(calls: AgentTaskRequest[]) {
  return {
    backend: "claude" as const,
    async run(request: AgentTaskRequest): Promise<AgentTaskResult> {
      calls.push(request);
      const output = request.prompt.includes("checkpoint working state")
        ? WORKING_STATE
        : envelopeFromPrompt(request.prompt);
      return {
        text: JSON.stringify(output),
        structuredOutput: output,
        usage: { inputTokens: 800, outputTokens: 200, costUsd: 0.5 },
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
    },
  };
}

/**
 * The prompt a delivery turn dispatches: the frozen seed — which the builder
 * opens with its checkpoint-context heading — then the actual user input.
 * The exact bytes are pinned by the delivery suite; this matcher lets every
 * other suite say "the seeded form of this text" without re-rendering it.
 */
export function seededPrompt(text: string) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return expect.stringMatching(
    new RegExp(`^## Checkpoint context\\n\\n[\\s\\S]*\\n\\n${escaped}$`),
  );
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Wraps the real generator behind a gate so a test can hold the build. The
 * gate yields to the owned cancel signal the way a real lane would.
 */
export function gatedGenerator(options: { armed?: boolean } = {}) {
  const started = deferred();
  const gate = deferred();
  let armed = options.armed ?? true;
  const generate: typeof generateCheckpoint = async (input, deps) => {
    if (!armed) return generateCheckpoint(input, deps);
    started.resolve();
    await Promise.race([
      gate.promise,
      new Promise<void>((resolve) => {
        if (deps.signal?.aborted) resolve();
        deps.signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    return generateCheckpoint(input, deps);
  };
  return {
    generate,
    started,
    release: () => gate.resolve(),
    /** Start holding builds from the next generation on. */
    arm: () => {
      armed = true;
    },
  };
}

/** A generator that throws, as a lane whose model call blew up would. */
export function throwingGenerator(message = "lane exploded") {
  const generate: typeof generateCheckpoint = async () => {
    throw new Error(message);
  };
  return generate;
}

export interface CreatedRuntime {
  /** The reference this runtime reports on `backend_init`. */
  ref: AgentSessionRef;
  input: ConversationBackendCreateInput;
  runtime: ConversationBackendRuntime;
  close: ReturnType<typeof vi.fn>;
}

type CheckpointSeams = NonNullable<LifecycleFixtureOptions["checkpoint"]>;

export interface CheckpointHarnessOptions {
  generate?: typeof generateCheckpoint;
  conversation?: LifecycleFixtureOptions["conversation"];
  backendSupportsCheckpoint?: () => boolean;
  scope?: "session" | "project";
  readEntries?: CheckpointSeams["readEntries"];
  readConversation?: CheckpointSeams["readConversation"];
  repo?: CheckpointSeams["repo"];
  queue?: LifecycleFixtureOptions["queue"];
  beforeAdmissionStateRead?: LifecycleFixtureOptions["beforeAdmissionStateRead"];
  /** Seeded row reference; every created runtime reports a fresh one. */
  seededRef?: AgentSessionRef | null;
  /** Actor seams layered over the harness's own (memory, transcript reads…). */
  actorDeps?: LifecycleFixtureOptions["actorDeps"];
}

export async function createCheckpointHarness(
  options: CheckpointHarnessOptions = {},
) {
  const seededRef =
    options.seededRef === undefined
      ? ({ backend: "claude", ref: "sdk-session-seeded" } as const)
      : options.seededRef;
  const state = {
    dispatches: [] as string[],
    /** Every provider send, with the seed the backend was asked to carry. */
    turnInputs: [] as {
      promptText: string;
      syntheticForkSeed: string | null | undefined;
      runtime: number;
    }[],
    laneCalls: [] as AgentTaskRequest[],
    created: [] as CreatedRuntime[],
    /** When true, every runtime's close rejects until cleared. */
    closeRejects: false,
    /** When set, `sendTurn` waits for it before returning its result. */
    holdTurn: null as null | Promise<ConversationBackendTurnResult>,
    /** When set, every runtime's close waits for it before settling. */
    holdClose: null as null | Promise<void>,
    /**
     * How a runtime reports the turn's provider events. The default is the
     * common order — input accepted, then the session reference; a test
     * substitutes a reversed, partial or absent sequence.
     */
    emitTurnEvents: null as
      | null
      | ((
          turn: ConversationBackendTurnInput,
          ref: AgentSessionRef,
        ) => Promise<void>),
    /** When set, the next send throws it after emitting nothing, then clears. */
    sendTurnError: null as null | Error,
    /**
     * When true, a runtime whose send threw — the next send's error, or an
     * event sequence that throws after reporting events — reports itself
     * dead afterwards, which is what lets the replacement retry policy send
     * once more.
     */
    deadAfterSendFailure: false,
    /** When set, every runtime's pre-turn readiness check answers with it. */
    prepareForTurnStart: null as null | (() => Promise<ReadyResult>),
    /** When set, overrides fields of the next turn result, then clears. */
    nextTurnResult: null as null | Partial<ConversationBackendTurnResult>,
    externalEvents: undefined as
      | undefined
      | ((event: ConversationBackendEvent) => void),
  };
  let runtimeCount = 0;

  function createRuntime(
    input: ConversationBackendCreateInput,
  ): ConversationBackendRuntime {
    runtimeCount += 1;
    const ref = {
      backend: "claude",
      ref: `sdk-session-${runtimeCount}`,
    } as const;
    const close = vi.fn(async () => {
      if (state.holdClose) await state.holdClose;
      if (state.closeRejects) throw new Error("provider teardown hung");
    });
    let dead = false;
    const runtime = createMockBackendRuntime({
      prepareForTurnStart: async () =>
        state.prepareForTurnStart
          ? state.prepareForTurnStart()
          : { status: "ready" as const },
      sendTurn: async (turn) => {
        state.dispatches.push(turn.promptText);
        state.turnInputs.push({
          promptText: turn.promptText,
          syntheticForkSeed: turn.syntheticForkSeed,
          runtime: runtimeCount,
        });
        try {
          if (state.sendTurnError) {
            const error = state.sendTurnError;
            state.sendTurnError = null;
            throw error;
          }
          if (state.emitTurnEvents) await state.emitTurnEvents(turn, ref);
          else {
            await turn.onEvent({ type: "input_accepted" });
            await turn.onEvent({ type: "backend_init", backendRef: ref });
          }
        } catch (error) {
          if (state.deadAfterSendFailure) dead = true;
          throw error;
        }
        const override = state.nextTurnResult;
        state.nextTurnResult = null;
        const result: ConversationBackendTurnResult = {
          ...{
            backendRef: ref,
            costUsd: 0.01,
            durationMs: 1,
            numTurns: 1,
            contextTokens: 1,
            contextWindowMax: 200000,
            contentBlocks: [],
            aborted: false,
            compacted: false,
            failure: null,
            continuationDisposition: "retain",
          },
          ...override,
        };
        if (state.holdTurn) return state.holdTurn;
        return result;
      },
      close,
    });
    // The mock's status is a plain value; a runtime that died mid-send has
    // to answer the retry policy's liveness read from the flag instead.
    Object.defineProperty(runtime, "status", {
      get: () => (dead ? "dead" : "alive"),
      configurable: true,
    });
    state.created.push({ ref, input, runtime, close });
    return runtime;
  }

  const fixture = await createLifecycleFixture({
    ...(options.scope === "project"
      ? {
          address: {
            projectPath: "/lifecycle-fixture",
            target: {
              scope: "project",
              projectName: "lifecycle-fixture",
              conversationId: "c",
            },
          },
        }
      : {}),
    conversation: {
      transcriptPath: CHECKPOINT_TRANSCRIPT,
      promptCount: 2,
      backendRef: seededRef,
      ...options.conversation,
    },
    actorDeps: {
      getTranscriptPath: async () => CHECKPOINT_TRANSCRIPT,
      getConversationBackendFactory: () => ({
        backend: "claude",
        validateModelSelection() {},
        createRuntime: async (input) => {
          state.externalEvents = input.onExternalTurnEvent;
          return createRuntime(input);
        },
      }),
      getTaskRunner: () => cannedCheckpointRunner(state.laneCalls),
      ...options.actorDeps,
    },
    checkpoint: {
      ...(options.generate ? { generate: options.generate } : {}),
      ...(options.backendSupportsCheckpoint
        ? { backendSupportsCheckpoint: options.backendSupportsCheckpoint }
        : {}),
      ...(options.readEntries ? { readEntries: options.readEntries } : {}),
      ...(options.readConversation
        ? { readConversation: options.readConversation }
        : {}),
      ...(options.repo ? { repo: options.repo } : {}),
    },
    ...(options.queue ? { queue: options.queue } : {}),
    ...(options.beforeAdmissionStateRead
      ? { beforeAdmissionStateRead: options.beforeAdmissionStateRead }
      : {}),
  });
  fixture.transcripts.set(CHECKPOINT_TRANSCRIPT, [...CHECKPOINT_ENTRIES]);

  const identity = fixture.identity;
  const key = conversationRuntimeKey(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
  );
  const scopeKey: CheckpointScopeKey =
    checkpointScopeKeyForStoreIdentity(identity);

  const harness = {
    fixture,
    state,
    seededRef,
    key,
    scopeKey,
    hosted() {
      return {
        actor: fixture.actor(
          identity.projectPath,
          identity.sessionName,
          identity.conversationId,
        ),
        runtime: getConversationRuntime(key),
      };
    },
    /** The row as a restarted store reads it. */
    async readRow() {
      const store = fixture.persistence.recreateStore();
      const row =
        scopeKey.scope === "project"
          ? await store.getProjectConversation(
              identity.projectPath,
              identity.conversationId,
            )
          : await store.getConversation(
              identity.projectPath,
              identity.sessionName,
              identity.conversationId,
            );
      if (!row) throw new Error("row missing");
      return row;
    },
    /** Run one ordinary turn so the host holds a live provider runtime. */
    async runOrdinaryTurn(prompt = "first") {
      const admission = await fixture.manager.submitConversationTurn({
        binding: fixture.binding,
        turn: { promptText: prompt },
      });
      if (admission.kind !== "accepted") throw new Error(admission.message);
      const settled = await admission.turn.completed;
      expect(settled.outcome.kind).toBe("call_result");
      return settled;
    },
    start(requestId: string = randomUUID(), recover: string | null = null) {
      return fixture.manager.startConversationCheckpoint({
        address: fixture.binding.address,
        requestId,
        ...(recover === null ? {} : { recover }),
      });
    },
    admittedOr(
      result: Awaited<
        ReturnType<typeof fixture.manager.startConversationCheckpoint>
      >,
    ) {
      if (result.kind === "refused")
        throw new Error(
          `refused: ${result.refusal.code} ${result.refusal.reason}`,
        );
      return result;
    },
    /** A whole ordinary checkpoint, driven to its durable outcome. */
    async checkpointToReady() {
      const started = harness.admittedOr(await harness.start());
      const operation = await started.completion;
      if (operation.phase !== "ready")
        throw new Error(
          `checkpoint ended ${operation.phase}: ${operation.failure?.code}`,
        );
      return operation;
    },
    nudge() {
      return fixture.manager.ensureConversationActorAndDrain(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      );
    },
    enqueue(text: string) {
      return fixture.queue.enqueue({
        ...identity,
        content: [{ type: "text", text }],
      });
    },
    operation(operationId: string) {
      return fixture.checkpoints.getOperation(scopeKey, operationId);
    },
    check(recover?: string) {
      return fixture.manager.checkConversationCheckpoint(
        fixture.binding.address,
        recover === undefined ? {} : { recover },
      );
    },
    submit(promptText: string) {
      return fixture.manager.submitConversationTurn({
        binding: fixture.binding,
        turn: { promptText },
      });
    },
    /** The most recently created provider runtime. */
    latestRuntime(): CreatedRuntime {
      const latest = state.created.at(-1);
      if (!latest) throw new Error("no runtime was created");
      return latest;
    },
    async close() {
      await fixture.close();
    },
  };
  return harness;
}

export type CheckpointHarness = Awaited<
  ReturnType<typeof createCheckpointHarness>
>;
