import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
let conversationActors: ReturnType<typeof createTestActorImplementations>;
import { createManagedRuntimeFixture } from "@/lib/workflows/conversation/testing/runtime-binding-fixture";
/**
 * Launch-capability eligibility through the PRODUCTION turn path (D7 R9.4,
 * decisions D11/D12).
 *
 * The signed capability is what makes a launch's origin a principal rather than
 * a claim, and D12 makes eligibility an ALLOWLIST: it is declared by the caller
 * that authoritatively knows which kind of runtime it is building, so anything
 * that does not declare it — a lane, the planner's task run, a collaboration
 * runtime, a conversation kind added later — is minted none and cannot launch.
 *
 * A declaration nobody makes would be a guard with no reachable success path,
 * so this reads the `ConversationBackendCreateInput` the real conversation actor
 * hands the backend factory: an ordinary conversation declares itself, and the
 * same actor building a workflow lane does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { buildStoredConversation } from "@/lib/conversations/testing/profile-snapshot-fixtures";
import type {
  ConversationBackendCreateInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import {
  createActorDependenciesFixture,
  createMockBackendRuntime,
} from "./testing/actor-deps-fixture";

import {
  conversationRuntimeKey,
  registerConversationRuntime,
  _resetForTesting as resetRuntimeRegistry,
} from "./runtime-state";
import type { ConversationRuntimeState } from "./runtime-state";
import type { ExecutePromptInput } from "./types";
import type { ConversationRole } from "@/lib/conversations/schemas";

const PROJECT_PATH = "/repo-launch";
const PROJECT_NAME = "repo-launch";
const SESSION_NAME = "launch-session";

const TURN_RESULT: ConversationBackendTurnResult = {
  backendRef: { backend: "claude", ref: "sdk-session-1" },
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  contextTokens: 1,
  contextWindowMax: 200_000,
  contentBlocks: [{ type: "text", text: "ok" }],
  aborted: false,
  compacted: false,
  failure: null,
  continuationDisposition: "retain",
};

let fixture: PersistenceFixture;

beforeEach(() => {
  resetRuntimeRegistry();
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  resetRuntimeRegistry();
  fixture.close();
});

/** Scopes the actor asked to have a capability minted for. */
let mintRequests: Array<{ sessionName: string; conversationId: string }> = [];

/** Run one real turn and return the create-input the actor built. */
async function runTurn(input: {
  conversationId: string;
  role: ConversationRole;
  persistence?: "durable" | "ephemeral";
  runtimeState?: Partial<ConversationRuntimeState>;
}): Promise<ConversationBackendCreateInput> {
  await fixture.seedConversation(
    PROJECT_PATH,
    SESSION_NAME,
    buildStoredConversation({ id: input.conversationId, role: input.role }),
  );
  const store = fixture.recreateStore();

  const created: ConversationBackendCreateInput[] = [];
  mintRequests = [];
  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      getConversation: (projectPath, sessionName, id) =>
        store.getConversation(projectPath, sessionName, id),
      // Injected rather than reaching the real signing key: the decision under
      // test is WHO is minted one and under WHICH identity, not the signature.
      mintConversationCapability: (scope) => {
        mintRequests.push(scope);
        return `cccc1.minted-for-${scope.conversationId}.sig`;
      },
      getConversationBackendFactory: () => ({
        backend: "claude",
        createRuntime: async (createInput) => {
          created.push(createInput);
          return createMockBackendRuntime({
            sendTurn: vi.fn(async () => TURN_RESULT),
          });
        },
        validateModelSelection: () => {},
      }),
    }),
  );

  registerConversationRuntime(
    conversationRuntimeKey(PROJECT_PATH, SESSION_NAME, input.conversationId),
    {
      managed: createManagedRuntimeFixture(
        conversationRuntimeKey(
          PROJECT_PATH,
          SESSION_NAME,
          input.conversationId,
        ),
      ),
      abortController: new AbortController(),
      ...input.runtimeState,
    },
  );

  const promptInput: ExecutePromptInput = {
    turn: {
      kind: "conversation_turn",
      backend: "claude",
      promptText: "Hello",
      images: [],
      modelSelection: null,
      autonomous: false,
    },
    persistence: input.persistence ?? "durable",
    projectPath: PROJECT_PATH,
    target: targetFromStoreSessionName(
      PROJECT_NAME,
      SESSION_NAME,
      input.conversationId,
    ),

    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,

    transcriptPath: `/transcripts/${input.conversationId}.jsonl`,
    agentBackend: "claude",
    backendRef: null,
    promptCount: 0,
    forkedFrom: null,
    role: input.role,
    streamId: "stream-1",
    onModelSelectionResolved: async () => {},
    debugMode: null,
  };

  await conversationActors.executePromptForMachine(promptInput);

  expect(created).toHaveLength(1);
  return created[0]!;
}

describe("launch-capability eligibility reaches the production runtime", () => {
  it("mints for a durable ordinary conversation, under its own conversation id", async () => {
    const created = await runTurn({
      conversationId: "ordinary-conv",
      role: null,
    });

    expect(created.conversationCapability).toBe(
      "cccc1.minted-for-ordinary-conv.sig",
    );
    // The identity signed is the conversation's OWN, taken at spawn. A
    // capability minted further down — from the env builder's target — would
    // read a redirected id for any runtime that sets one.
    expect(mintRequests).toEqual([
      { sessionName: SESSION_NAME, conversationId: "ordinary-conv" },
    ]);
  });

  it("mints nothing for a workflow lane, whose authority is its lane capability", async () => {
    const created = await runTurn({
      conversationId: "lane-conv",
      role: "iteration",
      runtimeState: {
        workflowContext: {
          executionId: "exec-1",
          contextId: "context-1",
          laneCapability: "lane-cap",
        },
      },
    });

    expect(created.conversationCapability).toBe(undefined);
    expect(created.workflowLaneCapability).toBe("lane-cap");
    expect(created.workflowExecutionId).toBe("exec-1");
    expect(mintRequests).toEqual([]);
  });

  it("mints nothing for a workflow role even when no lane identity is registered", async () => {
    // Role and lane registration are separate facts, and a validator turn that
    // races registration must not fall back into the ordinary allowlist.
    const created = await runTurn({
      conversationId: "validator-conv",
      role: "validator",
    });

    expect(created.conversationCapability).toBe(undefined);
    expect(mintRequests).toEqual([]);
  });

  it("mints nothing for the planner, which is a reserved role rather than a human's conversation", async () => {
    const created = await runTurn({
      conversationId: "planner-conv",
      role: "planner",
    });

    expect(created.conversationCapability).toBe(undefined);
    expect(mintRequests).toEqual([]);
  });

  it("mints nothing for the retired initialization role", async () => {
    // Retired, so no new conversation takes it — but legacy rows still carry
    // it, and an allowlist that admits a role nobody reviews for launch
    // authority is the failure this criterion names.
    const created = await runTurn({
      conversationId: "init-conv",
      role: "initialization",
    });

    expect(created.conversationCapability).toBe(undefined);
    expect(mintRequests).toEqual([]);
  });

  it("mints nothing for an ephemeral runtime, which CC state cannot resolve as an origin", async () => {
    const created = await runTurn({
      conversationId: "ephemeral-conv",
      role: null,
      persistence: "ephemeral",
    });

    expect(created.conversationCapability).toBe(undefined);
    expect(mintRequests).toEqual([]);
  });
});
