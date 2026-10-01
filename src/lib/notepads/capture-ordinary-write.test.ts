import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createNotepadCommentsRepo } from "@/lib/state-store/notepad-comments-repo";
import { createNotepadDeliveryWatermarksRepo } from "@/lib/state-store/notepad-delivery-watermarks-repo";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { buildClipFragment } from "./capture-fragment";
import { createNotepadAcceptedContextRecorder } from "./accepted-context";
import {
  createNotepadSourceReader,
  notepadInvolvementCursor,
} from "@/lib/subscriptions/notepad-source";
import {
  createNotepadsRouteHandlers,
  type NotepadsRouteHandlers,
} from "./route-handlers";
import { createNotepadService, type NotepadService } from "./service";

/**
 * R23.3: a capture is an ordinary user content write. Nothing here is
 * capture-specific machinery — that is the point. The fragment goes in through
 * the same route a typed append would use, and the assertions are about the
 * attribution and the change notice every other user write already earns.
 */

const PROJECT_PATH = "/repos/p1";
const CONVERSATION_ID = "conv-tracking";

const FRAGMENT = buildClipFragment({
  text: "Recorded speech is never silently lost.",
  isCode: false,
  provenance: { kind: "path", path: "docs/notepad-capture.md" },
});

/** The browser capture sends no bearer token, so it resolves as the user. */
const auth: AgentAuth = {
  async requireToken() {
    return null;
  },
  async validateOptionalToken(request) {
    return request.headers.get("authorization") === null
      ? { kind: "absent" }
      : { kind: "invalid" };
  },
};

let fixture: PersistenceFixture;
let repo: NotepadsRepo;
let service: NotepadService;
let handlers: NotepadsRouteHandlers;
let tracker: ReturnType<typeof createNotepadAcceptedContextRecorder>;
let readSource: ReturnType<typeof createNotepadSourceReader>;
let watermarks: ReturnType<typeof createNotepadDeliveryWatermarksRepo>;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  repo = createNotepadsRepo(fixture.db, writeQueue);
  const comments = createNotepadCommentsRepo(fixture.db, writeQueue);
  watermarks = createNotepadDeliveryWatermarksRepo(fixture.db, writeQueue);
  let clock = 0;
  let idSeq = 0;
  const now = () => {
    clock += 1000;
    return new Date(Date.UTC(2026, 7, 31, 9, 0, 0) + clock).toISOString();
  };
  service = createNotepadService({
    repo,
    comments,
    publish: () => ({ delivered: true }),
    deleteNotepadContent: async () => {},
    now,
    generateId: () => {
      idSeq += 1;
      return `np-gen-${idSeq}`;
    },
  });
  handlers = createNotepadsRouteHandlers({
    verifyConversationIdentity: async (id) => id !== "does-not-exist",
    getService: () => service,
    resolveProjectPath: async () => PROJECT_PATH,
    auth,
  });
  tracker = createNotepadAcceptedContextRecorder({ watermarks, now });
  readSource = createNotepadSourceReader({
    notepads: repo,
    comments,
    watermarks,
  });
});

afterEach(() => {
  fixture.close();
});

/** The capture's write, through the content route exactly as the client posts it. */
async function captureThroughRoute(notepadId: string): Promise<Response> {
  return handlers.contentPOST(
    new Request(`http://localhost/api/notepads/${notepadId}/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "append", content: FRAGMENT }),
    }),
    { params: Promise.resolve({ notepadId }) },
  );
}

async function seedNotepad(): Promise<string> {
  const created = await service.create({
    scope: "project",
    projectPath: PROJECT_PATH,
    name: "Inbox",
    content: "Existing content.",
  });
  if (!created.ok) throw new Error(`seed failed: ${created.error.code}`);
  return created.value.id;
}

describe("a capture is an ordinary user write (R23.3)", () => {
  it("records a user-attributed revision with origin append", async () => {
    const notepadId = await seedNotepad();

    const response = await captureThroughRoute(notepadId);
    expect(response.status).toBe(200);

    // Reloaded through the repository, not read off the response.
    const reloaded = await repo.find(notepadId);
    expect(reloaded?.content).toBe(`Existing content.\n\n${FRAGMENT}`);

    const head = await repo.findRevision(notepadId, reloaded?.revision ?? 0);
    expect(head).toMatchObject({
      revision: 2,
      origin: "append",
      authorKind: "user",
      authorConversationId: null,
      content: `Existing content.\n\n${FRAGMENT}`,
    });
  });

  it("produces the same change notice any other content write would", async () => {
    const notepadId = await seedNotepad();
    // The conversation was shown revision 1 — its watermark predates the
    // capture, which is exactly the state a notice exists to close.
    await tracker.recordDelivered({
      conversationId: CONVERSATION_ID,
      notepads: [
        {
          notepadId,
          revision: 1,
          openComments: { count: 0, latestCreatedAt: null },
        },
      ],
    });

    await captureThroughRoute(notepadId);

    const seen = (await watermarks.listForConversation(CONVERSATION_ID))[0];
    if (!seen) throw new Error("Expected accepted source context");
    const notice = await readSource(
      { projectPath: PROJECT_PATH, conversationId: CONVERSATION_ID },
      { kind: "notepad", id: notepadId },
      notepadInvolvementCursor(seen),
    );
    expect(notice.facts).toMatchObject([
      {
        eventKind: "notepad-content-revised",
        sourceTitle: "Inbox",
        revision: "2",
        actorConversationId: null,
        retrievalHandle: `cctl notepad get -- '${notepadId}'`,
      },
    ]);
    const evidence: unknown = JSON.parse(notice.facts[0]?.sourceText ?? "null");
    expect(evidence).toMatchObject({
      notepadId,
      revision: { revision: 2, origin: "append", authorKind: "user" },
    });
    expect(evidence).not.toHaveProperty("revision.content");
    expect((await repo.findRevision(notepadId, 2))?.content).toBe(
      `Existing content.\n\n${FRAGMENT}`,
    );
  });

  it("raises no notice for a conversation already at the captured revision", async () => {
    const notepadId = await seedNotepad();
    await captureThroughRoute(notepadId);
    await tracker.recordDelivered({
      conversationId: CONVERSATION_ID,
      notepads: [
        {
          notepadId,
          revision: 2,
          openComments: { count: 0, latestCreatedAt: null },
        },
      ],
    });

    const seen = (await watermarks.listForConversation(CONVERSATION_ID))[0];
    if (!seen) throw new Error("Expected accepted source context");
    expect(
      (
        await readSource(
          { projectPath: PROJECT_PATH, conversationId: CONVERSATION_ID },
          { kind: "notepad", id: notepadId },
          notepadInvolvementCursor(seen),
        )
      ).facts,
    ).toEqual([]);
  });
});
