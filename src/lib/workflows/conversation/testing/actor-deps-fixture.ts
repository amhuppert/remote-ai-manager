/**
 * Actor dependency fixture for tests that drive the REAL conversation actor
 * implementations (`runTaskRunTurnForMachine`, `executePromptForMachine`).
 *
 * Those functions reach their collaborators through a module-level singleton
 * (`setActorDeps`), so a test can only exercise the production turn projection
 * — outcome → `PromptActorResult` — by supplying a full dependency set. Every
 * seam here is inert (no filesystem, no store, no network); `executeAgentCall`
 * defaults to the REAL facade so the structured-output gate, its candidate
 * extraction fall-through, and its bounded repair all run for real, with only
 * the backend runner faked via `getTaskRunner`.
 *
 * Test-only: never imported by production code.
 */

import { vi } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { ActorImplementationDeps } from "@/lib/workflows/conversation/actor-implementations";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";

export function createMockBackendRuntime(
  overrides: Partial<ConversationBackendRuntime> = {},
): ConversationBackendRuntime {
  return {
    backend: overrides.backend ?? "claude",
    status: "alive",
    // Callers that want a specific backend's model pass it explicitly; deriving
    // one from the backend id here would just be another identity branch.
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },
    outputFormat: undefined,
    capabilities: {
      queueWhileRunning: false,
      askUserQuestion: true,
      preciseFork: false,
      portableMcpAtStart: false,
      portableMcpBetweenTurns: false,
      contextWindowMetrics: true,
    },
    sendTurn: vi.fn(),
    close: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ConversationBackendRuntime;
}

/**
 * A full, inert `ActorImplementationDeps`. The single cast is the reason this
 * lives in one module rather than being re-declared per test file: the type is
 * a wide composition of runtime seams, and duplicating the escape hatch in
 * every consumer is how the sets drift apart.
 */
export function createActorImplementationDepsFixture(
  overrides: Partial<ActorImplementationDeps> = {},
): ActorImplementationDeps {
  const backendRuntime = createMockBackendRuntime();
  const factory = {
    backend: "claude" as const,
    createRuntime: vi.fn(async () => backendRuntime),
    validateModelSelection: vi.fn(),
  };

  return {
    acquireConversationLock: vi.fn(() => vi.fn()),
    acquireQuerySlot: vi.fn(async () => vi.fn()),
    getTranscriptPath: vi.fn(async (id: string) => `/transcripts/${id}.jsonl`),
    readConfig: vi.fn(async () => ({
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
          timeoutMs: 300_000,
        },
        codex: {
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "false", reasoning: "high" },
          },
          timeoutMs: null,
        },
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
          timeoutMs: null,
        },
      },
      maxTurns: 50,
      idleQuerySessionTtlMs: 300_000,
    })),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    getDebugLogUrl: vi.fn(
      (id: string) =>
        `http://localhost:3000/api/debug-logs?conversationId=${id}`,
    ),
    safeAppendTranscriptEntry: vi.fn(async () => {}),
    safeAppendTranscriptEntryOnce: vi.fn(async () => {}),
    saveTranscriptImage: vi.fn(
      async (
        _id: string,
        index: number,
        mediaType: string,
      ): Promise<string> => {
        const ext = mediaType.split("/")[1] ?? "bin";
        return `/persisted/${index}.${ext}`;
      },
    ),
    getNextImageIndex: vi.fn(async () => 1),
    getConversationBackendFactory: vi.fn(() => factory),
    admitConfiguredModelSelection: vi.fn(async ({ modelSelection }) => ({
      ok: true as const,
      modelSelection,
    })),
    getConversationCapabilities: vi.fn(() => ({
      queue: {
        acceptsWhileRunning: true,
        deliveryTiming: "in_turn" as const,
      },
      continuationStrength: "precise_session" as const,
      fork: "native" as const,
      structuredOutput: "backend_native" as const,
      contextWindowMetrics: true,
      nativeMidTurnAskUser: true,
      externalTurns: true,
      capabilityKinds: [
        { kind: "skills" as const, applyTiming: "idle_live" as const },
        { kind: "plugins" as const, applyTiming: "idle_live" as const },
        {
          kind: "agents" as const,
          applyTiming: "next_conversation" as const,
        },
      ],
    })),
    registerBackendRuntime: vi.fn(),
    unregisterBackendRuntime: vi.fn(),
    // Defaults to the unprovisioned-server outcome, so a test that cares about
    // launch authority has to opt in and say which identity it expects.
    mintConversationCapability: vi.fn(() => null),
    buildChildEnv: vi.fn(() => ({ HOME: "/home/test" })),
    resolvePluginPaths: vi.fn(async () => []),
    getCodexToolPromptHint: vi.fn(() => ""),
    mutateConversation: vi.fn(async () => {}),
    getConversation: vi.fn(async () => null),
    getSessionState: vi.fn(async () => null),
    getActiveAlignmentInjection: vi.fn(async () => null),
    getActiveAlignmentVersion: vi.fn(async () => null),
    getLiveTicketBlock: vi.fn(async () => null),
    readNotepadForInjection: vi.fn(async () => null),
    claimWorkflowResults: vi.fn(async () => []),
    settleWorkflowResults: vi.fn(async () => 0),
    releaseWorkflowResults: vi.fn(async () => 0),
    createReferenceDocument: vi.fn(async () => ({})),
    getReferenceDocuments: vi.fn(async () => []),
    readConversationMessages: vi.fn(async () => []),
    fileExists: vi.fn(() => false),
    registerAbortController: vi.fn(),
    unregisterAbortController: vi.fn(),
    applyMcpAtTurnStart: vi.fn(
      async (_input: {
        projectPath: string;
        sessionName: string;
        conversationId: string;
        backend: "claude" | "codex";
      }) => ({
        conversationId: "conv-1",
        backend: "claude" as const,
        disposition: "applied_now" as const,
        effectiveConfigHash: "hash-1",
      }),
    ),
    applyCapabilityAtTurnStart: vi.fn(async () => ({})),
    applyCapabilityWhenIdle: vi.fn(async () => ({})),
    composeCapabilityConfigForConversation: vi.fn(async () => undefined),
    composeCapabilityConfigForProjectConversation: vi.fn(async () => undefined),
    composePortableMcpForConversation: vi.fn(
      async (args: {
        projectName: string;
        sessionName: string;
        transientPortableMcp?: { servers: Array<Record<string, unknown>> };
      }) => ({
        servers: [
          {
            id: "gateway-alpha",
            transport: "streamable-http" as const,
            url: `http://localhost:3000/api/projects/${args.projectName}/sessions/${args.sessionName}/mcp`,
          },
          ...(args.transientPortableMcp?.servers ?? []),
        ],
      }),
    ),
    executeAgentCall: defaultExecuteAgentCall,
    markQueuedDelivered: vi.fn(async () => {}),
    markQueuedPending: vi.fn(async () => {}),
    markQueuedFailed: vi.fn(async () => {}),
    log: createCapturingLogger(),
    ...overrides,
  } as ActorImplementationDeps;
}
