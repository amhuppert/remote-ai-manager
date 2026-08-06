import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import { conversationProfileInstructionBlock } from "./conversation-profile";
import {
  PROFILE_SECRET_SENTINEL,
  SNAPSHOT_FIXTURE,
  buildProfiledConversation,
  buildStoredConversation,
} from "./testing/profile-snapshot-fixtures";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

/**
 * R6.2 restart path. The guarantee is not "the snapshot survives" but "the
 * runtime a restarted server builds receives the SAME BYTES the first runtime
 * did" — so every assertion here reads through a store created AFTER the write,
 * over the same database, with no warm cache to serve the answer from memory.
 */

const PROJECT_PATH = "/repo-a";
const SESSION_NAME = "profile-session";

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

describe("profile block replay across a restart", () => {
  it("hands a restarted runtime the stored block byte-for-byte", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildProfiledConversation({ id: "restart-conv" }),
    );

    const restarted = fixture.recreateStore();
    const reloaded = await restarted.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      "restart-conv",
    );

    const replayed = conversationProfileInstructionBlock(reloaded!);
    expect(replayed).toBe(SNAPSHOT_FIXTURE.renderedInstructionBlock);
    // Byte-level, not just deep-equal: the block travels as prompt text, so a
    // normalization difference would be a real change to what the model reads.
    expect(Buffer.from(replayed!, "utf8")).toEqual(
      Buffer.from(SNAPSHOT_FIXTURE.renderedInstructionBlock, "utf8"),
    );
    // The persisted provenance hash still covers exactly those bytes.
    expect(computeContentHash(replayed!)).toBe(
      reloaded!.profileSnapshot!.resolvedInstructionHash,
    );
  });

  it("replays the stored block rather than recomposing from the library record", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildProfiledConversation({ id: "edited-library-conv" }),
    );

    // The library record moves on after the conversation started: new revision,
    // new instructions. Recomposing at restart would pick this up.
    const editedInstructions = "Rewritten profile instructions after the fact.";
    const recomposedNow = buildAgentProfileSnapshot({
      tier: SNAPSHOT_FIXTURE.tier,
      id: SNAPSHOT_FIXTURE.id,
      name: SNAPSHOT_FIXTURE.name,
      revision: SNAPSHOT_FIXTURE.revision + 1,
      sourceContentHash: computeContentHash(editedInstructions),
      instructions: editedInstructions,
    });
    expect(recomposedNow.renderedInstructionBlock).not.toBe(
      SNAPSHOT_FIXTURE.renderedInstructionBlock,
    );

    const restarted = fixture.recreateStore();
    const reloaded = await restarted.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      "edited-library-conv",
    );

    expect(conversationProfileInstructionBlock(reloaded!)).toBe(
      SNAPSHOT_FIXTURE.renderedInstructionBlock,
    );
    expect(reloaded!.profileSnapshot!.revision).toBe(SNAPSHOT_FIXTURE.revision);
    expect(reloaded!.profileSnapshot!.instructions).not.toBe(
      editedInstructions,
    );
  });

  it("gives a legacy conversation nothing to inject after a restart", async () => {
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      buildStoredConversation({ id: "legacy-conv" }),
    );

    const restarted = fixture.recreateStore();
    const reloaded = await restarted.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      "legacy-conv",
    );

    expect(reloaded!.profileSnapshot).toBeNull();
    expect(conversationProfileInstructionBlock(reloaded!)).toBeNull();
  });

  it("replays a project conversation's block across a restart too", async () => {
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      buildProfiledConversation({ id: "plc-restart", scope: "project" }),
    );

    const restarted = fixture.recreateStore();
    const reloaded = await restarted.getConversation(
      PROJECT_PATH,
      PROJECT_CONVERSATION_SESSION_SENTINEL,
      "plc-restart",
    );

    expect(conversationProfileInstructionBlock(reloaded!)).toBe(
      SNAPSHOT_FIXTURE.renderedInstructionBlock,
    );
    expect(reloaded!.profileSnapshot!.instructions).toContain(
      PROFILE_SECRET_SENTINEL,
    );
  });
});
