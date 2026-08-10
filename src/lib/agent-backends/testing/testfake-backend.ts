/**
 * Parameterized test-only backend descriptor ("testfake").
 *
 * Proves the consumer-locality criterion: execution consumers depend only on
 * the descriptor interface, so a descriptor whose id is NOT in the production
 * backend enum can flow through the same corpus code the real backends use.
 * Every operation records into an append-only call log so assertions can show
 * the descriptor itself was exercised rather than a hidden fallback branch.
 *
 * Design rule: wherever a capability value could be shared with Claude or
 * Codex, this fake picks the third option or a distinct value (e.g. queue
 * `deliveryTiming` differs from Claude, `toolDiscovery.probeFallback` differs
 * from both). A consumer that silently falls back to a real backend's
 * constants then produces an observably wrong value, which the locality
 * suite's behavioral assertions catch.
 *
 * Test-only: production code must never import from
 * `agent-backends/testing/**`; production registration (`registerBackend`)
 * rejects the id at runtime — only `_registerBackendForTesting` admits it.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type {
  AgentBackendDescriptor,
  AgentBackendMetadata,
  BackendConversationCapabilities,
  BackendConversationTranscriptProjection,
  BackendTaskTranscriptProjection,
} from "../descriptor";
import type {
  ConversationBackendCreateInput,
  ConversationBackendFactory,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "../conversation";
import {
  assertRefOwnedBy,
  type BackendContinuityAdapter,
  type ContinuityContext,
  type ContinuityResumption,
  type ContinuityStartInput,
  type ContinuityValidation,
  type ForkInput,
  type ForkOutcome,
} from "../continuity";
import type {
  BackendRuntimeConfigAdapter,
  ResolvedCapabilityCascade,
  RuntimeConfigApplyResult,
} from "../runtime-config";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "../task";
import type { AgentFailureClassification } from "../errors";
import {
  createClassifierWithDefaultContinuation,
  failureMessage,
  isAbortFailure,
} from "../errors";
import type { AgentTranscriptEntry } from "../transcript";
import type { McpApplyResult, PortableMcpConfig } from "../portable-mcp";
import type { McpBackendCapabilities } from "@/lib/mcp/backend-capabilities";

export const testWidenedAgentBackendSchema = z.enum([
  "claude",
  "codex",
  "testfake",
]);

/**
 * The ONE sanctioned type-level fiction in the codebase (design Blocker 4,
 * D-B4.2): "testfake" is runtime-verified against the widened schema above,
 * then narrowed to `AgentBackendId` so it can flow through consumer code
 * typed against the closed union. Production registration rejects it
 * (`registerBackend`'s id-enum check); only `_registerBackendForTesting`
 * accepts it, and `agentSessionRefSchema` rejects it at storage seams.
 */
export const TESTFAKE_BACKEND_ID = testWidenedAgentBackendSchema.parse(
  "testfake",
) as AgentBackendId;

/** Sentinel classified as `stale_resume_ref` by the fake's classifier. */
export class TestFakeStaleRefError extends Error {
  constructor(message = "testfake resume ref is stale") {
    super(message);
    this.name = "TestFakeStaleRefError";
  }
}

export interface TestFakeCall {
  op: string;
  input: unknown;
}
export type TestFakeCallLog = TestFakeCall[];

/**
 * Prompt the scripted runtime never completes on its own: the turn stays
 * in-flight until the caller aborts its signal, then resolves as a clean
 * aborted result. Lets the conformance cancellation and mid-turn checks
 * drive the fake through the same abort-then-close sequence production uses.
 */
export const TESTFAKE_HANGING_PROMPT = "testfake hanging prompt";

/** Deterministic scripted values, exported so assertions never re-derive them. */
export const TESTFAKE_CONVERSATION_REF = "fake-ref-1";
export const TESTFAKE_TASK_REF = "fake-task-ref-1";
export const TESTFAKE_TURN_TEXT = "testfake scripted turn text";
export const TESTFAKE_TASK_TEXT = "testfake scripted task text";
export const TESTFAKE_TURN_COST_USD = 0.0042;
export const TESTFAKE_TURN_DURATION_MS = 42;
export const TESTFAKE_TURN_NUM_TURNS = 1;

export const testfakeMetadata: AgentBackendMetadata = {
  label: "Test Fake",
  toneToken: "cyan",
  skillTriggerPrefix: "/",
  models: [
    {
      id: "fake-1",
      label: "Fake 1",
      description: "deterministic scripted model",
      effortLevels: [],
    },
  ],
  defaultModelId: "fake-1",
  defaultTimeoutMs: null,
};

