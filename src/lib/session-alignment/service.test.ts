import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  createSessionAlignmentRepo,
  type SessionAlignmentRepo,
} from "@/lib/session-alignment/repo";
import {
  ALIGNMENT_DOCUMENT_PATH,
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
  usesDigestPointer,
} from "@/lib/session-alignment/render";
import {
  ALIGNMENT_SNAPSHOT_DIR,
  CharterSnapshotConflictError,
  alignmentSnapshotPath,
  createCharterSnapshotWriter,
} from "@/lib/session-alignment/snapshot";
import type {
  AlignmentVersion,
  SessionAlignmentUpdatedEvent,
} from "@/lib/session-alignment/schemas";
import {
  composeTicketCharter,
  createSessionAlignmentService,
  type CapturedAlignmentCharter,
  type CharterMirrorCall,
  type SessionAlignmentService,
  type SessionAlignmentServiceDeps,
} from "@/lib/session-alignment/service";
import {
  createCharterMirrorWriter,
  type CharterMirrorWriteResult,
} from "@/lib/session-alignment/mirror";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";
const WORKTREE_PATH = "/p1/.worktrees/s1";
const CONVERSATION_ID = "conv-1";

interface EnqueuedMessage {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  message: string;
  deliveryPolicy?: "next_turn";
}

interface Harness {
  fixture: PersistenceFixture;
  repo: SessionAlignmentRepo;
  service: SessionAlignmentService;
  mirrorCalls: CharterMirrorCall[];
  broadcasts: SessionAlignmentUpdatedEvent[];
  enqueued: EnqueuedMessage[];
}

function makeService(
  fixture: PersistenceFixture,
  overrides: Partial<SessionAlignmentServiceDeps> = {},
): {
  service: SessionAlignmentService;
  repo: SessionAlignmentRepo;
  mirrorCalls: CharterMirrorCall[];
  broadcasts: SessionAlignmentUpdatedEvent[];
  enqueued: EnqueuedMessage[];
} {
  const repo = createSessionAlignmentRepo(fixture.db);
  const mirrorCalls: CharterMirrorCall[] = [];
  const broadcasts: SessionAlignmentUpdatedEvent[] = [];
  const enqueued: EnqueuedMessage[] = [];

  let idCounter = 0;
  let clock = 0;

  const deps: SessionAlignmentServiceDeps = {
    repo,
    render: {
      renderAlignmentPromptSection,
      computeAlignmentHash,
      usesDigestPointer,
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: {
      async write(input): Promise<CharterMirrorWriteResult> {
        mirrorCalls.push({ ...input });
        return { ok: true, filePath: ".cc/session-alignment/charter.md" };
      },
    },
    snapshot: {
      write({ contentHash }) {
        return Promise.resolve({
          filePath: alignmentSnapshotPath(contentHash),
          created: true,
        });
      },
    },
    broadcast(event) {
      if (event.type === "session-alignment-updated") {
        broadcasts.push(event);
      }
      return { delivered: true };
    },
    promptQueue: {
      async enqueue(message) {
        enqueued.push({ ...message });
      },
    },
    loadSession(projectPath, sessionName) {
      return Promise.resolve(
        projectPath === PROJECT_PATH && sessionName === SESSION_NAME
          ? {
              worktreePath: WORKTREE_PATH,
              creationMode: "normal" as const,
            }
          : null,
      );
    },
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
    ...overrides,
  };

  const service = createSessionAlignmentService(deps);
  return { service, repo, mirrorCalls, broadcasts, enqueued };
}

function setup(): Harness {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME, { creationMode: "normal" });
  const { service, repo, mirrorCalls, broadcasts, enqueued } =
    makeService(fixture);
  return { fixture, repo, service, mirrorCalls, broadcasts, enqueued };
}

let h: Harness;

beforeEach(() => {
  h = setup();
});

afterEach(() => {
  h.fixture.close();
});

describe("beginDraft", () => {
  it("composes a scaffold-based authoring prompt and creates a non-governing draft when no active charter exists", async () => {
    const result = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.draftId).toBeTruthy();
    expect(result.authoringPrompt).toContain(SCAFFOLD_TEMPLATE);

    const draft = h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
    expect(draft).not.toBeNull();
    expect(draft?.id).toBe(result.draftId);
    expect(draft?.status).toBe("draft");
    expect(draft?.version).toBeNull();
    expect(draft?.source).toBe("align_initial");
    expect(draft?.autoActivate).toBe(false);

    // A draft is never the active version.
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(
      h.repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME),
    ).toBeNull();
    // No charter change → no broadcast.
    expect(h.broadcasts).toHaveLength(0);
  });

  it("composes an existing-charter authoring prompt for a redraft and leaves the active charter unchanged", async () => {
    const begin = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nShip the alignment feature.",
    });
    const active = await h.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });
    h.broadcasts.length = 0;

    const redraft = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(redraft.authoringPrompt).toContain("Ship the alignment feature.");
    expect(redraft.authoringPrompt).not.toContain(
      "## Known ambiguities\n\n## Relevant sources",
    );

    const redraftRow = h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
    expect(redraftRow?.source).toBe("align_rerun");

    // Active charter still governs and is unchanged by re-drafting.
    const stillActive = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(stillActive?.id).toBe(active.id);
    expect(stillActive?.version).toBe(1);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("replaces a prior open draft (≤1 draft per session, last-writer-wins)", async () => {
    const first = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    const second = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(second.draftId).not.toBe(first.draftId);
    expect(h.repo.findVersionById(first.draftId)).toBeNull();

    const draft = h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
    expect(draft?.id).toBe(second.draftId);
  });

  it("weaves the user's guidance into a first-charter authoring prompt", async () => {
    const result = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      guidance: "focus on the API boundaries",
    });

    expect(result.authoringPrompt).toContain(SCAFFOLD_TEMPLATE);
    expect(result.authoringPrompt).toContain(
      "User guidance for the charter: focus on the API boundaries",
    );
  });

  it("weaves the user's guidance into a redraft authoring prompt", async () => {
    const begin = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nShip the alignment feature.",
    });
    await h.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });

    const redraft = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      guidance: "tighten the non-goals section",
    });

    expect(redraft.authoringPrompt).toContain("Ship the alignment feature.");
    expect(redraft.authoringPrompt).toContain(
      "User guidance for the charter: tighten the non-goals section",
    );
  });

  it("omits the guidance framing when no guidance is given", async () => {
    const result = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    expect(result.authoringPrompt).not.toContain(
      "User guidance for the charter",
    );
  });

  it("refuses to operate on an optimistic session", async () => {
    h.fixture.seedSession(PROJECT_PATH, "opt", { creationMode: "optimistic" });
    const { service } = makeService(h.fixture, {
      loadSession: () =>
        Promise.resolve({
          worktreePath: "/p1/.worktrees/opt",
          creationMode: "optimistic",
        }),
    });

    await expect(
      service.beginDraft({
        projectPath: PROJECT_PATH,
        sessionName: "opt",
        conversationId: CONVERSATION_ID,
      }),
    ).rejects.toThrow();
  });
});

