/**
 * Runs the shared conformance contract against the production Claude, Codex,
 * and Cursor descriptors and the parameterized testfake. Descriptors are
 * assembled through the same factories the registry bootstrap uses; every
 * provider touchpoint (Claude `query()`, Codex SDK client, native plugin
 * records, continuity services, the Cursor worker transport) is a fake port
 * injected through the adapters' DI seams, so the REAL factories/runners
 * execute their full pipelines with no subprocess and no state store.
 *
 * The lying-descriptor section proves the behavior checks BITE: a descriptor
 * whose declarations contradict its observed behavior fails the exported
 * check functions rather than registering green.
 */

import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkApplyTimingBehavior,
  checkCancellation,
  checkContextMetricsCoherence,
  checkConversationStructuredOutputPostValidation,
  checkConversationStructuredOutputForwarding,
  checkExternalTurnCoherence,
  checkQueueCoherence,
  describeBackendConformance,
  type ContinuityConformanceHarness,
  type ConversationTurnConformanceHarness,
} from "./conformance";
import type { ConversationBackendCreateInput } from "./conversation";
import type { AgentTaskRequest } from "./task";
import type { BackendModelSelection } from "./schemas";
import { createClaudeBackendDescriptor } from "./claude/descriptor";
import { claudeConversationBackendFactory } from "./claude/conversation-runtime";
import { createClaudeContinuityAdapter } from "./claude/continuity";
import { createClaudeRuntimeConfigAdapter } from "./claude/runtime-config/adapter";
import { ClaudeTaskRunner } from "./claude/task-runner";
import { createClaudeFailureClassifier } from "./claude/failure-classifier";
import { _setSdkQueryForTesting } from "./claude/query-session";
import { createCodexBackendDescriptor } from "./codex/descriptor";
import { CodexConversationRuntime } from "./codex/conversation-runtime";
import { createCodexContinuityAdapter } from "./codex/continuity";
import { createCodexRuntimeConfigAdapter } from "./codex/runtime-config";
import { CodexTaskRunner } from "./codex/task-runner";
import { createCodexFailureClassifier } from "./codex/failure-classifier";
import { createCursorBackendDescriptor } from "./cursor/descriptor";
import { CursorConversationRuntime } from "./cursor/conversation-runtime";
import { createCursorTaskRunner } from "./cursor/task-runner";
import { translatePortableMcpToCursor } from "./cursor/mcp-translation";
import { createCursorContinuityAdapter } from "./cursor/continuity";
import { createCursorRuntimeConfigAdapter } from "./cursor/runtime-config";
import { createCursorFailureClassifier } from "./cursor/failure-classifier";
import {
  createCursorModelCatalogFacet,
  loadGeneratedCursorModelCatalog,
} from "./cursor/model-catalog";
import { createScriptedTransport } from "./cursor/testing/scripted-worker";
import {
  claudeMcpCapabilities,
  codexMcpCapabilities,
  cursorMcpCapabilities,
} from "@/lib/mcp/backend-capabilities";
import {
  createTestFakeBackend,
  TESTFAKE_HANGING_PROMPT,
} from "./testing/testfake-backend";
import {
  createFakeClaudeSdkController,
  createFakeClaudeTaskPort,
  FAKE_CLAUDE_HANGING_PROMPT,
  FAKE_CLAUDE_QUEUE_HOLD_PROMPT,
} from "./testing/fake-claude-sdk-port";
import {
  createFakeCodexProvider,
  createFakeCodexTaskPort,
  FAKE_CODEX_HANGING_PROMPT,
  FAKE_CODEX_QUEUE_HOLD_PROMPT,
} from "./testing/fake-codex-provider";

const continuityHarness: ContinuityConformanceHarness = {
  startInput: { projectPath: "/conformance", sessionName: "conformance" },
  context: { projectPath: "/conformance", sessionName: "conformance" },
  forkInput: {
    projectPath: "/conformance",
    anchorMessageId: "uuid-anchor-1",
    sourceTranscriptPath: "/conformance/source.jsonl",
    messageIndex: 1,
  },
};

const STRUCTURED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};
const STRUCTURED_OUTPUT_VALUE = { ok: true };

