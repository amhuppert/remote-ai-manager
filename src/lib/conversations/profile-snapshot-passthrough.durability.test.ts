/**
 * R4.1 — the programmatic snapshot handoff on conversation creation.
 *
 * A workflow lane does not name a profile; it hands over bytes an execution
 * already resolved. This suite pins the three properties that make that handoff
 * a handoff rather than a second resolution: the library is never consulted, the
 * Standard Agent default never appears, and what a restart reader loads is the
 * caller's snapshot byte-for-byte.
 *
 * Real store, real repository round trip — the assertions read the reloaded row,
 * not the object the service returned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationService } from "./service";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { ConversationState } from "./schemas";

const PROJECT_PATH = "/repo-snapshot-passthrough";
const SESSION_NAME = "handoff-session";

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

const SEEDED_INSTRUCTIONS =
  "Seeded lane profile. Review only what the execution seeded.";

function seededSnapshot(): AgentProfileSnapshot {
  return buildAgentProfileSnapshot({
    tier: "project",
    id: "lane-reviewer",
    name: "Lane Reviewer",
    revision: 4,
    sourceContentHash: computeContentHash(SEEDED_INSTRUCTIONS),
    instructions: SEEDED_INSTRUCTIONS,
  });
}

function conversationService(
  resolveProfileSnapshot: ReturnType<typeof vi.fn>,
): ReturnType<typeof createConversationService> {
  const store = fixture.store;
  return createConversationService({
    mutateSession: store.mutateSession,
    createSessionConversation: store.createSessionConversation,
    getSession: store.getSession,
    getConversation: store.getConversation,
    getSessionConversations: store.getSessionConversations,
    setConversationPendingPromptText: store.setConversationPendingPromptText,
    resolveProfileSnapshot,
  });
}

/** Reload through a store built after the write — the restart reader. */
async function reload(conversationId: string): Promise<ConversationState> {
  const conversation = await fixture
    .recreateStore()
    .getConversation(PROJECT_PATH, SESSION_NAME, conversationId);
  expect(conversation).not.toBeNull();
  return conversation!;
}

describe("createConversation snapshot passthrough", () => {
  it("persists the handed-over snapshot verbatim and never resolves (R4.1)", async () => {
    const snapshot = seededSnapshot();
    const resolveProfileSnapshot = vi.fn();
    const service = conversationService(resolveProfileSnapshot);

    const created = await service.createConversation(
      PROJECT_PATH,
      SESSION_NAME,
      { role: "iteration", profileSnapshot: snapshot },
    );

    // The library is the thing a delayed lane must not reach: a post-seed edit
    // or deletion can only change the execution's bytes through a resolution.
    expect(resolveProfileSnapshot).not.toHaveBeenCalled();

    const reloaded = await reload(created.id);
    expect(reloaded.profileSnapshot).toEqual(snapshot);
    // Byte comparison, not deep-equality alone: a re-render with different
    // whitespace would satisfy `toEqual` on every field but the block.
    expect(
      Buffer.from(reloaded.profileSnapshot!.renderedInstructionBlock, "utf8"),
    ).toEqual(Buffer.from(snapshot.renderedInstructionBlock, "utf8"));
    expect(reloaded.profileSnapshot?.id).not.toBe(STANDARD_AGENT_PROFILE_ID);
  });

  it("still resolves when no snapshot is handed over", async () => {
    const fallback = seededSnapshot();
    const resolveProfileSnapshot = vi.fn(async () => fallback);
    const service = conversationService(resolveProfileSnapshot);

    const created = await service.createConversation(
      PROJECT_PATH,
      SESSION_NAME,
      { role: "iteration" },
    );

    expect(resolveProfileSnapshot).toHaveBeenCalledTimes(1);
    expect((await reload(created.id)).profileSnapshot).toEqual(fallback);
  });

  it("refuses a creation that both names a profile and hands one over", async () => {
    const resolveProfileSnapshot = vi.fn();
    const service = conversationService(resolveProfileSnapshot);

    await expect(
      service.createConversation(PROJECT_PATH, SESSION_NAME, {
        role: "iteration",
        profile: { tier: "builtin", id: STANDARD_AGENT_PROFILE_ID },
        profileSnapshot: seededSnapshot(),
      }),
    ).rejects.toThrow(/both/i);

    expect(resolveProfileSnapshot).not.toHaveBeenCalled();
  });
});