describe("fillDraft", () => {
  it("fills the open draft, recomputes the hash, and returns draft_ready without governing", async () => {
    await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    const content = "# Mission\nDeliver session alignment.";
    const result = await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content,
    });

    expect(result).toEqual({ status: "draft_ready", version: null });

    const draft = h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
    expect(draft?.content).toBe(content);
    expect(draft?.contentHash).toBe(computeAlignmentHash(content));
    expect(draft?.status).toBe("draft");
    expect(draft?.version).toBeNull();

    // An unapproved, filled draft is neither active nor injected.
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(
      h.repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME),
    ).toBeNull();
    // Draft-ready broadcasts so every open conversation surfaces the
    // Approve-Charter banner without a refetch.
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      type: "session-alignment-updated",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      activeVersion: null,
      hasDraft: true,
    });
  });

  it("rejects whitespace-only content without filling a normal draft", async () => {
    const { draftId } = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    await expect(
      h.service.fillDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        content: " \n\t",
      }),
    ).rejects.toThrow(/non-whitespace/i);

    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toMatchObject({
      id: draftId,
      content: "",
      autoActivate: false,
    });
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.broadcasts).toHaveLength(0);
  });

  it("broadcasts the governing active version alongside a ready redraft", async () => {
    const first = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "v1",
    });
    await h.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: first.draftId,
    });
    await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    h.broadcasts.length = 0;

    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "v2 redraft",
    });

    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      activeVersion: 1,
      hasDraft: true,
    });
  });
});

describe("approveDraft", () => {
  it("activates the draft as version 1, materializes the mirror, and broadcasts once", async () => {
    const begin = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nVersion one charter.",
    });
    h.broadcasts.length = 0;

    const activated = await h.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
      approver: "alex",
    });

    expect(activated.status).toBe("active");
    expect(activated.version).toBe(1);
    expect(activated.activatedAt).not.toBeNull();
    expect(activated.approver).toBe("alex");

    // Reload from the real store: exactly one active version, no open draft.
    const active = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.id).toBe(begin.draftId);
    expect(active?.version).toBe(1);
    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME)).toBe(1);

    // Mirror materialized with the activated content at the worktree.
    expect(h.mirrorCalls).toHaveLength(1);
    expect(h.mirrorCalls[0]).toMatchObject({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath: WORKTREE_PATH,
      content: "# Mission\nVersion one charter.",
    });

    // Exactly one broadcast, carrying the new active version and no draft.
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      type: "session-alignment-updated",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      activeVersion: 1,
      hasDraft: false,
    });
  });

  it("supersedes the prior active and assigns an incremented version number", async () => {
    const first = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "v1",
    });
    await h.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: first.draftId,
    });

    const second = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "v2",
    });
    const activated2 = await h.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: second.draftId,
    });

    expect(activated2.version).toBe(2);

    // Exactly one active version after the second activation.
    const active = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.id).toBe(second.draftId);
    expect(active?.version).toBe(2);

    // The prior active is now superseded (not deleted).
    const prior = h.repo.findVersionById(first.draftId);
    expect(prior?.status).toBe("superseded");

    // History holds both, newest-first; never more than one active.
    const history = h.repo.findVersionHistory(PROJECT_PATH, SESSION_NAME);
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    expect(history.filter((v) => v.status === "active")).toHaveLength(1);
  });

  it("rejects approving a non-existent draft", async () => {
    await expect(
      h.service.approveDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        draftId: "missing",
      }),
    ).rejects.toThrow();
  });

  it("rejects approving an unfilled align draft", async () => {
    const begin = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    await expect(
      h.service.approveDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        draftId: begin.draftId,
      }),
    ).rejects.toThrow(/content/i);

    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)?.id).toBe(
      begin.draftId,
    );
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("does not fail activation when the mirror write fails (best-effort)", async () => {
    const { service, repo, broadcasts } = makeService(h.fixture, {
      mirror: {
        async write() {
          return { ok: false, error: new Error("disk full") };
        },
      },
    });

    const begin = await service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "still activates",
    });
    broadcasts.length = 0;
    const activated = await service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });

    expect(activated.version).toBe(1);
    expect(repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME)).toBe(1);
    expect(broadcasts).toHaveLength(1);
  });

  it("does not throw when the SSE broadcast fails", async () => {
    const { service, repo } = makeService(h.fixture, {
      broadcast() {
        throw new Error("no clients");
      },
    });

    const begin = await service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "broadcast failure tolerated",
    });

    await expect(
      service.approveDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        draftId: begin.draftId,
      }),
    ).resolves.toMatchObject({ version: 1 });
    expect(repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME)).toBe(1);
  });
});