function buildCreateInput(
  conversationId: string,
  modelSelection: BackendModelSelection,
): ConversationBackendCreateInput {
  return {
    executionClass: "ordinary-conversation" as const,
    conversationId,
    projectPath: "/conformance",
    projectName: "conformance",
    conversationTarget: sessionConversationTarget(
      "conformance",
      "conformance",
      conversationId,
    ),
    worktreePath: "/conformance",
    persistedRef: null,
    modelSelection,
    sessionInstructions: [],
    tooling: {},
  };
}

function buildTaskRequest(
  withSchema: boolean,
  modelSelection: BackendModelSelection,
): AgentTaskRequest {
  return {
    executionClass: "nongoverned-task" as const,
    workingDirectory: "/conformance",
    prompt: "conformance task run",
    modelSelection,
    timeoutMs: 0,
    autonomous: true,
    ...(withSchema ? { outputSchema: STRUCTURED_OUTPUT_SCHEMA } : {}),
  };
}

const CLAUDE_MODEL_SELECTION = {
  modelId: "opus",
  parameters: { effort: "medium" },
} as const;
const CODEX_MODEL_SELECTION = {
  modelId: "gpt-5.4",
  parameters: { reasoning: "medium", fast: "false" },
} as const;
const CURSOR_MODEL_SELECTION = {
  modelId: "composer-2.5",
  parameters: { fast: "true" },
} as const;
const TESTFAKE_MODEL_SELECTION = {
  modelId: "fake-1",
  parameters: {},
} as const;

// ============================================================
// Claude — real factory/runner over fake provider ports
// ============================================================

const claudeSdk = createFakeClaudeSdkController({
  structuredOutput: STRUCTURED_OUTPUT_VALUE,
});
_setSdkQueryForTesting(claudeSdk.createSdkQuery);
afterAll(() => {
  _setSdkQueryForTesting(null);
});

const claudeTaskPort = createFakeClaudeTaskPort({
  structuredOutput: STRUCTURED_OUTPUT_VALUE,
});

const claudeDescriptor = createClaudeBackendDescriptor({
  conversationFactory: claudeConversationBackendFactory,
  continuity: createClaudeContinuityAdapter({
    forkSession: async () => ({ sessionId: "conformance-forked-session" }),
    buildSyntheticForkSeed: async () => "conformance seed",
  }),
  runtimeConfig: createClaudeRuntimeConfigAdapter({
    readNativePluginRecords: async () => [],
  }),
  taskRunner: new ClaudeTaskRunner(claudeTaskPort.deps),
  mcp: claudeMcpCapabilities,
  failureClassifier: createClaudeFailureClassifier(),
});

describe("Claude structured output capability declaration", () => {
  it("declares post-validation enforcement on both execution facets", () => {
    expect(claudeDescriptor.conversation?.capabilities.structuredOutput).toBe(
      "post_validation",
    );
    expect(claudeDescriptor.tasks?.structuredOutput).toBe("post_validation");
  });
});

describeBackendConformance(claudeDescriptor, {
  continuity: continuityHarness,
  conversationTurn: {
    buildCreateInput: () =>
      buildCreateInput("conformance-claude-conv", CLAUDE_MODEL_SELECTION),
    hangingPromptText: FAKE_CLAUDE_HANGING_PROMPT,
    queueHoldPromptText: FAKE_CLAUDE_QUEUE_HOLD_PROMPT,
    triggerExternalTurn: () => claudeSdk.pushExternalTurn(),
    structuredOutput: {
      schema: STRUCTURED_OUTPUT_SCHEMA,
      expected: STRUCTURED_OUTPUT_VALUE,
      readForwardedSchema: () => claudeSdk.lastOptions?.outputFormat,
      readDispatchedPrompt: () => claudeSdk.lastPromptText,
    },
  },
  task: {
    buildRequest: () => buildTaskRequest(true, CLAUDE_MODEL_SELECTION),
    structuredOutput: {
      schema: STRUCTURED_OUTPUT_SCHEMA,
      expected: STRUCTURED_OUTPUT_VALUE,
      readForwardedSchema: () => claudeTaskPort.lastOptions?.outputFormat,
      readDispatchedPrompt: () => claudeTaskPort.lastPrompt,
    },
  },
});

// ============================================================
// Codex — real runner class over fake provider deps
// ============================================================

const codexQueueReady = Promise.withResolvers<void>();
const codexProvider = createFakeCodexProvider({
  onQueueReady: codexQueueReady.resolve,
  structuredOutput: STRUCTURED_OUTPUT_VALUE,
});
const codexTaskPort = createFakeCodexTaskPort({
  structuredOutput: STRUCTURED_OUTPUT_VALUE,
});

