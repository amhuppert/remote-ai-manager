import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logger,
}));

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { conversationReadCommands } from "./attachment-commands";
import {
  createTicketContentStore,
  TicketContentError,
  type TicketContentStore,
} from "./content-store";
import {
  createTicketMaterializer,
  type TicketMaterializer,
} from "./materializer";
import type { TicketAttachment } from "./schemas";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const NOTE_ATTACHMENT_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const PROJECT_PATH = "/projects/demo";
const SESSION_NAME = "ticket-7-demo-1";
const TICKET_NUMBER = 7;

let base: string;
let contentRoot: string;
let worktreePath: string;
let store: TicketContentStore;
let registered: Array<{
  projectPath: string;
  sessionName: string;
  filePath: string;
  description: string;
}>;
let materializer: TicketMaterializer;

beforeEach(async () => {
  vi.clearAllMocks();
  base = await mkdtemp(path.join(tmpdir(), "cc-ticket-materializer-"));
  contentRoot = path.join(base, "ticket-content");
  worktreePath = path.join(base, "worktree");
  store = createTicketContentStore({
    contentRoot,
    listTicketIdsForProject: () => Promise.resolve([]),
  });
  registered = [];
  materializer = createTicketMaterializer({
    contentStore: store,
    registerReferenceDocument(projectPath, sessionName, filePath, description) {
      registered.push({ projectPath, sessionName, filePath, description });
      return Promise.resolve();
    },
  });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function baseAttachment(
  id: string,
  description: string,
  payload: TicketAttachment["payload"],
): TicketAttachment {
  return {
    id,
    ticketId: TICKET_ID,
    description,
    payload,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

async function captureFileAttachment(
  bytes: Uint8Array,
  fileName = "notes.txt",
): Promise<TicketAttachment> {
  const snapshot = await store.capture({
    ticketId: TICKET_ID,
    attachmentId: FILE_ATTACHMENT_ID,
    fileName,
    bytes,
  });
  return baseAttachment(FILE_ATTACHMENT_ID, "captured design notes", {
    kind: "file",
    fileName: snapshot.fileName,
    snapshotKey: snapshot.snapshotKey,
    mediaType: "text/plain",
    sizeBytes: snapshot.sizeBytes,
    sha256: snapshot.sha256,
  });
}

async function captureConversationAttachment(
  markdown: string,
): Promise<TicketAttachment> {
  const snapshot = await store.captureText({
    ticketId: TICKET_ID,
    attachmentId: CONVERSATION_ATTACHMENT_ID,
    fileName: `compaction-${CONVERSATION_ID}.md`,
    text: markdown,
  });
  return baseAttachment(
    CONVERSATION_ATTACHMENT_ID,
    "prior investigation conversation",
    {
      kind: "conversation",
      projectPath: PROJECT_PATH,
      sessionName: "older-session",
      conversationId: CONVERSATION_ID,
      snapshotKey: snapshot.snapshotKey,
      snapshotCapturedAt: "2026-07-09T12:00:00.000Z",
      snapshotStatus: "captured",
    },
  );
}

function materialize(attachments: TicketAttachment[]) {
  return materializer.materialize({
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    worktreePath,
    ticketNumber: TICKET_NUMBER,
    attachments,
  });
}

describe("createTicketMaterializer", () => {
  it("materializes a file attachment at the stable ticket path with snapshot-identical content", async () => {
    const bytes = Buffer.from("immutable snapshot body", "utf8");
    const attachment = await captureFileAttachment(bytes);

    const result = await materialize([attachment]);

    const relativePath = `.cc/tickets/${TICKET_NUMBER}/files/${FILE_ATTACHMENT_ID}-notes.txt`;
    expect(result).toEqual([
      {
        attachmentId: FILE_ATTACHMENT_ID,
        kind: "file",
        relativePath,
      },
    ]);
    const written = await readFile(path.join(worktreePath, relativePath));
    expect(Buffer.from(written).equals(bytes)).toBe(true);
  });

  it("registers every materialized file as a reference document carrying the attachment description", async () => {
    const fileAttachment = await captureFileAttachment(
      Buffer.from("file body", "utf8"),
    );
    const conversationAttachment = await captureConversationAttachment(
      "## Agent brief\ncontext",
    );

    await materialize([fileAttachment, conversationAttachment]);

    expect(registered).toEqual([
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        filePath: `.cc/tickets/${TICKET_NUMBER}/files/${FILE_ATTACHMENT_ID}-notes.txt`,
        description: "captured design notes",
      },
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        filePath: `.cc/tickets/${TICKET_NUMBER}/conversations/${CONVERSATION_ATTACHMENT_ID}-${CONVERSATION_ID}.md`,
        description: "prior investigation conversation",
      },
    ]);
  });

  it("writes conversation markdown from the snapshot with source-transcript read commands", async () => {
    const snapshotMarkdown = "## Agent brief\nThe compaction snapshot body";
    const attachment = await captureConversationAttachment(snapshotMarkdown);

    const result = await materialize([attachment]);

    const relativePath = `.cc/tickets/${TICKET_NUMBER}/conversations/${CONVERSATION_ATTACHMENT_ID}-${CONVERSATION_ID}.md`;
    expect(result).toEqual([
      {
        attachmentId: CONVERSATION_ATTACHMENT_ID,
        kind: "conversation",
        relativePath,
      },
    ]);
    const markdown = await readFile(
      path.join(worktreePath, relativePath),
      "utf8",
    );
    expect(markdown).toContain(snapshotMarkdown);
    expect(markdown).toContain(CONVERSATION_ID);
    expect(markdown).toContain("2026-07-09T12:00:00.000Z");
    for (const command of conversationReadCommands(CONVERSATION_ID, {
      projectName: "demo",
      sessionName: "older-session",
    })) {
      expect(markdown).toContain(command);
    }
  });

  it.each([
    { status: "pending" as const, error: undefined },
    {
      status: "failed" as const,
      error: "Conversation snapshot capture failed.",
    },
  ])(
    "skips a $status conversation and still materializes captured siblings",
    async ({ status, error }) => {
      const unavailable = baseAttachment(
        "99999999-9999-4999-8999-999999999999",
        "unavailable conversation",
        {
          kind: "conversation",
          projectPath: PROJECT_PATH,
          sessionName: "older-session",
          conversationId: "66666666-6666-4666-8666-666666666666",
          snapshotKey: null,
          snapshotCapturedAt: null,
          snapshotStatus: status,
          ...(error === undefined ? {} : { snapshotError: error }),
        },
      );
      const captured = await captureConversationAttachment("## Captured body");

      const result = await materialize([unavailable, captured]);

      const relativePath = `.cc/tickets/${TICKET_NUMBER}/conversations/${CONVERSATION_ATTACHMENT_ID}-${CONVERSATION_ID}.md`;
      expect(result).toEqual([
        {
          attachmentId: CONVERSATION_ATTACHMENT_ID,
          kind: "conversation",
          relativePath,
        },
      ]);
      expect(registered.map((entry) => entry.filePath)).toEqual([relativePath]);
      const written = await readdir(
        path.join(worktreePath, `.cc/tickets/${TICKET_NUMBER}/conversations`),
      );
      expect(written).toEqual([
        `${CONVERSATION_ATTACHMENT_ID}-${CONVERSATION_ID}.md`,
      ]);
      expect(logger.info).toHaveBeenCalledWith(
        "materialize.completed",
        expect.objectContaining({ conversationCount: 1, skippedCount: 1 }),
      );
    },
  );

  it("skips note, session, and related-ticket attachments without writes or registrations", async () => {
    const attachments: TicketAttachment[] = [
      baseAttachment(NOTE_ATTACHMENT_ID, "a note", {
        kind: "note",
        markdown: "note body",
      }),
      baseAttachment("66666666-6666-4666-8666-666666666666", "a session", {
        kind: "session",
        projectPath: PROJECT_PATH,
        sessionName: "other-session",
      }),
      baseAttachment("77777777-7777-4777-8777-777777777777", "a related", {
        kind: "related_ticket",
        ticketId: "88888888-8888-4888-8888-888888888888",
        identifierSnapshot: "demo#3",
      }),
    ];

    const result = await materialize(attachments);

    expect(result).toEqual([]);
    expect(registered).toEqual([]);
    await expect(readdir(worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("propagates a missing file snapshot and registers nothing for it", async () => {
    const attachment = baseAttachment(FILE_ATTACHMENT_ID, "gone", {
      kind: "file",
      fileName: "gone.txt",
      snapshotKey: `${TICKET_ID}/${FILE_ATTACHMENT_ID}/gone.txt`,
      mediaType: null,
      sizeBytes: 4,
      sha256: "deadbeef",
    });

    await expect(materialize([attachment])).rejects.toBeInstanceOf(
      TicketContentError,
    );
    expect(registered).toEqual([]);
  });

  it("rejects a conversation id that would escape the ticket directory", async () => {
    const snapshot = await store.captureText({
      ticketId: TICKET_ID,
      attachmentId: CONVERSATION_ATTACHMENT_ID,
      fileName: "compaction-evil.md",
      text: "body",
    });
    const attachment = baseAttachment(CONVERSATION_ATTACHMENT_ID, "evil", {
      kind: "conversation",
      projectPath: PROJECT_PATH,
      sessionName: null,
      conversationId: "../../../evil",
      snapshotKey: snapshot.snapshotKey,
      snapshotCapturedAt: "2026-07-09T12:00:00.000Z",
    });

    await expect(materialize([attachment])).rejects.toBeInstanceOf(
      TicketContentError,
    );
    expect(registered).toEqual([]);
    await expect(
      readFile(path.join(base, "evil"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an attachment id that would escape the ticket directory", async () => {
    const snapshot = await store.captureText({
      ticketId: TICKET_ID,
      attachmentId: CONVERSATION_ATTACHMENT_ID,
      fileName: "compaction-evil.md",
      text: "body",
    });
    const attachment = baseAttachment("../../escape", "evil id", {
      kind: "conversation",
      projectPath: PROJECT_PATH,
      sessionName: null,
      conversationId: CONVERSATION_ID,
      snapshotKey: snapshot.snapshotKey,
      snapshotCapturedAt: "2026-07-09T12:00:00.000Z",
    });

    await expect(materialize([attachment])).rejects.toBeInstanceOf(
      TicketContentError,
    );
    expect(registered).toEqual([]);
  });

  it("propagates a reference-document registration failure", async () => {
    const attachment = await captureFileAttachment(Buffer.from("body", "utf8"));
    materializer = createTicketMaterializer({
      contentStore: store,
      registerReferenceDocument() {
        return Promise.reject(new Error("registration unavailable"));
      },
    });

    await expect(materialize([attachment])).rejects.toThrow(
      "registration unavailable",
    );
  });
});
