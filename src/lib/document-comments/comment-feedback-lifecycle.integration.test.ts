/**
 * Integration tests for the document-comment + feedback lifecycle (task 9.1).
 *
 * Everything here runs over a REAL persistence fixture (`createPersistenceFixture`
 * — real repos over a fresh `:memory:` SQLite DB) and the REAL production
 * orchestration (the document-comments route handlers, the prompt route handler,
 * `deliverFeedback`, `queueMessage`, the message-queue service, and the drain
 * conversion). The only stubbed boundaries are nondeterminism (clock/id) and
 * filesystem-backed project resolution — never the persistence or the logic
 * under test. So a value that is silently dropped on the SQLite round-trip, a
 * sent comment that fails to revert on edit, a missing feedback block, a dropped
 * queued payload, or an out-of-scope mutation all fail a test here rather than
 * escaping to live verification.
 *
 * Covers, end to end:
 *  - create / edit / delete (with full-field round-trip durability)
 *  - sent → pending on editing a sent comment (sentAt cleared, persisted)
 *  - bulk-send marks ALL selected comments sent (one submission)
 *  - clear removes ONLY pending comments
 *  - immediate-send records a `document_feedback` block + derived agent text
 *    (and is unchanged without the payload)
 *  - the queue path persists the payload and re-emits a block on drain
 *  - ownership scoping: a cross-scope PATCH/DELETE returns 404 and mutates nothing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createDocumentCommentsRouteHandlers,
  type DocumentCommentsRouteDeps,
} from "./route-handlers";
import {
  createPromptRouteHandlers,
  type PromptRouteDeps,
} from "@/lib/prompt/route-handlers";
import {
  buildFeedbackItems,
  deliverFeedback,
  type FeedbackFetch,
} from "@/features/session/document-viewer/use-send-document-feedback";
import { formatDocumentFeedbackPrompt } from "./format-feedback";
import { queueMessage } from "@/lib/prompt/queue";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { queuedBatchToSubmitPrompt } from "@/lib/conversations/message-queue-drain";
import { buildUserTranscriptBlocks } from "@/lib/workflows/conversation/build-user-transcript-blocks";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { CollaborationManager } from "@/lib/workflows/collaboration/manager";
import type {
  CommentAnchor,
  DocumentComment,
  DocumentFeedbackPayload,
  DocumentFeedbackTarget,
  DocumentRef,
} from "./schemas";

// ---------------------------------------------------------------------------
// Fixed scope + builders
// ---------------------------------------------------------------------------

const PROJECT_NAME = "proj";
const PROJECT_PATH = "/proj";
/** The session that OWNS the document and its comments. */
const DOC_SESSION = "doc-sess";
/** A DIFFERENT session that holds the send target — proves cross-session send. */
const TARGET_SESSION = "target-sess";
const DOC_PATH = "docs/guide.md";
const NOW = "2026-03-03T00:00:00.000Z";

function anchor(overrides: Partial<CommentAnchor> = {}): CommentAnchor {
  return {
    sectionId: "overview",
    headingLabel: "1. Overview",
    line: 12,
    charStart: 4,
    charEnd: 18,
    quote: "selected words",
    prefix: "the ",
    suffix: " here",
    docRevision: "rev-1",
    ...overrides,
  };
}

const DOC_REF: DocumentRef = {
  projectName: PROJECT_NAME,
  sessionName: DOC_SESSION,
  docPath: DOC_PATH,
  title: "Guide",
};