describe("rejectDraft", () => {
  it("discards an open draft and broadcasts the dismissal, with no active charter", async () => {
    const begin = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "to be discarded",
    });
    h.broadcasts.length = 0;

    await h.service.rejectDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });

    expect(h.repo.findVersionById(begin.draftId)).toBeNull();
    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    // The dismissal broadcasts so every open conversation drops the
    // Approve-Charter banner without a refetch.
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      type: "session-alignment-updated",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      activeVersion: null,
      hasDraft: false,
    });
  });

  it("leaves the prior active version governing after rejecting a redraft", async () => {
    const first = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nGoverning charter.",
    });
    const active = await h.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: first.draftId,
    });
    const mirrorCallsBefore = h.mirrorCalls.length;
    h.broadcasts.length = 0;

    const redraft = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nRejected rewrite.",
    });
    h.broadcasts.length = 0;
    await h.service.rejectDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: redraft.draftId,
    });

    const stillActive = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(stillActive?.id).toBe(active.id);
    expect(stillActive?.version).toBe(1);
    expect(stillActive?.content).toBe("# Mission\nGoverning charter.");
    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();

    // Reject changes no charter → no new mirror write; the dismissal
    // broadcast still reports the untouched governing version.
    expect(h.mirrorCalls).toHaveLength(mirrorCallsBefore);
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      activeVersion: 1,
      hasDraft: false,
    });
  });

  it("rejects rejecting a non-existent draft", async () => {
    await expect(
      h.service.rejectDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        draftId: "missing",
      }),
    ).rejects.toThrow();
  });
});

describe("injection invariant", () => {
  it("never injects an unapproved draft; injection reflects only the active version", async () => {
    const begin = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nDraft-only content not yet governing.",
    });

    // While unapproved, there is no active version number to gate a runtime on.
    expect(
      h.repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME),
    ).toBeNull();

    await h.service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });

    expect(h.repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME)).toBe(1);
  });
});

/** Activate a charter via the /align lifecycle; returns the active version. */
async function activateCharter(content: string): Promise<number> {
  const begin = await h.service.beginDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
  });
  await h.service.fillDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    content,
  });
  const active = await h.service.approveDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    draftId: begin.draftId,
  });
  if (active.version === null) throw new Error("no version assigned");
  return active.version;
}

describe("proposeDecisions", () => {
  it("persists a durable pending batch without logging any decision and without broadcasting", async () => {
    const result = await h.service.proposeDecisions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      originMessageId: "msg-7",
      decisions: [
        {
          statement: "Use SQLite as the store",
          rationale: "single source of truth",
        },
        { statement: "Inject the charter every turn" },
      ],
    });

    expect(result.batchId).toBeTruthy();

    const proposals = h.repo.findProposalsByBatch(
      PROJECT_PATH,
      SESSION_NAME,
      result.batchId,
    );
    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.statement)).toEqual([
      "Use SQLite as the store",
      "Inject the charter every turn",
    ]);
    expect(proposals[0]?.conversationId).toBe(CONVERSATION_ID);
    expect(proposals[0]?.batchId).toBe(result.batchId);
    expect(proposals[0]?.originMessageId).toBe("msg-7");
    expect(proposals[0]?.rationale).toBe("single source of truth");
    expect(proposals[1]?.rationale).toBeNull();

    // A pending batch is durable and reviewable...
    const batches = h.repo.findPendingProposalBatches(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.proposals).toHaveLength(2);

    // ...but nothing is logged, no charter exists, and nothing is broadcast.
    expect(
      h.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME),
    ).toEqual([]);
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.broadcasts).toHaveLength(0);
  });

  it("refuses to operate on an optimistic session", async () => {
    const { service } = makeService(h.fixture, {
      loadSession: () =>
        Promise.resolve({
          worktreePath: "/p1/.worktrees/opt",
          creationMode: "optimistic",
        }),
    });

    await expect(
      service.proposeDecisions({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        decisions: [{ statement: "x" }],
      }),
    ).rejects.toThrow();
  });
});

