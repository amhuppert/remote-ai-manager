/**
 * The change path resolves through the LIBRARY, not just the built-in tier.
 *
 * `resolveLibraryAgentProfile` is what both scopes' PATCH routes are wired to,
 * so this drives it against real scoped storage: a user-authored global record
 * is reachable, its stored revision and content hash ride into the snapshot,
 * and a reference into a tier that has no such record is refused rather than
 * satisfied from a same-named sibling.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  changeConversationProfile,
  resolveLibraryAgentProfile,
  UnknownAgentProfileError,
} from "./profile-change";
import { resolveConversationProfileSnapshot } from "./profile-resolution";
import { buildStoredConversation } from "./testing/profile-snapshot-fixtures";
import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { computeContentHash } from "@/lib/agent-profiles/hashing";

const PROJECT_PATH = "/repo-library-change";
const SESSION_NAME = "library-change-session";
const CONVERSATION_ID = "library-change-conv";

let fixture: PersistenceFixture;
let configDir: string;
/** The real library service over an isolated scope directory. */
let library: AgentProfileLibraryService;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-profile-change-"));
  library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => configDir }),
  });

  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  await fixture.seedConversation(
    PROJECT_PATH,
    SESSION_NAME,
    buildStoredConversation({
      id: CONVERSATION_ID,
      profileSnapshot: await resolveConversationProfileSnapshot(PROJECT_PATH),
    }),
  );
});

afterEach(async () => {
  fixture.close();
  await rm(configDir, { recursive: true, force: true });
});

function deps() {
  return {
    getConversation: fixture.store.getConversation,
    mutateConversation: fixture.store.mutateConversation,
    // The production resolver, over this test's library — the refusal mapping
    // and the fail-closed behaviour under test are its own.
    resolveProfile: (
      projectPath: string,
      ref: Parameters<typeof resolveLibraryAgentProfile>[1],
    ) => resolveLibraryAgentProfile(projectPath, ref, library),
  };
}

const identity = {
  projectPath: PROJECT_PATH,
  sessionName: SESSION_NAME,
  conversationId: CONVERSATION_ID,
};

async function createHouseReviewer(instructions: string): Promise<void> {
  await library.create({
    projectPath: PROJECT_PATH,
    tier: "global",
    name: "House Reviewer",
    description: "The team's own review lens.",
    instructions,
    recommendedFor: ["conversation"],
    tags: ["review"],
  });
}

describe("changing a conversation onto a user-authored profile", () => {
  it("reaches a global-tier record and snapshots its stored revision and hash", async () => {
    const instructions = "审查 every boundary twice.";
    await createHouseReviewer(instructions);

    const redacted = await changeConversationProfile(deps(), identity, {
      tier: "global",
      id: "house-reviewer",
    });

    expect(redacted).toMatchObject({ tier: "global", id: "house-reviewer" });
    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID);
    const snapshot = reloaded!.profileSnapshot!;
    expect(snapshot.instructions).toBe(instructions);
    // NFC-normalized hashing is the library's contract; the snapshot carries
    // the record's STORED hash rather than one recomputed at the conversation.
    expect(snapshot.sourceContentHash).toBe(computeContentHash(instructions));
    expect(snapshot.revision).toBe(1);
  });

  it("refuses a project-tier reference when only the global record exists", async () => {
    await createHouseReviewer("Review carefully.");

    // Sibling tiers are separate scopes, never a shadowing chain: the same id
    // in another tier is a different profile and must not be substituted.
    await expect(
      changeConversationProfile(deps(), identity, {
        tier: "project",
        id: "house-reviewer",
      }),
    ).rejects.toBeInstanceOf(UnknownAgentProfileError);
  });
});
