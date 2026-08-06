/**
 * R7.1 — every conversation-domain construction site persists a resolved
 * profile snapshot through its OWNING repository, before any provider runtime
 * could exist.
 *
 * Real store, real library resolution, real composer: the snapshot each site
 * writes is read back through a store created after the write, so an assertion
 * here is about persisted bytes rather than the object the service returned.
 * The session-provisioning site (kickoff / quick-ticket / planner) is covered in
 * `sessions/service.test.ts`, which owns that flow's git harness.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationService } from "./service";
import { createProjectConversationService } from "@/lib/project-conversations/service";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { PROFILE_LAYER_HEADING } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { ConversationState } from "./schemas";

const PROJECT_PATH = "/repo-profile-creation";
const SESSION_NAME = "creation-session";

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
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
  });
}

function projectConversationService() {
  const store = fixture.store;
  return createProjectConversationService({
    createProjectConversationRecord: store.createProjectConversation,
    getProjectConversation: store.getProjectConversation,
    getProjectConversations: store.getProjectConversations,
    mutateProjectConversation: store.mutateProjectConversation,
    setProjectConversationArchived: store.setProjectConversationArchived,
    setProjectConversationOpen: store.setProjectConversationOpen,
    readConfig: async () => ({}),
    getProjectDisplayName: () => "repo-profile-creation",
    newId: () => `project-conv-${Math.random().toString(16).slice(2)}`,
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

/** Reload through a store built after the write — the restart reader. */
async function reloadSessionConversation(
  conversationId: string,
): Promise<ConversationState> {
  const conversation = await fixture
    .recreateStore()
    .getConversation(PROJECT_PATH, SESSION_NAME, conversationId);
  expect(conversation).not.toBeNull();
  return conversation!;
}

async function reloadProjectConversation(
  conversationId: string,
): Promise<ConversationState> {
  const conversation = await fixture
    .recreateStore()
    .getProjectConversation(PROJECT_PATH, conversationId);
  expect(conversation).not.toBeNull();
  return conversation!;
}

/**
 * What every construction site owes: a real snapshot whose rendered block is
 * the composer's output and whose hash covers exactly those bytes, and no lock
 * yet — the profile stays changeable until the first turn is admitted (R8).
 */
function expectUnlockedSnapshot(
  conversation: ConversationState,
): AgentProfileSnapshot {
  const snapshot = conversation.profileSnapshot ?? null;
  expect(snapshot).not.toBeNull();
  expect(
    snapshot!.renderedInstructionBlock.startsWith(PROFILE_LAYER_HEADING),
  ).toBe(true);
  expect(computeContentHash(snapshot!.renderedInstructionBlock)).toBe(
    snapshot!.resolvedInstructionHash,
  );
  expect(conversation.profileLockedAt).toBeNull();
  return snapshot!;
}

describe("session conversation creation", () => {
  it("persists the explicit Standard Agent snapshot when no selection is made", async () => {
    const created = await conversationService().createConversation(
      PROJECT_PATH,
      SESSION_NAME,
    );

    const snapshot = expectUnlockedSnapshot(
      await reloadSessionConversation(created.id),
    );
    expect(snapshot.tier).toBe("builtin");
    expect(snapshot.id).toBe(STANDARD_AGENT_PROFILE_ID);
  });

  it("persists the caller's selection when one is supplied", async () => {
    const created = await conversationService().createConversation(
      PROJECT_PATH,
      SESSION_NAME,
      { profile: { tier: "builtin", id: "security-reviewer" } },
    );

    const snapshot = expectUnlockedSnapshot(
      await reloadSessionConversation(created.id),
    );
    expect(snapshot.id).toBe("security-reviewer");
    expect(snapshot.name).toBe("Security Reviewer");
  });

  it("refuses to create a conversation under a profile that does not resolve", async () => {
    await expect(
      conversationService().createConversation(PROJECT_PATH, SESSION_NAME, {
        profile: { tier: "builtin", id: "no-such-profile" },
      }),
    ).rejects.toThrow(/no-such-profile/);

    const conversations = await fixture
      .recreateStore()
      .getSessionConversations(PROJECT_PATH, SESSION_NAME);
    expect(conversations).toHaveLength(0);
  });
});

describe("initialization finalization", () => {
  it("persists a Standard Agent snapshot on the conversation it opens", async () => {
    const service = conversationService();
    const initConversation = await service.createConversation(
      PROJECT_PATH,
      SESSION_NAME,
      { role: "initialization" },
    );
    expect(initConversation.role).toBe("initialization");

    const finalized = await service.finalizeInitialization(
      PROJECT_PATH,
      SESSION_NAME,
    );

    const snapshot = expectUnlockedSnapshot(
      await reloadSessionConversation(finalized.conversationId),
    );
    expect(snapshot.id).toBe(STANDARD_AGENT_PROFILE_ID);
  });
});

describe("project conversation creation", () => {
  it("persists the explicit Standard Agent snapshot when no selection is made", async () => {
    const created =
      await projectConversationService().createProjectConversation(
        PROJECT_PATH,
      );

    const snapshot = expectUnlockedSnapshot(
      await reloadProjectConversation(created.id),
    );
    expect(snapshot.tier).toBe("builtin");
    expect(snapshot.id).toBe(STANDARD_AGENT_PROFILE_ID);
  });

  it("persists the caller's selection when one is supplied", async () => {
    const created =
      await projectConversationService().createProjectConversation(
        PROJECT_PATH,
        { profile: { tier: "builtin", id: "general-implementer" } },
      );

    const snapshot = expectUnlockedSnapshot(
      await reloadProjectConversation(created.id),
    );
    expect(snapshot.id).toBe("general-implementer");
  });
});
