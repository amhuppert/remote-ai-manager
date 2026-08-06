/**
 * R7.2 / D28 — forking, in the order the snapshot guarantee requires.
 *
 * Two claims, both only provable against a real store:
 *
 *  - A session-derived fork inherits the source's profile snapshot VERBATIM —
 *    same identity and revision, no re-resolution — and is locked from
 *    creation, so its profile can never be changed.
 *  - The conversation row is persisted BEFORE provider continuity is created.
 *    The fake continuity adapter reads the store from inside `fork()`; if the
 *    row is not there yet, the ordering is wrong. No path may leave provider
 *    continuity behind without a snapshot-bearing row.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationService, ForkCreationError } from "./service";
import {
  changeConversationProfile,
  resolveLibraryAgentProfile,
} from "./profile-change";
import { ConversationProfileLockedError } from "./conversation-profile";
import { resolveConversationProfileSnapshot } from "./profile-resolution";
import { buildStoredConversation } from "./testing/profile-snapshot-fixtures";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { ContinuityForkError } from "@/lib/agent-backends/continuity";
import type {
  BackendContinuityAdapter,
  ForkOutcome,
} from "@/lib/agent-backends/continuity";
import type {
  AgentProfileRef,
  AgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import type { ConversationState } from "./schemas";
import type { StateStore } from "@/lib/state-store/store";

const PROJECT_PATH = "/repo-fork-profile";
const SESSION_NAME = "fork-session";
const SOURCE_ID = "source-conv";

let fixture: PersistenceFixture;
let configDir: string;
/** The real library service over an isolated scope directory. */
let library: AgentProfileLibraryService;

/** What the continuity adapter saw in the store at the moment it was called. */
let rowsAtForkTime: ConversationState[] = [];
/** Every profile reference the fork path asked the resolver to resolve. */
let resolveCalls: Array<AgentProfileRef | null | undefined> = [];

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-fork-profile-"));
  rowsAtForkTime = [];
  resolveCalls = [];
  library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => configDir }),
  });
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(async () => {
  fixture.close();
  await rm(configDir, { recursive: true, force: true });
});

