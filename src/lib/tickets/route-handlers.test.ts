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
  createTicketsRouteHandlers,
  parseProjectNameParam,
  resolveIdentity,
  type TicketsRouteHandlers,
} from "./route-handlers";
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

async function resolveAvailableProjectPath(
  name: string,
): Promise<string | null> {
  return projectAvailable ? resolveProjectPath(name) : null;
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  const insertProject = db.prepare(
    "INSERT INTO projects (root_path) VALUES (?)",
  );
  insertProject.run(PROJECT_PATH);
  insertProject.run(OTHER_PROJECT_PATH);
  projectAvailable = true;
  let idSeq = 0;
  let clock = 0;
  const service = createTicketService({
    repo: createTicketsRepo(db, createWriteQueue()),
    resolveProjectPath,
    resolveAvailableProjectPath,
    deleteTicketContent: () => Promise.resolve(),
    publish: () => ({ delivered: true }),
    runProjectTicketOperation: (_projectPath, operation) =>
      operation({ projectDeletionPrecededOperation: false }),
    runTicketOperation: (_key, fn) => fn(),
    now: () => {
      clock += 1;
      return `2026-07-10T00:00:${String(clock).padStart(2, "0")}.000Z`;
    },
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

async function createTicket(
  overrides: Partial<{
    projectName: string;
    title: string;
    workType: string;
    status: string;
    description: string;
  }> = {},
): Promise<Record<string, unknown>> {
  const { projectName = PROJECT_NAME, ...body } = overrides;
  const response = await handlers.projectCreatePOST(
    createRequest({ title: "Ship tickets", workType: "feature", ...body }),
    projectContext(projectName),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Record<string, unknown>;
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
