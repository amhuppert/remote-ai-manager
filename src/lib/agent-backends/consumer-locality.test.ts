import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { agentSessionRefSchema } from "@/lib/shared/schemas";
import { agentCapabilityCascadeKindSchema } from "@/lib/agent-capabilities/schemas";
import { ownedCascadesForBackend } from "@/lib/agent-capabilities/runtime-composer";
import type { BackendModelSelection } from "./schemas";
import type { ConversationBackendCreateInput } from "./conversation";
import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
  getTaskRunner,
} from "./registry-core";
import { bootstrapBackends } from "./registry";
import {
  createTestFakeBackend,
  TESTFAKE_BACKEND_ID,
  TESTFAKE_CONVERSATION_REF,
  TESTFAKE_TASK_REF,
  TESTFAKE_TASK_TEXT,
  TESTFAKE_TURN_TEXT,
  type TestFakeBackend,
} from "./testing/testfake-backend";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import { createInMemoryLaneStore } from "@/lib/workflows/primitives/lane-store";
import { createLaneService } from "@/lib/workflows/primitives/lane-service";
import { createLaneScheduler } from "@/lib/workflows/primitives/lane-scheduler";
import { createWorkflowAgentCaller } from "@/lib/workflows/primitives/workflow-agent-caller";

const PROJECT_PATH = "/projects/locality";

const PROJECT_NAME = "locality";

const SESSION_NAME = "locality-session";

const WORKTREE_PATH = "/projects/locality/.worktrees/locality-session";

const NOW = "2026-07-12T00:00:00.000Z";

const TESTFAKE_MODEL_SELECTION = {
  modelId: "fake-1",
  parameters: {},
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

describe("E1: executeAgentCall is parametric in the backend id", () => {
  it("conversation shape: dispatch resolution and result carry the fake's descriptor values", async () => {
    const conversationFacet = fake.descriptor.conversation;
    if (conversationFacet === undefined)
      throw new Error("test backend has no conversation facet");
    const runtime = await conversationFacet.factory.createRuntime(
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
            capabilityView: capabilityViewForBackend(
              request.backend ?? TESTFAKE_BACKEND_ID,
            ),
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
      metrics: {},
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
      metrics: { contextTokens: 41 },
    });
  });
});