async function writeSourceTranscript(transcriptPath: string): Promise<void> {
  const entries = [
    {
      timestamp: "2026-01-01T00:00:00Z",
      type: "user",
      role: "user",
      content: [{ type: "text", text: "Start the work" }],
    },
    {
      timestamp: "2026-01-01T00:00:01Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "Working on it" }],
      uuid: "assistant-1",
    },
  ];
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await writeFile(
    transcriptPath,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

/**
 * Seed a source conversation carrying `profileSnapshot`, with a real transcript
 * and a backend ref so a fork derives from its session.
 */
async function seedSource(
  profileSnapshot: AgentProfileSnapshot,
): Promise<string> {
  const transcriptPath = path.join(
    configDir,
    "transcripts",
    `${SOURCE_ID}.jsonl`,
  );
  await writeSourceTranscript(transcriptPath);
  await fixture.seedConversation(
    PROJECT_PATH,
    SESSION_NAME,
    buildStoredConversation({
      id: SOURCE_ID,
      transcriptPath,
      promptCount: 1,
      backendRef: { backend: "claude", ref: "source-session" },
      profileSnapshot,
      profileLockedAt: "2026-01-01T00:00:05.000Z",
    }),
  );
  return transcriptPath;
}

function services(
  fork: () => Promise<ForkOutcome>,
): ReturnType<typeof createConversationService> {
  const store: StateStore = fixture.store;
  const continuity: BackendContinuityAdapter = {
    backend: "claude",
    start: async () => {
      throw new Error("start is not driven by fork tests");
    },
    validate: async () => ({ status: "valid" }),
    resumeOrRecover: async (ref) => ({ ref, recovered: false }),
    // Reading the store HERE is the ordering assertion: provider continuity is
    // being created right now, so a row must already exist.
    fork: async () => {
      rowsAtForkTime = await store.getSessionConversations(
        PROJECT_PATH,
        SESSION_NAME,
      );
      return fork();
    },
  };

  return createConversationService({
    mutateSession: store.mutateSession,
    createSessionConversation: store.createSessionConversation,
    getSession: store.getSession,
    getConversation: store.getConversation,
    getSessionConversations: store.getSessionConversations,
    setConversationPendingPromptText: store.setConversationPendingPromptText,
    configDir,
    getContinuityAdapter: () => continuity,
    // The production resolver over this test's library, with a call log. It
    // resolves the LIVE record, so a fork that re-resolved would silently pick
    // up whatever the library says now instead of what the source was created
    // under — which is precisely the bug these tests have to be able to see.
    resolveProfileSnapshot: (projectPath, ref) => {
      resolveCalls.push(ref);
      return resolveConversationProfileSnapshot(projectPath, ref, {
        resolveProfile: (p, r) => library.resolve(p, r),
      });
    },
  });
}

const nativeFork = async (): Promise<ForkOutcome> => ({
  kind: "native",
  ref: { backend: "claude", ref: "forked-session" },
});

async function reload(
  conversationId: string,
): Promise<ConversationState | null> {
  return fixture
    .recreateStore()
    .getConversation(PROJECT_PATH, SESSION_NAME, conversationId);
}

describe("a session-derived fork", () => {
  it("inherits the source snapshot verbatim and is locked from creation", async () => {
    const sourceSnapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "builtin", id: "security-reviewer" },
    );
    await seedSource(sourceSnapshot);

    const result = await services(nativeFork).forkConversation({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sourceConversationId: SOURCE_ID,
      messageIndex: 1,
    });

    const forked = await reload(result.conversationId);
    // Verbatim, including revision: the fork re-uses the source's record of the
    // invocation rather than resolving the library again.
    expect(forked!.profileSnapshot).toEqual(sourceSnapshot);
    expect(forked!.profileLockedAt).not.toBeNull();
  });

  it("refuses a profile change from creation", async () => {
    const sourceSnapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "builtin", id: "security-reviewer" },
    );
    await seedSource(sourceSnapshot);

    const result = await services(nativeFork).forkConversation({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sourceConversationId: SOURCE_ID,
      messageIndex: 1,
    });

    const refusal = await changeConversationProfile(
      {
        getConversation: fixture.store.getConversation,
        mutateConversation: fixture.store.mutateConversation,
        resolveProfile: resolveLibraryAgentProfile,
      },
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: result.conversationId,
      },
      { tier: "builtin", id: STANDARD_AGENT_PROFILE_ID },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(ConversationProfileLockedError);
    // Refused because it is LOCKED, not because it came out legacy — the two
    // reasons produce the same error type, and only one of them is the fork
    // rule this criterion is about.
    expect((refusal as ConversationProfileLockedError).reason).toBe("locked");
  });

  it("persists the snapshot-bearing row before provider continuity is created", async () => {
    const sourceSnapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "builtin", id: "security-reviewer" },
    );
    await seedSource(sourceSnapshot);

    const result = await services(nativeFork).forkConversation({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sourceConversationId: SOURCE_ID,
      messageIndex: 1,
    });

    const provisional = rowsAtForkTime.find(
      (c) => c.id === result.conversationId,
    );
    expect(provisional).toBeDefined();
    // Already carrying its snapshot and its lock, and marked as a fork whose
    // provider continuity has not resolved yet.
    expect(provisional!.profileSnapshot).toEqual(sourceSnapshot);
    expect(provisional!.profileLockedAt).not.toBeNull();
    expect(provisional!.forkedFrom?.forkPending).toBe(true);
    expect(provisional!.backendRef).toBeNull();

    // Finalized once the adapter answered.
    const forked = await reload(result.conversationId);
    expect(forked!.forkedFrom?.forkPending).toBe(false);
    expect(forked!.forkedFrom?.forkMode).toBe("native");
    expect(forked!.backendRef).toEqual({
      backend: "claude",
      ref: "forked-session",
    });
  });

  it("finalizes through the synthetic-seed fallback without re-resolving the profile", async () => {
    const sourceSnapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "builtin", id: "security-reviewer" },
    );
    await seedSource(sourceSnapshot);

    const result = await services(async () => ({
      kind: "synthetic_seed",
      seed: "Here is what happened so far.",
    })).forkConversation({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sourceConversationId: SOURCE_ID,
      messageIndex: 1,
    });

    const forked = await reload(result.conversationId);
    expect(forked!.forkedFrom?.forkMode).toBe("synthetic");
    expect(forked!.forkedFrom?.forkPending).toBe(false);
    expect(forked!.backendRef).toBeNull();
    expect(forked!.pendingPromptText).toContain(
      "Here is what happened so far.",
    );
    expect(forked!.profileSnapshot).toEqual(sourceSnapshot);
  });

  it("leaves no row behind when the adapter can produce no outcome", async () => {
    const sourceSnapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "builtin", id: "security-reviewer" },
    );
    await seedSource(sourceSnapshot);

    await expect(
      services(async () => {
        throw new ContinuityForkError("claude", "fork unavailable");
      }).forkConversation({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        sourceConversationId: SOURCE_ID,
        messageIndex: 1,
      }),
    ).rejects.toBeInstanceOf(ForkCreationError);

    // A provisional row existed while the adapter ran, and is gone now — the
    // failure leaves neither an orphan conversation nor orphan continuity.
    expect(rowsAtForkTime.some((c) => c.id !== SOURCE_ID)).toBe(true);
    const remaining = await fixture
      .recreateStore()
      .getSessionConversations(PROJECT_PATH, SESSION_NAME);
    expect(remaining.map((c) => c.id)).toEqual([SOURCE_ID]);
  });
});