function makeConversation(
  id: string,
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return conversationStateSchema.parse({
    id,
    transcriptPath: null,
    status: "awaiting",
    role: null,
    agentBackend: "codex",
    promptCount: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Comment route handlers over the fixture (only id/clock + project resolution
// are stubbed — the filesystem/nondeterminism boundaries).
// ---------------------------------------------------------------------------

function commentDeps(
  fx: PersistenceFixture,
  ids: readonly string[],
): DocumentCommentsRouteDeps {
  let i = 0;
  return {
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    getSession: fx.store.getSession,
    getDocumentComments: fx.store.getDocumentComments,
    getDocumentCommentInScope: fx.store.getDocumentCommentInScope,
    upsertDocumentComment: fx.store.upsertDocumentComment,
    deleteDocumentComment: fx.store.deleteDocumentComment,
    now: () => NOW,
    newId: () => ids[i++] ?? `auto-${i}`,
  };
}

interface CommentApi {
  create(
    session: string,
    body: { docPath: string; anchor: CommentAnchor; note: string },
  ): Promise<{ status: number; comment: DocumentComment }>;
  patch(
    session: string,
    id: string,
    body: { note?: string; status?: "pending" | "sent" },
  ): Promise<{ status: number; comment: DocumentComment }>;
  remove(session: string, id: string): Promise<{ status: number }>;
  list(session: string, docPath: string): Promise<DocumentComment[]>;
}

function commentApi(handlers: {
  POST: (
    r: Request,
    c: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
  PATCH: (
    r: Request,
    c: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
  DELETE: (
    r: Request,
    c: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
  GET: (
    r: Request,
    c: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
}): CommentApi {
  const base = (session: string) =>
    `http://localhost/api/projects/${PROJECT_NAME}/sessions/${session}/document-comments`;
  return {
    async create(session, body) {
      const res = await handlers.POST(
        new Request(base(session), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ name: PROJECT_NAME, session }) },
      );
      return { status: res.status, comment: await res.json() };
    },
    async patch(session, id, body) {
      const res = await handlers.PATCH(
        new Request(`${base(session)}/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ name: PROJECT_NAME, session, id }) },
      );
      return { status: res.status, comment: await res.json() };
    },
    async remove(session, id) {
      const res = await handlers.DELETE(
        new Request(`${base(session)}/${id}`, { method: "DELETE" }),
        { params: Promise.resolve({ name: PROJECT_NAME, session, id }) },
      );
      return { status: res.status };
    },
    async list(session, docPath) {
      const res = await handlers.GET(
        new Request(`${base(session)}?docPath=${encodeURIComponent(docPath)}`),
        { params: Promise.resolve({ name: PROJECT_NAME, session }) },
      );
      return res.json();
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("document comment + feedback lifecycle (real store)", () => {
  let fx: PersistenceFixture;

  beforeEach(() => {
    fx = createPersistenceFixture();
    fx.seedProject(PROJECT_PATH);
    fx.seedSession(PROJECT_PATH, DOC_SESSION);
    fx.seedSession(PROJECT_PATH, TARGET_SESSION);
  });

  afterEach(() => {
    fx.close();
  });

  // -------------------------------------------------------------------------
  // create / edit / delete + full-field round-trip durability
  // -------------------------------------------------------------------------

  it("creates, edits, and deletes a comment, round-tripping every field through SQLite", async () => {
    const api = commentApi(
      createDocumentCommentsRouteHandlers(commentDeps(fx, ["c1"])),
    );

    const created = await api.create(DOC_SESSION, {
      docPath: DOC_PATH,
      anchor: anchor(),
      note: "tighten this heading",
    });
    expect(created.status).toBe(201);

    // Re-read straight from the store: every persisted field must survive the
    // repo ↔ SQLite serialization round-trip (fails if any field is dropped).
    const [persisted] = await fx.store.getDocumentComments(
      PROJECT_PATH,
      DOC_SESSION,
      DOC_PATH,
    );
    expect(persisted).toEqual({
      id: "c1",
      projectPath: PROJECT_PATH,
      sessionName: DOC_SESSION,
      docPath: DOC_PATH,
      anchor: anchor(),
      note: "tighten this heading",
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
      sentAt: null,
    });

    // Edit the note.
    const edited = await api.patch(DOC_SESSION, "c1", {
      note: "reworded note",
    });
    expect(edited.status).toBe(200);
    const [afterEdit] = await fx.store.getDocumentComments(
      PROJECT_PATH,
      DOC_SESSION,
      DOC_PATH,
    );
    expect(afterEdit?.note).toBe("reworded note");
    expect(afterEdit?.status).toBe("pending");

    // Delete it.
    const removed = await api.remove(DOC_SESSION, "c1");
    expect(removed.status).toBe(200);
    expect(
      await fx.store.getDocumentComments(PROJECT_PATH, DOC_SESSION, DOC_PATH),
    ).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // sent → pending on editing a sent comment
  // -------------------------------------------------------------------------

  it("reverts a sent comment to pending (clearing sentAt) when its note is edited", async () => {
    const api = commentApi(
      createDocumentCommentsRouteHandlers(commentDeps(fx, ["c1"])),
    );
    await api.create(DOC_SESSION, {
      docPath: DOC_PATH,
      anchor: anchor(),
      note: "first",
    });

    // Mark it sent (stamps sentAt).
    await api.patch(DOC_SESSION, "c1", { status: "sent" });
    const [sent] = await fx.store.getDocumentComments(
      PROJECT_PATH,
      DOC_SESSION,
      DOC_PATH,
    );
    expect(sent?.status).toBe("sent");
    expect(sent?.sentAt).toBe(NOW);

    // The card emits {note, status:"pending"} when a SENT comment's text
    // changes (the decision is unit-tested in CommentCard.test.tsx). Persisting
    // that update must flip the comment back to pending AND clear sentAt.
    await api.patch(DOC_SESSION, "c1", { note: "changed", status: "pending" });
    const [reverted] = await fx.store.getDocumentComments(
      PROJECT_PATH,
      DOC_SESSION,
      DOC_PATH,
    );
    expect(reverted?.status).toBe("pending");
    expect(reverted?.sentAt).toBeNull();
    expect(reverted?.note).toBe("changed");
  });

  // -------------------------------------------------------------------------
  // ownership scoping
  // -------------------------------------------------------------------------

  it("returns 404 and mutates nothing when a PATCH/DELETE targets a comment from another scope", async () => {
    const api = commentApi(
      createDocumentCommentsRouteHandlers(commentDeps(fx, ["c1"])),
    );
    await api.create(DOC_SESSION, {
      docPath: DOC_PATH,
      anchor: anchor(),
      note: "owned by doc-sess",
    });

    // The route addresses TARGET_SESSION but the id belongs to DOC_SESSION.
    const hijackPatch = await api.patch(TARGET_SESSION, "c1", {
      note: "hijacked",
      status: "sent",
    });
    expect(hijackPatch.status).toBe(404);

    const hijackDelete = await api.remove(TARGET_SESSION, "c1");
    expect(hijackDelete.status).toBe(404);

    // The original comment is untouched.
    const [unchanged] = await fx.store.getDocumentComments(
      PROJECT_PATH,
      DOC_SESSION,
      DOC_PATH,
    );
    expect(unchanged?.note).toBe("owned by doc-sess");
    expect(unchanged?.status).toBe("pending");
    expect(unchanged?.sentAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // bulk-send marks ALL selected comments sent
  // -------------------------------------------------------------------------

  it("bulk-send delivers all selected comments as one submission and flips them all to sent", async () => {
    fx.seedConversation(
      PROJECT_PATH,
      TARGET_SESSION,
      makeConversation("target-conv"),
    );
    const api = commentApi(
      createDocumentCommentsRouteHandlers(commentDeps(fx, ["c1", "c2", "c3"])),
    );

    const ids = ["c1", "c2", "c3"];
    const created: DocumentComment[] = [];
    for (const [n, id] of ids.entries()) {
      const r = await api.create(DOC_SESSION, {
        docPath: DOC_PATH,
        anchor: anchor({ line: 10 + n, quote: `passage ${id}` }),
        note: `note ${id}`,
      });
      expect(r.comment.id).toBe(id);
      created.push(r.comment);
    }

    const target: DocumentFeedbackTarget = {
      projectName: PROJECT_NAME,
      projectPath: PROJECT_PATH,
      sessionName: TARGET_SESSION,
      conversationId: "target-conv",
      backend: "codex",
      status: "awaiting", // not running → immediate (prompt) send
    };

    const calls: Array<{
      url: string;
      body: { documentFeedback?: DocumentFeedbackPayload };
    }> = [];
    const fetchImpl: FeedbackFetch = async (url, _action, options) => {
      calls.push({ url, body: JSON.parse(String(options.body)) });
      return new Response(null, { status: 200 });
    };

    const items = buildFeedbackItems(created);
    const outcome = await deliverFeedback({
      docRef: DOC_REF,
      target,
      text: formatDocumentFeedbackPrompt(items),
      payload: { items },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);

    // Exactly ONE submission, carrying every selected comment, to the target's
    // own conversation prompt endpoint (cross-session).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(
      `/sessions/${TARGET_SESSION}/conversations/target-conv/prompt`,
    );
    expect(calls[0]!.body.documentFeedback?.items).toHaveLength(3);

    // The hook's success path then marks every delivered comment sent (the
    // route PATCH persists each over the real store).
    await Promise.all(
      created.map((c) => api.patch(DOC_SESSION, c.id, { status: "sent" })),
    );
    const stored = await fx.store.getDocumentComments(
      PROJECT_PATH,
      DOC_SESSION,
      DOC_PATH,
    );
    expect(stored).toHaveLength(3);
    expect(stored.every((c) => c.status === "sent")).toBe(true);
    expect(stored.every((c) => c.sentAt === NOW)).toBe(true);
  });

  it("queues the feedback (persisting the payload) when the target is running", async () => {
    fx.seedConversation(
      PROJECT_PATH,
      TARGET_SESSION,
      makeConversation("running-conv", {
        status: "running",
        agentBackend: "codex",
      }),
    );

    // The queue branch routes through the REAL queueMessage + a fixture-backed
    // message-queue service so the payload actually persists to SQLite.
    let idCounter = 0;
    const queueSvc = createMessageQueueService({
      mutateConversation: fx.store.mutateConversation,
      getConversation: fx.store.getConversation,
      getProjectDisplayName: () => PROJECT_NAME,
      broadcast: () => {},
      now: () => NOW,
      newId: () => `q-${(idCounter += 1)}`,
    });

    const target: DocumentFeedbackTarget = {
      projectName: PROJECT_NAME,
      projectPath: PROJECT_PATH,
      sessionName: TARGET_SESSION,
      conversationId: "running-conv",
      backend: "codex",
      status: "running",
    };

    const fetchImpl: FeedbackFetch = async (url, _action, options) => {
      // deliverFeedback routes a running target to `.../queue`.
      expect(url).toContain("/conversations/running-conv/queue");
      const body = JSON.parse(String(options.body)) as {
        text: string;
        documentFeedback: DocumentFeedbackPayload;
      };
      await queueMessage({
        projectPath: PROJECT_PATH,
        sessionName: TARGET_SESSION,
        conversationId: "running-conv",
        text: body.text,
        documentFeedback: body.documentFeedback,
        backend: "codex",
        deps: { enqueue: queueSvc.enqueue },
      });
      return new Response(null, { status: 200 });
    };

    const items = buildFeedbackItems([
      {
        id: "c1",
        projectPath: PROJECT_PATH,
        sessionName: DOC_SESSION,
        docPath: DOC_PATH,
        anchor: anchor(),
        note: "please reconsider",
        status: "pending",
        createdAt: NOW,
        updatedAt: NOW,
        sentAt: null,
      },
    ]);
    const outcome = await deliverFeedback({
      docRef: DOC_REF,
      target,
      text: formatDocumentFeedbackPrompt(items),
      payload: { items },
      fetchImpl,
    });
    expect(outcome.ok).toBe(true);

    // The durable, reloaded queue entry carries the structured feedback block.
    const reloaded = await fx.store.getConversation(
      PROJECT_PATH,
      TARGET_SESSION,
      "running-conv",
    );
    expect(reloaded?.pendingQueue).toHaveLength(1);
    expect(reloaded?.pendingQueue[0]?.content).toEqual([
      { type: "document_feedback", items },
    ]);
  });

  // -------------------------------------------------------------------------
  // clear removes ONLY pending comments
  // -------------------------------------------------------------------------

  it("clearing pending comments removes only the pending ones, leaving sent comments", async () => {
    const api = commentApi(
      createDocumentCommentsRouteHandlers(commentDeps(fx, ["c1", "c2", "c3"])),
    );
    for (const id of ["c1", "c2", "c3"]) {
      await api.create(DOC_SESSION, {
        docPath: DOC_PATH,
        anchor: anchor(),
        note: `note ${id}`,
      });
    }
    // c2 is already sent; c1 and c3 stay pending.
    await api.patch(DOC_SESSION, "c2", { status: "sent" });

    // The tray's Clear deletes each PENDING comment (sent ones are left).
    const before = await api.list(DOC_SESSION, DOC_PATH);
    const pending = before.filter((c) => c.status === "pending");
    expect(pending.map((c) => c.id).sort()).toEqual(["c1", "c3"]);
    for (const c of pending) {
      await api.remove(DOC_SESSION, c.id);
    }

    const remaining = await fx.store.getDocumentComments(
      PROJECT_PATH,
      DOC_SESSION,
      DOC_PATH,
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe("c2");
    expect(remaining[0]?.status).toBe("sent");
  });

  // -------------------------------------------------------------------------
  // immediate-send records a document_feedback block + derived agent text
  // (and is unchanged without the payload)
  // -------------------------------------------------------------------------

  it("forwards documentFeedback through the conversation prompt route to the execution layer", async () => {
    fx.seedConversation(
      PROJECT_PATH,
      DOC_SESSION,
      makeConversation("conv-immediate"),
    );

    // `executePromptStream` is the execution-layer seam — injected as a test
    // double at the deps boundary (the codebase's DI pattern; mirrors
    // prompt/route-handlers.test.ts) so the assertion targets what the ROUTE
    // forwards, not the actor's internals.
    const promptDeps: PromptRouteDeps = {
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      getSession: fx.store.getSession,
      getConversation: fx.store.getConversation,
      getActiveGraphWorkflowExecution: async () => null,
      isConversationBusy: () => false,
      executePromptStream: vi.fn(),
      getCollaborationManager: () => ({}) as unknown as CollaborationManager,
      setConversationPendingPromptText: async () => {},
      clearConversationPendingPromptTextIfMatches: async (
        projectPath,
        sessionName,
        conversationId,
        expectedText,
      ) =>
        fx.store.mutateConversation(
          projectPath,
          sessionName,
          conversationId,
          "test.pending.clear_if_matches",
          (conversation) => {
            if (conversation.pendingPromptText !== expectedText) return false;
            conversation.pendingPromptText = null;
            return true;
          },
        ),
    };
    const handlers = createPromptRouteHandlers(promptDeps);

    const payload: DocumentFeedbackPayload = {
      items: [
        {
          docPath: DOC_PATH,
          path: DOC_PATH,
          headingLabel: "1. Overview",
          line: 12,
          quote: "selected words",
          note: "please reconsider this section",
        },
      ],
    };

    async function send(body: unknown): Promise<void> {
      const res = await handlers.conversationPOST(
        new Request(
          `http://localhost/api/projects/${PROJECT_NAME}/sessions/${DOC_SESSION}/conversations/conv-immediate/prompt`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        ),
        {
          params: Promise.resolve({
            name: PROJECT_NAME,
            session: DOC_SESSION,
            conversationId: "conv-immediate",
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
    }

    await send({
      prompt: formatDocumentFeedbackPrompt(payload.items),
      documentFeedback: payload,
    });
    await send({ prompt: "just a normal prompt" });

    // `executePromptStream(projectPath, session, prompt, emit, conversationId,
    // modelId, images, options)` — prompt is arg 2, options (carrying
    // documentFeedback) is arg 7.
    const calls = vi.mocked(promptDeps.executePromptStream).mock.calls;
    expect(calls).toHaveLength(2);

    const withPayload = calls[0]![7] as {
      documentFeedback?: DocumentFeedbackPayload;
    };
    expect(withPayload.documentFeedback).toEqual(payload);
    expect(calls[0]![2]).toContain("selected words");

    const withoutPayload = calls[1]![7] as {
      documentFeedback?: DocumentFeedbackPayload;
    };
    expect(withoutPayload.documentFeedback).toBeUndefined();
  });

  it("records a document_feedback block + derived text on the user turn, and a plain text turn without the payload", () => {
    // The exact transform the immediate-send actor path applies: an empty
    // transcript text + the payload yields the card-only block, and the
    // agent-facing prose is derived from the items. (executePromptForMachine
    // composes exactly these two production functions.)
    const items = [
      {
        docPath: DOC_PATH,
        path: DOC_PATH,
        headingLabel: "1. Overview",
        line: 12,
        quote: "selected words",
        note: "reconsider",
      },
    ];

    expect(
      buildUserTranscriptBlocks({
        rewrittenPromptText: "",
        imageRefs: [],
        documentFeedback: { items },
      }),
    ).toEqual([{ type: "document_feedback", items }]);

    const derived = formatDocumentFeedbackPrompt(items);
    expect(derived).toContain(DOC_PATH);
    expect(derived).toContain("1. Overview");
    expect(derived).toContain("L12");
    expect(derived).toContain("selected words");
    expect(derived).toContain("reconsider");

    // Without a payload the user turn is an ordinary text block — no feedback.
    expect(
      buildUserTranscriptBlocks({
        rewrittenPromptText: "hello world",
        imageRefs: [],
      }),
    ).toEqual([{ type: "text", text: "hello world" }]);
  });

  // -------------------------------------------------------------------------
  // queue path persists the payload + re-emits a block on drain
  // -------------------------------------------------------------------------

  it("persists the queued feedback payload through SQLite and re-emits a document_feedback block on drain", async () => {
    fx.seedConversation(
      PROJECT_PATH,
      DOC_SESSION,
      makeConversation("conv-queue"),
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

    const payload: DocumentFeedbackPayload = {
      items: [
        {
          docPath: DOC_PATH,
          path: DOC_PATH,
          headingLabel: "1. Overview",
          line: 12,
          quote: "the exact quoted passage",
          note: "queued feedback note",
        },
      ],
    };

    // Real enqueue orchestration (codex → next_turn, no live runtime needed).
    await queueMessage({
      projectPath: PROJECT_PATH,
      sessionName: DOC_SESSION,
      conversationId: "conv-queue",
      text: formatDocumentFeedbackPrompt(payload.items),
      documentFeedback: payload,
      backend: "codex",
      deps: { enqueue: queueSvc.enqueue },
    });

    // Persisted: the durable entry carries the structured block (no duplicate
    // prose text block) and survives the reload from SQLite.
    const reloaded = await fx.store.getConversation(
      PROJECT_PATH,
      DOC_SESSION,
      "conv-queue",
    );
    expect(reloaded?.pendingQueue).toHaveLength(1);
    expect(reloaded?.pendingQueue[0]?.content).toEqual([
      { type: "document_feedback", items: payload.items },
    ]);

    // Drain: the claimed batch re-emits the payload so the submit carries it.
    const batch = await queueSvc.claimNextTurnBatch({
      projectPath: PROJECT_PATH,
      sessionName: DOC_SESSION,
      conversationId: "conv-queue",
    });
    expect(batch).not.toBeNull();
    const submit = queuedBatchToSubmitPrompt(batch!.content);
    expect(submit.documentFeedback).toEqual({ items: payload.items });
  });

  it("a queued plain-text message carries no documentFeedback on drain (negative control)", async () => {
    fx.seedConversation(
      PROJECT_PATH,
      DOC_SESSION,
      makeConversation("conv-plain"),
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

    await queueMessage({
      projectPath: PROJECT_PATH,
      sessionName: DOC_SESSION,
      conversationId: "conv-plain",
      text: "an ordinary follow-up",
      backend: "codex",
      deps: { enqueue: queueSvc.enqueue },
    });

    const batch = await queueSvc.claimNextTurnBatch({
      projectPath: PROJECT_PATH,
      sessionName: DOC_SESSION,
      conversationId: "conv-plain",
    });
    const submit = queuedBatchToSubmitPrompt(batch!.content);
    expect(submit.documentFeedback).toBeUndefined();
    expect(submit.promptText).toBe("an ordinary follow-up");
  });
});
