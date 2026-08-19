import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  withTracing: (handler: unknown) => handler,
}));

import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createTicketAttachmentService,
  type TicketAttachmentService,
} from "./attachment-service";
import {
  createTicketAttachmentRouteHandlers,
  MAX_TICKET_FILE_UPLOAD_BYTES,
  readBodyBounded,
  type TicketAttachmentRouteHandlers,
} from "./attachment-route-handlers";
import {
  createTicketContentStore,
  type TicketContentStore,
} from "./content-store";
import { createTicketService, type TicketService } from "./service";
import type { TicketDetail } from "./schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";
const CONVERSATION_ID = "conv-0001";

let db: Db;
let repo: TicketsRepo;
let contentStore: TicketContentStore;
let contentBase: string;
let ticketService: TicketService;
let attachmentService: TicketAttachmentService;
let idSeq: number;

function grantedAuth(): AgentAuth {
  return {
    async requireToken() {
      return null;
    },
    async validateOptionalToken() {
      return { kind: "absent" };
    },
  };
}

function rejectedAuth(): AgentAuth {
  return {
    async requireToken() {
      return Response.json({ error: "Invalid token" }, { status: 401 });
    },
    async validateOptionalToken() {
      return { kind: "invalid" };
    },
  };
}

async function resolveProjectPath(name: string): Promise<string | null> {
  return name === PROJECT_NAME ? PROJECT_PATH : null;
}

function buildAttachmentService(
  overrides: {
    repo?: TicketsRepo;
    isTicketStartActive?: () => boolean;
  } = {},
): TicketAttachmentService {
  return createTicketAttachmentService({
    repo: overrides.repo ?? repo,
    contentStore,
    resolveProjectPath,
    runProjectTicketOperation: (_projectPath, operation) => operation(),
    scheduleConversationSnapshotRefresh: () => {},
    getLiveCompaction: () =>
      Promise.resolve({
        markdown: "## Live compaction",
        capturedAt: "2026-07-10T02:00:00.000Z",
        coveredEndSeq: 0,
      }),
    resolveConversation: (input) => Promise.resolve(input),
    conversationExists: () => Promise.resolve(true),
    getSessionOverview: () =>
      Promise.resolve({
        sessionName: "feature-work",
        finished: false,
        conversationIds: [CONVERSATION_ID],
      }),
    isTicketStartActive: overrides.isTicketStartActive ?? (() => false),
    onTicketStartReleased: () => Promise.resolve(),
    publish: () => ({ delivered: true }),
    now: () => "2026-07-10T00:00:00.000Z",
    generateId: () => {
      idSeq += 1;
      return `generated-${idSeq}`;
    },
  });
}

function buildHandlers(
  overrides: {
    auth?: AgentAuth;
    attachmentService?: TicketAttachmentService;
  } = {},
): TicketAttachmentRouteHandlers {
  return createTicketAttachmentRouteHandlers({
    getTicketService: () => ticketService,
    getAttachmentService: () =>
      overrides.attachmentService ?? attachmentService,
    auth: overrides.auth ?? grantedAuth(),
  });
}

beforeEach(async () => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  repo = createTicketsRepo(db, createWriteQueue());
  contentBase = await mkdtemp(path.join(tmpdir(), "cc-ticket-attach-routes-"));
  await mkdir(path.join(contentBase, "ticket-content"), { recursive: true });
  contentStore = createTicketContentStore({
    contentRoot: path.join(contentBase, "ticket-content"),
    listTicketIdsForProject: () => Promise.resolve([]),
  });
  idSeq = 0;
  ticketService = createTicketService({
    repo,
    attachmentPlanner: {
      async plan() {
        return {
          attachments: [],
          pendingConversationAttachmentIds: [],
          warnings: [],
          compensate: async () => {},
          afterCommit: () => {},
        };
      },
    },
    resolveProjectPath,
    resolveAvailableProjectPath: resolveProjectPath,
    deleteTicketContent: () => Promise.resolve(),
    publish: () => ({ delivered: true }),
    runProjectTicketOperation: (_projectPath, operation) =>
      operation({ projectDeletionPrecededOperation: false }),
    runTicketOperation: (_key, fn) => fn(),
    now: () => "2026-07-10T00:00:00.000Z",
    generateId: () => {
      idSeq += 1;
      return `ticket-${idSeq}`;
    },
  });
  attachmentService = buildAttachmentService();
});