/**
 * The discriminating case for "verbatim, no re-resolution".
 *
 * A built-in profile is immutable, so a fork that re-resolved one would produce
 * the same identity, revision, and bytes as inheritance — the assertions above
 * cannot tell the two apart. A user-authored profile can be REVISIONED, so the
 * source is snapshotted at revision N and the library record is then moved to
 * N+1 with different instructions. Now the two behaviours disagree: inheritance
 * keeps N, re-resolution would yield N+1.
 */
describe("a session-derived fork whose library record changed after the source was created", () => {
  const ORIGINAL_INSTRUCTIONS =
    "Review as the house style demands: smallest diff, tests first.";
  const REWRITTEN_INSTRUCTIONS =
    "Ignore the house style; do whatever seems fastest.";

  /**
   * Snapshot a project profile at revision N onto the source conversation, then
   * move the library record to N+1. Returns the snapshot the source was created
   * under — the one the fork must still be carrying.
   */
  async function seedSourceThenReviseLibrary(): Promise<{
    original: AgentProfileSnapshot;
    revisedRevision: number;
  }> {
    const created = await library.create({
      projectPath: PROJECT_PATH,
      tier: "project",
      name: "House Style",
      description: "The team's own working style.",
      instructions: ORIGINAL_INSTRUCTIONS,
      recommendedFor: ["conversation"],
      tags: [],
    });

    const original = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "project", id: created.id },
      { resolveProfile: (p, r) => library.resolve(p, r) },
    );
    await seedSource(original);

    const revised = await library.update({
      projectPath: PROJECT_PATH,
      ref: { tier: "project", id: created.id },
      expectedRevision: created.revision,
      content: {
        name: "House Style",
        description: "Rewritten.",
        instructions: REWRITTEN_INSTRUCTIONS,
        recommendedFor: ["conversation"],
        tags: [],
      },
    });
    // The premise of the whole test: the library really did move on.
    expect(revised.revision).not.toBe(original.revision);

    return { original, revisedRevision: revised.revision };
  }

  /** Assert `forked` is the pre-revision snapshot, byte for byte. */
  function expectVerbatim(
    forked: ConversationState,
    original: AgentProfileSnapshot,
    revisedRevision: number,
  ): void {
    expect(forked.profileSnapshot).toEqual(original);
    // Spelled out, because equality alone would also hold if BOTH sides had
    // moved to N+1 through some shared re-resolution.
    expect(forked.profileSnapshot!.revision).toBe(original.revision);
    expect(forked.profileSnapshot!.revision).not.toBe(revisedRevision);
    expect(forked.profileSnapshot!.instructions).toBe(ORIGINAL_INSTRUCTIONS);
    expect(forked.profileSnapshot!.instructions).not.toBe(
      REWRITTEN_INSTRUCTIONS,
    );
    expect(forked.profileSnapshot!.renderedInstructionBlock).toBe(
      original.renderedInstructionBlock,
    );
    expect(forked.profileSnapshot!.sourceContentHash).toBe(
      original.sourceContentHash,
    );
    expect(forked.profileSnapshot!.resolvedInstructionHash).toBe(
      original.resolvedInstructionHash,
    );
    // Inherited, not re-derived: the fork never consulted the library at all.
    expect(resolveCalls).toEqual([]);
  }

  it("a native fork keeps the source's revision and never calls the resolver", async () => {
    const { original, revisedRevision } = await seedSourceThenReviseLibrary();

    const result = await services(nativeFork).forkConversation({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sourceConversationId: SOURCE_ID,
      messageIndex: 1,
    });

    const forked = await reload(result.conversationId);
    expect(forked!.forkedFrom?.forkMode).toBe("native");
    expectVerbatim(forked!, original, revisedRevision);
  });

  it("a synthetic fork keeps the source's revision and never calls the resolver", async () => {
    const { original, revisedRevision } = await seedSourceThenReviseLibrary();

    const result = await services(async () => ({
      kind: "synthetic_seed",
      seed: "Here is what happened so far.",
    })).forkConversation({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sourceConversationId: SOURCE_ID,
      messageIndex: 1,
    });

    const forked = await reload(result.conversationId);
    expect(forked!.forkedFrom?.forkMode).toBe("synthetic");
    expectVerbatim(forked!, original, revisedRevision);
  });

  it("still refuses a profile change, so the stale revision cannot be swapped out", async () => {
    const { original } = await seedSourceThenReviseLibrary();

    const result = await services(nativeFork).forkConversation({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sourceConversationId: SOURCE_ID,
      messageIndex: 1,
    });

    const refusal = await changeConversationProfile(
      {
        getConversation: fixture.store.getConversation,
        mutateConversation: fixture.store.mutateConversation,
        resolveProfile: resolveLibraryAgentProfile,
      },
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: result.conversationId,
      },
      { tier: "builtin", id: STANDARD_AGENT_PROFILE_ID },
    ).then(
      () => null,
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(ConversationProfileLockedError);
    expect((refusal as ConversationProfileLockedError).reason).toBe("locked");

    const forked = await reload(result.conversationId);
    expect(forked!.profileSnapshot).toEqual(original);
  });
});

describe("a fork at message index 0", () => {
  it("is a fresh conversation with the standard default, still changeable", async () => {
    const sourceSnapshot = await resolveConversationProfileSnapshot(
      PROJECT_PATH,
      { tier: "builtin", id: "security-reviewer" },
    );
    await seedSource(sourceSnapshot);

    const result = await services(nativeFork).forkConversation({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sourceConversationId: SOURCE_ID,
      messageIndex: 0,
    });

    const forked = await reload(result.conversationId);
    // No session derivation, so nothing of the source's context carries over —
    // including its instructions. It follows the standard default instead.
    expect(forked!.profileSnapshot!.id).toBe(STANDARD_AGENT_PROFILE_ID);
    expect(forked!.profileLockedAt).toBeNull();
    // And it never asked the continuity adapter for anything.
    expect(rowsAtForkTime).toEqual([]);
    // The control for the derived-fork tests' `resolveCalls` assertion: this is
    // the one fork shape that DOES resolve, so an empty log there is a real
    // observation rather than a log that never records anything.
    expect(resolveCalls).toHaveLength(1);
  });
});
