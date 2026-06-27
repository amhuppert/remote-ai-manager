import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Infrastructure-only mock: createLogger has module-load side effects.
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import {
  createMessageQueueService,
  contentToText,
  type MessageQueueServiceDeps,
} from "@/lib/conversations/message-queue-service";
import {
  createSessionAlignmentRepo,
  type SessionAlignmentRepo,
} from "@/lib/session-alignment/repo";
import {
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
} from "@/lib/session-alignment/render";
import {
  createSessionAlignmentService,
  type SessionAlignmentService,
} from "@/lib/session-alignment/service";
import type { SessionAlignmentUpdatedEvent } from "@/lib/session-alignment/schemas";

// End-to-end verification of the decision evolution flow through the REAL store
// and the REAL prompt queue: the alignment service's incorporation and
// feedback turns are routed through `messageQueueService`, so they durably land
// in the conversation's `pendingQueue` in SQLite (not merely captured). The flow
// proves propose → resolve(approve) → incorporation turn → auto-activation with
// decision linkage and an emitted alignment-updated event, plus the
// reject-with-feedback branch leaving the charter unchanged with nothing logged
// (R5.3, R5.4, R5.5, R5.6, R6.1, R6.2, R9.5).

const PROJECT = "/p-decisions";
const SESSION = "decisions-session";
const CONVERSATION = "conv-decisions";
const NOW = "2026-06-26T12:00:00.000Z";

function textBlock(text: string): MessageContentBlock {
  return { type: "text", text };
}

interface Harness {
  fixture: PersistenceFixture;
  service: SessionAlignmentService;
  repo: SessionAlignmentRepo;
  broadcasts: SessionAlignmentUpdatedEvent[];
  pendingTexts(): Promise<string[]>;
}

async function setup(): Promise<Harness> {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION, { creationMode: "normal" });
  await fixture.seedConversation(
    PROJECT,
    SESSION,
    conversationStateSchema.parse({
      id: CONVERSATION,
      transcriptPath: null,
      status: "running",
      role: null,
      agentBackend: "claude",
      promptCount: 0,
      createdAt: NOW,
      lastActivityAt: NOW,
    }),
  );

  const repo = createSessionAlignmentRepo(fixture.db);

  let queueId = 0;
  const queueDeps: MessageQueueServiceDeps = {
    mutateConversation: fixture.deps.mutateConversation,
    getConversation: fixture.deps.getConversation,
    getProjectDisplayName: () => "p-decisions",
    broadcast: () => {},
    now: () => NOW,
    newId: () => `q-${(queueId += 1)}`,
  };
  const messageQueue = createMessageQueueService(queueDeps);

  const broadcasts: SessionAlignmentUpdatedEvent[] = [];
  let idCounter = 0;
  let clock = 0;
  const service = createSessionAlignmentService({
    repo,
    render: {
      renderAlignmentPromptSection,
      computeAlignmentHash,
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: {
      async write() {
        return { ok: true, filePath: ".cc/session-alignment/charter.md" };
      },
    },
    broadcast(event) {
      if (event.type === "session-alignment-updated") broadcasts.push(event);
    },
    // The REAL prompt-queue persistence: incorporation/feedback turns route
    // through messageQueueService and land in the conversation's pendingQueue.
    promptQueue: {
      async enqueue({ projectPath, sessionName, conversationId, message }) {
        await messageQueue.enqueue({
          projectPath,
          sessionName,
          conversationId,
          content: [textBlock(message)],
        });
      },
    },
    loadSession: (projectPath, sessionName) =>
      Promise.resolve(
        projectPath === PROJECT && sessionName === SESSION
          ? {
              worktreePath: `${PROJECT}/.worktrees/${SESSION}`,
              creationMode: "normal" as const,
            }
          : null,
      ),
    now: () => new Date((clock += 1000)).toISOString(),
    newId: () => `a-${(idCounter += 1)}`,
  });

  return {
    fixture,
    service,
    repo,
    broadcasts,
    async pendingTexts() {
      const convo = await fixture.deps.getConversation(
        PROJECT,
        SESSION,
        CONVERSATION,
      );
      return (convo?.pendingQueue ?? []).map((e) => contentToText(e.content));
    },
  };
}

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => {
  h.fixture.close();
});

function proposalIds(batchId: string): string[] {
  return h.repo
    .findProposalsByBatch(PROJECT, SESSION, batchId)
    .map((p) => p.id);
}

