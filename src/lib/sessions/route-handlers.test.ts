import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createBulkSessionsRouteHandlers,
  type BulkSessionsRouteDeps,
} from "./route-handlers";

function createTestDeps(): BulkSessionsRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    setSessionArchived: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue({ worktreeRemoved: true }),
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
    expect(deps.deleteSession).not.toHaveBeenCalled();
  });

  it("unarchives passes archived=false", async () => {
    await handlers.POST(
      makeRequest({ op: "unarchive", sessionNames: ["a"] }),
      makeParams(),
    );
    expect(deps.setSessionArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "a",
      false,
    );
  });

  it("deletes every session via deleteSession", async () => {
    const res = await handlers.POST(
      makeRequest({ op: "delete", sessionNames: ["a", "b"] }),
      makeParams(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.every((r: { success: boolean }) => r.success)).toBe(
      true,
    );
    expect(deps.deleteSession).toHaveBeenCalledTimes(2);
    expect(deps.setSessionArchived).not.toHaveBeenCalled();
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
