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

import type Database from "better-sqlite3";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createTicketsRepo } from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createCreateAttachmentPlanner,
  type CreateAttachmentPlannerDeps,
} from "./create-attachment-planner";
import {
  createTicketsRouteHandlers,
  MAX_TICKET_CREATE_BODY_BYTES,
  parseProjectNameParam,
  resolveIdentity,
  type TicketsRouteHandlers,
} from "./route-handlers";
import {
  createTicketResponseSchema,
  ticketDetailSchema,
  type QuickTicketDiagnostics,
} from "./schemas";
import { createTicketService } from "./service";

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT_NAME = "other-repo";
const OTHER_PROJECT_PATH = "/repos/other-repo";

const PROJECTS: Record<string, string> = {
  [PROJECT_NAME]: PROJECT_PATH,
  [OTHER_PROJECT_NAME]: OTHER_PROJECT_PATH,
};

describe("ticket route segment parsing", () => {
  it("preserves the framework-decoded project name for identity routes", async () => {
    await expect(
      resolveIdentity({
        params: Promise.resolve({
          name: "literal%20project",
          number: "12",
        }),
      }),
    ).resolves.toEqual({ projectName: "literal%20project", number: 12 });
  });

  it("preserves the framework-decoded project name for collection routes", () => {
    expect(parseProjectNameParam({ name: "literal%20project" })).toEqual({
      ok: true,
      projectName: "literal%20project",
    });
  });
});

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
  return PROJECTS[name] ?? null;
}

let db: Db;
let handlers: TicketsRouteHandlers;
let projectAvailable: boolean;
let unavailableProjectNames: Set<string>;
let conversationExists: ReturnType<
  typeof vi.fn<CreateAttachmentPlannerDeps["conversationExists"]>
>;

async function resolveAvailableProjectPath(
  name: string,
): Promise<string | null> {
  if (!projectAvailable || unavailableProjectNames.has(name)) return null;
  return resolveProjectPath(name);
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const insertProject = db.prepare(
    "INSERT INTO projects (root_path) VALUES (?)",
  );
  insertProject.run(PROJECT_PATH);
  insertProject.run(OTHER_PROJECT_PATH);
  projectAvailable = true;
  unavailableProjectNames = new Set();
  conversationExists = vi.fn(async () => true);
  let idSeq = 0;
  let attachmentIdSeq = 0;
  let clock = 0;
  function now(): string {
    clock += 1;
    return `2026-07-10T00:00:${String(clock).padStart(2, "0")}.000Z`;
  }
  const service = createTicketService({
    repo: createTicketsRepo(db, createWriteQueue()),
    attachmentPlanner: createCreateAttachmentPlanner({
      resolveAvailableProjectPath,
      conversationExists,
      async captureScreenshot(input) {
        return {
          snapshotKey: `${input.ticketId}/${input.attachmentId}/${input.fileName}`,
          fileName: input.fileName,
          sizeBytes: input.bytes.byteLength,
          sha256: "route-test-screenshot-sha",
        };
      },
      async deleteSnapshot() {},
      diagnosticEnvironment() {
        return {
          sha: "route-test-sha",
          buildTime: "2026-07-10T00:00:00.000Z",
          appVersion: "0.1.0",
          platform: "route-test-platform",
        };
      },
      scheduleConversationSnapshotRefresh() {},
      scheduleEnrichment() {},
      generateId() {
        attachmentIdSeq += 1;
        return `attachment-${attachmentIdSeq}`;
      },
      now,
    }),
    resolveProjectPath,
    resolveAvailableProjectPath,
    deleteTicketContent: () => Promise.resolve(),
    publish: () => ({ delivered: true }),
    runProjectTicketOperation: (_projectPath, operation) =>
      operation({ projectDeletionPrecededOperation: false }),
    runTicketOperation: (_key, fn) => fn(),
    now,
    generateId: () => {
      idSeq += 1;
      return `ticket-${idSeq}`;
    },
  });
  handlers = createTicketsRouteHandlers({
    getService: () => service,
    resolveProjectPath,
    resolveAvailableProjectPath,
    auth: grantedAuth(),
  });
});

afterEach(() => {
  db.close();
});

function projectContext(name: string) {
  return { params: Promise.resolve({ name }) };
}

function detailContext(name: string, number: string) {
  return { params: Promise.resolve({ name, number }) };
}

