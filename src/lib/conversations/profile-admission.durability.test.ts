/**
 * R8.1 — the admission operation, against a real SQLite store.
 *
 * The lock is only worth anything if it is durable and sequenced: admission
 * runs inside the store's single-writer critical section, so a profile change
 * racing a first prompt cannot interleave with it, and the stamp is on disk
 * before the call resolves. Every assertion here reads back through a store
 * created after the write — the state a restarted server comes up with.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  admitConversationProfile,
  type ConversationProfileAdmissionDeps,
} from "./profile-admission";
import {
  changeConversationProfile,
  resolveLibraryAgentProfile,
  UnknownAgentProfileError,
  type ConversationProfileChangeDeps,
} from "./profile-change";
import { ConversationProfileLockedError } from "./conversation-profile";
import { buildStoredConversation } from "./testing/profile-snapshot-fixtures";
import { resolveConversationProfileSnapshot } from "./profile-resolution";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";

const PROJECT_PATH = "/repo-admission";
const SESSION_NAME = "admission-session";

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

function admissionDeps(): ConversationProfileAdmissionDeps {
  return { mutateConversation: fixture.store.mutateConversation };
}

function changeDeps(): ConversationProfileChangeDeps {
  return {
    getConversation: fixture.store.getConversation,
    mutateConversation: fixture.store.mutateConversation,
    // The production resolver: built-ins answer without touching storage, so
    // the change path under test is the real one.
    resolveProfile: resolveLibraryAgentProfile,
  };
}

async function snapshotFor(id: string): Promise<AgentProfileSnapshot> {
  return resolveConversationProfileSnapshot(PROJECT_PATH, {
    tier: "builtin",
    id,
  });
}

async function seedProfiled(
  conversationId: string,
  profileId = STANDARD_AGENT_PROFILE_ID,
): Promise<AgentProfileSnapshot> {
  const profileSnapshot = await snapshotFor(profileId);
  await fixture.seedConversation(
    PROJECT_PATH,
    SESSION_NAME,
    buildStoredConversation({
      id: conversationId,
      profileSnapshot,
      profileLockedAt: null,
    }),
  );
  return profileSnapshot;
}

const identity = (conversationId: string) => ({
  projectPath: PROJECT_PATH,
  sessionName: SESSION_NAME,
  conversationId,
});

describe("admitConversationProfile", () => {
  it("stamps the lock durably and returns the snapshot bound to the runtime", async () => {
    const seeded = await seedProfiled("admit-1");

    const admitted = await admitConversationProfile(
      admissionDeps(),
      identity("admit-1"),
    );

    expect(admitted.snapshot).toEqual(seeded);
    // The block the runtime will append is byte-identical to the stored one —
    // admission returns bytes, not a re-render.
    expect(admitted.instructionBlock).toBe(seeded.renderedInstructionBlock);
    expect(admitted.lockedAt).not.toBeNull();

    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT_PATH, SESSION_NAME, "admit-1");
    expect(reloaded!.profileLockedAt).toBe(admitted.lockedAt);
  });

  it("keeps the first admission's stamp when later turns are admitted", async () => {
    await seedProfiled("admit-2");

    const first = await admitConversationProfile(
      admissionDeps(),
      identity("admit-2"),
    );
    const second = await admitConversationProfile(
      admissionDeps(),
      identity("admit-2"),
    );

    expect(second.lockedAt).toBe(first.lockedAt);
  });

  it("admits a legacy conversation with no block and no lock", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildStoredConversation({ id: "legacy-admit" }),
    );

    const admitted = await admitConversationProfile(
      admissionDeps(),
      identity("legacy-admit"),
    );

    expect(admitted.snapshot).toBeNull();
    expect(admitted.instructionBlock).toBeNull();
    // Not locked: there is no profile to settle, and a stamp would make a later
    // "already ran a turn" refusal indistinguishable from the legacy one.
    expect(admitted.lockedAt).toBeNull();
    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT_PATH, SESSION_NAME, "legacy-admit");
    expect(reloaded!.profileLockedAt).toBeNull();
  });

  it("admits a project conversation through the sentinel", async () => {
    const seeded = await snapshotFor("general-reviewer");
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      buildStoredConversation({
        id: "plc-admit",
        scope: "project",
        open: true,
        profileSnapshot: seeded,
      }),
    );

    const admitted = await admitConversationProfile(admissionDeps(), {
      projectPath: PROJECT_PATH,
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      conversationId: "plc-admit",
    });

    expect(admitted.instructionBlock).toBe(seeded.renderedInstructionBlock);
    const reloaded = await fixture
      .recreateStore()
      .getProjectConversation(PROJECT_PATH, "plc-admit");
    expect(reloaded!.profileLockedAt).toBe(admitted.lockedAt);
  });
});

describe("a profile change racing first-prompt admission", () => {
  it("resolves deterministically: the admitted turn's snapshot is the delivered one", async () => {
    const original = await seedProfiled("race-1");

    // Both operations are issued before either is awaited, so they contend for
    // the same conversation's writer. Whichever the queue admits first decides.
    const admission = admitConversationProfile(
      admissionDeps(),
      identity("race-1"),
    );
    const change = changeConversationProfile(changeDeps(), identity("race-1"), {
      tier: "builtin",
      id: "security-reviewer",
    }).then(
      () => "changed" as const,
      (err: unknown) => err,
    );

    const [admitted, changeOutcome] = await Promise.all([admission, change]);

    if (changeOutcome === "changed") {
      // The change won the race: it committed before the profile was locked, so
      // the admitted turn must be running under the NEW profile.
      const reloaded = await fixture
        .recreateStore()
        .getConversation(PROJECT_PATH, SESSION_NAME, "race-1");
      expect(admitted.instructionBlock).toBe(
        reloaded!.profileSnapshot!.renderedInstructionBlock,
      );
    } else {
      // Admission won: the change is refused, and the delivered block is the
      // one that was in force when the turn was admitted.
      expect(changeOutcome).toBeInstanceOf(ConversationProfileLockedError);
      expect(admitted.instructionBlock).toBe(original.renderedInstructionBlock);
      const reloaded = await fixture
        .recreateStore()
        .getConversation(PROJECT_PATH, SESSION_NAME, "race-1");
      expect(reloaded!.profileSnapshot).toEqual(original);
    }
  });

  it("refuses every change issued after admission, across a restart", async () => {
    const original = await seedProfiled("race-2");

    await admitConversationProfile(admissionDeps(), identity("race-2"));

    // The restarted reader has no in-memory state to fall back on: the refusal
    // has to come from the persisted stamp.
    const restarted = fixture.recreateStore();
    await expect(
      changeConversationProfile(
        {
          getConversation: restarted.getConversation,
          mutateConversation: restarted.mutateConversation,
          resolveProfile: changeDeps().resolveProfile,
        },
        identity("race-2"),
        { tier: "builtin", id: "security-reviewer" },
      ),
    ).rejects.toBeInstanceOf(ConversationProfileLockedError);

    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT_PATH, SESSION_NAME, "race-2");
    expect(reloaded!.profileSnapshot).toEqual(original);
  });

  it("re-snapshots and stays changeable when the change lands before admission", async () => {
    await seedProfiled("pre-admit");

    await changeConversationProfile(changeDeps(), identity("pre-admit"), {
      tier: "builtin",
      id: "security-reviewer",
    });

    const admitted = await admitConversationProfile(
      admissionDeps(),
      identity("pre-admit"),
    );

    expect(admitted.snapshot!.id).toBe("security-reviewer");
    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT_PATH, SESSION_NAME, "pre-admit");
    expect(reloaded!.profileSnapshot!.id).toBe("security-reviewer");
    expect(reloaded!.profileLockedAt).toBe(admitted.lockedAt);
  });

  it("leaves the profile untouched when the requested one does not resolve", async () => {
    const original = await seedProfiled("unknown-ref");

    await expect(
      changeConversationProfile(changeDeps(), identity("unknown-ref"), {
        tier: "builtin",
        id: "no-such-profile",
      }),
    ).rejects.toBeInstanceOf(UnknownAgentProfileError);

    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT_PATH, SESSION_NAME, "unknown-ref");
    expect(reloaded!.profileSnapshot).toEqual(original);
    expect(reloaded!.profileLockedAt).toBeNull();
  });
});