afterEach(async () => {
  db.close();
  await rm(contentBase, { recursive: true, force: true });
});

async function createTicket(): Promise<TicketDetail> {
  const result = await ticketService.create({
    projectName: PROJECT_NAME,
    title: "Host ticket",
    workType: "feature",
  });
  if (!result.ok) throw new Error(`ticket create failed: ${result.error.code}`);
  return result.value;
}

function routeContext(number: number, attachmentId?: string) {
  return {
    params: Promise.resolve({
      name: PROJECT_NAME,
      number: String(number),
      ...(attachmentId !== undefined ? { attachmentId } : {}),
    }),
  };
}

const BASE_URL = "http://localhost/api/projects/command-center/tickets";

function jsonRequest(
  url: string,
  method: string,
  body: Record<string, unknown>,
): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function multipartRequest(
  number: number,
  file: File,
  metadata: Record<string, unknown>,
): Request {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("file", file);
  return new Request(`${BASE_URL}/${number}/attachments`, {
    method: "POST",
    body: form,
  });
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("index GET", () => {
  it("returns the ticket's attachments", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    await attachmentService.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "a note",
      payload: { kind: "note", markdown: "hello" },
    });

    const response = await handlers.indexGET(
      new Request(`${BASE_URL}/${ticket.number}/attachments`),
      routeContext(ticket.number),
    );
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body["attachments"]).toHaveLength(1);
  });

  it("returns 404 for an unknown ticket and 401 for an invalid token", async () => {
    const handlers = buildHandlers();
    const missing = await handlers.indexGET(
      new Request(`${BASE_URL}/999/attachments`),
      routeContext(999),
    );
    expect(missing.status).toBe(404);

    const denied = await buildHandlers({ auth: rejectedAuth() }).indexGET(
      new Request(`${BASE_URL}/1/attachments`),
      routeContext(1),
    );
    expect(denied.status).toBe(401);
  });
});

