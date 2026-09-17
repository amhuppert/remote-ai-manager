import { settledConversationTurn } from "@/lib/workflows/conversation/testing/turn-result-fixture";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { createMcpRuntimeApplicationStore } from "@/lib/mcp/runtime-apply";
import { createConversationManagerFixture } from "@/lib/workflows/conversation/testing/manager-fixture";

import { getConversationQueueDeps as currentQueueDependencies } from "@/lib/conversations/message-queue-drain";
import { admitConversationProfileForTurn as admitFixtureProfile } from "@/lib/conversations/profile-admission";
const managerFixture: ReturnType<typeof createConversationManagerFixture> =
  createConversationManagerFixture({
    loadActors: async () => conversationActors,
    dependencies: {
      admitProfileForTurn: (identity) => admitFixtureProfile(identity),
      queue: {
        submitTurn: (...args) => currentQueueDependencies().submitTurn(...args),
        claimNextTurnBatch: (...args) =>
          currentQueueDependencies().claimNextTurnBatch(...args),
        markPending: (...args) =>
          currentQueueDependencies().markPending(...args),
        markDelivered: (...args) =>
          currentQueueDependencies().markDelivered(...args),
        markFailed: (...args) => currentQueueDependencies().markFailed(...args),
        recoverAbandonedDeliveries: (...args) =>
          currentQueueDependencies().recoverAbandonedDeliveries(...args),
        runConversationCommand: (...args) =>
          currentQueueDependencies().runConversationCommand(...args),
      },
    },
  });
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
let conversationActors: ReturnType<typeof createTestActorImplementations>;
import type { ActorFixtureDependencies } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { createManagedRuntimeFixture } from "@/lib/workflows/conversation/testing/runtime-binding-fixture";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
/**
 * Consumer-locality behavioral half (design Blocker 4, D-B4.4 §2).
 *
 * Registers the parameterized testfake descriptor via the sanctioned
 * `_registerBackendForTesting` bypass and drives real corpus-E code
 * end-to-end with `backend: "testfake"`, asserting on values only obtainable
 * through the descriptor (distinct capability values, the call log, the
 * `testfake_frame` markers, the `{backend:"testfake", ref}` envelopes).
 * Literal-absence (the static half) proves the corpus needs no edits; this
 * half proves the parametric path is live.
 *
 * Persistence boundary (deliberate): `agentSessionRefSchema` rejects
 * `"testfake"` at storage seams by design, so these drives use in-memory
 * stores through the existing DI seams — an explicit, documented exemption
 * from the real-store-fixture steering rule (that rule targets durability
 * correctness, owned by the per-backend contract tests; this suite asserts
 * consumer parametricity). The one drive that does touch real SQLite (E5)
 * stores no backend id on the row it mutates.
 *
 * Sections staged to Phase 3 pin the EXACT current blocking outcome (the
 * schema rejection or misreported value that blocks the fake today) instead
 * of a blanket `it.fails`: when the owning Phase 3 slice lands, the pinned
 * outcome changes and the section must be rewritten as enforced in the same
 * PR — while any *different* failure surfaces as a real regression instead
 * of being absorbed.
 */

import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import {
  getConversationQueueDeps,
  setConversationQueueDeps,
  _resetConversationQueueDepsForTesting,
} from "@/lib/conversations/message-queue-drain";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentSessionRefSchema } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { SessionState } from "@/lib/sessions/schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import {
  agentCapabilityCascadeKindSchema,
  type AgentCapabilityCascadeKind,
} from "@/lib/agent-capabilities/schemas";
import {
  applyRuntimeConfigToConversationRuntime,
  createConversationStartCapabilityComposer,
  type ConversationStartCapabilityComposerDeps,
} from "@/lib/agent-capabilities/default-deps";
import { createCapabilityConfigComposer } from "@/lib/agent-capabilities/runtime-seed";
import {
  composeConversationStartRuntime,
  ownedCascadesForBackend,
} from "@/lib/agent-capabilities/runtime-composer";
import {
  registerRuntime,
  _resetForTesting as resetBackendRuntimeRegistry,
} from "./runtime-registry";

import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
  getBackendDescriptor,
  getConversationBackendFactory,
  getTaskRunner,
} from "./registry-core";
import { bootstrapBackends } from "./registry";
import type { ConversationBackendCreateInput } from "./conversation";
import {
  createTestFakeBackend,
  TESTFAKE_BACKEND_ID,
  TESTFAKE_CONVERSATION_REF,
  TESTFAKE_TASK_REF,
  TESTFAKE_TASK_TEXT,
  TESTFAKE_TURN_COST_USD,
  TESTFAKE_TURN_TEXT,
  type TestFakeBackend,
} from "./testing/testfake-backend";

import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";

import type { ExecutePromptInput } from "@/lib/workflows/conversation/types";
import {
  conversationRuntimeKey,
  registerConversationRuntime,
  _resetForTesting as resetConversationRuntimeState,
} from "@/lib/workflows/conversation/runtime-state";

import { createExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import { createMcpRuntimeApplyService } from "@/lib/mcp/runtime-apply";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { createConversationService } from "@/lib/conversations/service";

import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createLaneScheduler } from "@/lib/workflows/primitives/lane-scheduler";
import { createWorkflowAgentCaller } from "@/lib/workflows/primitives/workflow-agent-caller";
import { createGraphWorkflowImplementerRunner } from "@/lib/workflow-graph/implementer-runner";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PROJECT_PATH = "/projects/locality";
const PROJECT_NAME = "locality";
const SESSION_NAME = "locality-session";
const WORKTREE_PATH = "/projects/locality/.worktrees/locality-session";
const NOW = "2026-07-12T00:00:00.000Z";
const TESTFAKE_MODEL_SELECTION = {
  modelId: "fake-1",
  parameters: {},
} satisfies BackendModelSelection;
const CLAUDE_MODEL_SELECTION = {
  modelId: "opus",
  parameters: { effort: "high" },
} satisfies BackendModelSelection;
const CODEX_MODEL_SELECTION = {
  modelId: "gpt-5.4",
  parameters: { reasoning: "high", fast: "false" },
} satisfies BackendModelSelection;
const CURSOR_MODEL_SELECTION = {
  modelId: "composer-2.5",
  parameters: { fast: "true" },
} satisfies BackendModelSelection;

function makeCreateInput(
  conversationId: string,
): ConversationBackendCreateInput {
  return {
    executionClass: "ordinary-conversation" as const,
    conversationId,
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    conversationTarget: sessionConversationTarget(
      PROJECT_NAME,
      SESSION_NAME,
      conversationId,
    ),
    worktreePath: WORKTREE_PATH,
    persistedRef: null,
    modelSelection: TESTFAKE_MODEL_SELECTION,
    sessionInstructions: [],
    tooling: {},
  };
}

function makeConversationRecord(
  id: string,
  overrides: Partial<ConversationState> = {},
): ConversationState {
  // "testfake" fails the stored schema's agentBackend enum, so it is applied
  // after the parse rather than passed through makeConversationState.
  return {
    ...makeConversationState({ id, createdAt: NOW, lastActivityAt: NOW }),
    agentBackend: TESTFAKE_BACKEND_ID,
    ...overrides,
  };
}

interface InMemoryActorHarness {
  deps: ActorFixtureDependencies;
  transcript: TranscriptEntry[];
  conversation: ConversationState;
  /** Every cascade kind production composition asked a discovery provider
   * for — a misrouted identity fallback would surface another backend's
   * cascades here. */
  capabilityDiscoveryLookups: AgentCapabilityCascadeKind[];
}

/**
 * Production composer over in-memory stores: the REAL
 * `createConversationStartCapabilityComposer` + `composeConversationStartRuntime`
 * pipeline, with discovery lookups recorded so drives can assert which
 * cascades composition selected for the fake backend.
 */
function createInMemoryCapabilityComposer(
  lookups: AgentCapabilityCascadeKind[],
) {
  const deps: ConversationStartCapabilityComposerDeps = {
    readGlobalOverrides: async () => undefined,
    getProjectAgentCapabilityOverrides: async () => undefined,
    getSession: async () => null,
    getProjectConversation: async () => null,
    getDiscoveryProvider: (cascadeKind) => {
      lookups.push(cascadeKind);
      return { discover: async () => ({ items: [] }) };
    },
    composeRuntime: composeConversationStartRuntime,
    homeDir: () => "/inmemory/home",
    logDiscoveryFailure: () => {},
  };
  return createConversationStartCapabilityComposer(deps);
}

/**
 * Fully in-memory `ActorFixtureDependencies`: transcript appends land in an
 * array, conversation mutations hit a plain typed record, and backend
 * resolution goes through the REAL registry (populated with the testfake
 * descriptor) so the drive proves the registry path, not a test shortcut.
 * Capability composition is the production composer pipeline (not a stubbed
 * `undefined`), so a turn exercises real conversation-start composition.
 */
