import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createArchiveSessionRouteHandler,
  createBulkSessionsRouteHandlers,
  createSessionRouteHandlers,
  type ArchiveSessionRouteDeps,
  type BulkSessionsRouteDeps,
  type CreateSessionRouteDeps,
} from "./route-handlers";
import { BackgroundWorkUnstoppedError } from "@/lib/conversation-core/background-work";
import { sessionStateSchema, type SessionState } from "./schemas";

function createTestDeps(): BulkSessionsRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    setSessionArchived: vi.fn().mockResolvedValue(undefined),
    bulkDeleteSessions: vi
      .fn()
      .mockImplementation(async (_projectPath: string, names: string[]) =>
        names.map((sessionName) => ({ sessionName, success: true })),
      ),
    stopAllForSession: vi.fn().mockResolvedValue(undefined),
    closeBackgroundWork: vi.fn(async (_scope, commit) => commit()),
  };
}

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/projects/test-proj/sessions/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeParams(name = "test-proj") {
  return { params: Promise.resolve({ name }) };
}

let deps: BulkSessionsRouteDeps;
let handlers: ReturnType<typeof createBulkSessionsRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createBulkSessionsRouteHandlers(deps);
});

describe("POST /api/projects/[name]/sessions/bulk", () => {
  it("returns 404 when project is unknown", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);
    const res = await handlers.POST(
      makeRequest({ op: "archive", sessionNames: ["a"] }),
      makeParams("nope"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Project not found");
  });

  it("returns 400 when op is invalid", async () => {
    const res = await handlers.POST(
      makeRequest({ op: "frobnicate", sessionNames: ["a"] }),
      makeParams(),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when sessionNames is empty", async () => {
    const res = await handlers.POST(
      makeRequest({ op: "delete", sessionNames: [] }),
      makeParams(),
    );
    expect(res.status).toBe(400);
  });

  it("archives every session and reports success", async () => {
    const res = await handlers.POST(
      makeRequest({ op: "archive", sessionNames: ["a", "b"] }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { sessionName: "a", success: true },
        { sessionName: "b", success: true },
      ],
    });
    expect(deps.setSessionArchived).toHaveBeenCalledTimes(2);
    expect(deps.setSessionArchived).toHaveBeenNthCalledWith(
      1,
      "/home/projects/test-proj",
      "a",
      true,
    );
    expect(deps.setSessionArchived).toHaveBeenNthCalledWith(
      2,
      "/home/projects/test-proj",
      "b",
      true,
    );
    expect(deps.bulkDeleteSessions).not.toHaveBeenCalled();
    expect(deps.stopAllForSession).toHaveBeenCalledWith({
      projectPath: "/home/projects/test-proj",
      sessionName: "a",
    });
    expect(deps.stopAllForSession).toHaveBeenCalledWith({
      projectPath: "/home/projects/test-proj",
      sessionName: "b",
    });
    // Stop must run before the archive flag flips for each session.
    const stopOrder = vi.mocked(deps.stopAllForSession).mock
      .invocationCallOrder[0]!;
    const archiveOrder = vi.mocked(deps.setSessionArchived).mock
      .invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(archiveOrder);
  });

  it("unarchives passes archived=false and does not stop dev servers", async () => {
    await handlers.POST(
      makeRequest({ op: "unarchive", sessionNames: ["a"] }),
      makeParams(),
    );
    expect(deps.setSessionArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "a",
      false,
    );
    expect(deps.stopAllForSession).not.toHaveBeenCalled();
  });

  it("deletes every session via a single bulkDeleteSessions call", async () => {
    const res = await handlers.POST(
      makeRequest({ op: "delete", sessionNames: ["a", "b"] }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.every((r: { success: boolean }) => r.success)).toBe(
      true,
    );
    expect(deps.bulkDeleteSessions).toHaveBeenCalledTimes(1);
    expect(deps.bulkDeleteSessions).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      ["a", "b"],
    );
    expect(deps.setSessionArchived).not.toHaveBeenCalled();
  });

  it("surfaces per-session failures from bulkDeleteSessions in the response", async () => {
    vi.mocked(deps.bulkDeleteSessions).mockResolvedValueOnce([
      { sessionName: "a", success: true },
      { sessionName: "b", success: false, error: "rm failed" },
      { sessionName: "c", success: true },
    ]);
    const res = await handlers.POST(
      makeRequest({ op: "delete", sessionNames: ["a", "b", "c"] }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { sessionName: "a", success: true },
        { sessionName: "b", success: false, error: "rm failed" },
        { sessionName: "c", success: true },
      ],
    });
  });

  it("captures per-item errors without aborting the batch", async () => {
    vi.mocked(deps.setSessionArchived).mockImplementation(
      async (_path, name) => {
        if (name === "b") throw new Error("boom");
      },
    );
    const res = await handlers.POST(
      makeRequest({ op: "archive", sessionNames: ["a", "b", "c"] }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { sessionName: "a", success: true },
        { sessionName: "b", success: false, error: "boom" },
        { sessionName: "c", success: true },
      ],
    });
    expect(deps.setSessionArchived).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// POST /api/projects/[name]/sessions — creation dispatch (two modes)
// ===========================================================================

function makeCreatedSession(name: string): SessionState {
  return sessionStateSchema.parse({
    sessionName: name,
    worktreePath: `/wt/${name}`,
    branchName: `csm/${name}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
  });
}

function createCreateSessionDeps(): CreateSessionRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    getSession: vi.fn().mockResolvedValue(null),
    createSessionNormal: vi
      .fn()
      .mockImplementation(async (_path: string, sessionName: string) =>
        makeCreatedSession(sessionName),
      ),
    createSessionOptimistic: vi
      .fn()
      .mockImplementation(async () => makeCreatedSession("ai-named")),
  };
}

function makeCreateRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/projects/test-proj/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("POST /api/projects/[name]/sessions (creation dispatch)", () => {
  let createDeps: CreateSessionRouteDeps;
  let createHandlers: ReturnType<typeof createSessionRouteHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    createDeps = createCreateSessionDeps();
    createHandlers = createSessionRouteHandlers(createDeps);
  });

  it("dispatches a normal-mode request to createSessionNormal", async () => {
    const res = await createHandlers.POST(
      makeCreateRequest({ mode: "normal", sessionName: "feature-x" }),
      makeParams(),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).sessionName).toBe("feature-x");
    expect(createDeps.createSessionNormal).toHaveBeenCalledTimes(1);
    expect(createDeps.createSessionNormal).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "feature-x",
      undefined,
      undefined,
    );
    expect(createDeps.createSessionOptimistic).not.toHaveBeenCalled();
  });

  it("dispatches an optimistic-mode request to createSessionOptimistic", async () => {
    const res = await createHandlers.POST(
      makeCreateRequest({ mode: "optimistic", instructions: "do the thing" }),
      makeParams(),
    );
    expect(res.status).toBe(201);
    expect(createDeps.createSessionOptimistic).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createDeps.createSessionOptimistic).mock.calls[0]!;
    expect(call[0]).toBe("/home/projects/test-proj");
    expect(call[1]).toBe("do the thing");
    expect(createDeps.createSessionNormal).not.toHaveBeenCalled();
  });

  it("rejects an unsupported creation mode (focus) with a 400 and creates nothing", async () => {
    const res = await createHandlers.POST(
      makeCreateRequest({ mode: "focus", objective: "ship it" }),
      makeParams(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mode/i);
    expect(createDeps.createSessionNormal).not.toHaveBeenCalled();
    expect(createDeps.createSessionOptimistic).not.toHaveBeenCalled();
  });

  it("rejects a fast-mode request (legacy mode removed) with a 400", async () => {
    const res = await createHandlers.POST(
      makeCreateRequest({ mode: "fast", sessionName: "legacy" }),
      makeParams(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mode/i);
    expect(createDeps.createSessionNormal).not.toHaveBeenCalled();
    expect(createDeps.createSessionOptimistic).not.toHaveBeenCalled();
  });

  it("returns 404 when the project is unknown", async () => {
    vi.mocked(createDeps.resolveProjectPath).mockResolvedValue(null);
    const res = await createHandlers.POST(
      makeCreateRequest({ mode: "normal", sessionName: "feature-x" }),
      makeParams("nope"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Project not found");
  });
});

describe("archiving sessions that keep background work (design C5b §5)", () => {
  const unstopped = () =>
    new BackgroundWorkUnstoppedError("conv-kept", "the CLI did not exit");

  /** A closing that records how it was asked and when its commit ran, refusing the scopes `refuse` names. */
  function closing(
    log: string[],
    refuse: (sessionName: string | undefined) => boolean = () => false,
  ): ArchiveSessionRouteDeps["closeBackgroundWork"] {
    return async (scope, commit, options) => {
      log.push(`close:${scope.sessionName}:${options.end}:${options.stop}`);
      if (refuse(scope.sessionName)) throw unstopped();
      try {
        return await commit();
      } finally {
        log.push(`closed:${scope.sessionName}`);
      }
    };
  }

  it("archives each session inside its closing, stopping dev servers only after its background work stopped, and reports one that cannot be stopped", async () => {
    const order: string[] = [];
    const bulk = createBulkSessionsRouteHandlers({
      ...createTestDeps(),
      stopAllForSession: vi.fn(async ({ sessionName }) => {
        order.push(`dev-servers:${sessionName}`);
      }),
      setSessionArchived: vi.fn(async (_projectPath, sessionName: string) => {
        order.push(`archive:${sessionName}`);
      }),
      closeBackgroundWork: closing(order, (name) => name === "busy"),
    });

    const res = await bulk.POST(
      makeRequest({ op: "archive", sessionNames: ["busy", "idle"] }),
      makeParams(),
    );

    expect(await res.json()).toEqual({
      results: [
        {
          sessionName: "busy",
          success: false,
          error: expect.stringContaining("could not be confirmed stopped"),
        },
        { sessionName: "idle", success: true },
      ],
    });
    expect(order).toEqual([
      "close:busy:archived:true",
      "close:idle:archived:true",
      "dev-servers:idle",
      "archive:idle",
      "closed:idle",
    ]);
  });

  function archiveDeps(
    overrides: Partial<ArchiveSessionRouteDeps> = {},
  ): ArchiveSessionRouteDeps {
    return {
      resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
      getSession: vi.fn().mockResolvedValue({ sessionName: "busy" }),
      setSessionArchived: vi.fn().mockResolvedValue(undefined),
      stopAllForSession: vi.fn().mockResolvedValue(undefined),
      closeBackgroundWork: vi.fn(async (_scope, commit) => commit()),
      ...overrides,
    };
  }

  function archiveRequest(archived: boolean): NextRequest {
    return new Request(
      "http://localhost/api/projects/test-proj/sessions/busy/archive",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      },
    ) as unknown as NextRequest;
  }
  const sessionParams = {
    params: Promise.resolve({ name: "test-proj", session: "busy" }),
  };

  it("archives the session inside its closing, stopping dev servers only after its background work stopped", async () => {
    const order: string[] = [];
    const deps = archiveDeps({
      closeBackgroundWork: closing(order),
      stopAllForSession: vi.fn(async () => {
        order.push("dev-servers");
      }),
      setSessionArchived: vi.fn(async () => {
        order.push("archive");
      }),
    });

    const res = await createArchiveSessionRouteHandler(deps)(
      archiveRequest(true),
      sessionParams,
    );

    expect(res.status).toBe(200);
    expect(order).toEqual([
      "close:busy:archived:true",
      "dev-servers",
      "archive",
      "closed:busy",
    ]);
  });

  it("refuses the archive with 409, changing nothing, when the session's background work cannot be confirmed stopped", async () => {
    const deps = archiveDeps({
      closeBackgroundWork: closing([], () => true),
    });

    const res = await createArchiveSessionRouteHandler(deps)(
      archiveRequest(true),
      sessionParams,
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "BACKGROUND_WORK_UNSTOPPED",
      details: { conversationId: "conv-kept" },
    });
    expect(deps.setSessionArchived).not.toHaveBeenCalled();
    expect(deps.stopAllForSession).not.toHaveBeenCalled();
  });

  it("closes nothing to unarchive a session", async () => {
    const deps = archiveDeps();

    await createArchiveSessionRouteHandler(deps)(
      archiveRequest(false),
      sessionParams,
    );

    expect(deps.closeBackgroundWork).not.toHaveBeenCalled();
    expect(deps.setSessionArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "busy",
      false,
    );
  });
});
