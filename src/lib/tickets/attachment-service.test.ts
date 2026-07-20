import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { SSEEvent } from "@/lib/api/sse-events";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createTicketContentStore,
  type TicketContentStore,
} from "./content-store";
import {
  createTicketAttachmentService,
  type EnsureConversationCompactionResult,
  type LiveCompaction,
  type TicketAttachmentService,
  type TicketAttachmentServiceDeps,
  type TicketSessionOverview,
} from "./attachment-service";
import type {
  ConversationAttachmentPayload,
  ResolvedAttachment,
  TicketAttachment,
  TicketDetail,
  TicketResult,
  TicketStatus,
} from "./schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT_NAME = "side-project";
const OTHER_PROJECT_PATH = "/repos/side-project";
const CONVERSATION_ID = "conv-0001";

let db: Db;
let repo: TicketsRepo;
let contentStore: TicketContentStore;
let contentBase: string;
let events: SSEEvent[];
let idSeq: number;
let clock: number;

let ensureResult: EnsureConversationCompactionResult;
let ensureCalls: unknown[];
let liveCompaction: LiveCompaction | null;
let conversationExistsResult: boolean;
let sessionOverview: TicketSessionOverview | null;
let startActive: boolean;
let startReleased: Promise<void>;
let releaseStart: () => void;

beforeEach(async () => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
    OTHER_PROJECT_PATH,
  );
  repo = createTicketsRepo(db, createWriteQueue());
  contentBase = await mkdtemp(path.join(tmpdir(), "cc-ticket-attach-"));
  await mkdir(path.join(contentBase, "ticket-content"), { recursive: true });
  contentStore = createTicketContentStore({
    contentRoot: path.join(contentBase, "ticket-content"),
    listTicketIdsForProject: () => Promise.resolve([]),
  });
  events = [];
  idSeq = 0;
  clock = 0;
  ensureResult = {
    ok: true,
    markdown: "## Compaction\n\n- summarized",
    capturedAt: "2026-07-10T01:00:00.000Z",
  };
  ensureCalls = [];
  liveCompaction = {
    markdown: "## Live compaction",
    capturedAt: "2026-07-10T02:00:00.000Z",
    coveredEndSeq: 0,
  };
  conversationExistsResult = true;
  sessionOverview = {
    sessionName: "feature-work",
    finished: false,
    conversationIds: [CONVERSATION_ID],
  };
  startActive = false;
  releaseStart = () => {};
  startReleased = new Promise((resolve) => {
    releaseStart = resolve;
  });
});

afterEach(async () => {
  db.close();
  await rm(contentBase, { recursive: true, force: true });
});

function makeService(
  overrides: Partial<TicketAttachmentServiceDeps> = {},
): TicketAttachmentService {
  return createTicketAttachmentService({
    repo,
    contentStore,
    runProjectTicketOperation: (_projectPath, operation) => operation(),
    resolveProjectPath: (name) =>
      Promise.resolve(
        name === PROJECT_NAME
          ? PROJECT_PATH
          : name === OTHER_PROJECT_NAME
            ? OTHER_PROJECT_PATH
            : null,
      ),
    ensureConversationCompaction: (input) => {
      ensureCalls.push(input);
      return Promise.resolve(ensureResult);
    },
    getLiveCompaction: () => Promise.resolve(liveCompaction),
    conversationExists: () => Promise.resolve(conversationExistsResult),
    getSessionOverview: () => Promise.resolve(sessionOverview),
    isTicketStartActive: () => startActive,
    onTicketStartReleased: () => startReleased,
    publish: (event) => {
      events.push(event);
      return { delivered: true };
    },
    now: () => {
      clock += 1;
      return `2026-07-10T00:00:${String(clock).padStart(2, "0")}.000Z`;
    },
    generateId: () => {
      idSeq += 1;
      return `generated-${idSeq}`;
    },
    ...overrides,
  });
}

async function createTicket(
  status: TicketStatus = "not_started",
  projectPath = PROJECT_PATH,
): Promise<TicketDetail> {
  idSeq += 1;
  const ticket = await repo.create({
    id: `ticket-${idSeq}`,
    projectPath,
    title: "Host ticket",
    description: "",
    workType: "feature",
    status,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  });
  return {
    ...ticket,
    projectName: path.basename(projectPath),
    attachments: [],
    sessions: [],
  };
}

