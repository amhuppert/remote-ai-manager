import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import type { ConversationAttachmentPayload } from "@/lib/tickets/schemas";
import { _createTestDb } from "./state-db";
import { createTicketsRepo, type TicketsRepo } from "./tickets-repo";
import { createWriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const TICKET_ID = "ticket-snapshot-cas";
const ATTACHMENT_ID = "conversation-snapshot";
const CREATED_AT = "2026-07-01T00:00:00.000Z";

const pendingPayload: ConversationAttachmentPayload = {
  kind: "conversation",
  projectPath: PROJECT_PATH,
  sessionName: "csm/origin",
  conversationId: "conversation-1",
  snapshotKey: null,
  snapshotCapturedAt: null,
  snapshotStatus: "pending",
};

function capturedPayload(
  snapshotKey: string,
  capturedAt: string,
): ConversationAttachmentPayload {
  return {
    ...pendingPayload,
    snapshotKey,
    snapshotCapturedAt: capturedAt,
    snapshotStatus: "captured",
  };
}

let db: Db;
let repo: TicketsRepo;

async function createTicketWithPendingSnapshot() {
  return repo.createWithAttachments(
    {
      id: TICKET_ID,
      projectPath: PROJECT_PATH,
      title: "Snapshot races",
      description: "",
      workType: "bug",
      status: "not_started",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    [
      {
        id: ATTACHMENT_ID,
        ticketId: TICKET_ID,
        description: "Originating conversation",
        payload: pendingPayload,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
  );
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  repo = createTicketsRepo(db, createWriteQueue());
});

afterEach(() => {
  db.close();
});

describe("compareAndSwapConversationSnapshot", () => {
  it("wins an exact-payload swap and advances the attachment and parent revision", async () => {
    await createTicketWithPendingSnapshot();
    const captured = capturedPayload(
      `${TICKET_ID}/${ATTACHMENT_ID}/winner.md`,
      "2026-07-02T00:00:00.000Z",
    );

    const result = await repo.compareAndSwapConversationSnapshot({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      previousPayload: pendingPayload,
      payload: captured,
      updatedAt: "2026-07-02T01:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "won",
      ticketUpdatedAt: "2026-07-02T01:00:00.000Z",
      attachment: {
        id: ATTACHMENT_ID,
        payload: captured,
        updatedAt: "2026-07-02T01:00:00.000Z",
      },
    });
    const detail = await repo.find(PROJECT_PATH, 1);
    expect(detail?.updatedAt).toBe("2026-07-02T01:00:00.000Z");
    expect(detail?.attachments[0]?.payload).toEqual(captured);
    expect(detail?.attachments[0]?.updatedAt).toBe(detail?.updatedAt);
  });

  it("loses against a newer payload and leaves both revisions unchanged", async () => {
    await createTicketWithPendingSnapshot();
    const winner = capturedPayload(
      `${TICKET_ID}/${ATTACHMENT_ID}/winner.md`,
      "2026-07-02T00:00:00.000Z",
    );
    await repo.compareAndSwapConversationSnapshot({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      previousPayload: pendingPayload,
      payload: winner,
      updatedAt: "2026-07-02T01:00:00.000Z",
    });
    const loser = capturedPayload(
      `${TICKET_ID}/${ATTACHMENT_ID}/loser.md`,
      "2026-07-03T00:00:00.000Z",
    );

    const result = await repo.compareAndSwapConversationSnapshot({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      previousPayload: pendingPayload,
      payload: loser,
      updatedAt: "2026-07-03T01:00:00.000Z",
    });

    expect(result).toEqual({ status: "lost", currentPayload: winner });
    const detail = await repo.find(PROJECT_PATH, 1);
    expect(detail?.updatedAt).toBe("2026-07-02T01:00:00.000Z");
    expect(detail?.attachments[0]?.payload).toEqual(winner);
    expect(detail?.attachments[0]?.updatedAt).toBe("2026-07-02T01:00:00.000Z");
  });

  it("returns missing for a removed attachment without advancing the parent revision", async () => {
    const detail = await createTicketWithPendingSnapshot();
    await repo.deleteAttachment({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const before = await repo.find(PROJECT_PATH, detail.number);

    const result = await repo.compareAndSwapConversationSnapshot({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      previousPayload: pendingPayload,
      payload: capturedPayload(
        `${TICKET_ID}/${ATTACHMENT_ID}/orphan.md`,
        "2026-07-03T00:00:00.000Z",
      ),
      updatedAt: "2026-07-03T01:00:00.000Z",
    });

    expect(result).toEqual({ status: "missing" });
    const after = await repo.find(PROJECT_PATH, detail.number);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.attachments).toEqual([]);
  });
});
