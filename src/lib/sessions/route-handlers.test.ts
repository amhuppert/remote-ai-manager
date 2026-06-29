import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createBulkSessionsRouteHandlers,
  createSessionRouteHandlers,
  type BulkSessionsRouteDeps,
  type CreateSessionRouteDeps,
} from "./route-handlers";
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
