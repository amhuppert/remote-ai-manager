/**
 * Runs the shared conformance contract against the production Claude and
 * Codex descriptors and the parameterized testfake. Descriptors are assembled
 * through the same factories the registry bootstrap uses; every provider
 * touchpoint (Claude `query()`, Codex SDK client, native plugin records,
 * continuity services) is a fake port injected through the adapters' DI
 * seams, so the REAL factories/runners execute their full pipelines with no
 * subprocess and no state store.
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
import {
  claudeMcpCapabilities,
  codexMcpCapabilities,
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
): ConversationBackendCreateInput {
  return {
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
    sessionInstructions: [],
    tooling: {},
  };
}

function buildTaskRequest(withSchema: boolean): AgentTaskRequest {
  return {
    workingDirectory: "/conformance",
    prompt: "conformance task run",
    timeoutMs: 0,
    autonomous: true,
    ...(withSchema ? { outputSchema: STRUCTURED_OUTPUT_SCHEMA } : {}),
  };
}

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
    buildCreateInput: () => buildCreateInput("conformance-claude-conv"),
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
    buildRequest: () => buildTaskRequest(true),
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

const codexProvider = createFakeCodexProvider({
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
  taskRunner: new CodexTaskRunner(codexTaskPort.deps),
  prepareManagedSkillsCheckout: async () => undefined,
  mcp: codexMcpCapabilities,
  failureClassifier: createCodexFailureClassifier(),
});

describeBackendConformance(codexDescriptor, {
  continuity: continuityHarness,
  conversationTurn: {
    buildCreateInput: () => buildCreateInput("conformance-codex-conv"),
    hangingPromptText: FAKE_CODEX_HANGING_PROMPT,
    structuredOutput: {
      schema: STRUCTURED_OUTPUT_SCHEMA,
      expected: STRUCTURED_OUTPUT_VALUE,
      readForwardedSchema: () => codexProvider.lastTurnOptions?.outputSchema,
    },
  },
  task: {
    buildRequest: () => buildTaskRequest(true),
    structuredOutput: {
      schema: STRUCTURED_OUTPUT_SCHEMA,
      expected: STRUCTURED_OUTPUT_VALUE,
      readForwardedSchema: () => codexTaskPort.lastOutputSchema,
    },
  },
});

// ============================================================
// Testfake — scripted descriptor through the same contract
// ============================================================

const testfake = createTestFakeBackend();

const testfakeTurnHarness: ConversationTurnConformanceHarness = {
  buildCreateInput: () => buildCreateInput("conformance-testfake-conv"),
  hangingPromptText: TESTFAKE_HANGING_PROMPT,
};

describeBackendConformance(testfake.descriptor, {
  continuity: continuityHarness,
  conversationTurn: testfakeTurnHarness,
  task: {
    buildRequest: () => buildTaskRequest(false),
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
            readForwardedSchema: () => undefined,
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
            readForwardedSchema: () => undefined,
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