function createInMemoryActorDeps(conversationId: string): InMemoryActorHarness {
  const transcript: TranscriptEntry[] = [];
  const conversation = makeConversationRecord(conversationId);
  const capabilityDiscoveryLookups: AgentCapabilityCascadeKind[] = [];
  const composeCapabilityConfig = createCapabilityConfigComposer(
    createInMemoryCapabilityComposer(capabilityDiscoveryLookups),
  );

  const deps: ActorFixtureDependencies = {
    log: createCapturingLogger(),
    checkpoint: {
      async repo() {
        throw new Error("in-memory harness has no checkpoint repository");
      },
      now: () => new Date().toISOString(),
    },
    acquireConversationLock: () => () => {},
    acquireQuerySlot: async () => () => {},
    getTranscriptPath: async (id) => `/inmemory/${id}.jsonl`,
    readConfig: async () => ({
      agentBackends: {
        claude: {
          modelSelection: CLAUDE_MODEL_SELECTION,
          timeoutMs: null,
        },
        codex: {
          modelSelection: CODEX_MODEL_SELECTION,
          timeoutMs: null,
        },
        cursor: {
          modelSelection: CURSOR_MODEL_SELECTION,
          timeoutMs: null,
        },
        [TESTFAKE_BACKEND_ID]: {
          modelSelection: TESTFAKE_MODEL_SELECTION,
          timeoutMs: null,
          stallTimeoutMs: null,
        },
      },
      maxTurns: 50,
      idleQuerySessionTtlMs: 0,
    }),
    getProjectDisplayName: (p) => p.split("/").pop() ?? p,
    getDebugLogUrl: (id) => `http://localhost/debug/${id}`,
    safeAppendTranscriptEntry: async (_id, entry) => {
      transcript.push(entry);
    },
    appendTranscriptEntryOnce: async () => {},
    safeAppendTranscriptEntryOnce: async (_id, entry) => {
      if (transcript.some((existing) => existing.id === entry.id)) return;
      transcript.push(entry);
    },
    saveTranscriptImage: async (_id, index) => `/inmemory/images/${index}`,
    getNextImageIndex: async () => 1,
    backendSupportsCheckpointFork: () => false,
    getConversationBackendFactory: (backend) =>
      getConversationBackendFactory(backend),
    admitConfiguredModelSelection: async ({ modelSelection }) => ({
      ok: true,
      modelSelection,
    }),
    getConversationCapabilities: (backend) =>
      getBackendDescriptor(backend).conversation?.capabilities,
    registerBackendRuntime: () => {},
    unregisterBackendRuntime: () => {},
    buildChildEnv: () => ({ NODE_ENV: "test" }),
    resolvePluginPaths: async () => [],
    getCodexToolPromptHint: () => "",
    mutateConversation: async (_pp, _sn, _id, _label, mutate) => {
      mutate(conversation);
    },
    getConversation: async () => conversation,
    getSessionState: async () => null,
    getActiveAlignmentInjection: async () => null,
    getActiveAlignmentVersion: async () => null,
    createReferenceDocument: async () => ({}),
    getReferenceDocuments: async () => [],
    fileExists: () => false,
    readConversationMessages: async () => [],
    composePortableMcpForConversation: async () => ({ servers: [] }),
    applyMcpAtTurnStart: async (input) => ({
      conversationId: input.conversationId,
      backend: input.backend,
      disposition: "applied_now" as const,
      effectiveConfigHash: "inmemory-hash",
    }),
    applyCapabilityAtTurnStart: async () => ({}),
    applyCapabilityWhenIdle: async () => ({}),
    composeCapabilityConfigForConversation: composeCapabilityConfig,
    composeCapabilityConfigForProjectConversation: async () => {
      throw new Error(
        "project-conversation composition is out of scope for session drives",
      );
    },
    executeAgentCall,
    getTaskRunner: (backend) => getTaskRunner(backend),
    getLiveTicketBlock: async () => null,
    getMemoryIndexBlock: async () => null,
    readLiveReference: async () => null,
    readNotepadForInjection: async () => null,
    recordNotepadDeliveries: async () => {},
    recordMemoryIndexDeliveries: async () => {},
    resetMemoryIndexDelivery: async () => {},
    prepareNotepadChangeNotice: async (conversationId: string) => ({
      conversationId,
      block: null,
      advances: [],
    }),
    settleNotepadChangeNotice: async () => {},
    claimWorkflowResults: async () => [],
    settleWorkflowResults: async () => 0,
    releaseWorkflowResults: async () => 0,
    confirmQueuedDelivery: async () => 0,
    markQueuedUncertain: async () => {},
    markQueuedPending: async () => {},
    markQueuedFailed: async () => {},
    notifyRuntimeCleanup: async () => {},
  };

  return { deps, transcript, conversation, capabilityDiscoveryLookups };
}

let fake: TestFakeBackend;

beforeEach(() => {
  fake = createTestFakeBackend();
  _resetBackendRegistryForTesting();
  _registerBackendForTesting(fake.descriptor);
});

afterEach(() => {
  _resetBackendRegistryForTesting();
  bootstrapBackends();
});

// ---------------------------------------------------------------------------
// Boundary pin
// ---------------------------------------------------------------------------

