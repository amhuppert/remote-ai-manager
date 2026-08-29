/**
 * Integration tests for dispatching a notepad's open review comments to a
 * conversation (R20.2 / notepad-crit-comment-dispatch).
 *
 * Everything here runs over a REAL persistence fixture (real repos on a fresh
 * `:memory:` SQLite DB), the REAL notepad service (so the dispatched comments
 * are ones the store actually holds, with their passages resolved against the
 * notepad's current canonical text), and the REAL delivery orchestration — the
 * prompt route handler, `deliverNotepadFeedback`, `queueMessage`, the message
 * queue service, the drain conversion, and the actor's pre-turn composition.
 * Only nondeterminism (clock/ids), project resolution, and the execution-layer
 * seam are stubbed.
 *
 * Covers both routing paths end to end, and the divergence between what the
 * transcript durably records and what the agent is delivered.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createNotepadsRepo } from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { queuedBatchToSubmitPrompt } from "@/lib/conversations/message-queue-drain";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { queueMessage } from "@/lib/prompt/queue";
import {
  createPromptRouteHandlers,
  type PromptRouteDeps,
} from "@/lib/prompt/route-handlers";
import {
  composeUserTranscriptBlocks,
  resolveTurnPromptText,
} from "@/lib/workflows/conversation/pre-turn/review-feedback";
import {
  buildNotepadFeedbackPayload,
  deliverNotepadFeedback,
  type DispatchFetch,
} from "@/features/session/conversation/notepad-comment-dispatch";
import type { CollaborationManager } from "@/lib/workflows/collaboration/manager";
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";
import type { NotepadFeedbackPayload } from "@/lib/conversations/message-content-schemas";

import { createNotepadContentStore } from "./content-store";
import { createNotepadService, type NotepadService } from "./service";

const PROJECT_NAME = "proj";
const PROJECT_PATH = "/proj";
const SESSION = "sess";
const NOW = "2026-03-03T00:00:00.000Z";
const CONTENT = "# Release notes\n\nThe migration lands on Tuesday.\n";

const ANCHOR = {
  sectionId: "release-notes",
  headingLabel: "Release notes",
  line: 3,
  charStart: 4,
  charEnd: 13,
  quote: "migration",
  prefix: "The ",
  suffix: " lands",
  notepadRevision: 1,
};

let fx: PersistenceFixture;
let service: NotepadService;
let contentBase: string;

beforeEach(() => {
  fx = createPersistenceFixture();
  fx.seedProject(PROJECT_PATH);
  fx.seedSession(PROJECT_PATH, SESSION);
  const writeQueue = createWriteQueue();
  const repo = createNotepadsRepo(fx.db, writeQueue);
  const comments = createNotepadCommentsRepo(fx.db, writeQueue);
  contentBase = mkdtempSync(path.join(tmpdir(), "cc-notepad-dispatch-"));
  const contentStore = createNotepadContentStore({
    contentRoot: path.join(contentBase, "notepad-content"),
    listNotepadIdsForProject: (projectPath) => repo.listNotepadIds(projectPath),
  });
  let ids = 0;
  service = createNotepadService({
    repo,
    comments,
    publish: () => ({ delivered: true }),
    deleteNotepadContent: (notepadId) => contentStore.deleteNotepad(notepadId),
    now: () => NOW,
    generateId: () => `np-gen-${(ids += 1)}`,
  });
});

afterEach(() => {
  rmSync(contentBase, { recursive: true, force: true });
});

/**
 * Create a notepad with two comments — one open, one resolved — and build the
 * dispatch payload from what the service actually lists back.
 */