function expectOk<T>(result: TicketResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got error ${result.error.code}`);
  }
  return result.value;
}

function snapshotKeyOf(attachment: TicketAttachment): string {
  const payload = attachment.payload;
  if (payload.kind !== "file" && payload.kind !== "conversation") {
    throw new Error(`payload kind ${payload.kind} has no snapshot`);
  }
  if (payload.snapshotKey === null) {
    throw new Error("conversation snapshot has no captured blob");
  }
  return payload.snapshotKey;
}

type CapturedResolvedConversation = Extract<
  ResolvedAttachment,
  { kind: "conversation"; source: string }
>;

function expectResolvedKind(
  value: ResolvedAttachment,
  kind: "conversation",
): CapturedResolvedConversation;
function expectResolvedKind<
  K extends Exclude<ResolvedAttachment["kind"], "conversation">,
>(value: ResolvedAttachment, kind: K): Extract<ResolvedAttachment, { kind: K }>;
function expectResolvedKind(
  value: ResolvedAttachment,
  kind: ResolvedAttachment["kind"],
): ResolvedAttachment {
  if (value.kind !== kind) {
    throw new Error(`expected resolved kind ${kind}, got ${value.kind}`);
  }
  if (kind === "conversation" && "state" in value) {
    throw new Error(`expected captured conversation, got ${value.state}`);
  }
  return value;
}

function attachmentEvents() {
  return events.filter(
    (event) =>
      (event as { type?: string; change?: string }).type === "ticket-changed" &&
      (event as { change?: string }).change === "attachments",
  );
}

describe("add note", () => {
  it.each(["not_started", "in_progress", "done", "blocked", "closed"] as const)(
    "adds a note in status %s and publishes one event",
    async (status) => {
      const ticket = await createTicket(status);
      const service = makeService();

      const result = await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "why this matters",
        payload: { kind: "note", markdown: "remember the edge case" },
      });

      const attachment = expectOk(result);
      expect(attachment.payload).toEqual({
        kind: "note",
        markdown: "remember the edge case",
      });

      const detail = await repo.find(ticket.projectPath, ticket.number);
      expect(detail?.attachments).toHaveLength(1);
      expect(detail?.attachments[0]?.description).toBe("why this matters");

      const published = attachmentEvents();
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        attachmentIndexChanged: true,
        projectName: PROJECT_NAME,
        ticketNumber: ticket.number,
      });
      expect(
        (published[0] as { listItem: { attachmentCount: number } }).listItem
          .attachmentCount,
      ).toBe(1);
    },
  );

  it("rejects an empty description", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "   ",
      payload: { kind: "note", markdown: "text" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_failed");
    expect(attachmentEvents()).toHaveLength(0);
  });

  it("uses an explicit note attachment id and treats a retry as already appended", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const input = {
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: `ticket-enrichment:${ticket.id}:agent-triage`,
      description: "Agent triage",
      payload: { kind: "note" as const, markdown: "## Triage" },
    };

    const first = expectOk(await service.add(input));
    const second = expectOk(await service.add(input));

    expect(first.id).toBe(input.attachmentId);
    expect(second).toEqual(first);
    expect(attachmentEvents()).toHaveLength(1);
    expect((await repo.find(PROJECT_PATH, ticket.number))?.attachments).toEqual(
      [first],
    );
  });

  it("rejects explicit ids for blob-backed attachment kinds", async () => {
    const ticket = await createTicket();
    const service = makeService();

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "caller-selected-file-id",
      description: "file",
      payload: {
        kind: "file",
        fileName: "source.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("source"),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(attachmentEvents()).toHaveLength(0);
  });

  it("bumps the parent ticket's updated time on add, edit, and remove", async () => {
    const ticket = await createTicket();
    const service = makeService();

    const attachment = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "initial context",
        payload: { kind: "note", markdown: "remember this" },
      }),
    );
    const afterAdd = await repo.find(ticket.projectPath, ticket.number);

    expectOk(
      await service.update({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: attachment.id,
        description: "revised context",
      }),
    );
    const afterUpdate = await repo.find(ticket.projectPath, ticket.number);

    expectOk(
      await service.remove({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: attachment.id,
      }),
    );
    const afterRemove = await repo.find(ticket.projectPath, ticket.number);

    expect(afterAdd?.updatedAt).toBe("2026-07-10T00:00:01.000Z");
    expect(afterUpdate?.updatedAt).toBe("2026-07-10T00:00:02.000Z");
    expect(afterRemove?.updatedAt).toBe("2026-07-10T00:00:03.000Z");
  });
});

describe("add file", () => {
  it("holds the project gate across snapshot capture, persistence, and event publication", async () => {
    const ticket = await createTicket();
    const phases: string[] = [];
    const service = makeService({
      contentStore: {
        ...contentStore,
        async capture(input) {
          phases.push("capture");
          return contentStore.capture(input);
        },
      },
      async runProjectTicketOperation(projectPath, operation) {
        phases.push(`gate:${projectPath}:start`);
        const result = await operation();
        phases.push(`gate:${projectPath}:end`);
        return result;
      },
      publish(event) {
        phases.push("event");
        events.push(event);
        return { delivered: true };
      },
    });

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "captured source",
      payload: {
        kind: "file",
        fileName: "source.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("source"),
      },
    });

    expect(result.ok).toBe(true);
    expect(phases).toEqual([
      `gate:${PROJECT_PATH}:start`,
      "capture",
      "event",
      `gate:${PROJECT_PATH}:end`,
    ]);
  });

  it("snapshots bytes into the content store before the row insert", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const bytes = Buffer.from("file body", "utf8");

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "design doc",
      payload: {
        kind: "file",
        fileName: "../sneaky/design.md",
        mediaType: "text/markdown",
        bytes,
      },
    });

    const attachment = expectOk(result);
    expect(attachment.payload).toMatchObject({
      kind: "file",
      fileName: "design.md",
      sizeBytes: bytes.byteLength,
      mediaType: "text/markdown",
    });
    const stored = await contentStore.read(snapshotKeyOf(attachment));
    expect(Buffer.from(stored).toString("utf8")).toBe("file body");
  });

  it("removes the snapshot when the row insert fails", async () => {
    const ticket = await createTicket();
    const { stat } = await import("node:fs/promises");
    const ticketDir = path.join(contentBase, "ticket-content", ticket.id);
    let snapshotExistedAtInsert = false;
    const failingRepo: TicketsRepo = {
      ...repo,
      async addAttachment() {
        snapshotExistedAtInsert = await stat(ticketDir).then(
          () => true,
          () => false,
        );
        throw new Error("insert failed");
      },
    };
    const service = makeService({ repo: failingRepo });

    await expect(
      service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "doomed",
        payload: {
          kind: "file",
          fileName: "doomed.txt",
          mediaType: null,
          bytes: Buffer.from("x"),
        },
      }),
    ).rejects.toThrow("insert failed");

    expect(snapshotExistedAtInsert).toBe(true);
    await expect(stat(ticketDir)).rejects.toMatchObject({ code: "ENOENT" });
    const detail = await repo.find(ticket.projectPath, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
    expect(attachmentEvents()).toHaveLength(0);
  });

  it("removes the snapshot on a failed insert even while a start is active", async () => {
    const ticket = await createTicket();
    startActive = true;
    const { stat } = await import("node:fs/promises");
    const ticketDir = path.join(contentBase, "ticket-content", ticket.id);
    const failingRepo: TicketsRepo = {
      ...repo,
      addAttachment() {
        return Promise.reject(new Error("insert failed"));
      },
    };
    const service = makeService({ repo: failingRepo });

    await expect(
      service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "doomed during start",
        payload: {
          kind: "file",
          fileName: "doomed.txt",
          mediaType: null,
          bytes: Buffer.from("x"),
        },
      }),
    ).rejects.toThrow("insert failed");

    await expect(stat(ticketDir)).rejects.toMatchObject({ code: "ENOENT" });
    const detail = await repo.find(ticket.projectPath, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
    expect(attachmentEvents()).toHaveLength(0);
  });
});

describe("add conversation", () => {
  it("ensures a compaction and snapshots its markdown with source coordinates", async () => {
    const ticket = await createTicket();
    const service = makeService();

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "prior investigation",
      payload: {
        kind: "conversation",
        projectName: PROJECT_NAME,
        sessionName: "feature-work",
        conversationId: CONVERSATION_ID,
      },
    });

    const attachment = expectOk(result);
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0]).toMatchObject({
      projectPath: PROJECT_PATH,
      sessionName: "feature-work",
      conversationId: CONVERSATION_ID,
    });
    expect(attachment.payload).toMatchObject({
      kind: "conversation",
      projectPath: PROJECT_PATH,
      sessionName: "feature-work",
      conversationId: CONVERSATION_ID,
      snapshotCapturedAt: "2026-07-10T01:00:00.000Z",
      snapshotStatus: "captured",
    });
    const stored = await contentStore.read(snapshotKeyOf(attachment));
    expect(Buffer.from(stored).toString("utf8")).toBe(
      "## Compaction\n\n- summarized",
    );
  });

  it("fails without a row when the compaction cannot be prepared", async () => {
    const ticket = await createTicket();
    ensureResult = { ok: false, reason: "transcript missing" };
    const service = makeService();

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "prior investigation",
      payload: {
        kind: "conversation",
        projectName: PROJECT_NAME,
        sessionName: null,
        conversationId: CONVERSATION_ID,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("context_preparation_failed");
    }
    const detail = await repo.find(ticket.projectPath, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
    expect(attachmentEvents()).toHaveLength(0);
  });

  it("rejects an unknown conversation before preparing anything", async () => {
    const ticket = await createTicket();
    conversationExistsResult = false;
    const service = makeService();

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "prior investigation",
      payload: {
        kind: "conversation",
        projectName: PROJECT_NAME,
        sessionName: null,
        conversationId: "nope",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_failed");
    expect(ensureCalls).toHaveLength(0);
  });
});

describe("add session and related ticket", () => {
  it("stores a session live pointer after validating the session exists", async () => {
    const ticket = await createTicket();
    const service = makeService();

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "where the work happened",
      payload: {
        kind: "session",
        projectName: PROJECT_NAME,
        sessionName: "feature-work",
      },
    });

    const attachment = expectOk(result);
    expect(attachment.payload).toEqual({
      kind: "session",
      projectPath: PROJECT_PATH,
      sessionName: "feature-work",
    });
  });

  it("rejects a session that does not exist", async () => {
    const ticket = await createTicket();
    sessionOverview = null;
    const service = makeService();

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "where the work happened",
      payload: {
        kind: "session",
        projectName: PROJECT_NAME,
        sessionName: "ghost",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_failed");
  });

  it("stores a related ticket as uuid + identifier snapshot", async () => {
    const host = await createTicket();
    const target = await createTicket("not_started", OTHER_PROJECT_PATH);
    const service = makeService();

    const result = await service.add({
      projectName: PROJECT_NAME,
      number: host.number,
      description: "duplicate of",
      payload: {
        kind: "related_ticket",
        projectName: OTHER_PROJECT_NAME,
        number: target.number,
      },
    });

    const attachment = expectOk(result);
    expect(attachment.payload).toEqual({
      kind: "related_ticket",
      ticketId: target.id,
      identifierSnapshot: `${OTHER_PROJECT_NAME}#${target.number}`,
    });
  });

  it("rejects an unknown related ticket with the target identifier", async () => {
    const host = await createTicket();
    const service = makeService();
    const result = await service.add({
      projectName: PROJECT_NAME,
      number: host.number,
      description: "duplicate of",
      payload: {
        kind: "related_ticket",
        projectName: OTHER_PROJECT_NAME,
        number: 999,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "ticket_not_found",
        identifier: `${OTHER_PROJECT_NAME}#999`,
      });
    }
  });

  it("rejects attaching a ticket to itself", async () => {
    const host = await createTicket();
    const service = makeService();
    const result = await service.add({
      projectName: PROJECT_NAME,
      number: host.number,
      description: "self",
      payload: {
        kind: "related_ticket",
        projectName: PROJECT_NAME,
        number: host.number,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_failed");
  });
});

describe("update", () => {
  it("edits the description of any kind and the markdown of a note", async () => {
    const ticket = await createTicket("in_progress");
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "before",
        payload: { kind: "note", markdown: "old" },
      }),
    );

    const result = await service.update({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: added.id,
      description: "after",
      markdown: "new body",
    });

    const updated = expectOk(result);
    expect(updated.description).toBe("after");
    expect(updated.payload).toEqual({ kind: "note", markdown: "new body" });
    expect(attachmentEvents()).toHaveLength(2);
  });

  it("rejects markdown edits on a non-note attachment", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "file",
        payload: {
          kind: "file",
          fileName: "a.txt",
          mediaType: null,
          bytes: Buffer.from("x"),
        },
      }),
    );

    const result = await service.update({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: added.id,
      markdown: "nope",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_failed");
  });

  it("returns attachment_not_found for an unknown attachment", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const result = await service.update({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "missing",
      description: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("attachment_not_found");
  });
});