describe("decision evolution flow (end-to-end through the real store and prompt queue)", () => {
  it("approves decisions → logs them, queues the incorporation turn, auto-activates a linked version, and broadcasts alignment-updated", async () => {
    const { batchId } = await h.service.proposeDecisions({
      projectPath: PROJECT,
      sessionName: SESSION,
      conversationId: CONVERSATION,
      decisions: [
        { statement: "Adopt feature flags for risky changes." },
        { statement: "Record every decision as an ADR." },
      ],
      originMessageId: "msg-origin",
    });

    const resolved = await h.service.resolveProposals({
      projectPath: PROJECT,
      sessionName: SESSION,
      batchId,
      resolutions: proposalIds(batchId).map((proposalId) => ({
        proposalId,
        approve: true,
      })),
      approver: "alex",
    });
    expect(resolved).toEqual({ approved: 2, rejected: 0 });

    // Resolution alone does not broadcast (only activation does, R11) ...
    expect(h.broadcasts).toHaveLength(0);
    // ... but the incorporation turn durably lands in the conversation queue
    // through the REAL prompt queue (R5.5).
    const afterResolve = await h.pendingTexts();
    expect(afterResolve).toHaveLength(1);
    expect(afterResolve[0]).toContain("Adopt feature flags for risky changes.");
    expect(afterResolve[0]).toContain("Record every decision as an ADR.");
    expect(afterResolve[0]).toContain("write_session_charter");

    // The agent's incorporation turn fills the auto-activate draft → it
    // activates without a separate approval gate (R5.5).
    const fill = await h.service.fillDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      conversationId: CONVERSATION,
      content: "# Mission\nFolded both decisions into the charter.",
    });
    expect(fill).toEqual({ status: "activated", version: 1 });

    // The produced version is logged-and-linked: each approved decision is
    // stamped with the version it produced (R5.4, R6.2).
    const log = h.repo.findDecisionsReverseChron(PROJECT, SESSION);
    expect(log).toHaveLength(2);
    expect(log.every((d) => d.producedVersion === 1)).toBe(true);
    expect(log.every((d) => d.approver === "alex")).toBe(true);

    // Exactly one alignment-updated event broadcasts on activation (R9.5).
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]).toMatchObject({
      activeVersion: 1,
      hasDraft: false,
    });
  });

  it("rejects with feedback → leaves the active charter unchanged, logs no decision, queues the feedback turn, and broadcasts nothing", async () => {
    // Establish an active v1 charter through the /align draft lifecycle.
    const begin = await h.service.beginDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      conversationId: CONVERSATION,
    });
    await h.service.fillDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      conversationId: CONVERSATION,
      content: "# Mission\nThe governing charter.",
    });
    const v1 = await h.service.approveDraft({
      projectPath: PROJECT,
      sessionName: SESSION,
      draftId: begin.draftId,
    });
    expect(v1.version).toBe(1);

    h.broadcasts.length = 0;

    const { batchId } = await h.service.proposeDecisions({
      projectPath: PROJECT,
      sessionName: SESSION,
      conversationId: CONVERSATION,
      decisions: [{ statement: "Rewrite everything in assembly." }],
    });
    const resolved = await h.service.resolveProposals({
      projectPath: PROJECT,
      sessionName: SESSION,
      batchId,
      resolutions: proposalIds(batchId).map((proposalId) => ({
        proposalId,
        approve: false,
        feedback: "Out of scope for this session.",
      })),
    });
    expect(resolved).toEqual({ approved: 0, rejected: 1 });

    // The active charter is unchanged and nothing is logged (R5.3, R5.6, R6.1).
    const active = h.repo.findActiveVersion(PROJECT, SESSION);
    expect(active?.version).toBe(1);
    expect(active?.content).toBe("# Mission\nThe governing charter.");
    expect(h.repo.findDecisionsReverseChron(PROJECT, SESSION)).toEqual([]);
    expect(h.repo.findDraftVersion(PROJECT, SESSION)).toBeNull();

    // No alignment-updated event — a rejection changes no version (R9.5).
    expect(h.broadcasts).toHaveLength(0);

    // The feedback turn is routed back to the conversation through the real queue.
    const texts = await h.pendingTexts();
    expect(
      texts.some((t) => t.includes("Out of scope for this session.")),
    ).toBe(true);
  });
});
