/**
 * Ownership through the REAL store.
 *
 * The pure decisions are covered in `ownership.test.ts`. What can only be
 * proven against a genuine SQLite round-trip is that each operation's check and
 * write land in ONE serialized mutation — a claim that read the record, then
 * wrote it in a second mutation, would let a concurrent prompt slip between the
 * two and be silently overwritten.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admitConversationTurn,
  claimConversationOwnership,
  reclaimConversationOwnership,
  releaseConversationOwnership,
  type MutateConversationFn,
} from "./ownership";
import { buildConversation } from "./build-conversation";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT = "/tmp/proj-ownership";
const SESSION = "s1";
const CONVERSATION = "c1";
const SCOPE = {
  projectPath: PROJECT,
  storeSessionName: SESSION,
  conversationId: CONVERSATION,
};
const OWNER = {
  kind: "collaboration" as const,
  workflowId: "wf-1",
  attemptEpoch: 1,
};

let fixture: PersistenceFixture;

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION);
  await fixture.seedConversation(
    PROJECT,
    SESSION,
    buildConversation({
      id: CONVERSATION,
      scope: "session",
      name: "ownership fixture",
      createdAt: "2026-01-01T00:00:00Z",
      agentBackend: "claude",
    }),
  );
});

afterEach(() => {
  fixture.close();
});

async function reload() {
  const conversation = await fixture.store.getConversation(
    PROJECT,
    SESSION,
    CONVERSATION,
  );
  if (!conversation) throw new Error("conversation vanished");
  return conversation;
}

/** The production store's own mutator, late-bound so each test gets the
 *  fixture `beforeEach` built rather than one captured at module load. */
const mutate: MutateConversationFn = (...args) =>
  fixture.store.mutateConversation(...args);

describe("conversation ownership durability", () => {
  it("persists a claim and the generation it claimed against", async () => {
    const decision = await claimConversationOwnership(mutate, SCOPE, OWNER);
    expect(decision).toEqual({ kind: "admit", turnGeneration: 1 });

    const reloaded = await reload();
    expect(reloaded.owner).toEqual(OWNER);
    expect(reloaded.turnGeneration).toBe(1);
  });

  it("refuses a prompt while the conversation is owned, leaving the record untouched", async () => {
    await claimConversationOwnership(mutate, SCOPE, OWNER);

    const admission = await admitConversationTurn(mutate, SCOPE);
    expect(admission).toMatchObject({ kind: "refuse" });

    const reloaded = await reload();
    expect(reloaded.turnGeneration).toBe(1);
    expect(reloaded.owner).toEqual(OWNER);
  });

  it("moves the generation exactly once per admitted turn", async () => {
    await admitConversationTurn(mutate, SCOPE);
    await admitConversationTurn(mutate, SCOPE);
    expect((await reload()).turnGeneration).toBe(2);
  });

  // The failure-then-resume path: release so the user can type, then take it
  // back only if they did not.
  it("reclaims a released conversation when no turn intervened", async () => {
    await claimConversationOwnership(mutate, SCOPE, OWNER);
    expect(await releaseConversationOwnership(mutate, SCOPE, OWNER)).toBe(true);
    expect((await reload()).owner).toBeNull();

    const decision = await reclaimConversationOwnership(
      mutate,
      SCOPE,
      { ...OWNER, attemptEpoch: 2 },
      { workflowId: OWNER.workflowId, claimedTurnGeneration: 1 },
    );
    expect(decision).toEqual({ kind: "claim", reason: "free_and_unchanged" });
    expect((await reload()).owner).toEqual({ ...OWNER, attemptEpoch: 2 });
  });

  it("refuses to reclaim after the user took a turn", async () => {
    await claimConversationOwnership(mutate, SCOPE, OWNER);
    await releaseConversationOwnership(mutate, SCOPE, OWNER);
    await admitConversationTurn(mutate, SCOPE);

    const decision = await reclaimConversationOwnership(
      mutate,
      SCOPE,
      { ...OWNER, attemptEpoch: 2 },
      { workflowId: OWNER.workflowId, claimedTurnGeneration: 1 },
    );
    expect(decision).toMatchObject({
      kind: "refuse",
      reason: "turn_intervened",
    });
    expect((await reload()).owner).toBeNull();
  });

  // A restart leaves the claim on the record because nothing released it.
  it("reclaims its own orphaned claim after a restart", async () => {
    await claimConversationOwnership(mutate, SCOPE, OWNER);

    const decision = await reclaimConversationOwnership(
      mutate,
      SCOPE,
      { ...OWNER, attemptEpoch: 2 },
      { workflowId: OWNER.workflowId, claimedTurnGeneration: 1 },
    );
    expect(decision).toEqual({ kind: "claim", reason: "still_owner" });
    expect((await reload()).owner).toEqual({ ...OWNER, attemptEpoch: 2 });
  });

  // A superseded attempt finishing late must not free a conversation its
  // successor now holds.
  it("refuses a release from a superseded attempt", async () => {
    await claimConversationOwnership(mutate, SCOPE, OWNER);
    await reclaimConversationOwnership(
      mutate,
      SCOPE,
      { ...OWNER, attemptEpoch: 2 },
      { workflowId: OWNER.workflowId, claimedTurnGeneration: 1 },
    );

    expect(await releaseConversationOwnership(mutate, SCOPE, OWNER)).toBe(
      false,
    );
    expect((await reload()).owner).toEqual({ ...OWNER, attemptEpoch: 2 });
  });

  it("serializes concurrent admissions so no generation is lost", async () => {
    await Promise.all([
      admitConversationTurn(mutate, SCOPE),
      admitConversationTurn(mutate, SCOPE),
      admitConversationTurn(mutate, SCOPE),
    ]);
    expect((await reload()).turnGeneration).toBe(3);
  });

  it("lets exactly one of several concurrent claims win", async () => {
    const decisions = await Promise.all([
      claimConversationOwnership(mutate, SCOPE, {
        ...OWNER,
        workflowId: "wf-a",
      }),
      claimConversationOwnership(mutate, SCOPE, {
        ...OWNER,
        workflowId: "wf-b",
      }),
    ]);
    expect(decisions.filter((d) => d.kind === "admit")).toHaveLength(1);
    expect((await reload()).owner).not.toBeNull();
  });
});