describe("resolveProposals", () => {
  async function propose(
    statements: string[],
  ): Promise<{ batchId: string; proposalIds: string[] }> {
    const { batchId } = await h.service.proposeDecisions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      decisions: statements.map((statement) => ({ statement })),
    });
    const proposalIds = h.repo
      .findProposalsByBatch(PROJECT_PATH, SESSION_NAME, batchId)
      .map((p) => p.id);
    return { batchId, proposalIds };
  }

  it("logs only approved decisions, discards the rest, and consumes the batch", async () => {
    const { batchId, proposalIds } = await propose(["keep", "drop", "drop2"]);

    const result = await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [
        { proposalId: proposalIds[0]!, approve: true },
        { proposalId: proposalIds[1]!, approve: false },
        { proposalId: proposalIds[2]!, approve: false, feedback: "not now" },
      ],
    });

    expect(result).toEqual({ approved: 1, rejected: 2 });

    const log = h.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME);
    expect(log).toHaveLength(1);
    expect(log[0]?.statement).toBe("keep");
    expect(log[0]?.originConversationId).toBe(CONVERSATION_ID);

    // The whole batch is consumed on resolution.
    expect(
      h.repo.findProposalsByBatch(PROJECT_PATH, SESSION_NAME, batchId),
    ).toEqual([]);
    expect(
      h.repo.findPendingProposalBatches(PROJECT_PATH, SESSION_NAME),
    ).toEqual([]);
  });

  it("creates an auto-activating draft linked to the approved decisions, not yet governing or broadcast", async () => {
    const { batchId, proposalIds } = await propose(["a", "b"]);

    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: proposalIds.map((proposalId) => ({
        proposalId,
        approve: true,
      })),
    });

    const draft = h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
    expect(draft).not.toBeNull();
    expect(draft?.status).toBe("draft");
    expect(draft?.autoActivate).toBe(true);
    expect(draft?.source).toBe("decision");
    expect(draft?.authorConversationId).toBe(CONVERSATION_ID);

    const decisionIds = h.repo
      .findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME)
      .map((d) => d.id);
    expect([...(draft?.linkedDecisionIds ?? [])].sort()).toEqual(
      [...decisionIds].sort(),
    );

    // Not governing and no broadcast until the agent fills + auto-activates.
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.broadcasts).toHaveLength(0);
  });

  it("rejects manual approval of an auto-activating decision draft", async () => {
    const { batchId, proposalIds } = await propose(["approved"]);
    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [{ proposalId: proposalIds[0]!, approve: true }],
    });
    const draft = h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);

    await expect(
      h.service.approveDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        draftId: draft!.id,
      }),
    ).rejects.toThrow(/automatically/i);

    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)?.id).toBe(
      draft?.id,
    );
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(
      h.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME)[0]
        ?.producedVersion,
    ).toBeNull();
  });

  it("rejects manual rejection of an auto-activating decision draft", async () => {
    const { batchId, proposalIds } = await propose(["approved"]);
    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [{ proposalId: proposalIds[0]!, approve: true }],
    });
    const draft = h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);

    await expect(
      h.service.rejectDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        draftId: draft!.id,
      }),
    ).rejects.toThrow(/automatically/i);

    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)?.id).toBe(
      draft?.id,
    );
    expect(
      h.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME),
    ).toHaveLength(1);
  });

  it("routes an incorporation message carrying the approved statements to the originating conversation", async () => {
    const { batchId, proposalIds } = await propose([
      "Adopt feature flags",
      "Write ADRs",
    ]);

    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: proposalIds.map((proposalId) => ({
        proposalId,
        approve: true,
      })),
    });

    const incorporation = h.enqueued.find((m) =>
      m.message.includes("Adopt feature flags"),
    );
    expect(incorporation).toBeDefined();
    expect(incorporation?.conversationId).toBe(CONVERSATION_ID);
    expect(incorporation?.message).toContain("Write ADRs");
    expect(incorporation?.message).toContain("cctl charter write --file");
    expect(incorporation?.deliveryPolicy).toBe("next_turn");
  });

  it("routes mixed approval and rejection feedback in one next-turn review message", async () => {
    const { batchId, proposalIds } = await propose(["keep", "drop"]);

    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [
        { proposalId: proposalIds[0]!, approve: true },
        {
          proposalId: proposalIds[1]!,
          approve: false,
          feedback: "too broad",
        },
      ],
    });

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      deliveryPolicy: "next_turn",
    });
    expect(h.enqueued[0]?.message).toContain("keep");
    expect(h.enqueued[0]?.message).toContain("drop");
    expect(h.enqueued[0]?.message).toContain("too broad");
  });

  it("routes an all-rejected review even when the user leaves no feedback note", async () => {
    const { batchId, proposalIds } = await propose(["not now"]);

    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [{ proposalId: proposalIds[0]!, approve: false }],
    });

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      deliveryPolicy: "next_turn",
    });
    expect(h.enqueued[0]?.message).toContain("not now");
    expect(h.enqueued[0]?.message).toContain("No feedback was provided");
  });

  it("rejects whitespace-only content without activating an approved-decision draft", async () => {
    const { batchId, proposalIds } = await propose(["approved"]);
    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [{ proposalId: proposalIds[0]!, approve: true }],
    });
    const draft = h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);

    await expect(
      h.service.fillDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        content: " \n\t",
      }),
    ).rejects.toThrow(/non-whitespace/i);

    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toMatchObject({
      id: draft?.id,
      content: "",
      autoActivate: true,
    });
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(
      h.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME)[0]
        ?.producedVersion,
    ).toBeNull();
  });

  it("on reject-with-feedback, changes no charter, logs nothing, and routes the feedback back", async () => {
    const v1 = await activateCharter("# Mission\nGoverning charter.");
    h.broadcasts.length = 0;
    h.enqueued.length = 0;

    const { batchId, proposalIds } = await propose(["risky"]);
    const result = await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [
        { proposalId: proposalIds[0]!, approve: false, feedback: "too broad" },
      ],
    });

    expect(result).toEqual({ approved: 0, rejected: 1 });

    // Charter unchanged, nothing logged, no draft, no broadcast.
    const active = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.version).toBe(v1);
    expect(active?.content).toBe("# Mission\nGoverning charter.");
    expect(
      h.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME),
    ).toEqual([]);
    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.broadcasts).toHaveLength(0);

    const feedback = h.enqueued.find((m) => m.message.includes("too broad"));
    expect(feedback).toBeDefined();
    expect(feedback?.conversationId).toBe(CONVERSATION_ID);
    expect(feedback?.deliveryPolicy).toBe("next_turn");
  });

  it("auto-activates on fill, stamping each approved decision with the produced version and broadcasting once", async () => {
    const { batchId, proposalIds } = await propose(["d1", "d2"]);
    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: proposalIds.map((proposalId) => ({
        proposalId,
        approve: true,
      })),
    });

    const fill = await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "# Mission\nDecisions folded in.",
    });

    // No separate approval gate: filling an auto-activate draft activates it.
    expect(fill).toEqual({ status: "activated", version: 1 });

    const active = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.version).toBe(1);
    expect(active?.content).toBe("# Mission\nDecisions folded in.");
    expect(active?.source).toBe("decision");

    // Each approved decision is stamped with the version it produced.
    const log = h.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME);
    expect(log).toHaveLength(2);
    expect(log.every((d) => d.producedVersion === 1)).toBe(true);

    // The mirror materialized and exactly one broadcast (the activation) fired.
    expect(h.mirrorCalls).toHaveLength(1);
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      activeVersion: 1,
      hasDraft: false,
    });
  });

  it("supersedes the prior active charter when a decision draft activates", async () => {
    await activateCharter("v1 charter");
    h.broadcasts.length = 0;

    const { batchId, proposalIds } = await propose(["evolve"]);
    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [{ proposalId: proposalIds[0]!, approve: true }],
    });
    await h.service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content: "v2 charter with the decision",
    });

    const active = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.version).toBe(2);
    const history = h.repo.findVersionHistory(PROJECT_PATH, SESSION_NAME);
    expect(history.filter((v) => v.status === "active")).toHaveLength(1);

    const log = h.repo.findDecisionsReverseChron(PROJECT_PATH, SESSION_NAME);
    expect(log[0]?.producedVersion).toBe(2);
  });

  it("rejects resolving a non-existent batch", async () => {
    await expect(
      h.service.resolveProposals({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        batchId: "missing",
        resolutions: [{ proposalId: "x", approve: true }],
      }),
    ).rejects.toThrow();
  });

  it("rejects a resolution that references a proposal outside the batch", async () => {
    const { batchId } = await propose(["only"]);
    await expect(
      h.service.resolveProposals({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        batchId,
        resolutions: [{ proposalId: "not-in-batch", approve: true }],
      }),
    ).rejects.toThrow();
  });
});