describe("add POST — JSON kinds", () => {
  it("round-trips note, conversation, session, and related-ticket adds", async () => {
    const ticket = await createTicket();
    const related = await createTicket();
    const handlers = buildHandlers();

    const payloads: Record<string, unknown>[] = [
      { kind: "note", markdown: "inline note" },
      {
        kind: "conversation",
        projectName: PROJECT_NAME,
        sessionName: "feature-work",
        conversationId: CONVERSATION_ID,
      },
      {
        kind: "session",
        projectName: PROJECT_NAME,
        sessionName: "feature-work",
      },
      {
        kind: "related_ticket",
        projectName: PROJECT_NAME,
        number: related.number,
      },
    ];

    for (const payload of payloads) {
      const response = await handlers.addPOST(
        jsonRequest(`${BASE_URL}/${ticket.number}/attachments`, "POST", {
          description: `attachment of kind ${String(payload["kind"])}`,
          payload,
        }),
        routeContext(ticket.number),
      );
      expect(response.status).toBe(201);
      const body = await jsonOf(response);
      expect((body["payload"] as { kind: string }).kind).toBe(payload["kind"]);

      const resolved = await handlers.resolveGET(
        new Request(
          `${BASE_URL}/${ticket.number}/attachments/${String(body["id"])}`,
        ),
        routeContext(ticket.number, String(body["id"])),
      );
      expect(resolved.status).toBe(200);
      const resolvedBody = await jsonOf(resolved);
      expect(resolvedBody["kind"]).toBe(payload["kind"]);
    }

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments).toHaveLength(payloads.length);
  });

  it("rejects a JSON file add with 400 pointing at multipart", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const response = await handlers.addPOST(
      jsonRequest(`${BASE_URL}/${ticket.number}/attachments`, "POST", {
        description: "file the wrong way",
        payload: { kind: "file", fileName: "a.txt" },
      }),
      routeContext(ticket.number),
    );
    expect(response.status).toBe(400);
    const body = await jsonOf(response);
    expect(JSON.stringify(body)).toContain("multipart");
  });

  it("rejects a non-JSON body with 400", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const response = await handlers.addPOST(
      new Request(`${BASE_URL}/${ticket.number}/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      routeContext(ticket.number),
    );
    expect(response.status).toBe(400);
  });
});

describe("add POST — multipart file", () => {
  it("round-trips a multipart file upload with a validated metadata part", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const file = new File(["file body"], "design.md", {
      type: "text/markdown",
    });

    const response = await handlers.addPOST(
      multipartRequest(ticket.number, file, { description: "design doc" }),
      routeContext(ticket.number),
    );
    expect(response.status).toBe(201);
    const body = await jsonOf(response);
    const payload = body["payload"] as Record<string, unknown>;
    expect(payload["kind"]).toBe("file");
    expect(payload["fileName"]).toBe("design.md");
    expect(payload["mediaType"]).toBe("text/markdown");

    const resolved = await handlers.resolveGET(
      new Request(
        `${BASE_URL}/${ticket.number}/attachments/${String(body["id"])}`,
      ),
      routeContext(ticket.number, String(body["id"])),
    );
    expect(resolved.status).toBe(200);
    const resolvedBody = await jsonOf(resolved);
    expect(resolvedBody["kind"]).toBe("file");
    expect(resolvedBody["encoding"]).toBe("utf8");
    expect(resolvedBody["content"]).toBe("file body");
  });

  it("rejects a multipart add without a valid metadata part", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const form = new FormData();
    form.set("file", new File(["x"], "a.txt"));
    const response = await handlers.addPOST(
      new Request(`${BASE_URL}/${ticket.number}/attachments`, {
        method: "POST",
        body: form,
      }),
      routeContext(ticket.number),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an oversized upload with 413 leaving no row and no snapshot", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const oversized = new File(
      [new Uint8Array(MAX_TICKET_FILE_UPLOAD_BYTES + 1)],
      "huge.bin",
    );

    const response = await handlers.addPOST(
      multipartRequest(ticket.number, oversized, { description: "too big" }),
      routeContext(ticket.number),
    );
    expect(response.status).toBe(413);

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
    await expect(
      stat(path.join(contentBase, "ticket-content", ticket.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized declared content-length with 413 before reading the body", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const request = new Request(`${BASE_URL}/${ticket.number}/attachments`, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(MAX_TICKET_FILE_UPLOAD_BYTES * 3),
      },
      body: "irrelevant",
    });
    const response = await handlers.addPOST(
      request,
      routeContext(ticket.number),
    );
    expect(response.status).toBe(413);
  });

  it("a failed file insert leaves neither a row nor a snapshot", async () => {
    const ticket = await createTicket();
    const failingRepo: TicketsRepo = {
      ...repo,
      addAttachment() {
        return Promise.reject(new Error("insert failed"));
      },
    };
    const handlers = buildHandlers({
      attachmentService: buildAttachmentService({ repo: failingRepo }),
    });

    const response = await handlers.addPOST(
      multipartRequest(ticket.number, new File(["x"], "doomed.txt"), {
        description: "doomed",
      }),
      routeContext(ticket.number),
    );
    expect(response.status).toBe(500);

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
    await expect(
      stat(path.join(contentBase, "ticket-content", ticket.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a failed file insert during an active start still removes the snapshot", async () => {
    const ticket = await createTicket();
    const failingRepo: TicketsRepo = {
      ...repo,
      addAttachment() {
        return Promise.reject(new Error("insert failed"));
      },
    };
    const handlers = buildHandlers({
      attachmentService: buildAttachmentService({
        repo: failingRepo,
        isTicketStartActive: () => true,
      }),
    });

    const response = await handlers.addPOST(
      multipartRequest(ticket.number, new File(["x"], "doomed.txt"), {
        description: "doomed during start",
      }),
      routeContext(ticket.number),
    );
    expect(response.status).toBe(500);

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments).toHaveLength(0);
    await expect(
      stat(path.join(contentBase, "ticket-content", ticket.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("readBodyBounded", () => {
  it("stops pulling from the stream and cancels it once the ceiling is crossed", async () => {
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024).fill(7);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 1000) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await readBodyBounded(stream, 10 * 1024);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.receivedBytes).toBeGreaterThan(10 * 1024);
    }
    expect(cancelled).toBe(true);
    // A bounded reader stops near the ceiling instead of draining all 1000
    // chunks the way a full-body buffer would.
    expect(pulls).toBeLessThanOrEqual(12);
  });

  it("returns the concatenated bytes when the body fits under the ceiling", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });

    const result = await readBodyBounded(stream, 16);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    }
  });

  it("treats a missing body as empty", async () => {
    const result = await readBodyBounded(null, 16);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes).toHaveLength(0);
    }
  });
});

describe("resolve GET", () => {
  it("yields 410 when the snapshot content is unavailable", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const added = await attachmentService.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "file",
      payload: {
        kind: "file",
        fileName: "gone.txt",
        mediaType: null,
        bytes: Buffer.from("bye"),
      },
    });
    if (!added.ok) throw new Error("add failed");
    const payload = added.value.payload;
    if (payload.kind !== "file") throw new Error("expected file payload");
    await contentStore.delete(payload.snapshotKey);

    const response = await handlers.resolveGET(
      new Request(`${BASE_URL}/${ticket.number}/attachments/${added.value.id}`),
      routeContext(ticket.number, added.value.id),
    );
    expect(response.status).toBe(410);
    const body = await jsonOf(response);
    expect(body["code"]).toBe("content_unavailable");
  });

  it("returns 404 for an unknown attachment id", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const response = await handlers.resolveGET(
      new Request(`${BASE_URL}/${ticket.number}/attachments/missing`),
      routeContext(ticket.number, "missing"),
    );
    expect(response.status).toBe(404);
    const body = await jsonOf(response);
    expect(body).toEqual({
      error: `Attachment not found on ${PROJECT_NAME}#${ticket.number}: missing`,
      code: "attachment_not_found",
      details: { attachmentId: "missing" },
    });
  });
});