function createRequest(body: unknown): Request {
  return new Request("http://localhost/api/projects/x/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function diagnostics(
  conversationId: string,
  overrides: Partial<QuickTicketDiagnostics> = {},
): QuickTicketDiagnostics {
  return {
    capturedAt: "2026-07-19T12:00:00.000Z",
    route: {
      url: `/projects/${OTHER_PROJECT_NAME}/conversations/${conversationId}`,
      viewState: "pane=conversation",
    },
    identities: {
      projectName: OTHER_PROJECT_NAME,
      conversationId,
      deepLinks: [],
    },
    clientErrors: [],
    removed: [],
    ...overrides,
  };
}

async function postCreateTicket(body: unknown, projectName = PROJECT_NAME) {
  const response = await handlers.projectCreatePOST(
    createRequest(body),
    projectContext(projectName),
  );
  expect(response.status).toBe(201);
  return createTicketResponseSchema.parse(await response.json());
}

async function createTicket(
  overrides: Partial<{
    projectName: string;
    title: string;
    workType: string;
    status: string;
    description: string;
  }> = {},
) {
  const { projectName = PROJECT_NAME, ...body } = overrides;
  const payload = await postCreateTicket(
    { title: "Ship tickets", workType: "feature", ...body },
    projectName,
  );
  expect(payload.warnings).toEqual([]);
  return payload.ticket;
}

describe("global list GET /api/tickets", () => {
  it("returns an empty list when no tickets exist", async () => {
    const response = await handlers.globalListGET(
      new Request("http://localhost/api/tickets"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("returns tickets across projects and applies filters", async () => {
    await createTicket({ title: "Feature A", workType: "feature" });
    await createTicket({
      title: "Bug B",
      workType: "bug",
      status: "in_progress",
      projectName: OTHER_PROJECT_NAME,
    });

    const all = await handlers.globalListGET(
      new Request("http://localhost/api/tickets"),
    );
    const allItems = (await all.json()) as Array<Record<string, unknown>>;
    expect(allItems).toHaveLength(2);

    const filtered = await handlers.globalListGET(
      new Request("http://localhost/api/tickets?status=in_progress"),
    );
    const filteredItems = (await filtered.json()) as Array<
      Record<string, unknown>
    >;
    expect(filteredItems).toHaveLength(1);
    expect(filteredItems[0]?.["title"]).toBe("Bug B");

    // The status param is a comma-separated set: membership, not equality.
    const multi = await handlers.globalListGET(
      new Request(
        "http://localhost/api/tickets?status=in_progress,not_started",
      ),
    );
    const multiItems = (await multi.json()) as Array<Record<string, unknown>>;
    expect(multiItems.map((row) => row["title"]).sort()).toEqual([
      "Bug B",
      "Feature A",
    ]);

    const invalid = await handlers.globalListGET(
      new Request("http://localhost/api/tickets?status=in_progress,bogus"),
    );
    expect(invalid.status).toBe(400);

    const byProject = await handlers.globalListGET(
      new Request(`http://localhost/api/tickets?project=${PROJECT_NAME}`),
    );
    const projectItems = (await byProject.json()) as Array<
      Record<string, unknown>
    >;
    expect(projectItems).toHaveLength(1);
    expect(projectItems[0]?.["projectName"]).toBe(PROJECT_NAME);
  });

  it("rejects an invalid filter with 400 and structured issues", async () => {
    const response = await handlers.globalListGET(
      new Request("http://localhost/api/tickets?sort=bogus"),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
    expect(Array.isArray(body["issues"])).toBe(true);
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const gated = createTicketsRouteHandlers({
      getService: () => {
        throw new Error("service must not be reached");
      },
      resolveProjectPath,
      resolveAvailableProjectPath,
      auth: rejectedAuth(),
    });
    const response = await gated.globalListGET(
      new Request("http://localhost/api/tickets"),
    );
    expect(response.status).toBe(401);
  });
});

describe("project list GET /api/projects/:name/tickets", () => {
  it("returns 404 with a stable code for an unknown project", async () => {
    const response = await handlers.projectListGET(
      new Request("http://localhost/api/projects/nope/tickets"),
      projectContext("nope"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("project_not_found");
  });

  it("rejects a missing project-name param with 400 issues before resolution", async () => {
    const response = await handlers.projectListGET(
      new Request("http://localhost/api/projects//tickets"),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
    expect(Array.isArray(body["issues"])).toBe(true);
  });

  it("lists only the project's tickets", async () => {
    await createTicket({ title: "Mine" });
    await createTicket({ title: "Theirs", projectName: OTHER_PROJECT_NAME });

    const response = await handlers.projectListGET(
      new Request("http://localhost/api/projects/command-center/tickets"),
      projectContext(PROJECT_NAME),
    );
    expect(response.status).toBe(200);
    const items = (await response.json()) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.["title"]).toBe("Mine");
  });

  it("lists retained tickets when the project checkout is unavailable", async () => {
    await createTicket({ title: "Retained" });
    projectAvailable = false;

    const response = await handlers.projectListGET(
      new Request("http://localhost/api/projects/command-center/tickets"),
      projectContext(PROJECT_NAME),
    );

    expect(response.status).toBe(200);
    const items = (await response.json()) as Array<Record<string, unknown>>;
    expect(items.map((item) => item["title"])).toEqual(["Retained"]);
  });
});

describe("create POST /api/projects/:name/tickets", () => {
  it("creates a ticket with the not_started default and returns 201 detail", async () => {
    const detail = await createTicket({ title: "First" });
    expect(detail["number"]).toBe(1);
    expect(detail["status"]).toBe("not_started");
    expect(detail["projectName"]).toBe(PROJECT_NAME);
    expect(detail["attachments"]).toEqual([]);
    expect(detail["sessions"]).toEqual([]);
  });

  it("persists generic conversation context from a source project that differs from the ticket target", async () => {
    const payload = await postCreateTicket({
      title: "Cross-project context",
      workType: "feature",
      conversationContext: {
        sourceProjectName: OTHER_PROJECT_NAME,
        sessionName: "source-session",
        conversationId: "source-conversation",
        title: "Observed source conversation",
      },
    });

    expect(payload.warnings).toEqual([]);
    expect(payload.ticket).toMatchObject({
      projectName: PROJECT_NAME,
      projectPath: PROJECT_PATH,
    });
    expect(payload.ticket.attachments).toEqual([
      expect.objectContaining({
        description: "Observed source conversation",
        payload: {
          kind: "conversation",
          projectPath: OTHER_PROJECT_PATH,
          sessionName: "source-session",
          conversationId: "source-conversation",
          snapshotKey: null,
          snapshotCapturedAt: null,
          snapshotStatus: "pending",
        },
      }),
    ]);
    expect(conversationExists).toHaveBeenCalledWith(
      OTHER_PROJECT_PATH,
      "source-session",
      "source-conversation",
    );
  });

  it("persists project-level conversation context from another project in diagnostics bug mode", async () => {
    const conversationId = "project-conversation";
    const payload = await postCreateTicket({
      title: "Command Center bug",
      workType: "bug",
      diagnostics: diagnostics(conversationId),
      conversationContext: {
        sourceProjectName: OTHER_PROJECT_NAME,
        sessionName: null,
        conversationId,
        title: "Project conversation",
      },
    });

    expect(payload.warnings).toEqual([]);
    expect(payload.ticket).toMatchObject({
      projectName: PROJECT_NAME,
      projectPath: PROJECT_PATH,
      workType: "bug",
    });
    expect(
      payload.ticket.attachments.map((attachment) => attachment.payload.kind),
    ).toEqual(["note", "conversation"]);
    expect(payload.ticket.attachments[1]).toMatchObject({
      description: "Conversation active when the bug was observed",
      payload: {
        kind: "conversation",
        projectPath: OTHER_PROJECT_PATH,
        sessionName: null,
        conversationId,
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "pending",
      },
    });
    expect(conversationExists).toHaveBeenCalledWith(
      OTHER_PROJECT_PATH,
      null,
      conversationId,
    );
  });

  it("creates with a warning and omits context when only the source project is unavailable", async () => {
    unavailableProjectNames.add(OTHER_PROJECT_NAME);

    const payload = await postCreateTicket({
      title: "Stale source project",
      workType: "feature",
      conversationContext: {
        sourceProjectName: OTHER_PROJECT_NAME,
        sessionName: null,
        conversationId: "stale-conversation",
      },
    });

    expect(payload.ticket.projectName).toBe(PROJECT_NAME);
    expect(payload.ticket.attachments).toEqual([]);
    expect(payload.warnings).toEqual([
      {
        code: "conversation_source_unavailable",
        message:
          "Conversation context was not attached because project 'other-repo' is unavailable.",
      },
    ]);
    expect(conversationExists).not.toHaveBeenCalled();

    const persistedResponse = await handlers.detailGET(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/tickets/${payload.ticket.number}`,
      ),
      detailContext(PROJECT_NAME, String(payload.ticket.number)),
    );
    expect(persistedResponse.status).toBe(200);
    const persisted = ticketDetailSchema.parse(await persistedResponse.json());
    expect(persisted.attachments).toEqual([]);
  });

  it("persists a failed conversation row when the source project resolves but the conversation is unknown", async () => {
    conversationExists.mockResolvedValue(false);

    const payload = await postCreateTicket({
      title: "Stale source conversation",
      workType: "feature",
      conversationContext: {
        sourceProjectName: OTHER_PROJECT_NAME,
        sessionName: null,
        conversationId: "unknown-conversation",
      },
    });

    expect(payload.warnings).toEqual([]);
    expect(payload.ticket.attachments).toHaveLength(1);
    expect(payload.ticket.attachments[0]?.payload).toEqual({
      kind: "conversation",
      projectPath: OTHER_PROJECT_PATH,
      sessionName: null,
      conversationId: "unknown-conversation",
      snapshotKey: null,
      snapshotCapturedAt: null,
      snapshotStatus: "failed",
      snapshotError: "The source conversation is unavailable.",
    });

    const persistedResponse = await handlers.detailGET(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/tickets/${payload.ticket.number}`,
      ),
      detailContext(PROJECT_NAME, String(payload.ticket.number)),
    );
    expect(persistedResponse.status).toBe(200);
    const persisted = ticketDetailSchema.parse(await persistedResponse.json());
    expect(persisted.attachments[0]?.payload).toEqual(
      payload.ticket.attachments[0]?.payload,
    );
  });

  it("rejects a missing project-name param with 400 issues before resolution", async () => {
    const response = await handlers.projectCreatePOST(
      createRequest({ title: "x", workType: "feature" }),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
  });

  it("rejects a body missing required fields with 400 issues", async () => {
    const response = await handlers.projectCreatePOST(
      createRequest({ workType: "feature" }),
      projectContext(PROJECT_NAME),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
    const issues = body["issues"] as Array<Record<string, unknown>>;
    expect(issues.some((issue) => issue["path"] === "title")).toBe(true);
  });

  it("rejects diagnostics for a non-bug ticket", async () => {
    const response = await handlers.projectCreatePOST(
      createRequest({
        title: "Feature with diagnostics",
        workType: "feature",
        diagnostics: diagnostics("conversation-1"),
      }),
      projectContext(PROJECT_NAME),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
    expect(body["issues"]).toContainEqual(
      expect.objectContaining({
        path: "diagnostics",
        message: "diagnostics are only available for bug tickets",
      }),
    );
  });

  it("rejects a non-JSON body with 400", async () => {
    const response = await handlers.projectCreatePOST(
      new Request("http://localhost/api/projects/x/tickets", {
        method: "POST",
        body: "not json",
      }),
      projectContext(PROJECT_NAME),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
  });

  it("rejects a declared oversized create body before reading it", async () => {
    const response = await handlers.projectCreatePOST(
      new Request("http://localhost/api/projects/x/tickets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(MAX_TICKET_CREATE_BODY_BYTES + 1),
        },
        body: JSON.stringify({ title: "x", workType: "bug" }),
      }),
      projectContext(PROJECT_NAME),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      code: "payload_too_large",
      details: { maxBytes: MAX_TICKET_CREATE_BODY_BYTES },
    });
  });

  it("cuts off a streamed create body whose declared length is dishonest", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        emitted += chunk.byteLength;
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handlers.projectCreatePOST(
      new Request("http://localhost/api/projects/x/tickets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "2",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
      projectContext(PROJECT_NAME),
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("returns 404 for an unknown project", async () => {
    const response = await handlers.projectCreatePOST(
      createRequest({ title: "x", workType: "feature" }),
      projectContext("nope"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when a retained project's checkout is unavailable", async () => {
    projectAvailable = false;

    const response = await handlers.projectCreatePOST(
      createRequest({ title: "x", workType: "feature" }),
      projectContext(PROJECT_NAME),
    );

    expect(response.status).toBe(404);
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const gated = createTicketsRouteHandlers({
      getService: () => {
        throw new Error("service must not be reached");
      },
      resolveProjectPath,
      resolveAvailableProjectPath,
      auth: rejectedAuth(),
    });
    const response = await gated.projectCreatePOST(
      createRequest({ title: "x", workType: "feature" }),
      projectContext(PROJECT_NAME),
    );
    expect(response.status).toBe(401);
  });
});

describe("detail GET /api/projects/:name/tickets/:number", () => {
  it("round-trips a created ticket", async () => {
    await createTicket({ title: "Read me", description: "body" });
    const response = await handlers.detailGET(
      new Request("http://localhost/api/projects/command-center/tickets/1"),
      detailContext(PROJECT_NAME, "1"),
    );
    expect(response.status).toBe(200);
    const detail = (await response.json()) as Record<string, unknown>;
    expect(detail["title"]).toBe("Read me");
    expect(detail["description"]).toBe("body");
    expect(detail["number"]).toBe(1);
  });

  it("returns 404 with the ticket_not_found code and identifier", async () => {
    const response = await handlers.detailGET(
      new Request("http://localhost/api/projects/command-center/tickets/99"),
      detailContext(PROJECT_NAME, "99"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("ticket_not_found");
    expect(body["error"]).toContain("command-center#99");
  });

  it("rejects a non-numeric ticket number with 400", async () => {
    const response = await handlers.detailGET(
      new Request("http://localhost/api/projects/command-center/tickets/abc"),
      detailContext(PROJECT_NAME, "abc"),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
  });

  it.each(["0x1", "1e0", " 1 ", "+1", "01", "9007199254740992"])(
    "rejects the noncanonical ticket segment %j with 400",
    async (number) => {
      const response = await handlers.detailGET(
        new Request(
          `http://localhost/api/projects/command-center/tickets/${encodeURIComponent(number)}`,
        ),
        detailContext(PROJECT_NAME, number),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation_failed");
    },
  );
});

describe("update PATCH /api/projects/:name/tickets/:number", () => {
  function patchRequest(body: unknown): Request {
    return new Request(
      "http://localhost/api/projects/command-center/tickets/1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  it("updates fields and persists them", async () => {
    await createTicket({ title: "Before" });
    const response = await handlers.detailPATCH(
      patchRequest({ title: "After", status: "done" }),
      detailContext(PROJECT_NAME, "1"),
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated["title"]).toBe("After");
    expect(updated["status"]).toBe("done");

    const reread = await handlers.detailGET(
      new Request("http://localhost/api/projects/command-center/tickets/1"),
      detailContext(PROJECT_NAME, "1"),
    );
    const detail = (await reread.json()) as Record<string, unknown>;
    expect(detail["title"]).toBe("After");
    expect(detail["status"]).toBe("done");
  });

  it("returns 404 for an unknown ticket", async () => {
    const response = await handlers.detailPATCH(
      patchRequest({ status: "done" }),
      detailContext(PROJECT_NAME, "42"),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("ticket_not_found");
  });

  it("rejects an invalid status value with 400 issues", async () => {
    await createTicket();
    const response = await handlers.detailPATCH(
      patchRequest({ status: "bogus" }),
      detailContext(PROJECT_NAME, "1"),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("validation_failed");
  });
});

describe("delete DELETE /api/projects/:name/tickets/:number", () => {
  function deleteRequest(): Request {
    return new Request(
      "http://localhost/api/projects/command-center/tickets/1",
      { method: "DELETE" },
    );
  }

  it("deletes the ticket and returns its identity", async () => {
    await createTicket();
    const response = await handlers.detailDELETE(
      deleteRequest(),
      detailContext(PROJECT_NAME, "1"),
    );
    expect(response.status).toBe(200);
    const deleted = (await response.json()) as Record<string, unknown>;
    expect(deleted["projectName"]).toBe(PROJECT_NAME);
    expect(deleted["number"]).toBe(1);

    const reread = await handlers.detailGET(
      new Request("http://localhost/api/projects/command-center/tickets/1"),
      detailContext(PROJECT_NAME, "1"),
    );
    expect(reread.status).toBe(404);
  });

  it("returns 404 for an unknown ticket", async () => {
    const response = await handlers.detailDELETE(
      deleteRequest(),
      detailContext(PROJECT_NAME, "1"),
    );
    expect(response.status).toBe(404);
  });
});