/** Approve one decision through the full decision flow, producing a new version. */
async function logDecisionViaApproval(
  statement: string,
  charterContent: string,
): Promise<void> {
  const { batchId } = await h.service.proposeDecisions({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    decisions: [{ statement }],
  });
  const proposal = h.repo.findProposalsByBatch(
    PROJECT_PATH,
    SESSION_NAME,
    batchId,
  )[0];
  await h.service.resolveProposals({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    batchId,
    resolutions: [{ proposalId: proposal!.id, approve: true }],
  });
  await h.service.fillDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    content: charterContent,
  });
}

/** Activate a second `/align` version on top of an existing charter. */
async function activateNextVersion(content: string): Promise<number> {
  const begin = await h.service.beginDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
  });
  await h.service.fillDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    content,
  });
  const active = await h.service.approveDraft({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    draftId: begin.draftId,
  });
  if (active.version === null) throw new Error("no version assigned");
  return active.version;
}

describe("read accessors (getActiveVersion / getActiveInjection / getState)", () => {
  it("returns an empty aggregate and null accessors when no charter exists", async () => {
    const state = await h.service.getState(PROJECT_PATH, SESSION_NAME);
    expect(state).toEqual({
      active: null,
      draft: null,
      history: [],
      decisions: [],
      pendingProposals: [],
      preview: null,
    });
    expect(
      await h.service.getActiveVersion(PROJECT_PATH, SESSION_NAME),
    ).toBeNull();
    expect(
      await h.service.getActiveInjection(PROJECT_PATH, SESSION_NAME),
    ).toBeNull();
  });

  it("exposes the active version, injection, and a preview equal to what is injected", async () => {
    await activateCharter("# Mission\nDeliver alignment.");

    expect(await h.service.getActiveVersion(PROJECT_PATH, SESSION_NAME)).toBe(
      1,
    );

    const injection = await h.service.getActiveInjection(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(injection?.version).toBe(1);
    expect(injection?.contentHash).toBe(
      computeAlignmentHash("# Mission\nDeliver alignment."),
    );
    // The injection text is the governing section the agent receives.
    expect(injection?.text).toBe(
      renderAlignmentPromptSection({
        content: "# Mission\nDeliver alignment.",
      }),
    );
    expect(injection?.text).toContain("Deliver alignment.");

    const state = await h.service.getState(PROJECT_PATH, SESSION_NAME);
    expect(state.active?.version).toBe(1);
    // The preview is exactly what would be injected.
    expect(state.preview).toBe(injection?.text);
  });

  it("aggregates active, draft, decisions (newest-first), history, and pending proposals", async () => {
    await activateCharter("v1"); // version 1
    await logDecisionViaApproval("first decision", "v2 charter"); // version 2
    await logDecisionViaApproval("second decision", "v3 charter"); // version 3

    // An open decision draft awaiting fill, plus an unresolved pending batch.
    const { batchId } = await h.service.proposeDecisions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      decisions: [{ statement: "third decision" }],
    });
    const proposal = h.repo.findProposalsByBatch(
      PROJECT_PATH,
      SESSION_NAME,
      batchId,
    )[0];
    await h.service.resolveProposals({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      batchId,
      resolutions: [{ proposalId: proposal!.id, approve: true }],
    });
    const { batchId: pendingBatch } = await h.service.proposeDecisions({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      decisions: [{ statement: "still pending" }],
    });

    const state = await h.service.getState(PROJECT_PATH, SESSION_NAME);

    expect(state.active?.version).toBe(3);
    expect(state.active?.content).toBe("v3 charter");
    expect(state.draft?.autoActivate).toBe(true);
    expect(state.draft?.source).toBe("decision");

    // Decision log is reverse-chronological.
    expect(state.decisions.map((d) => d.statement)).toEqual([
      "third decision",
      "second decision",
      "first decision",
    ]);

    // History is newest-first and holds exactly one active version.
    expect(state.history.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(state.history.filter((v) => v.status === "active")).toHaveLength(1);

    // The unresolved batch is surfaced as a pending proposal.
    expect(state.pendingProposals).toHaveLength(1);
    expect(state.pendingProposals[0]?.batchId).toBe(pendingBatch);

    expect(state.preview).toContain("v3 charter");
  });
});