const codexDescriptor = createCodexBackendDescriptor({
  conversationFactory: {
    backend: "codex",
    // The production factory is a thin `new CodexConversationRuntime(input)`
    // wrapper over default deps; the conformance drive constructs the same
    // real runtime class with the fake provider deps injected.
    createRuntime: async (input) =>
      new CodexConversationRuntime(input, codexProvider.deps),
  },
  continuity: createCodexContinuityAdapter({
    buildSyntheticForkSeed: async () => "conformance seed",
  }),
  runtimeConfig: createCodexRuntimeConfigAdapter(),
  skillCatalog: { getCommands: async () => [] },
  taskRunner: new CodexTaskRunner(codexTaskPort.deps),
  prepareManagedSkillsCheckout: async () => undefined,
  mcp: codexMcpCapabilities,
  failureClassifier: createCodexFailureClassifier(),
});

it("Codex declares post-validation structured output on both facets", () => {
  expect(codexDescriptor.tasks?.structuredOutput).toBe("post_validation");
  expect(codexDescriptor.conversation?.capabilities.structuredOutput).toBe(
    "post_validation",
  );
});

describeBackendConformance(codexDescriptor, {
  continuity: continuityHarness,
  conversationTurn: {
    buildCreateInput: () =>
      buildCreateInput("conformance-codex-conv", CODEX_MODEL_SELECTION),
    hangingPromptText: FAKE_CODEX_HANGING_PROMPT,
    queueHoldPromptText: FAKE_CODEX_QUEUE_HOLD_PROMPT,
    waitUntilQueueReady: () => codexQueueReady.promise,
    structuredOutput: {
      schema: STRUCTURED_OUTPUT_SCHEMA,
      expected: STRUCTURED_OUTPUT_VALUE,
      readForwardedSchema: () => codexProvider.lastOutputSchema,
      readDispatchedPrompt: () => codexProvider.lastPrompt,
    },
  },
  task: {
    buildRequest: () => buildTaskRequest(true, CODEX_MODEL_SELECTION),
    structuredOutput: {
      schema: STRUCTURED_OUTPUT_SCHEMA,
      expected: STRUCTURED_OUTPUT_VALUE,
      readForwardedSchema: () => codexTaskPort.lastOutputSchema,
      readDispatchedPrompt: () => codexTaskPort.lastPrompt,
    },
  },
});

// ============================================================
// Cursor — real runtime/continuity over a scripted worker transport
// ============================================================

const CURSOR_HANGING_PROMPT = "conformance: cursor hang";
const CURSOR_QUEUE_HOLD_PROMPT = "conformance: cursor queue hold";

let cursorRunCounter = 0;
const cursorQueueReady = Promise.withResolvers<void>();

// The scripted transport plays the worker's side of the IPC contract only, so
// the runtime, continuity adapter, projections, classifier, and runtime-config
// adapter under test are the production ones (spec D19).
const cursorTransport = createScriptedTransport({
  onSteer: (input, worker) => {
    worker.send({
      type: "steerResult",
      runId: input.runId,
      requestId: input.requestId,
      outcome: "complete_delivered",
    });
    worker.settle(input.runId, "completed");
  },
  onTurn: (turn, worker) => {
    worker.sendInputAccepted(turn.runId);
    // The hanging prompt never settles on its own — cancellation has to.
    if (turn.input.promptText.includes(CURSOR_HANGING_PROMPT)) return;
    if (turn.input.promptText.includes(CURSOR_QUEUE_HOLD_PROMPT)) {
      cursorQueueReady.resolve();
      return;
    }
    if (turn.input.promptText.includes("conformance: cursor failure")) {
      worker.settle(turn.runId, "failed", {
        name: "AgentNotFoundError",
        code: "agent_not_found",
        status: 404,
        message: "agent missing",
      });
      return;
    }
    worker.sendNativeEvent(turn.runId, 0, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: JSON.stringify(STRUCTURED_OUTPUT_VALUE) },
        ],
      },
    });
    worker.sendUsage(turn.runId, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
    });
    worker.settle(turn.runId, "completed");
  },
});

