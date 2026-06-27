import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  createSessionAlignmentRepo,
  type SessionAlignmentRepo,
} from "@/lib/session-alignment/repo";
import {
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
} from "@/lib/session-alignment/render";
import type { SessionAlignmentUpdatedEvent } from "@/lib/session-alignment/schemas";
import {
  createSessionAlignmentService,
  type CharterMirrorCall,
  type SessionAlignmentService,
  type SessionAlignmentServiceDeps,
} from "@/lib/session-alignment/service";
import type { CharterMirrorWriteResult } from "@/lib/session-alignment/mirror";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";
const WORKTREE_PATH = "/p1/.worktrees/s1";
const CONVERSATION_ID = "conv-1";

interface EnqueuedMessage {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  message: string;
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
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: {
      async write(input): Promise<CharterMirrorWriteResult> {
        mirrorCalls.push({ ...input });
        return { ok: true, filePath: ".cc/session-alignment/charter.md" };
      },
    },
    broadcast(event) {
      if (event.type === "session-alignment-updated") {
        broadcasts.push(event);
      }
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
    // Filling a draft is not an activation → it must not broadcast.
    expect(h.broadcasts).toHaveLength(0);
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
  it("discards an open draft and broadcasts nothing, with no active charter", async () => {
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

    await h.service.rejectDraft({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      draftId: begin.draftId,
    });

    expect(h.repo.findVersionById(begin.draftId)).toBeNull();
    expect(h.repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    expect(h.broadcasts).toHaveLength(0);
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

    // Reject changes no charter → no new mirror write, no broadcast.
    expect(h.mirrorCalls).toHaveLength(mirrorCallsBefore);
    expect(h.broadcasts).toHaveLength(0);
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
    expect(incorporation?.message).toContain("write_session_charter");
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