describe("diff", () => {
  it("reports the content of two activated versions", async () => {
    await activateCharter("v1 content");
    await activateNextVersion("v2 content");

    const diff = await h.service.diff(PROJECT_PATH, SESSION_NAME, 1, 2);
    expect(diff).toEqual({
      from: 1,
      to: 2,
      fromContent: "v1 content",
      toContent: "v2 content",
    });
  });

  it("rejects a diff against a non-existent version", async () => {
    await activateCharter("only");
    await expect(
      h.service.diff(PROJECT_PATH, SESSION_NAME, 1, 99),
    ).rejects.toThrow();
  });
});

describe("rollback", () => {
  it("clones a prior version into a new active version, superseding the current active and broadcasting once", async () => {
    await activateCharter("v1 content"); // version 1
    await activateNextVersion("v2 content"); // version 2
    h.broadcasts.length = 0;
    const mirrorBefore = h.mirrorCalls.length;

    const rolled = await h.service.rollback({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      version: 1,
    });

    expect(rolled.version).toBe(3);
    expect(rolled.content).toBe("v1 content");
    expect(rolled.source).toBe("rollback");
    expect(rolled.status).toBe("active");

    const active = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.version).toBe(3);
    expect(active?.content).toBe("v1 content");

    // Exactly one active; v2 superseded; v1 unchanged and still reviewable.
    const history = h.repo.findVersionHistory(PROJECT_PATH, SESSION_NAME);
    expect(history.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(history.filter((v) => v.status === "active")).toHaveLength(1);
    expect(
      h.repo.findVersionByNumber(PROJECT_PATH, SESSION_NAME, 1)?.content,
    ).toBe("v1 content");

    // Mirror materialized with the rolled content; exactly one broadcast.
    expect(h.mirrorCalls).toHaveLength(mirrorBefore + 1);
    expect(h.mirrorCalls.at(-1)).toMatchObject({ content: "v1 content" });
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      activeVersion: 3,
      hasDraft: false,
    });

    // The new version is reviewable via diff afterward.
    const diff = await h.service.diff(PROJECT_PATH, SESSION_NAME, 2, 3);
    expect(diff.toContent).toBe("v1 content");
  });

  it("rejects rolling back to a non-existent version", async () => {
    await activateCharter("only");
    await expect(
      h.service.rollback({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        version: 42,
      }),
    ).rejects.toThrow();
  });

  it("refuses rollback on an optimistic session", async () => {
    const { service } = makeService(h.fixture, {
      loadSession: () =>
        Promise.resolve({
          worktreePath: "/p1/.worktrees/opt",
          creationMode: "optimistic",
        }),
    });
    await expect(
      service.rollback({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        version: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("copyActiveCharter", () => {
  const PARENT_SESSION = "s0";
  const PARENT_WORKTREE = "/p1/.worktrees/s0";
  const PARENT_CONTENT = "# Mission\nInherited from the parent session.";

  function seedParentActiveCharter(content = PARENT_CONTENT): AlignmentVersion {
    h.fixture.seedSession(PROJECT_PATH, PARENT_SESSION, {
      creationMode: "normal",
    });
    const parentActive: AlignmentVersion = {
      id: "parent-active",
      version: 1,
      content,
      contentHash: computeAlignmentHash(content),
      status: "active",
      source: "align_initial",
      authorConversationId: "parent-conv",
      autoActivate: false,
      linkedDecisionIds: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      activatedAt: "2026-01-01T01:00:00.000Z",
      approver: "alex",
    };
    h.repo.insertVersion(PROJECT_PATH, PARENT_SESSION, parentActive);
    return parentActive;
  }

  it("copies the parent's active charter into the target as an active forked version 1", async () => {
    const parentActive = seedParentActiveCharter();

    const copied = await h.service.copyActiveCharter({
      projectPath: PROJECT_PATH,
      sourceSessionName: PARENT_SESSION,
      targetSessionName: SESSION_NAME,
    });

    expect(copied).not.toBeNull();
    expect(copied?.version).toBe(1);
    expect(copied?.status).toBe("active");
    expect(copied?.source).toBe("forked");
    expect(copied?.content).toBe(parentActive.content);
    expect(copied?.contentHash).toBe(parentActive.contentHash);
    expect(copied?.authorConversationId).toBeNull();
    expect(copied?.autoActivate).toBe(false);
    expect(copied?.approver).toBeNull();
    expect(copied?.activatedAt).not.toBeNull();
    expect(copied?.linkedDecisionIds).toEqual([]);
    // A fresh identity, not the parent's row.
    expect(copied?.id).not.toBe(parentActive.id);

    // Reload from the real store: the target now governs with this forked version.
    const active = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.id).toBe(copied?.id);
    expect(active?.version).toBe(1);
    expect(active?.source).toBe("forked");
    expect(active?.content).toBe(PARENT_CONTENT);
    expect(h.repo.findActiveVersionNumber(PROJECT_PATH, SESSION_NAME)).toBe(1);

    // The parent's charter is untouched.
    expect(h.repo.findActiveVersion(PROJECT_PATH, PARENT_SESSION)?.id).toBe(
      parentActive.id,
    );

    // Mirror materialized with the inherited content at the target worktree.
    expect(h.mirrorCalls).toHaveLength(1);
    expect(h.mirrorCalls[0]).toMatchObject({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath: WORKTREE_PATH,
      content: PARENT_CONTENT,
    });

    // Exactly one broadcast announcing the target's new active version.
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      type: "session-alignment-updated",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      activeVersion: 1,
      hasDraft: false,
      pendingProposalBatchIds: [],
    });
  });

  it("is a no-op when the parent has no active charter", async () => {
    h.fixture.seedSession(PROJECT_PATH, PARENT_SESSION, {
      creationMode: "normal",
    });

    const copied = await h.service.copyActiveCharter({
      projectPath: PROJECT_PATH,
      sourceSessionName: PARENT_SESSION,
      targetSessionName: SESSION_NAME,
    });

    expect(copied).toBeNull();
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.mirrorCalls).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("is a no-op when the target already has an active charter", async () => {
    seedParentActiveCharter();
    const existingContent = "# Mission\nTarget already aligned.";
    const existing: AlignmentVersion = {
      id: "target-existing",
      version: 1,
      content: existingContent,
      contentHash: computeAlignmentHash(existingContent),
      status: "active",
      source: "align_initial",
      authorConversationId: null,
      autoActivate: false,
      linkedDecisionIds: [],
      createdAt: "2026-01-02T00:00:00.000Z",
      activatedAt: "2026-01-02T01:00:00.000Z",
      approver: null,
    };
    h.repo.insertVersion(PROJECT_PATH, SESSION_NAME, existing);

    const copied = await h.service.copyActiveCharter({
      projectPath: PROJECT_PATH,
      sourceSessionName: PARENT_SESSION,
      targetSessionName: SESSION_NAME,
    });

    expect(copied).toBeNull();
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)?.id).toBe(
      "target-existing",
    );
    expect(h.mirrorCalls).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
  });

  it("refuses to copy into a non-normal target session", async () => {
    const { service } = makeService(h.fixture, {
      loadSession: (projectPath, sessionName) =>
        Promise.resolve(
          projectPath === PROJECT_PATH && sessionName === PARENT_SESSION
            ? { worktreePath: PARENT_WORKTREE, creationMode: "normal" as const }
            : {
                worktreePath: "/p1/.worktrees/opt",
                creationMode: "optimistic" as const,
              },
        ),
    });

    await expect(
      service.copyActiveCharter({
        projectPath: PROJECT_PATH,
        sourceSessionName: PARENT_SESSION,
        targetSessionName: SESSION_NAME,
      }),
    ).rejects.toThrow();
  });
});

describe("createAndActivateTicketCharter", () => {
  const TICKET_INPUT = {
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    ticketIdentifier: "demo#12",
    title: "Add durable ticket context",
    description: "Agents need the ticket bundle materialized at start.",
  };

  it("labels the ticket fields without presenting the title as the mission", () => {
    expect(composeTicketCharter(TICKET_INPUT)).toBe(
      [
        "# Ticket charter: demo#12",
        "",
        "## Mission",
        "Implement ticket demo#12.",
        "",
        "## Title",
        "Add durable ticket context",
        "",
        "## Description",
        "Agents need the ticket bundle materialized at start.",
        "",
        "## Working agreement",
        "This session exists to work ticket demo#12. The ticket's current state (status and attachment index with retrieval commands) is provided on every turn; creation-time attachments are materialized under `.cc/tickets/` and registered as reference documents.",
        "",
      ].join("\n"),
    );
  });

  it("creates and immediately activates a source=ticket charter with no approval step", async () => {
    const activated =
      await h.service.createAndActivateTicketCharter(TICKET_INPUT);

    expect(activated.status).toBe("active");
    expect(activated.source).toBe("ticket");
    expect(activated.version).toBe(1);
    expect(activated.approver).toBeNull();
    expect(activated.authorConversationId).toBeNull();
    expect(activated.content).toContain("demo#12");
    expect(activated.content).toContain("Add durable ticket context");
    expect(activated.content).toContain(
      "Agents need the ticket bundle materialized at start.",
    );

    const active = h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
    expect(active?.id).toBe(activated.id);
    expect(active?.source).toBe("ticket");
    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("replaces an open draft instead of stranding it", async () => {
    const { draftId } = await h.service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });

    await h.service.createAndActivateTicketCharter(TICKET_INPUT);

    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.repo.findVersionById(draftId)).toBeNull();
  });

  it("activates through the existing mirror-and-broadcast path", async () => {
    const activated =
      await h.service.createAndActivateTicketCharter(TICKET_INPUT);

    expect(h.mirrorCalls).toEqual([
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        worktreePath: WORKTREE_PATH,
        content: activated.content,
      },
    ]);
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      type: "session-alignment-updated",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      activeVersion: 1,
      hasDraft: false,
    });
  });

  it("supersedes an existing active charter through the standard activation path", async () => {
    await h.service.createAndActivateTicketCharter(TICKET_INPUT);
    const second = await h.service.createAndActivateTicketCharter({
      ...TICKET_INPUT,
      title: "Updated mission",
    });

    expect(second.version).toBe(2);
    const versions = h.repo.findVersionHistory(PROJECT_PATH, SESSION_NAME);
    const superseded = versions.find((version) => version.version === 1);
    expect(superseded?.status).toBe("superseded");
  });

  it("rejects a non-normal session without persisting anything", async () => {
    const { service, repo } = makeService(h.fixture, {
      loadSession: () =>
        Promise.resolve({
          worktreePath: WORKTREE_PATH,
          creationMode: "optimistic" as const,
        }),
    });

    await expect(
      service.createAndActivateTicketCharter(TICKET_INPUT),
    ).rejects.toThrow("alignment is unavailable for optimistic sessions");
    expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
  });

  it("rejects an unknown session", async () => {
    await expect(
      h.service.createAndActivateTicketCharter({
        ...TICKET_INPUT,
        sessionName: "missing-session",
      }),
    ).rejects.toThrow("session not found");
  });
});