describe("persistence boundary pin", () => {
  it("agentSessionRefSchema is the intentional rejection point for the fake id", () => {
    // The closed registry means persistence stays closed: the canonical id
    // schema (allowed-edit #1 when adding a real backend) is the single
    // sanctioned place a fake id is rejected.
    expect(
      agentSessionRefSchema.safeParse({ backend: "testfake", ref: "x" })
        .success,
    ).toBe(false);
  });

  it("agentCapabilityCascadeKindSchema is the intentional rejection point for third-backend cascades", () => {
    // Overrides, metadata, and runtime hashes are keyed by the persisted
    // cascade-kind enum; declaring a new backend's cascades is a schema
    // edit, so composition honestly derives ZERO owned cascades for the
    // fake instead of borrowing another backend's.
    expect(
      agentCapabilityCascadeKindSchema.safeParse("testfake-agents").success,
    ).toBe(false);
    expect(ownedCascadesForBackend(TESTFAKE_BACKEND_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E1 — AgentCall facade
// ---------------------------------------------------------------------------

describe("E1: executeAgentCall is parametric in the backend id", () => {
  it("conversation shape: dispatch resolution and result carry the fake's descriptor values", async () => {
    const runtime = await fake.descriptor.conversation!.factory.createRuntime(
      makeCreateInput("conv-e1"),
    );
    let resolvedBackend: string | undefined;

    const result = await executeAgentCall(
      {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn",
        prompt: "run the testfake turn",
        modelSelection: TESTFAKE_MODEL_SELECTION,
        writeCapability: "read_only",
      },
      {
        defaultConversationBackend: TESTFAKE_BACKEND_ID,
        resolveConversationRuntime: (request) => {
          resolvedBackend = request.backend;
          return {
            runtime,
            capabilityView: capabilityViewForBackend(request.backend!),
            signal: new AbortController().signal,
            modelSelection: TESTFAKE_MODEL_SELECTION,
          };
        },
      },
    );

    expect(resolvedBackend).toBe("testfake");
    expect(result.backend).toBe(TESTFAKE_BACKEND_ID);
    expect(result.backendRef).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      ref: TESTFAKE_CONVERSATION_REF,
    });
    // The attached view equals the fake's declared values — specifically
    // `synthetic_thread`, which the deleted Claude-fallback could not produce.
    expect(result.capabilities).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      continuationStrength: "synthetic_thread",
      structuredOutputEnforcement: "post_validation",
      mcpApplicationBoundary: "per_request",
      contextMetricsAvailable: false,
      nativeMidTurnAskUser: false,
    });
    expect(result.outcome).toEqual({
      kind: "completed",
      text: TESTFAKE_TURN_TEXT,
      contentBlocks: [{ type: "text", text: TESTFAKE_TURN_TEXT }],
      numTurns: 1,
    });
    expect(fake.calls.map((c) => c.op)).toContain("factory.createRuntime");
    expect(fake.calls.map((c) => c.op)).toContain("runtime.sendTurn");
  });

  it("task shape: the request carries the fake id through the facade to the fake runner", async () => {
    const result = await executeAgentCall(
      {
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        backend: TESTFAKE_BACKEND_ID,
        prompt: "run the testfake task",
        modelSelection: TESTFAKE_MODEL_SELECTION,
        timeoutMs: 0,
      },
      {
        resolveTaskRunner: (request) => ({
          runner: getTaskRunner(request.backend),
          capabilityView: capabilityViewForBackend(request.backend),
          workingDirectory: "/tmp",
          modelSelection: TESTFAKE_MODEL_SELECTION,
        }),
      },
    );

    expect(result.backend).toBe(TESTFAKE_BACKEND_ID);
    expect(result.backendRef).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      ref: TESTFAKE_TASK_REF,
    });
    if (result.outcome.kind !== "completed") {
      throw new Error(`expected completed outcome, got ${result.outcome.kind}`);
    }
    expect(result.outcome.text).toBe(TESTFAKE_TASK_TEXT);
    expect(result.outcome.transcript?.map((e) => e.raw)).toEqual(
      fake.taskTranscriptEntries.map((e) => e.raw),
    );
    expect(fake.calls.map((c) => c.op)).toContain("runner.run");
  });
});

// ---------------------------------------------------------------------------
// E2 — conversation actor (executePromptForMachine)
// ---------------------------------------------------------------------------

