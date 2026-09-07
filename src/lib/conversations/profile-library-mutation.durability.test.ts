import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
let conversationActors: ReturnType<typeof createTestActorImplementations>;
import { createManagedRuntimeFixture } from "@/lib/workflows/conversation/testing/runtime-binding-fixture";
/**
 * R6.1 — a conversation is immune to the library record it was created from.
 *
 * Everything here is real: the library service over a real scoped store, the
 * conversation service's own creation path, real SQLite, and the PRODUCTION
 * prompt actor building the runtime input. Between creation and delivery the
 * library record is edited and then deleted outright — after which the
 * conversation must still be handed the same bytes, byte for byte, across a
 * simulated restart and a fresh runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationService } from "./service";
import { admitConversationProfile } from "./profile-admission";
import { resolveConversationProfileSnapshot } from "./profile-resolution";
import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { PROFILE_LAYER_HEADING } from "@/lib/agent-profiles/composer";
import {
  createActorDependenciesFixture,
  createMockBackendRuntime,
} from "@/lib/workflows/conversation/testing/actor-deps-fixture";

import {
  conversationRuntimeKey,
  registerConversationRuntime,
  _resetForTesting as resetRuntimeRegistry,
} from "@/lib/workflows/conversation/runtime-state";
import type { ConversationBackendCreateInput } from "@/lib/agent-backends/conversation";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import type { ExecutePromptInput } from "@/lib/workflows/conversation/types";

const PROJECT_PATH = "/repo-profile-mutation";
const PROJECT_NAME = "repo-profile-mutation";
const SESSION_NAME = "mutation-session";

const ORIGINAL_INSTRUCTIONS =
  "Review as the house style demands: smallest diff, tests first.";

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
let configDir: string;
/** The real library service over an isolated scope directory. */
let library: AgentProfileLibraryService;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-profile-mutation-"));
  library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => configDir }),
    // Deletion is a step here, not the subject: the durability claim is about
    // conversation snapshots, and no workflow artifacts exist in this fixture.
    referenceReporter: {
      async enumerateSavedReferences() {
        return { definitions: [], templates: [], workflowDefaults: false };
      },
    },
  });
  resetRuntimeRegistry();
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(async () => {
  resetRuntimeRegistry();
  fixture.close();
  await rm(configDir, { recursive: true, force: true });
});

function conversationService() {
  const store = fixture.store;
  return createConversationService({
    mutateSession: store.mutateSession,
    createSessionConversation: store.createSessionConversation,
    getSession: store.getSession,
    getConversation: store.getConversation,
    getSessionConversations: store.getSessionConversations,
    setConversationPendingPromptText: store.setConversationPendingPromptText,
    // The production resolver over this test's library: creation still runs
    // resolve → compose → persist, just against an isolated scope directory.
    resolveProfileSnapshot: (projectPath, ref) =>
      resolveConversationProfileSnapshot(projectPath, ref, {
        resolveProfile: (p, r) => library.resolve(p, r),
      }),
  });
}

/**
 * Run one real turn through the production prompt actor, reading the
 * conversation through a store built AFTER every write — the restart. Returns
 * the create-input the actor handed the backend factory.
 */
async function runTurnAfterRestart(
  conversationId: string,
): Promise<ConversationBackendCreateInput> {
  const restarted = fixture.recreateStore();
  const created: ConversationBackendCreateInput[] = [];

  conversationActors = createTestActorImplementations(
    createActorDependenciesFixture({
      getConversation: (projectPath, sessionName, id) =>
        restarted.getConversation(projectPath, sessionName, id),
      getConversationBackendFactory: () => ({
        backend: "claude" as const,
        createRuntime: async (input: ConversationBackendCreateInput) => {
          created.push(input);
          return createMockBackendRuntime({
            sendTurn: vi.fn(async () => TURN_RESULT),
          });
        },
        validateModelSelection: () => {},
      }),
    }),
  );

  const input: ExecutePromptInput = {
    turn: {
      kind: "conversation_turn",
      backend: "claude",
      promptText: "Hello",
      images: [],
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      autonomous: false,
    },
    persistence: "durable",
    projectPath: PROJECT_PATH,
    target: targetFromStoreSessionName(
      PROJECT_NAME,
      SESSION_NAME,
      conversationId,
    ),

    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,

    transcriptPath: `/transcripts/${conversationId}.jsonl`,
    agentBackend: "claude",
    backendRef: null,
    promptCount: 0,
    forkedFrom: null,
    role: null,
    streamId: "stream-1",
    onModelSelectionResolved: async () => {},
    debugMode: null,
  };

  registerConversationRuntime(
    conversationRuntimeKey(PROJECT_PATH, SESSION_NAME, conversationId),
    {
      managed: createManagedRuntimeFixture(
        conversationRuntimeKey(PROJECT_PATH, SESSION_NAME, conversationId),
      ),
      abortController: new AbortController(),
    },
  );

  await conversationActors.executePromptForMachine(input);

  expect(created).toHaveLength(1);
  return created[0]!;
}