const cursorDescriptor = createCursorBackendDescriptor({
  taskRunner: createCursorTaskRunner({
    transport: cursorTransport,
    storePath: (id) => `/state/cursor/${id}`,
    resolveModel: async (selection) => ({ ok: true, selection }),
    translatePortableMcpToCursor,
    newRunId: () => `conformance-cursor-run-${++cursorRunCounter}`,
    now: Date.now,
    stallTimeoutMs: 5_000,
    cancelSettleTimeoutMs: 10,
  }),
  modelCatalog: createCursorModelCatalogFacet({
    loadCatalog: loadGeneratedCursorModelCatalog,
    supportedModels: async () => null,
  }),
  conversationFactory: {
    backend: "cursor",
    createRuntime: async (input) =>
      new CursorConversationRuntime(input, {
        transport: cursorTransport,
        storePath: (conversationId) => `/state/cursor/${conversationId}`,
        resolveModel: async () => ({
          ok: true,
          selection: CURSOR_MODEL_SELECTION,
        }),
        translatePortableMcpToCursor: () => ({
          servers: {},
          rejectedServers: [],
          rejectedFields: [],
          errorsByServer: {},
        }),
        newRunId: () => `conformance-cursor-run-${(cursorRunCounter += 1)}`,
        now: () => 0,
        stallTimeoutMs: 5_000,
        cancelSettleTimeoutMs: 500,
      }),
  },
  continuity: createCursorContinuityAdapter({
    transport: cursorTransport,
    buildSyntheticForkSeed: async () => "User: conformance history",
    resolveBinding: async () => ({
      conversationId: "conformance-cursor-continuity",
      cwd: "/conformance",
      storePath: "/state/cursor/conformance",
      modelSelection: CURSOR_MODEL_SELECTION,
      mcpServers: {},
    }),
  }),
  runtimeConfig: createCursorRuntimeConfigAdapter(),
  mcp: cursorMcpCapabilities,
  failureClassifier: createCursorFailureClassifier(),
});

function lastCursorTurnPrompt(): string | undefined {
  const worker = cursorTransport.workers.at(-1);
  return worker?.turns.at(-1)?.input.promptText;
}

describeBackendConformance(cursorDescriptor, {
  continuity: continuityHarness,
  task: {
    buildRequest: () => buildTaskRequest(true, CURSOR_MODEL_SELECTION),
    hangingPromptText: CURSOR_HANGING_PROMPT,
    failurePromptText: "conformance: cursor failure",
    structuredOutput: {
      schema: STRUCTURED_OUTPUT_SCHEMA,
      expected: STRUCTURED_OUTPUT_VALUE,
      readForwardedSchema: () =>
        cursorTransport.workers.at(-1)?.turns.at(-1)?.input
          .structuredOutputInstruction ?? undefined,
      readDispatchedPrompt: () => lastCursorTurnPrompt() ?? "",
    },
  },
  conversationTurn: {
    buildCreateInput: () =>
      buildCreateInput("conformance-cursor-conv", CURSOR_MODEL_SELECTION),
    hangingPromptText: CURSOR_HANGING_PROMPT,
    queueHoldPromptText: CURSOR_QUEUE_HOLD_PROMPT,
    waitUntilQueueReady: () => cursorQueueReady.promise,
    structuredOutput: {
      schema: STRUCTURED_OUTPUT_SCHEMA,
      expected: STRUCTURED_OUTPUT_VALUE,
      // Post-validation: the SDK is handed no schema at all, and the rendered
      // contract rides in the prompt the worker receives.
      readForwardedSchema: () =>
        cursorTransport.workers.at(-1)?.turns.at(-1)?.input
          .structuredOutputInstruction ?? undefined,
      readDispatchedPrompt: () => lastCursorTurnPrompt() ?? "",
    },
  },
});

// ============================================================
// Testfake — scripted descriptor through the same contract
// ============================================================

const testfake = createTestFakeBackend();

const testfakeTurnHarness: ConversationTurnConformanceHarness = {
  buildCreateInput: () =>
    buildCreateInput("conformance-testfake-conv", TESTFAKE_MODEL_SELECTION),
  hangingPromptText: TESTFAKE_HANGING_PROMPT,
};

describeBackendConformance(testfake.descriptor, {
  continuity: continuityHarness,
  conversationTurn: testfakeTurnHarness,
  task: {
    buildRequest: () => buildTaskRequest(false, TESTFAKE_MODEL_SELECTION),
  },
});

// ============================================================
// Lying descriptors must FAIL the behavior checks
// ============================================================