describe("E2: executePromptForMachine drives a testfake turn end-to-end", () => {
  afterEach(() => {
    resetConversationRuntimeState();
  });

  it("completes the turn, persists byte-identical testfake frames, and reads the disposition from the result", async () => {
    const harness = createInMemoryActorDeps("conv-e2");
    conversationActors = createTestActorImplementations(harness.deps);

    const input: ExecutePromptInput = {
      turn: {
        kind: "conversation_turn",
        backend: TESTFAKE_BACKEND_ID,
        promptText: "hello testfake",
        images: [],
        modelSelection: TESTFAKE_MODEL_SELECTION,
        autonomous: false,
      },
      persistence: "durable",
      projectPath: PROJECT_PATH,
      target: targetFromStoreSessionName(PROJECT_NAME, SESSION_NAME, "conv-e2"),

      worktreePath: WORKTREE_PATH,

      transcriptPath: "/inmemory/conv-e2.jsonl",
      agentBackend: TESTFAKE_BACKEND_ID,
      backendRef: null,
      promptCount: 0,
      forkedFrom: null,
      role: null,
      streamId: "stream-e2",
      onModelSelectionResolved: async () => {},
      debugMode: null,
    };
    registerConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );

    const result = await conversationActors.executePromptForMachine(input);

    expect(result.error).toBeNull();
    expect(result.backendRef).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      ref: TESTFAKE_CONVERSATION_REF,
    });
    // Completion reads the disposition from the normalized result — no
    // identity branch decides whether the ref survives.
    expect(result.continuationDisposition).toBe("retain");
    expect(result.costUsd).toBe(TESTFAKE_TURN_COST_USD);
    expect(result.contentBlocks).toEqual([
      { type: "text", text: TESTFAKE_TURN_TEXT },
    ]);

    // Both testfake_frame envelopes persisted byte-identically (marker uuid
    // equality proves passthrough — a consumer that rebuilt the payload
    // would lose the per-instance markers).
    const frames = harness.transcript.filter(
      (entry) => entry.type === "testfake_frame",
    );
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.raw)).toEqual(
      fake.conversationFrameMarkers.map((marker) => ({
        type: "testfake_frame",
        marker,
      })),
    );

    // The non-Claude result envelope carries the fake id from the runtime.
    const resultEnvelope = harness.transcript.find(
      (entry) => entry.type === "result",
    );
    expect(resultEnvelope).toBeDefined();
    expect(
      (resultEnvelope!.raw as { backend: string; backendRef: unknown }).backend,
    ).toBe("testfake");

    expect(fake.calls.map((c) => c.op)).toContain("factory.createRuntime");
    expect(fake.calls.map((c) => c.op)).toContain("runtime.sendTurn");
    expect(fake.calls.map((c) => c.op)).toContain(
      "transcript.projectBackendInit",
    );
    expect(fake.calls.map((c) => c.op)).toContain(
      "transcript.projectTurnResult",
    );

    // The turn ran PRODUCTION capability composition (not a stubbed
    // undefined): the fake's declared `agents` kind has no persisted cascade
    // encoding, so composition consulted no discovery provider — an identity
    // fallback would have surfaced another backend's cascade kinds here —
    // and the factory received no capability seed.
    expect(harness.capabilityDiscoveryLookups).toEqual([]);
    const createCall = fake.calls.find((c) => c.op === "factory.createRuntime");
    expect(
      (createCall!.input as { capabilities: unknown }).capabilities,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E4 — transcript consumers
// ---------------------------------------------------------------------------

describe("E4: transcript consumers pass testfake envelopes through untouched", () => {
  it("execution-logger writes validator transcript items with raw deep-equal", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "cc-locality-e4-"));
    const logger = createExecutionLogger("exec-e4", { configDir });

    logger.writeValidatorTranscript(
      { contextId: "ctx-1", assignmentId: "general" },
      { lane: "context_validator", engine: TESTFAKE_BACKEND_ID },
      [...fake.taskTranscriptEntries],
    );

    const written = await readFile(
      path.join(
        logger.logDir,
        "contexts",
        "ctx-1",
        "validators",
        "general",
        "validation-transcript.jsonl",
      ),
      "utf8",
    );
    const events = written
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const begin = events[0]!;
    expect(begin["event"]).toBe("validator.transcript_begin");
    expect(begin["engine"]).toBe("testfake");

    const items = events.filter(
      (e) => e["event"] === "validator.transcript_item",
    );
    expect(items.map((e) => e["backend"])).toEqual(["testfake", "testfake"]);
    expect(items.map((e) => e["raw"])).toEqual(
      fake.taskTranscriptEntries.map((e) => e.raw),
    );
  });

  describe("executeWorkflowTaskRun read path", () => {
    beforeEach(() => {
      setConversationQueueDeps({
        ...getConversationQueueDeps(),
        claimNextTurnBatch: async () => null,
        recoverAbandonedDeliveries: async () => 0,
      });
      managerFixture.dispose();
      resetConversationRuntimeState();
    });

    afterEach(() => {
      _resetConversationQueueDepsForTesting();

      managerFixture.dispose();
      resetConversationRuntimeState();
    });

    it("returns the fake runner's transcript and ref through the real machine + actor turn", async () => {
      const harness = createInMemoryActorDeps("conv-e4");
      conversationActors = createTestActorImplementations(harness.deps);

      const result = await managerFixture.executeWorkflowTaskRun({
        binding: {
          kind: "ephemeral",
          backend: TESTFAKE_BACKEND_ID,
          role: null,
          worktreePath: WORKTREE_PATH,
          address: {
            projectPath: PROJECT_PATH,
            target: targetFromStoreSessionName(
              PROJECT_NAME,
              SESSION_NAME,
              "conv-e4",
            ),
          },
        },
        executionClass: "nongoverned-task" as const,
        kind: "task_run",
        prompt: "validate something",
        modelSelection: TESTFAKE_MODEL_SELECTION,
        timeoutMs: 10_000,
      });

      if (result.kind !== "text") {
        throw new Error(
          `expected text result, got ${result.kind}: ${JSON.stringify(result)}`,
        );
      }
      expect(result.text).toBe(TESTFAKE_TASK_TEXT);
      expect(result.backendRef).toEqual({
        backend: TESTFAKE_BACKEND_ID,
        ref: TESTFAKE_TASK_REF,
      });
      // Raw payloads come back deep-equal (markers intact): the machine +
      // task-run mapping recorded envelopes without interpreting entry.raw.
      expect(result.transcript?.map((e) => e.raw)).toEqual(
        fake.taskTranscriptEntries.map((e) => e.raw),
      );
      expect(fake.calls.map((c) => c.op)).toContain("runner.run");
      expect(fake.calls.map((c) => c.op)).toContain(
        "transcript.projectTaskAssistantMetadata",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// E5 — MCP apply (enforced: both operations derive from the descriptor)
// ---------------------------------------------------------------------------

describe("E5: applyAfterOverrideChange stages per the descriptor's betweenTurnApply", () => {
  it("invokes the fake runtime's staging apply even while a turn is active (descriptor: next-turn, never identity)", async () => {
    // A backend whose descriptor declares `mcp.betweenTurnApply: "next-turn"`
    // stages regardless of turn activity — the per-turn reconstruction picks
    // the new portable up at the next turn start. An identity-driven decision
    // would treat the unknown id as live-when-idle and skip the runtime call
    // while a turn is active.
    const activeTurnFake = createTestFakeBackend({ runtimeIsTurnActive: true });
    _resetBackendRegistryForTesting();
    _registerBackendForTesting(activeTurnFake.descriptor);

    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      await fixture.seedConversation(
        PROJECT_PATH,
        SESSION_NAME,
        conversationStateSchema.parse(
          makeConversationRecord("conv-e5-override", {
            agentBackend: "claude",
          }),
        ),
      );

      const runtime =
        await activeTurnFake.descriptor.conversation!.factory.createRuntime(
          makeCreateInput("conv-e5-override"),
        );
      expect(runtime.isTurnActive).toBe(true);

      const service = createMcpRuntimeApplyService({
        applicationState: createMcpRuntimeApplicationStore(fixture.store),
        getRuntime: () => runtime,
        resolvePortableForConversation: async () => ({
          portable: {
            servers: [
              { id: "gateway", transport: "streamable-http", url: "http://x" },
            ],
          },
        }),
      });

      const result = await service.applyAfterOverrideChange({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: "conv-e5-override",
        backend: TESTFAKE_BACKEND_ID,
        changedServerKeys: ["gateway"],
      });

      // The staging call reached the runtime — observable only through the
      // descriptor-declared next-turn mode.
      expect(activeTurnFake.calls.map((c) => c.op)).toContain(
        "runtime.applyPortableMcpConfig",
      );
      expect(result.disposition).toBe("deferred_to_next_turn");

      // Durable state records the pending change without ever advancing the
      // applied hash — that stays owned by the turn-start writer.
      const persisted = await fixture.deps.getConversation(
        PROJECT_PATH,
        SESSION_NAME,
        "conv-e5-override",
      );
      expect(persisted?.mcpRuntime?.pendingConfigHash).toBe(
        result.effectiveConfigHash,
      );
      expect(persisted?.mcpRuntime?.pendingServerKeys).toEqual(["gateway"]);
      expect(persisted?.mcpRuntime?.lastAppliedConfigHash).toBeUndefined();
      expect(persisted?.mcpRuntime?.lastApplyDisposition).toBe(
        "deferred_to_next_turn",
      );
    } finally {
      fixture.close();
    }
  });
});

describe("E5: applyAtTurnStart derives its disposition from the fake runtime", () => {
  it("applies via the fake's applyPortableMcpConfig with no id-branch outcome possible", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      // The stored row's own backend column is never read by the apply
      // service (identity travels on the call input), so the row stays
      // schema-valid while the drive itself runs with the fake id.
      await fixture.seedConversation(
        PROJECT_PATH,
        SESSION_NAME,
        conversationStateSchema.parse(
          makeConversationRecord("conv-e5", { agentBackend: "claude" }),
        ),
      );

      const runtime = await fake.descriptor.conversation!.factory.createRuntime(
        makeCreateInput("conv-e5"),
      );
      let resolvedBackend: string | undefined;
      const service = createMcpRuntimeApplyService({
        applicationState: createMcpRuntimeApplicationStore(fixture.store),
        getRuntime: () => runtime,
        resolvePortableForConversation: async (input) => {
          resolvedBackend = input.backend;
          return {
            portable: {
              servers: [
                {
                  id: "gateway",
                  transport: "streamable-http",
                  url: "http://x",
                },
              ],
            },
          };
        },
      });

      const result = await service.applyAtTurnStart({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: "conv-e5",
        backend: TESTFAKE_BACKEND_ID,
      });

      expect(resolvedBackend).toBe("testfake");
      expect(result.backend).toBe(TESTFAKE_BACKEND_ID);
      // Disposition observed is what the fake runtime reported, truthful to
      // its declared mcp.betweenTurnApply staging mode — not a Claude
      // idle-live "applied_now" from an identity fallback.
      expect(result.disposition).toBe("deferred_to_next_turn");
      expect(fake.calls.map((c) => c.op)).toContain(
        "runtime.applyPortableMcpConfig",
      );

      const persisted = await fixture.deps.getConversation(
        PROJECT_PATH,
        SESSION_NAME,
        "conv-e5",
      );
      expect(persisted?.mcpRuntime?.lastAppliedConfigHash).toBe(
        result.effectiveConfigHash,
      );
    } finally {
      fixture.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E6 — conversations/service fork (enforced from 1.6)
// ---------------------------------------------------------------------------

describe("E6: conversation fork routes through the owning continuity adapter", () => {
  it("refuses the fake's unsupported fork declaration before adapter dispatch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cc-locality-e6-"));
    const sourceTranscriptPath = path.join(dir, "source.jsonl");
    await writeFile(
      sourceTranscriptPath,
      [
        JSON.stringify({
          timestamp: NOW,
          type: "user",
          role: "user",
          content: [{ type: "text", text: "hi" }],
        }),
        JSON.stringify({
          timestamp: NOW,
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const source = makeConversationRecord("conv-source", {
      transcriptPath: sourceTranscriptPath,
      backendRef: { backend: TESTFAKE_BACKEND_ID, ref: "src-ref-1" },
      name: "Source",
    });
    const session: SessionState = {
      sessionName: SESSION_NAME,
      worktreePath: WORKTREE_PATH,
      branchName: "csm/locality-session",
      createdAt: NOW,
      lastActivityAt: NOW,
      archived: false,
      finished: false,
      conversations: [source],
      source: "cc",
      creationMode: "normal",
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      referenceDocuments: [],
    };

    const requestedAdapters: string[] = [];
    const service = createConversationService({
      mutateSession: async (_pp, _sn, _label, mutate) => mutate(session),
      createSessionConversation: async (_pp, _sn, build) => {
        const conversation = build(session.conversations.length + 1);
        session.conversations.push(conversation);
        return conversation;
      },
      getSession: async () => session,
      getConversation: async (_pp, _sn, conversationId) =>
        session.conversations.find((c) => c.id === conversationId) ?? null,
      getSessionConversations: async () => session.conversations,
      setConversationPendingPromptText: async () => {},
      configDir: dir,
      getContinuityAdapter: (backend) => {
        requestedAdapters.push(backend);
        return fake.descriptor.conversation!.continuity;
      },
    });

    await expect(
      service.forkConversation({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        sourceConversationId: "conv-source",
        messageIndex: 1,
      }),
    ).rejects.toMatchObject({ code: "backend-fork-unsupported" });
    expect(requestedAdapters).toEqual([]);
    expect(fake.calls.filter((call) => call.op === "continuity.fork")).toEqual(
      [],
    );
    expect(
      session.conversations.map((conversation) => conversation.id),
    ).toEqual(["conv-source"]);
  });
});

// ---------------------------------------------------------------------------
// E7 — capability composition + runtime-config apply
// ---------------------------------------------------------------------------

describe("E7: conversation-start capability composition derives from the descriptor", () => {
  it("derives the claude/codex cascade taxonomy from their registered descriptors, plugin cascade first", () => {
    _resetBackendRegistryForTesting();
    bootstrapBackends();
    expect(ownedCascadesForBackend("claude").map((c) => c.cascadeKind)).toEqual(
      ["claude-plugins", "claude-skills", "claude-agents"],
    );
    expect(ownedCascadesForBackend("codex").map((c) => c.cascadeKind)).toEqual([
      "codex-plugins",
      "codex-skills",
    ]);
  });

  it("composes a third-backend conversation without borrowing another backend's cascades", async () => {
    const providerLookups: AgentCapabilityCascadeKind[] = [];
    const composer = createInMemoryCapabilityComposer(providerLookups);

    const input = {
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
      conversationId: "conv-e7-compose",
      worktreePath: WORKTREE_PATH,
      backend: TESTFAKE_BACKEND_ID,
    };
    const result = await composer(input);

    // The fake's declared `agents` kind has no persisted cascade encoding,
    // so composition consults no discovery provider. An identity fallback
    // would route the unknown id into another backend's cascade set and
    // stamp that backend on the composed cascade.
    expect(providerLookups).toEqual([]);
    expect(result.backend).toBe(TESTFAKE_BACKEND_ID);
    expect(result.capabilities).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      kinds: [],
    });
    expect(result.failedCascadeKinds).toEqual([]);
    expect(result.diagnostics).toEqual([]);

    // The production seed projection keeps "no cascades" honest: no seed.
    const seed = await createCapabilityConfigComposer(composer)(input);
    expect(seed).toBeUndefined();
  });
});

describe("E7: runtime-config apply routes through the descriptor adapter", () => {
  afterEach(() => {
    resetBackendRuntimeRegistry();
  });

  it("applies a declared-kind cascade via the fake adapter and rejects an undeclared kind", async () => {
    const runtime = await fake.descriptor.conversation!.factory.createRuntime(
      makeCreateInput("conv-e7-apply"),
    );
    registerRuntime("conv-e7-apply", runtime);

    const conversation = {
      conversationScope: "session" as const,
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
      conversationId: "conv-e7-apply",
      worktreePath: WORKTREE_PATH,
      backend: TESTFAKE_BACKEND_ID,
    };

    const applied = await applyRuntimeConfigToConversationRuntime({
      conversation,
      resolved: {
        backend: TESTFAKE_BACKEND_ID,
        kinds: [
          {
            kind: "agents",
            items: [
              { itemId: "reviewer", enabled: false, originLayer: "global" },
            ],
          },
        ],
      },
    });
    expect(applied).toEqual({ status: "applied" });
    // The descriptor's own adapter did the work — observable through the
    // fake's call log, which no identity-branched fallback would reach.
    const applyCall = fake.calls.find((c) => c.op === "runtimeConfig.apply");
    expect(applyCall?.input).toEqual({
      backend: TESTFAKE_BACKEND_ID,
      kinds: ["agents"],
    });

    // Declared-kind coherence is enforced below the seam: the fake declares
    // only `agents`, so a `skills` cascade is rejected, not silently dropped.
    const rejected = await applyRuntimeConfigToConversationRuntime({
      conversation,
      resolved: {
        backend: TESTFAKE_BACKEND_ID,
        kinds: [{ kind: "skills", items: [] }],
      },
    });
    expect(rejected).toEqual({
      status: "rejected",
      error: `capability kind 'skills' is not declared by backend '${TESTFAKE_BACKEND_ID}'`,
    });
  });

  it("rejects when the live runtime belongs to a different backend than the conversation", async () => {
    const runtime = await fake.descriptor.conversation!.factory.createRuntime(
      makeCreateInput("conv-e7-mismatch"),
    );
    registerRuntime("conv-e7-mismatch", runtime);

    const result = await applyRuntimeConfigToConversationRuntime({
      conversation: {
        conversationScope: "session",
        projectPath: PROJECT_PATH,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        conversationId: "conv-e7-mismatch",
        backend: "claude",
        worktreePath: WORKTREE_PATH,
      },
      resolved: { backend: "claude", kinds: [] },
    });
    expect(result).toEqual({
      status: "rejected",
      error:
        "runtime backend 'testfake' does not match conversation backend 'claude'",
    });
  });
});

// ---------------------------------------------------------------------------
// E3 — lane modules
// ---------------------------------------------------------------------------

describe("E3: lane modules", () => {
  it("starts and then resumes a registered backend through descriptor-owned continuity", async () => {
    const laneService = createLaneService({ store: createInMemoryLaneStore() });
    const laneRef = { workflowId: "wf-e3", laneId: "implementer" };
    await laneService.initialize({
      workflowId: "wf-e3",
      laneId: "implementer",
      backend: TESTFAKE_BACKEND_ID,
      writeCapability: "write_capable",
      policy: { continuityEnabled: true },
      ref: null,
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: NOW,
    });
    const caller = createWorkflowAgentCaller({
      laneService,
      laneScheduler: createLaneScheduler(),
      continuityContext: {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
      },
      async callAgent(_request, continuity) {
        return {
          backend: TESTFAKE_BACKEND_ID,
          backendRef: continuity.resumeRef,
          capabilities: capabilityViewForBackend(TESTFAKE_BACKEND_ID),
          usage: { contextTokens: 41 },
          artifacts: [],
          outcome: { kind: "completed", text: TESTFAKE_TURN_TEXT },
          continuationDisposition: "retain",
        };
      },
    });
    const request = {
      laneRef,
      sessionKey: SESSION_NAME,
      agentCallRequest: {
        executionClass: "ordinary-conversation" as const,
        kind: "conversation_turn" as const,
        backend: TESTFAKE_BACKEND_ID,
        prompt: "exercise descriptor continuity",
        modelSelection: TESTFAKE_MODEL_SELECTION,
        laneRef,
        writeCapability: "write_capable" as const,
      },
    };

    await caller.call(request);
    await caller.call(request);

    const recorded = await laneService.resolve(laneRef);
    const continuityCalls = fake.calls
      .map((call) => call.op)
      .filter((op) => op.startsWith("continuity."));

    expect(continuityCalls).toEqual([
      "continuity.start",
      "continuity.resumeOrRecover",
    ]);
    expect(recorded).toMatchObject({
      backend: TESTFAKE_BACKEND_ID,
      ref: TESTFAKE_CONVERSATION_REF,
      metrics: { contextTokens: 41, rotateBeforeNextTurn: false },
    });
  });
});

// ---------------------------------------------------------------------------
// E6 — graph runners
// ---------------------------------------------------------------------------

describe("E6: graph runners", () => {
  it("preserves the registered backend id in turn-failure classification", async () => {
    const runner = createGraphWorkflowImplementerRunner({
      executeConversationTurn: async () =>
        settledConversationTurn({
          backend: TESTFAKE_BACKEND_ID,
          outcome: {
            kind: "failed",
            error: {
              backend: TESTFAKE_BACKEND_ID,
              failureKind: "backend_error",
              message: "backend exploded",
            },
          },
        }),
      getConversation: async () => null,
    });

    const session: SessionState = {
      sessionName: SESSION_NAME,
      worktreePath: WORKTREE_PATH,
      branchName: "csm/locality-session",
      createdAt: NOW,
      lastActivityAt: NOW,
      archived: false,
      finished: false,
      conversations: [],
      source: "cc",
      creationMode: "normal",
      tddEnabled: true,
      targetBranch: "main",
      parentSessionName: null,
      graphWorkflowExecution: null,
      referenceDocuments: [],
    };

    const thrown = await runner
      .runIteration({
        projectPath: PROJECT_PATH,
        session,
        prompt: "implement",
        conversationId: "conv-e6",
        executionId: "exec-e6",
        contextId: "ctx-e6",
        backend: TESTFAKE_BACKEND_ID,
        modelSelection: TESTFAKE_MODEL_SELECTION,
        placement: { lane: "build", mode: "full" },
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(thrown).toBeInstanceOf(AgentTurnFailedError);
    expect((thrown as AgentTurnFailedError).engine).toBe(TESTFAKE_BACKEND_ID);
  });
});