function profileLayerOf(input: ConversationBackendCreateInput): string {
  const entry = input.sessionInstructions.find((s) =>
    s.startsWith(PROFILE_LAYER_HEADING),
  );
  if (entry === undefined) {
    throw new Error("no profile layer reached the runtime");
  }
  return entry;
}

describe("editing and deleting the library record a conversation was created from", () => {
  it("leaves the conversation's resolved instructions byte-identical (R6.1)", async () => {
    const created = await library.create({
      projectPath: PROJECT_PATH,
      tier: "project",
      name: "House Style",
      description: "The team's own working style.",
      instructions: ORIGINAL_INSTRUCTIONS,
      recommendedFor: ["conversation"],
      tags: [],
    });

    const conversation = await conversationService().createConversation(
      PROJECT_PATH,
      SESSION_NAME,
      { profile: { tier: "project", id: created.id } },
    );

    // The bytes bound to the turn, taken from the admission operation — the
    // same value the requirement says the runtime must receive (R8.1).
    const admitted = await admitConversationProfile(
      { mutateConversation: fixture.store.mutateConversation },
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: conversation.id,
      },
    );
    expect(admitted.instructionBlock).not.toBeNull();

    // The library record changes out from under the conversation, then stops
    // existing at all.
    const updated = await library.update({
      projectPath: PROJECT_PATH,
      ref: { tier: "project", id: created.id },
      expectedRevision: created.revision,
      content: {
        name: "House Style",
        description: "Rewritten.",
        instructions: "Ignore the house style; do whatever seems fastest.",
        recommendedFor: ["conversation"],
        tags: [],
      },
    });
    await library.delete({
      projectPath: PROJECT_PATH,
      ref: { tier: "project", id: created.id },
      expectedRevision: updated.revision,
      confirmed: true,
    });
    await expect(
      library.resolve(PROJECT_PATH, { tier: "project", id: created.id }),
    ).rejects.toThrow();

    const runtimeInput = await runTurnAfterRestart(conversation.id);
    const delivered = profileLayerOf(runtimeInput);

    expect(delivered).toBe(admitted.instructionBlock);
    expect(Buffer.from(delivered, "utf8")).toEqual(
      Buffer.from(admitted.instructionBlock!, "utf8"),
    );
    // The deleted record's replacement text never reaches the conversation, and
    // the original still does — a replay, not a re-resolution.
    expect(delivered).toContain(ORIGINAL_INSTRUCTIONS);
    expect(delivered).not.toContain("whatever seems fastest");
  });

  it("keeps the snapshot's revision at the one that was resolved", async () => {
    const created = await library.create({
      projectPath: PROJECT_PATH,
      tier: "project",
      name: "House Style",
      description: "The team's own working style.",
      instructions: ORIGINAL_INSTRUCTIONS,
      recommendedFor: ["conversation"],
      tags: [],
    });

    const conversation = await conversationService().createConversation(
      PROJECT_PATH,
      SESSION_NAME,
      { profile: { tier: "project", id: created.id } },
    );

    await library.update({
      projectPath: PROJECT_PATH,
      ref: { tier: "project", id: created.id },
      expectedRevision: created.revision,
      content: {
        name: "House Style",
        description: "Rewritten.",
        instructions: "Something else entirely.",
        recommendedFor: ["conversation"],
        tags: [],
      },
    });

    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT_PATH, SESSION_NAME, conversation.id);
    expect(reloaded!.profileSnapshot!.revision).toBe(created.revision);
    expect(reloaded!.profileSnapshot!.instructions).toBe(ORIGINAL_INSTRUCTIONS);
  });
});