describe("edit PATCH and remove DELETE", () => {
  it("edits description and note markdown by attachment id", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const added = await attachmentService.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "before",
      payload: { kind: "note", markdown: "old" },
    });
    if (!added.ok) throw new Error("add failed");

    const response = await handlers.editPATCH(
      jsonRequest(
        `${BASE_URL}/${ticket.number}/attachments/${added.value.id}`,
        "PATCH",
        { description: "after", markdown: "new" },
      ),
      routeContext(ticket.number, added.value.id),
    );
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body["description"]).toBe("after");
    expect((body["payload"] as { markdown: string }).markdown).toBe("new");
  });

  it("removes an attachment and subsequent resolution is 404", async () => {
    const ticket = await createTicket();
    const handlers = buildHandlers();
    const added = await attachmentService.add({
      projectName: PROJECT_NAME,
      number: ticket.number,
      description: "to remove",
      payload: { kind: "note", markdown: "bye" },
    });
    if (!added.ok) throw new Error("add failed");

    const removed = await handlers.removeDELETE(
      new Request(
        `${BASE_URL}/${ticket.number}/attachments/${added.value.id}`,
        { method: "DELETE" },
      ),
      routeContext(ticket.number, added.value.id),
    );
    expect(removed.status).toBe(200);
    const removedBody = await jsonOf(removed);
    expect(removedBody["attachmentId"]).toBe(added.value.id);
    expect(removedBody["ticketUpdatedAt"]).toBe("2026-07-10T00:00:00.002Z");
    expect(
      (await repo.find(ticket.projectPath, ticket.number))?.updatedAt,
    ).toBe(removedBody["ticketUpdatedAt"]);

    const resolved = await handlers.resolveGET(
      new Request(`${BASE_URL}/${ticket.number}/attachments/${added.value.id}`),
      routeContext(ticket.number, added.value.id),
    );
    expect(resolved.status).toBe(404);
  });
});