describe("remove", () => {
  it("commits the row first and deletes the blob best-effort", async () => {
    const ticket = await createTicket("done");
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "file",
        payload: {
          kind: "file",
          fileName: "a.txt",
          mediaType: null,
          bytes: Buffer.from("x"),
        },
      }),
    );

    const result = await service.remove({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: added.id,
    });

    const deleted = expectOk(result);
    expect(deleted.kind).toBe("file");
    expect(deleted.ticketUpdatedAt).toMatch(/^2026-07-10T/);
    const detail = await repo.find(ticket.projectPath, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
    await expect(contentStore.read(snapshotKeyOf(added))).rejects.toMatchObject(
      { code: "snapshot_not_found" },
    );
  });

  it.each([
    {
      status: "pending" as const,
      payload: {
        kind: "conversation" as const,
        projectPath: PROJECT_PATH,
        sessionName: null,
        conversationId: CONVERSATION_ID,
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "pending" as const,
      },
    },
    {
      status: "failed" as const,
      payload: {
        kind: "conversation" as const,
        projectPath: PROJECT_PATH,
        sessionName: null,
        conversationId: CONVERSATION_ID,
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "failed" as const,
        snapshotError: "Snapshot capture failed safely.",
      },
    },
  ])(
    "removes a $status conversation without attempting blob cleanup",
    async ({ payload }) => {
      const ticket = await createTicket();
      const attachment = await repo.addAttachment({
        id: `conversation-${payload.snapshotStatus}`,
        ticketId: ticket.id,
        description: "Conversation awaiting a snapshot",
        payload,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      });
      const deleteSpy = vi.spyOn(contentStore, "delete");
      const service = makeService();

      const result = await service.remove({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: attachment.id,
      });

      expect(result.ok).toBe(true);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(await repo.find(PROJECT_PATH, ticket.number)).toMatchObject({
        attachments: [],
      });
    },
  );

  it("reclaims a captured conversation snapshot", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const attachment = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "Captured conversation",
        payload: {
          kind: "conversation",
          projectName: PROJECT_NAME,
          sessionName: null,
          conversationId: CONVERSATION_ID,
        },
      }),
    );
    const snapshotKey = snapshotKeyOf(attachment);

    const result = await service.remove({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: attachment.id,
    });

    expect(result.ok).toBe(true);
    await expect(contentStore.read(snapshotKey)).rejects.toMatchObject({
      code: "snapshot_not_found",
    });
  });

  it("returns the repository's committed ticket revision when the service clock is behind", async () => {
    const ticket = await createTicket();
    const requestedAt = "2026-07-08T00:00:00.000Z";
    const service = makeService({ now: () => requestedAt });
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "note",
        payload: { kind: "note", markdown: "context" },
      }),
    );

    const deleted = expectOk(
      await service.remove({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: added.id,
      }),
    );
    const persisted = await repo.find(ticket.projectPath, ticket.number);

    expect(deleted.ticketUpdatedAt).toBe("2026-07-09T00:00:00.002Z");
    expect(deleted.ticketUpdatedAt).toBe(persisted?.updatedAt);
    expect(deleted.ticketUpdatedAt).not.toBe(requestedAt);
  });

  it("defers blob cleanup while a start holds the blob, then reclaims it on release", async () => {
    const ticket = await createTicket();
    startActive = true;
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "file",
        payload: {
          kind: "file",
          fileName: "held.txt",
          mediaType: null,
          bytes: Buffer.from("held"),
        },
      }),
    );

    const result = await service.remove({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: added.id,
    });

    expect(result.ok).toBe(true);
    const detail = await repo.find(ticket.projectPath, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
    const stored = await contentStore.read(snapshotKeyOf(added));
    expect(Buffer.from(stored).toString("utf8")).toBe("held");

    startActive = false;
    releaseStart();
    await vi.waitFor(async () => {
      await expect(
        contentStore.read(snapshotKeyOf(added)),
      ).rejects.toMatchObject({ code: "snapshot_not_found" });
    });
  });

  it("still succeeds when blob cleanup fails", async () => {
    const ticket = await createTicket();
    const failingStore: TicketContentStore = {
      ...contentStore,
      delete() {
        return Promise.reject(new Error("disk detached"));
      },
    };
    const service = makeService({ contentStore: failingStore });
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "file",
        payload: {
          kind: "file",
          fileName: "a.txt",
          mediaType: null,
          bytes: Buffer.from("x"),
        },
      }),
    );

    const result = await service.remove({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: added.id,
    });
    expect(result.ok).toBe(true);
    const detail = await repo.find(ticket.projectPath, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
  });
});

