/**
 * R6.5 refusal, through the production change operation and real SQLite.
 *
 * `changeConversationProfile` is the only way a conversation's profile column is
 * ever rewritten, so the refusal it enforces is the feature's actual rule rather
 * than a guard some future caller might remember to invoke. Every case reloads
 * through a store created after the write, so "the row was not modified" is a
 * claim about the database and not about an in-memory object.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  changeConversationProfile,
  ConversationNotFoundForProfileChangeError,
  UnknownAgentProfileError,
  type ConversationProfileChangeDeps,
} from "./profile-change";
import { ConversationProfileLockedError } from "./conversation-profile";
import {
  SNAPSHOT_FIXTURE,
  buildProfiledConversation,
  buildStoredConversation,
} from "./testing/profile-snapshot-fixtures";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import type { ResolvedAgentProfile } from "@/lib/agent-profiles/schemas";

const PROJECT_PATH = "/repo-a";
const SESSION_NAME = "profile-session";

const REPLACEMENT_INSTRUCTIONS = "Work as a performance specialist.";
const REPLACEMENT: ResolvedAgentProfile = {
  tier: "builtin",
  id: "performance-specialist",
  name: "Performance specialist",
  revision: 1,
  sourceContentHash: computeContentHash(REPLACEMENT_INSTRUCTIONS),
  instructions: REPLACEMENT_INSTRUCTIONS,
};

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

function deps(): ConversationProfileChangeDeps {
  return {
    getConversation: (projectPath, sessionName, id) =>
      fixture.store.getConversation(projectPath, sessionName, id),
    mutateConversation: (projectPath, sessionName, id, label, mutate) =>
      fixture.store.mutateConversation(
        projectPath,
        sessionName,
        id,
        label,
        mutate,
      ),
    resolveProfile: async (_projectPath, ref) =>
      ref.id === REPLACEMENT.id ? REPLACEMENT : null,
  };
}

function identity(conversationId: string) {
  return {
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId,
  };
}

async function reload(conversationId: string) {
  const restarted = fixture.recreateStore();
  return await restarted.getConversation(
    PROJECT_PATH,
    SESSION_NAME,
    conversationId,
  );
}

describe("changeConversationProfile", () => {
  it("refuses a legacy conversation with the standard post-lock error (R6.5)", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildStoredConversation({ id: "legacy-conv" }),
    );

    await expect(
      changeConversationProfile(deps(), identity("legacy-conv"), {
        tier: "builtin",
        id: REPLACEMENT.id,
      }),
    ).rejects.toBeInstanceOf(ConversationProfileLockedError);

    // A pre-feature conversation is never backfilled — not even by a failed
    // change attempt (D18).
    const reloaded = await reload("legacy-conv");
    expect(reloaded!.profileSnapshot).toBeNull();
    expect(reloaded!.profileLockedAt).toBeNull();
  });

  it("names legacy as the reason, distinct from a locked conversation", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildStoredConversation({ id: "legacy-reason" }),
    );

    const error = await changeConversationProfile(
      deps(),
      identity("legacy-reason"),
      { tier: "builtin", id: REPLACEMENT.id },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConversationProfileLockedError);
    expect((error as ConversationProfileLockedError).reason).toBe("legacy");
  });

  it("refuses a conversation that has already run a turn", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildProfiledConversation({ id: "locked-conv" }),
    );

    const error = await changeConversationProfile(
      deps(),
      identity("locked-conv"),
      { tier: "builtin", id: REPLACEMENT.id },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConversationProfileLockedError);
    expect((error as ConversationProfileLockedError).reason).toBe("locked");

    const reloaded = await reload("locked-conv");
    expect(reloaded!.profileSnapshot!.id).toBe(SNAPSHOT_FIXTURE.id);
  });

  it("swaps the snapshot of an unlocked profiled conversation", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildProfiledConversation({
        id: "unlocked-conv",
        profileLockedAt: null,
      }),
    );

    const redacted = await changeConversationProfile(
      deps(),
      identity("unlocked-conv"),
      { tier: "builtin", id: REPLACEMENT.id },
    );

    // The caller gets the redacted form back — a change response is a read
    // surface like any other (R6.3).
    expect(redacted).toEqual({
      tier: "builtin",
      id: REPLACEMENT.id,
      name: REPLACEMENT.name,
      revision: REPLACEMENT.revision,
      sourceContentHash: REPLACEMENT.sourceContentHash,
      resolvedInstructionHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });

    const reloaded = await reload("unlocked-conv");
    expect(reloaded!.profileSnapshot!.id).toBe(REPLACEMENT.id);
    // The rendered block is composed and stored at the swap, so the next
    // runtime replays the NEW profile verbatim.
    expect(reloaded!.profileSnapshot!.renderedInstructionBlock).toContain(
      REPLACEMENT_INSTRUCTIONS,
    );
    expect(
      computeContentHash(reloaded!.profileSnapshot!.renderedInstructionBlock),
    ).toBe(reloaded!.profileSnapshot!.resolvedInstructionHash);
  });

  it("refuses an unknown profile without touching the stored snapshot", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildProfiledConversation({ id: "unknown-ref", profileLockedAt: null }),
    );

    await expect(
      changeConversationProfile(deps(), identity("unknown-ref"), {
        tier: "builtin",
        id: "no-such-profile",
      }),
    ).rejects.toBeInstanceOf(UnknownAgentProfileError);

    const reloaded = await reload("unknown-ref");
    expect(reloaded!.profileSnapshot!.id).toBe(SNAPSHOT_FIXTURE.id);
  });

  it("reports a missing conversation distinctly from a refusal", async () => {
    await expect(
      changeConversationProfile(deps(), identity("no-such-conv"), {
        tier: "builtin",
        id: REPLACEMENT.id,
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundForProfileChangeError);
  });
});
