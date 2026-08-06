/**
 * R6.2 / R6.5 through the PRODUCTION turn path.
 *
 * The sibling durability suite proves the snapshot survives SQLite. This one
 * proves the part that actually matters to a user: after a restart, the runtime
 * the real prompt actor builds is handed the stored block byte-for-byte, and a
 * legacy conversation's runtime is handed no profile layer at all.
 *
 * Nothing here calls the profile helpers directly — the conversation is seeded
 * into a real store, reloaded through a store created after the write, and the
 * assertions read the `ConversationBackendCreateInput` the production actor
 * passed to the backend factory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  SNAPSHOT_FIXTURE,
  PROFILE_SECRET_SENTINEL,
  buildProfiledConversation,
  buildStoredConversation,
} from "@/lib/conversations/testing/profile-snapshot-fixtures";
import { PROFILE_LAYER_HEADING } from "@/lib/agent-profiles/composer";
import {
  createActorImplementationDepsFixture,
  createMockBackendRuntime,
} from "./testing/actor-deps-fixture";
import {
  executePromptForMachine,
  setActorDeps,
  _resetActorDepsForTesting,
} from "./actor-implementations";
import {
  conversationRuntimeKey,
  registerConversationRuntime,
  _resetForTesting as resetRuntimeRegistry,
} from "./runtime-state";
import type { ConversationBackendCreateInput } from "@/lib/agent-backends/conversation";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import type { ExecutePromptInput } from "./types";

const PROJECT_PATH = "/repo-a";
const PROJECT_NAME = "repo-a";
const SESSION_NAME = "profile-session";

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
  _resetActorDepsForTesting();
  resetRuntimeRegistry();
  fixture.close();
});

/**
 * Run one real turn for `conversationId`, reading the conversation through a
 * store created AFTER the seed — the restart. Returns the create-input the
 * actor handed the backend factory.
 */
async function runTurnAfterRestart(
  conversationId: string,
): Promise<ConversationBackendCreateInput> {
  const restarted = fixture.recreateStore();
  const created: ConversationBackendCreateInput[] = [];
  const createRuntime = async (input: ConversationBackendCreateInput) => {
    created.push(input);
    return createMockBackendRuntime({
      sendTurn: vi.fn(async () => TURN_RESULT),
    });
  };

  setActorDeps(
    createActorImplementationDepsFixture({
      getConversation: (projectPath, sessionName, id) =>
        restarted.getConversation(projectPath, sessionName, id),
      getConversationBackendFactory: () => ({
        backend: "claude" as const,
        createRuntime,
        validateModelAndEffort: () => {},
      }),
    }),
  );

  const input: ExecutePromptInput = {
    persistence: "durable",
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    sessionName: SESSION_NAME,
    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    conversationId,
    transcriptPath: `/transcripts/${conversationId}.jsonl`,
    agentBackend: "claude",
    backendRef: null,
    promptCount: 0,
    forkedFrom: null,
    role: null,
    promptText: "Hello",
    images: [],
    streamId: "stream-1",
    modelId: null,
    effort: null,
    autonomous: false,
    debugMode: null,
    codexFastMode: null,
  };

  registerConversationRuntime(
    conversationRuntimeKey(PROJECT_PATH, SESSION_NAME, conversationId),
    { abortController: new AbortController() },
  );

  await executePromptForMachine(input);

  expect(created).toHaveLength(1);
  return created[0]!;
}

describe("agent profile reaches the production runtime", () => {
  it("hands a restarted runtime the stored block byte-for-byte (R6.2)", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildProfiledConversation({ id: "restart-conv" }),
    );

    const created = await runTurnAfterRestart("restart-conv");

    // The block travels as ONE session-instruction entry, unmodified. Joining
    // and substring-matching would pass even if the composer had re-rendered
    // it with different whitespace, so the entry is compared whole.
    const entry = created.sessionInstructions.find((s) =>
      s.startsWith(PROFILE_LAYER_HEADING),
    );
    expect(entry).toBe(SNAPSHOT_FIXTURE.renderedInstructionBlock);
    expect(Buffer.from(entry!, "utf8")).toEqual(
      Buffer.from(SNAPSHOT_FIXTURE.renderedInstructionBlock, "utf8"),
    );
  });

  it("delivers the profile layer last, subordinate to the CC layers above it", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildProfiledConversation({ id: "ordering-conv" }),
    );

    const created = await runTurnAfterRestart("ordering-conv");

    expect(created.sessionInstructions.length).toBeGreaterThan(1);
    expect(created.sessionInstructions.at(-1)).toBe(
      SNAPSHOT_FIXTURE.renderedInstructionBlock,
    );
  });

  it("gives a legacy conversation's runtime no profile layer (R6.5)", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildStoredConversation({ id: "legacy-conv" }),
    );

    const created = await runTurnAfterRestart("legacy-conv");

    // Not merely "no sentinel": no profile layer at all. A legacy conversation
    // ran every prior turn without one, and inventing a frame for it now would
    // change how the agent reads its own instructions.
    expect(
      created.sessionInstructions.some((s) =>
        s.includes(PROFILE_LAYER_HEADING),
      ),
    ).toBe(false);
    // The rest of the turn's instructions are unaffected.
    expect(created.sessionInstructions.length).toBeGreaterThan(0);
  });

  it("never puts the profile's instruction text anywhere but inside its block", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildProfiledConversation({ id: "sentinel-conv" }),
    );

    const created = await runTurnAfterRestart("sentinel-conv");

    const carrying = created.sessionInstructions.filter((s) =>
      s.includes(PROFILE_SECRET_SENTINEL),
    );
    expect(carrying).toEqual([SNAPSHOT_FIXTURE.renderedInstructionBlock]);
  });
});