describe("conformance behavior checks reject lying descriptors", () => {
  it("fails a descriptor that claims contextWindowMetrics its turns never report", async () => {
    const lying = createTestFakeBackend({
      capabilities: { contextWindowMetrics: true },
    });
    await expect(
      checkContextMetricsCoherence(
        lying.descriptor.conversation!,
        testfakeTurnHarness,
      ),
    ).rejects.toThrow();
  });

  it("fails a descriptor that claims in_turn queue delivery without a live queueUserInput surface", async () => {
    const lying = createTestFakeBackend({
      capabilities: {
        queue: { acceptsWhileRunning: true, deliveryTiming: "in_turn" },
      },
    });
    await expect(
      checkQueueCoherence(lying.descriptor.conversation!, {
        ...testfakeTurnHarness,
        queueHoldPromptText: "conformance: hold (never honored by the fake)",
      }),
    ).rejects.toThrow();
  });

  it("fails a descriptor that declares externalTurns but never emits one", async () => {
    const lying = createTestFakeBackend({
      capabilities: { externalTurns: true },
    });
    await expect(
      checkExternalTurnCoherence(lying.descriptor.conversation!, {
        ...testfakeTurnHarness,
        // The drive fires, but the runtime has no external emission path —
        // the check must time out waiting for external_turn_completed.
        triggerExternalTurn: () => {},
      }),
    ).rejects.toThrow(/external_turn_completed/);
  }, 10_000);

  it("fails a descriptor that declares backend_native structured output but surfaces none", async () => {
    const lying = createTestFakeBackend({
      capabilities: { structuredOutput: "backend_native" },
    });
    await expect(
      checkConversationStructuredOutputForwarding(
        lying.descriptor.conversation!,
        {
          ...testfakeTurnHarness,
          structuredOutput: {
            schema: STRUCTURED_OUTPUT_SCHEMA,
            expected: STRUCTURED_OUTPUT_VALUE,
            readForwardedSchema: () =>
              cursorTransport.workers.at(-1)?.turns.at(-1)?.input
                .structuredOutputInstruction ?? undefined,
          },
        },
      ),
    ).rejects.toThrow();
  });

  it("fails a post_validation descriptor that still forwards a native schema", async () => {
    const lying = createTestFakeBackend({
      capabilities: { structuredOutput: "post_validation" },
    });
    await expect(
      checkConversationStructuredOutputPostValidation(
        lying.descriptor.conversation!,
        {
          ...testfakeTurnHarness,
          structuredOutput: {
            schema: STRUCTURED_OUTPUT_SCHEMA,
            expected: STRUCTURED_OUTPUT_VALUE,
            readForwardedSchema: () => STRUCTURED_OUTPUT_SCHEMA,
            readDispatchedPrompt: () =>
              'contract contains schema property "ok"',
          },
        },
      ),
    ).rejects.toThrow();
  });

  it("fails a post_validation descriptor that omits the schema contract from its prompt", async () => {
    const lying = createTestFakeBackend({
      capabilities: { structuredOutput: "post_validation" },
    });
    await expect(
      checkConversationStructuredOutputPostValidation(
        lying.descriptor.conversation!,
        {
          ...testfakeTurnHarness,
          structuredOutput: {
            schema: STRUCTURED_OUTPUT_SCHEMA,
            expected: STRUCTURED_OUTPUT_VALUE,
            readForwardedSchema: () =>
              cursorTransport.workers.at(-1)?.turns.at(-1)?.input
                .structuredOutputInstruction ?? undefined,
            readDispatchedPrompt: () => "plain prompt without a contract",
          },
        },
      ),
    ).rejects.toThrow();
  });

  it("fails a descriptor that declares an idle_live kind its adapter applies mid-turn", async () => {
    const lying = createTestFakeBackend({
      capabilities: {
        capabilityKinds: [{ kind: "agents", applyTiming: "idle_live" }],
      },
    });
    await expect(
      checkApplyTimingBehavior(
        lying.descriptor,
        lying.descriptor.conversation!,
        testfakeTurnHarness,
      ),
    ).rejects.toThrow();
  });

  it("passes cancellation only when an aborted turn resolves as aborted (testfake control)", async () => {
    const truthful = createTestFakeBackend();
    await expect(
      checkCancellation(truthful.descriptor.conversation!, testfakeTurnHarness),
    ).resolves.toBeUndefined();
  });
});