describe("resolve", () => {
  it("resolves a note to its markdown", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "note",
        payload: { kind: "note", markdown: "the body" },
      }),
    );

    const resolved = expectOk(
      await service.resolve({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: added.id,
      }),
    );
    expect(resolved).toMatchObject({ kind: "note", markdown: "the body" });
  });

  it("resolves a text file to utf8 content and a binary file to base64", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const textAdded = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "text",
        payload: {
          kind: "file",
          fileName: "readme.md",
          mediaType: "text/markdown",
          bytes: Buffer.from("hello", "utf8"),
        },
      }),
    );
    const binaryBytes = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const binaryAdded = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "binary",
        payload: {
          kind: "file",
          fileName: "blob.bin",
          mediaType: null,
          bytes: binaryBytes,
        },
      }),
    );

    const text = expectResolvedKind(
      expectOk(
        await service.resolve({
          projectName: PROJECT_NAME,
          number: ticket.number,
          attachmentId: textAdded.id,
        }),
      ),
      "file",
    );
    expect(text).toMatchObject({ encoding: "utf8", content: "hello" });

    const binary = expectResolvedKind(
      expectOk(
        await service.resolve({
          projectName: PROJECT_NAME,
          number: ticket.number,
          attachmentId: binaryAdded.id,
        }),
      ),
      "file",
    );
    expect(binary.encoding).toBe("base64");
    expect(Buffer.from(binary.content, "base64").equals(binaryBytes)).toBe(
      true,
    );
  });

  it("returns content_unavailable when a file snapshot is gone", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "file",
        payload: {
          kind: "file",
          fileName: "a.txt",
          mediaType: null,
          bytes: Buffer.from("x"),
        },
      }),
    );
    await contentStore.delete(snapshotKeyOf(added));

    const result = await service.resolve({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: added.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("content_unavailable");
  });

  it("returns the canonical pending arm without consulting live or retained content", async () => {
    const ticket = await createTicket();
    const payload: ConversationAttachmentPayload = {
      kind: "conversation",
      projectPath: PROJECT_PATH,
      sessionName: "feature-work",
      conversationId: CONVERSATION_ID,
      snapshotKey: null,
      snapshotCapturedAt: null,
      snapshotStatus: "pending",
    };
    const attachment = await repo.addAttachment({
      id: "pending-conversation",
      ticketId: ticket.id,
      description: "Conversation snapshot in progress",
      payload,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const readSpy = vi.spyOn(contentStore, "read");
    const service = makeService({
      conversationExists: () =>
        Promise.reject(new Error("pending resolve consulted source")),
      getLiveCompaction: () =>
        Promise.reject(new Error("pending resolve consulted live content")),
    });

    const resolved = expectOk(
      await service.resolve({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: attachment.id,
      }),
    );

    expect(resolved).toMatchObject({
      kind: "conversation",
      state: "pending",
      conversationId: CONVERSATION_ID,
      sessionName: "feature-work",
      retryCommand: `cctl ticket attachment refresh '${PROJECT_NAME}#${ticket.number}' '${attachment.id}'`,
    });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("returns the canonical failed arm with only the persisted safe error", async () => {
    const ticket = await createTicket();
    const safeError = "Conversation snapshot capture was interrupted.";
    const payload: ConversationAttachmentPayload = {
      kind: "conversation",
      projectPath: PROJECT_PATH,
      sessionName: null,
      conversationId: CONVERSATION_ID,
      snapshotKey: null,
      snapshotCapturedAt: null,
      snapshotStatus: "failed",
      snapshotError: safeError,
    };
    const attachment = await repo.addAttachment({
      id: "failed-conversation",
      ticketId: ticket.id,
      description: "Conversation snapshot failed",
      payload,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const readSpy = vi.spyOn(contentStore, "read");
    const service = makeService({
      conversationExists: () =>
        Promise.reject(new Error("failed resolve consulted source")),
      getLiveCompaction: () =>
        Promise.reject(new Error("failed resolve consulted live content")),
    });

    const resolved = expectOk(
      await service.resolve({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: attachment.id,
      }),
    );

    expect(resolved).toMatchObject({
      kind: "conversation",
      state: "failed",
      conversationId: CONVERSATION_ID,
      sessionName: null,
      error: safeError,
      retryCommand: `cctl ticket attachment refresh '${PROJECT_NAME}#${ticket.number}' '${attachment.id}'`,
    });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("prefers the live compaction with read commands while the source exists", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "conv",
        payload: {
          kind: "conversation",
          projectName: PROJECT_NAME,
          sessionName: "feature-work",
          conversationId: CONVERSATION_ID,
        },
      }),
    );

    const resolved = expectResolvedKind(
      expectOk(
        await service.resolve({
          projectName: PROJECT_NAME,
          number: ticket.number,
          attachmentId: added.id,
        }),
      ),
      "conversation",
    );
    expect(resolved.source).toBe("live_compaction");
    expect(resolved.sourceAvailable).toBe(true);
    expect(resolved.markdown).toBe("## Live compaction");
    expect(
      resolved.readCommands.some((command) =>
        command.includes(`cctl conversation read '${CONVERSATION_ID}'`),
      ),
    ).toBe(true);
    expect(resolved.readCommands).toEqual([
      `cctl conversation compaction get '${CONVERSATION_ID}' --project '${PROJECT_NAME}' --session 'feature-work'`,
      `cctl conversation read '${CONVERSATION_ID}' --outline --project '${PROJECT_NAME}' --session 'feature-work'`,
      `cctl conversation read '${CONVERSATION_ID}' --message-range A:B --project '${PROJECT_NAME}' --session 'feature-work'`,
    ]);
  });

  it("qualifies live project-conversation read commands without an ambient session", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "project conversation",
        payload: {
          kind: "conversation",
          projectName: PROJECT_NAME,
          sessionName: null,
          conversationId: CONVERSATION_ID,
        },
      }),
    );

    const resolved = expectResolvedKind(
      expectOk(
        await service.resolve({
          projectName: PROJECT_NAME,
          number: ticket.number,
          attachmentId: added.id,
        }),
      ),
      "conversation",
    );

    expect(resolved.readCommands).toEqual([
      `cctl conversation compaction get '${CONVERSATION_ID}' --project '${PROJECT_NAME}'`,
      `cctl conversation read '${CONVERSATION_ID}' --outline --project '${PROJECT_NAME}'`,
      `cctl conversation read '${CONVERSATION_ID}' --message-range A:B --project '${PROJECT_NAME}'`,
    ]);
  });

  it("falls back to the retained-compaction snapshot after the source is deleted", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "conv",
        payload: {
          kind: "conversation",
          projectName: PROJECT_NAME,
          sessionName: null,
          conversationId: CONVERSATION_ID,
        },
      }),
    );
    conversationExistsResult = false;
    liveCompaction = null;

    const resolved = expectResolvedKind(
      expectOk(
        await service.resolve({
          projectName: PROJECT_NAME,
          number: ticket.number,
          attachmentId: added.id,
        }),
      ),
      "conversation",
    );
    expect(resolved.source).toBe("retained_compaction");
    expect(resolved.sourceAvailable).toBe(false);
    expect(resolved.markdown).toBe("## Compaction\n\n- summarized");
    expect(resolved.capturedAt).toBe("2026-07-10T01:00:00.000Z");
    expect(resolved.readCommands).toEqual([]);
  });

  it("resolves a session to metadata, conversation index, and read commands", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "session",
        payload: {
          kind: "session",
          projectName: PROJECT_NAME,
          sessionName: "feature-work",
        },
      }),
    );

    const resolved = expectResolvedKind(
      expectOk(
        await service.resolve({
          projectName: PROJECT_NAME,
          number: ticket.number,
          attachmentId: added.id,
        }),
      ),
      "session",
    );
    expect(resolved.sessionName).toBe("feature-work");
    expect(resolved.conversationIds).toEqual([CONVERSATION_ID]);
    expect(resolved.readCommands.length).toBeGreaterThan(0);
  });

  it("resolves a cross-project session to the session's own project", async () => {
    const host = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: host.number,
        description: "session in another project",
        payload: {
          kind: "session",
          projectName: OTHER_PROJECT_NAME,
          sessionName: "feature-work",
        },
      }),
    );

    const resolved = expectOk(
      await service.resolve({
        projectName: PROJECT_NAME,
        number: host.number,
        attachmentId: added.id,
      }),
    );
    const session = expectResolvedKind(resolved, "session");
    expect(session.projectName).toBe(OTHER_PROJECT_NAME);
  });

  it("returns content_unavailable for a deleted session", async () => {
    const ticket = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: ticket.number,
        description: "session",
        payload: {
          kind: "session",
          projectName: PROJECT_NAME,
          sessionName: "feature-work",
        },
      }),
    );
    sessionOverview = null;

    const result = await service.resolve({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: added.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("content_unavailable");
  });

  it("resolves a related ticket to its current detail and attachment index", async () => {
    const host = await createTicket();
    const target = await createTicket();
    const service = makeService();
    await service.add({
      projectName: PROJECT_NAME,
      number: target.number,
      description: "target note",
      payload: { kind: "note", markdown: "inside target" },
    });
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: host.number,
        description: "related",
        payload: {
          kind: "related_ticket",
          projectName: PROJECT_NAME,
          number: target.number,
        },
      }),
    );

    const resolved = expectOk(
      await service.resolve({
        projectName: PROJECT_NAME,
        number: host.number,
        attachmentId: added.id,
      }),
    );
    const related = expectResolvedKind(resolved, "related_ticket");
    expect(related.available).toBe(true);
    if (related.available) {
      expect(related.ticket.number).toBe(target.number);
      expect(related.ticket.attachments).toHaveLength(1);
    }
  });

  it("resolves a deleted related ticket to a typed unavailable result", async () => {
    const host = await createTicket();
    const target = await createTicket();
    const service = makeService();
    const added = expectOk(
      await service.add({
        projectName: PROJECT_NAME,
        number: host.number,
        description: "related",
        payload: {
          kind: "related_ticket",
          projectName: PROJECT_NAME,
          number: target.number,
        },
      }),
    );
    await repo.delete(PROJECT_PATH, target.number);

    const resolved = expectOk(
      await service.resolve({
        projectName: PROJECT_NAME,
        number: host.number,
        attachmentId: added.id,
      }),
    );
    const related = expectResolvedKind(resolved, "related_ticket");
    expect(related.available).toBe(false);
    if (!related.available) {
      expect(related.identifierSnapshot).toBe(
        `${PROJECT_NAME}#${target.number}`,
      );
    }
  });

  it("returns attachment_not_found and ticket_not_found appropriately", async () => {
    const ticket = await createTicket();
    const service = makeService();

    const unknownAttachment = await service.resolve({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "missing",
    });
    expect(unknownAttachment.ok).toBe(false);
    if (!unknownAttachment.ok) {
      expect(unknownAttachment.error.code).toBe("attachment_not_found");
    }

    const unknownTicket = await service.resolve({
      projectName: PROJECT_NAME,
      number: 424242,
      attachmentId: "missing",
    });
    expect(unknownTicket.ok).toBe(false);
    if (!unknownTicket.ok) {
      expect(unknownTicket.error.code).toBe("ticket_not_found");
    }
  });
});