async function seedDispatchPayload(): Promise<NotepadFeedbackPayload> {
  const created = await service.create({
    scope: "global",
    projectPath: null,
    name: "Release plan",
    content: CONTENT,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  const notepadId = created.value.id;

  const open = await service.createComment(notepadId, {
    anchor: ANCHOR,
    body: "Name the owner of this migration.",
    author: { kind: "user" },
  });
  if (!open.ok) throw new Error(`comment failed: ${open.error.code}`);

  const settled = await service.createComment(notepadId, {
    anchor: ANCHOR,
    body: "Already handled — do not re-raise.",
    author: { kind: "user" },
  });
  if (!settled.ok) throw new Error(`comment failed: ${settled.error.code}`);
  const resolved = await service.setCommentStatus(notepadId, settled.value.id, {
    status: "resolved",
    author: { kind: "user" },
  });
  if (!resolved.ok) throw new Error(`resolve failed: ${resolved.error.code}`);

  const threads = await service.listComments(notepadId, {});
  if (!threads.ok) throw new Error(`list failed: ${threads.error.code}`);

  const payload = buildNotepadFeedbackPayload(
    {
      notepadId,
      name: created.value.name,
      scope: created.value.scope,
      projectName: null,
    },
    threads.value,
  );
  if (payload === null) throw new Error("expected an open comment to dispatch");
  return payload;
}

function makeConversation(id: string, status?: "running") {
  return makeConversationState({
    id,
    agentBackend: "codex",
    createdAt: NOW,
    lastActivityAt: NOW,
    ...(status ? { status } : {}),
  });
}

function target(
  conversationId: string,
  status: DocumentFeedbackTarget["status"],
): DocumentFeedbackTarget {
  return {
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    sessionName: SESSION,
    conversationId,
    backend: "codex",
    status,
  };
}

describe("notepad comment dispatch (real store)", () => {
  it("dispatches only the open comment, with its quoted context and the notepad reference", async () => {
    const payload = await seedDispatchPayload();

    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.body).toBe("Name the owner of this migration.");
    expect(payload.items[0]!.quote).toBe("migration");
    expect(payload.items[0]!.location).toContain("Release notes");
    expect(payload.notepadRefXml).toContain(
      `notepad-id="${payload.notepadId}"`,
    );
  });

  it("forwards the dispatch through the live prompt route to the execution layer", async () => {
    const payload = await seedDispatchPayload();
    fx.seedConversation(PROJECT_PATH, SESSION, makeConversation("conv-live"));

    // `executePromptStream` is the execution-layer seam, injected at the deps
    // boundary so the assertion targets what the ROUTE forwards.
    const promptDeps: PromptRouteDeps = {
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      getSession: fx.store.getSession,
      getConversation: fx.store.getConversation,
      getActiveGraphWorkflowExecution: async () => null,
      isConversationBusy: () => false,
      admitConversationTurn: async () => ({
        kind: "admit" as const,
        turnGeneration: 1,
      }),
      executePromptStream: vi.fn(),
      getCollaborationManager: () => ({}) as unknown as CollaborationManager,
      setConversationPendingPromptText: async () => {},
      clearConversationPendingPromptTextIfMatches: async () => false,
    };
    const handlers = createPromptRouteHandlers(promptDeps);

    const fetchImpl: DispatchFetch = async (url, _action, options) => {
      const res = await handlers.conversationPOST(
        new Request(`http://localhost${url}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: String(options.body),
        }),
        {
          params: Promise.resolve({
            name: PROJECT_NAME,
            session: SESSION,
            conversationId: "conv-live",
          }),
        },
      );
      // Drain the SSE stream so the handler's executePromptStream call runs.
      const reader = res.body?.getReader();
      if (reader) {
        while (!(await reader.read()).done) {
          /* drain */
        }
      }
      return new Response(null, { status: res.status });
    };

    const outcome = await deliverNotepadFeedback({
      payload,
      target: target("conv-live", "awaiting"),
      fetchImpl,
    });
    expect(outcome).toEqual({ ok: true });

    // executePromptStream(projectPath, session, prompt, emit, conversationId,
    // modelSelection, images, options) — prompt is arg 2, options is arg 7.
    const call = vi.mocked(promptDeps.executePromptStream).mock.calls[0]!;
    const agentText = call[2] as string;
    expect(agentText).toContain("Name the owner of this migration.");
    expect(agentText).toContain("migration");
    expect(agentText).toContain(payload.notepadRefXml);

    const options = call[7] as {
      notepadFeedback?: NotepadFeedbackPayload[];
    };
    expect(options.notepadFeedback).toEqual([payload]);
  });

  it("queues the dispatch to a running conversation, persisting the typed block and re-emitting it on drain", async () => {
    const payload = await seedDispatchPayload();
    fx.seedConversation(
      PROJECT_PATH,
      SESSION,
      makeConversation("conv-queued", "running"),
    );

    let idCounter = 0;
    const queueSvc = createMessageQueueService({
      mutateConversation: fx.store.mutateConversation,
      getConversation: fx.store.getConversation,
      getProjectDisplayName: () => PROJECT_NAME,
      broadcast: () => {},
      now: () => NOW,
      newId: () => `q-${(idCounter += 1)}`,
    });

    const fetchImpl: DispatchFetch = async (url, _action, options) => {
      // A running target routes to the queue endpoint.
      expect(url).toContain("/conversations/conv-queued/queue");
      const body = JSON.parse(String(options.body)) as {
        notepadFeedback: NotepadFeedbackPayload;
      };
      await queueMessage({
        projectPath: PROJECT_PATH,
        sessionName: SESSION,
        conversationId: "conv-queued",
        notepadFeedback: body.notepadFeedback,
        backend: "codex",
        deps: { enqueue: queueSvc.enqueue },
      });
      return new Response(null, { status: 200 });
    };

    const outcome = await deliverNotepadFeedback({
      payload,
      target: target("conv-queued", "running"),
      fetchImpl,
    });
    expect(outcome).toEqual({ ok: true });

    // Durable: the typed block survives the SQLite round-trip, and the row
    // carries NO prose — the agent-facing text is derived at delivery.
    const reloaded = await fx.store.getConversation(
      PROJECT_PATH,
      SESSION,
      "conv-queued",
    );
    expect(reloaded?.pendingQueue).toHaveLength(1);
    expect(reloaded?.pendingQueue[0]?.content).toEqual([
      { type: "notepad_feedback", ...payload },
    ]);

    // Drain: the claimed batch re-emits the payload, and the actor's pre-turn
    // composition derives the same agent text a live turn would deliver while
    // recording the typed block as the transcript's dispatch record.
    const batch = await queueSvc.claimNextTurnBatch({
      projectPath: PROJECT_PATH,
      sessionName: SESSION,
      conversationId: "conv-queued",
    });
    expect(batch).not.toBeNull();
    const submit = queuedBatchToSubmitPrompt(batch!.content);
    expect(submit.notepadFeedback).toEqual([payload]);

    const { effectivePromptText, isDrainedFeedbackBatch } =
      resolveTurnPromptText({
        promptText: submit.promptText,
        notepadFeedback: submit.notepadFeedback,
        isQueuedDelivery: true,
      });
    expect(effectivePromptText).toContain("Name the owner of this migration.");
    expect(effectivePromptText).toContain(payload.notepadRefXml);

    expect(
      composeUserTranscriptBlocks({
        promptText: submit.promptText,
        effectivePromptText,
        rewrittenPromptText: effectivePromptText,
        isDrainedFeedbackBatch,
        notepadFeedback: submit.notepadFeedback,
        imageRefs: [],
      }),
    ).toEqual([{ type: "notepad_feedback", ...payload }]);
  });
});