/**
 * Distinct-from-real capability values: `deliveryTiming` differs from
 * Claude's `in_turn`; `continuationStrength` is the third option neither the
 * Claude (`precise_session`) nor pre-seam fallbacks would produce for a
 * conversation backend; the `(agents, next_turn)` capability-kind pair is
 * declared by neither real backend (Claude agents bind `next_conversation`,
 * Codex declares no `agents` kind).
 */
export const testfakeConversationCapabilities: BackendConversationCapabilities =
  {
    queue: { acceptsWhileRunning: false, deliveryTiming: "next_turn" },
    continuationStrength: "synthetic_thread",
    fork: "unsupported",
    structuredOutput: "post_validation",
    contextWindowMetrics: false,
    nativeMidTurnAskUser: false,
    externalTurns: false,
    capabilityKinds: [{ kind: "agents", applyTiming: "next_turn" }],
  };

/**
 * MCP capability combination distinct from both real backends:
 * `strictAuthoritativeConfig: false` and `probeFallback: false` are values
 * neither Claude nor Codex declares.
 */
export const testfakeMcpCapabilities: McpBackendCapabilities = {
  backend: TESTFAKE_BACKEND_ID,
  strictAuthoritativeConfig: false,
  serverDisable: "native",
  betweenTurnApply: "next-turn",
  toolFiltering: {
    mode: "permission-layer",
    byTransport: {
      stdio: "permission-layer",
      "streamable-http": "permission-layer",
      sse: "permission-layer",
    },
  },
  toolDiscovery: { preferred: "probe", probeFallback: false },
};

export interface TestFakeBackendOverrides {
  capabilities?: Partial<BackendConversationCapabilities>;
  metadata?: Partial<AgentBackendMetadata>;
  /** Reported by every runtime the fake creates; lets consumer-locality
   * drives observe capability-vs-turn-state decisions (e.g. MCP staging
   * while a turn is active). */
  runtimeIsTurnActive?: boolean;
}

export interface TestFakeBackend {
  descriptor: AgentBackendDescriptor;
  calls: TestFakeCallLog;
  /**
   * Per-instance frame markers proving byte-faithful transcript passthrough:
   * a consumer that rebuilt or normalized the payload would lose them.
   */
  conversationFrameMarkers: readonly [string, string];
  taskFrameMarkers: readonly [string, string];
  /** The exact `transcript_entry` envelopes the conversation runtime emits. */
  conversationTranscriptEntries: readonly AgentTranscriptEntry[];
  /** The exact transcript the task runner returns. */
  taskTranscriptEntries: readonly AgentTranscriptEntry[];
}

function buildFrameEntries(
  markers: readonly [string, string],
): AgentTranscriptEntry[] {
  return markers.map((marker, seq) => ({
    seq,
    backend: TESTFAKE_BACKEND_ID,
    type: "testfake_frame",
    raw: { type: "testfake_frame", marker },
  }));
}