describe("captureActiveCharterForRun", () => {
  let worktreePath: string;
  let service: SessionAlignmentService;

  /** Charter comfortably above ALIGNMENT_INLINE_THRESHOLD, so it renders as a digest. */
  const largeCharter = (marker: string) =>
    `# Mission\n${marker}\n${`${marker} governs this session. `.repeat(300)}`;

  /** Activate `content` as the next version through the standard `/align` path. */
  async function activate(content: string): Promise<void> {
    const begin = await service.beginDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    });
    await service.fillDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      content,
    });
    await service.approveDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });
  }

  const capture = () =>
    service.captureActiveCharterForRun({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      worktreePath,
    });

  /** Capture and narrow to digest mode, where a snapshot pointer is required. */
  async function requireDigestCapture(): Promise<
    CapturedAlignmentCharter & { snapshotPath: string }
  > {
    const captured = await capture();
    if (!captured?.snapshotPath) {
      throw new Error("expected a digest-mode capture with a snapshot path");
    }
    return { ...captured, snapshotPath: captured.snapshotPath };
  }

  const readWorktreeFile = (relativePath: string) =>
    readFile(path.join(worktreePath, relativePath), "utf-8");

  beforeEach(async () => {
    worktreePath = await mkdtemp(path.join(tmpdir(), "cc-align-capture-"));
    // Real file boundaries over a temp worktree: the mutable mirror and the
    // immutable snapshot must be provably different files on disk.
    ({ service } = makeService(h.fixture, {
      mirror: createCharterMirrorWriter({
        registerReferenceDocument: (_projectPath, _sessionName, filePath) =>
          Promise.resolve({ id: `doc-${filePath}`, filePath }),
      }),
      snapshot: createCharterSnapshotWriter(),
      loadSession: () =>
        Promise.resolve({ worktreePath, creationMode: "normal" as const }),
    }));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it("returns null when the session has no active charter", async () => {
    expect(await capture()).toBeNull();
    await expect(
      stat(path.join(worktreePath, ALIGNMENT_SNAPSHOT_DIR)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inline mode returns the canonical injection text byte-for-byte with no snapshot", async () => {
    const content = "# Mission\nShip the capture API.";
    await activate(content);

    const captured = await capture();
    const injection = await service.getActiveInjection(
      PROJECT_PATH,
      SESSION_NAME,
    );

    expect(captured?.version).toBe(1);
    expect(captured?.contentHash).toBe(computeAlignmentHash(content));
    // Byte-identical to the ordinary-turn injection: one renderer, one text.
    expect(captured?.text).toBe(injection?.text);
    expect(captured?.snapshotPath).toBeUndefined();
    await expect(
      stat(path.join(worktreePath, ALIGNMENT_SNAPSHOT_DIR)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("digest mode freezes the full charter and points the governing text at the immutable snapshot", async () => {
    const content = largeCharter("charter-N");
    expect(usesDigestPointer(content)).toBe(true);
    await activate(content);

    const captured = await requireDigestCapture();

    expect(captured.snapshotPath).toBe(
      alignmentSnapshotPath(computeAlignmentHash(content)),
    );
    // The governing instruction dereferences the frozen bytes, never the
    // mutable active mirror.
    expect(captured.text).toContain(captured.snapshotPath);
    expect(captured.text).not.toContain(ALIGNMENT_DOCUMENT_PATH);
    expect(await readWorktreeFile(captured.snapshotPath)).toBe(content);

    // The ordinary-turn injection is untouched: it still points at the mirror.
    const injection = await service.getActiveInjection(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(injection?.text).toContain(ALIGNMENT_DOCUMENT_PATH);
    expect(injection?.text).toBe(renderAlignmentPromptSection({ content }));
  });

  it("keeps a captured charter dereferenceable after a later charter is activated", async () => {
    const charterN = largeCharter("charter-N");
    const charterNext = largeCharter("charter-N-plus-1");
    await activate(charterN);

    const captured = await requireDigestCapture();

    await activate(charterNext);

    // The mutable mirror moved on to N+1 ...
    expect(await readWorktreeFile(ALIGNMENT_DOCUMENT_PATH)).toBe(charterNext);
    // ... while the captured pointer still yields charter N's exact bytes.
    expect(await readWorktreeFile(captured.snapshotPath)).toBe(charterN);
    expect(captured.text).toContain(captured.snapshotPath);
    expect(captured.text).toContain("charter-N");

    // A fresh capture addresses different bytes rather than clobbering N's.
    const recaptured = await requireDigestCapture();
    expect(recaptured.snapshotPath).not.toBe(captured.snapshotPath);
    expect(await readWorktreeFile(recaptured.snapshotPath)).toBe(charterNext);
    expect(await readWorktreeFile(captured.snapshotPath)).toBe(charterN);
  });

  it("refuses to hand out a snapshot whose bytes are not the charter it just rendered", async () => {
    const charterN = largeCharter("charter-N");
    // A version boundary is the normalized hash, so a CRLF twin is the same
    // content hash — and would address charter N's already-frozen snapshot.
    const charterTwin = charterN.replace(/\n/g, "\r\n");
    expect(computeAlignmentHash(charterTwin)).toBe(
      computeAlignmentHash(charterN),
    );

    await activate(charterN);
    const captured = await requireDigestCapture();

    await activate(charterTwin);

    // Rather than render the twin's digest over a pointer to charter N's
    // bytes, capture fails closed.
    await expect(capture()).rejects.toBeInstanceOf(
      CharterSnapshotConflictError,
    );
    expect(await readWorktreeFile(captured.snapshotPath)).toBe(charterN);
  });

  it("fails closed when the snapshot cannot be materialized", async () => {
    const failure = new Error("disk full");
    const { service: failing } = makeService(h.fixture, {
      snapshot: {
        write: () => Promise.reject(failure),
      },
      loadSession: () =>
        Promise.resolve({ worktreePath, creationMode: "normal" as const }),
    });
    await activate(largeCharter("charter-N"));

    await expect(
      failing.captureActiveCharterForRun({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        worktreePath,
      }),
    ).rejects.toBe(failure);
  });
});