export function createTestFakeBackend(
  overrides: TestFakeBackendOverrides = {},
): TestFakeBackend {
  const calls: TestFakeCallLog = [];
  const record = (op: string, input: unknown): void => {
    calls.push({ op, input });
  };

  const capabilities: BackendConversationCapabilities = {
    ...testfakeConversationCapabilities,
    ...overrides.capabilities,
  };
  const metadata: AgentBackendMetadata = {
    ...testfakeMetadata,
    ...overrides.metadata,
  };

  const conversationFrameMarkers = [randomUUID(), randomUUID()] as const;
  const taskFrameMarkers = [randomUUID(), randomUUID()] as const;
  const conversationTranscriptEntries = buildFrameEntries(
    conversationFrameMarkers,
  );
  const taskTranscriptEntries = buildFrameEntries(taskFrameMarkers);

  // ---------------------------------------------------------------
  // Conversation runtime + factory
  // ---------------------------------------------------------------

  function createScriptedRuntime(
    input: ConversationBackendCreateInput,
  ): ConversationBackendRuntime {
    let status: "alive" | "dead" = "alive";
    let hangingTurnActive = false;

    const runtime: ConversationBackendRuntime = {
      backend: TESTFAKE_BACKEND_ID,
      get status() {
        return status;
      },
      get isTurnActive() {
        return overrides.runtimeIsTurnActive === true || hangingTurnActive;
      },
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      outputFormat: input.outputFormat,
      alignmentVersion: null,

      async sendTurn(
        turnInput: ConversationBackendTurnInput,
      ): Promise<ConversationBackendTurnResult> {
        record("runtime.sendTurn", {
          promptText: turnInput.promptText,
          modelId: turnInput.modelId,
          autonomous: turnInput.autonomous,
        });
        if (turnInput.promptText === TESTFAKE_HANGING_PROMPT) {
          hangingTurnActive = true;
          try {
            await new Promise<void>((resolve) => {
              if (turnInput.signal.aborted) {
                resolve();
                return;
              }
              turnInput.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          } finally {
            hangingTurnActive = false;
          }
          return {
            backendRef: null,
            costUsd: null,
            durationMs: null,
            numTurns: null,
            contextTokens: null,
            contextWindowMax: null,
            contentBlocks: [],
            aborted: true,
            compacted: false,
            failure: null,
            continuationDisposition: "retain",
          };
        }
        await turnInput.onEvent({
          type: "backend_init",
          backendRef: {
            backend: TESTFAKE_BACKEND_ID,
            ref: TESTFAKE_CONVERSATION_REF,
          },
        });
        const block = { type: "text" as const, text: TESTFAKE_TURN_TEXT };
        await turnInput.onEvent({ type: "content", block });
        for (const entry of conversationTranscriptEntries) {
          await turnInput.onEvent({ type: "transcript_entry", entry });
        }
        await turnInput.onEvent({ type: "input_accepted" });
        return {
          backendRef: {
            backend: TESTFAKE_BACKEND_ID,
            ref: TESTFAKE_CONVERSATION_REF,
          },
          costUsd: TESTFAKE_TURN_COST_USD,
          durationMs: TESTFAKE_TURN_DURATION_MS,
          numTurns: TESTFAKE_TURN_NUM_TURNS,
          contextTokens: null,
          contextWindowMax: null,
          contentBlocks: [block],
          aborted: false,
          compacted: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },

      async applyPortableMcpConfig(
        config: PortableMcpConfig,
      ): Promise<McpApplyResult> {
        record("runtime.applyPortableMcpConfig", {
          serverIds: config.servers.map((s) => s.id),
        });
        // Truthful to the declared mcp.betweenTurnApply: "next-turn".
        return {
          disposition: "deferred_to_next_turn",
          droppedServerIds: [],
          droppedFields: [],
          errors: {},
        };
      },

      close() {
        record("runtime.close", {});
        status = "dead";
      },
    };

    return runtime;
  }

  const factory: ConversationBackendFactory = {
    backend: TESTFAKE_BACKEND_ID,
    async createRuntime(input) {
      record("factory.createRuntime", {
        conversationId: input.conversationId,
        persistedRef: input.persistedRef,
        modelId: input.modelId,
        capabilities: input.tooling.capabilities ?? null,
      });
      return createScriptedRuntime(input);
    },
  };

  // ---------------------------------------------------------------
  // Continuity adapter (in-memory)
  // ---------------------------------------------------------------

  const mintedRefs = new Set<string>();
  let mintCounter = 0;

  const continuity: BackendContinuityAdapter = {
    backend: TESTFAKE_BACKEND_ID,
    async start(input: ContinuityStartInput): Promise<AgentSessionRef> {
      record("continuity.start", input);
      mintCounter += 1;
      const ref = `fake-ref-${mintCounter}`;
      mintedRefs.add(ref);
      return { backend: TESTFAKE_BACKEND_ID, ref };
    },
    async validate(
      ref: AgentSessionRef,
      input: ContinuityContext,
    ): Promise<ContinuityValidation> {
      assertRefOwnedBy(TESTFAKE_BACKEND_ID, ref);
      record("continuity.validate", { ref, input });
      if (!mintedRefs.has(ref.ref)) {
        return {
          status: "stale",
          reason: `ref "${ref.ref}" was not minted by this instance`,
        };
      }
      return { status: "valid" };
    },
    async resumeOrRecover(
      ref: AgentSessionRef,
      input: ContinuityContext,
    ): Promise<ContinuityResumption> {
      assertRefOwnedBy(TESTFAKE_BACKEND_ID, ref);
      record("continuity.resumeOrRecover", { ref, input });
      return { ref, recovered: false };
    },
    async fork(ref: AgentSessionRef, input: ForkInput): Promise<ForkOutcome> {
      assertRefOwnedBy(TESTFAKE_BACKEND_ID, ref);
      record("continuity.fork", { ref, input });
      // Matches the declared `fork: "unsupported"` capability.
      return { kind: "unsupported" };
    },
  };

  // ---------------------------------------------------------------
  // Runtime-config adapter
  // ---------------------------------------------------------------

  const runtimeConfig: BackendRuntimeConfigAdapter = {
    backend: TESTFAKE_BACKEND_ID,
    async apply(input: {
      runtime: ConversationBackendRuntime;
      resolved: ResolvedCapabilityCascade;
    }): Promise<RuntimeConfigApplyResult> {
      record("runtimeConfig.apply", {
        backend: input.resolved.backend,
        kinds: input.resolved.kinds.map((k) => k.kind),
      });
      // Structural declared-kind check without the closed id enum: the
      // production `validateResolvedCascade` parses the cascade through
      // `agentBackendSchema`, which would reject the widened test id and
      // mask the coherence being tested (declared vs undeclared kinds).
      if (input.resolved.backend !== TESTFAKE_BACKEND_ID) {
        return {
          status: "rejected",
          error: `cascade addressed to backend '${input.resolved.backend}' but adapter is '${TESTFAKE_BACKEND_ID}'`,
        };
      }
      const declared = new Set(capabilities.capabilityKinds.map((k) => k.kind));
      for (const kind of input.resolved.kinds) {
        if (!declared.has(kind.kind)) {
          return {
            status: "rejected",
            error: `capability kind '${kind.kind}' is not declared by backend '${TESTFAKE_BACKEND_ID}'`,
          };
        }
      }
      return { status: "applied" };
    },
  };

  // ---------------------------------------------------------------
  // Task runner
  // ---------------------------------------------------------------

  const runner: AgentTaskRunner = {
    backend: TESTFAKE_BACKEND_ID,
    async run(input: AgentTaskRequest): Promise<AgentTaskResult> {
      record("runner.run", {
        prompt: input.prompt,
        workingDirectory: input.workingDirectory,
        resumeRef: input.resumeRef ?? null,
        hasOutputSchema: input.outputSchema !== undefined,
      });
      return {
        backendRef: { backend: TESTFAKE_BACKEND_ID, ref: TESTFAKE_TASK_REF },
        text: TESTFAKE_TASK_TEXT,
        usage: {
          inputTokens: 11,
          cachedInputTokens: null,
          outputTokens: 7,
          costUsd: 0.0007,
        },
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
        transcript: [...taskTranscriptEntries],
      };
    },
  };

  // ---------------------------------------------------------------
  // Failure classifier
  // ---------------------------------------------------------------

  function classifyFailure(error: unknown): AgentFailureClassification {
    record("errors.classify", { message: failureMessage(error) });
    if (isAbortFailure(error)) {
      return {
        kind: "aborted",
        message: failureMessage(error),
        retryable: false,
      };
    }
    if (error instanceof TestFakeStaleRefError) {
      return {
        kind: "stale_resume_ref",
        message: error.message,
        retryable: true,
      };
    }
    return {
      kind: "backend_error",
      message: failureMessage(error),
      retryable: false,
    };
  }

  const errors = createClassifierWithDefaultContinuation(classifyFailure);

  const conversationTranscriptProjection: BackendConversationTranscriptProjection =
    {
      persistContentEvents: true,
      projectBackendInit(input) {
        record("transcript.projectBackendInit", input);
        return null;
      },
      projectTurnResult(input) {
        record("transcript.projectTurnResult", input);
        return {
          timestamp: input.timestamp,
          type: "result",
          raw: {
            backend: TESTFAKE_BACKEND_ID,
            backendRef: input.backendRef,
            durationMs: input.durationMs,
            numTurns: input.numTurns,
            contextTokens: input.contextTokens,
            contextWindowMax: input.contextWindowMax,
            costUsd: input.costUsd,
            aborted: input.aborted,
            error: input.error,
          },
        };
      },
    };

  const taskTranscriptProjection: BackendTaskTranscriptProjection = {
    projectAssistantMetadata(backendRef) {
      record("transcript.projectTaskAssistantMetadata", backendRef);
      return undefined;
    },
  };

  const descriptor: AgentBackendDescriptor = {
    id: TESTFAKE_BACKEND_ID,
    metadata,
    conversation: {
      factory,
      continuity,
      capabilities,
      // Same honesty as the task facet below: the fake conversation runtime
      // establishes no OS-level envelope, so an implementer turn that needs one
      // must be refused rather than dispatched here.
      fsWriteRestriction: "unsupported",
      runtimeConfig,
      transcript: conversationTranscriptProjection,
    },
    tasks: {
      runner,
      structuredOutput: "post_validation",
      transcript: taskTranscriptProjection,
      // The fake runner records requests; it establishes no OS-level envelope,
      // so declaring anything else here would be a lie the refusal rule trusts.
      fsWriteRestriction: "unsupported",
    },
    managedSkills: { conversations: "hermetic", tasks: "hermetic" },
    mcp: testfakeMcpCapabilities,
    errors,
  };

  return {
    descriptor,
    calls,
    conversationFrameMarkers,
    taskFrameMarkers,
    conversationTranscriptEntries,
    taskTranscriptEntries,
  };
}
