import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  createArchiveRouteHandlers,
  type ArchiveRouteDeps,
} from "./archive-route-handlers";
import { BackgroundWorkUnstoppedError } from "@/lib/conversation-core/background-work";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(): ArchiveRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    setProjectArchived: vi.fn().mockResolvedValue(undefined),
    getProjectSessionListItems: vi.fn().mockResolvedValue([]),
    stopAllForSession: vi.fn().mockResolvedValue(undefined),
    closeBackgroundWork: vi.fn(async (_scope, commit) => commit()),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/projects/test-proj/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeParams(name = "test-proj") {
  return { params: Promise.resolve({ name }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: ArchiveRouteDeps;
let handlers: ReturnType<typeof createArchiveRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createArchiveRouteHandlers(deps);
});

// ===========================================================================
// API route tests
// ===========================================================================

describe("POST /api/projects/[name]/archive", () => {
  it("archives a project when archived:true", async () => {
    const response = await handlers.POST(
      makeRequest({ archived: true }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deps.setProjectArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      true,
    );
  });

  it("stops every session's dev servers before archiving the project", async () => {
    vi.mocked(deps.getProjectSessionListItems).mockResolvedValue([
      { sessionName: "alpha" },
      { sessionName: "beta" },
    ]);

    const response = await handlers.POST(
      makeRequest({ archived: true }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.stopAllForSession).toHaveBeenCalledWith({
      projectPath: "/home/projects/test-proj",
      sessionName: "alpha",
    });
    expect(deps.stopAllForSession).toHaveBeenCalledWith({
      projectPath: "/home/projects/test-proj",
      sessionName: "beta",
    });
    const stopOrder = vi.mocked(deps.stopAllForSession).mock
      .invocationCallOrder[0]!;
    const archiveOrder = vi.mocked(deps.setProjectArchived).mock
      .invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(archiveOrder);
  });

  it("unarchives a project when archived:false and does not stop dev servers", async () => {
    const response = await handlers.POST(
      makeRequest({ archived: false }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.setProjectArchived).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      false,
    );
    expect(deps.stopAllForSession).not.toHaveBeenCalled();
    expect(deps.getProjectSessionListItems).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown project", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);

    const response = await handlers.POST(
      makeRequest({ archived: true }),
      makeParams("nonexistent"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 400 for invalid body", async () => {
    const response = await handlers.POST(
      makeRequest({ invalid: "data" }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("archived");
  });
});

describe("archiving a project whose conversations keep background work (design C5b §5)", () => {
  it("archives the project inside its closing, stopping dev servers only after its background work stopped", async () => {
    const order: string[] = [];
    const deps = createTestDeps();
    deps.getProjectSessionListItems = vi
      .fn()
      .mockResolvedValue([{ sessionName: "s1" }]);
    deps.closeBackgroundWork = vi.fn(async (scope, commit, options) => {
      order.push(
        `close:${JSON.stringify(scope)}:${options.end}:${options.stop}`,
      );
      const value = await commit();
      order.push("closed");
      return value;
    });
    deps.stopAllForSession = vi.fn(async ({ sessionName }) => {
      order.push(`dev-servers:${sessionName}`);
    });
    deps.setProjectArchived = vi.fn(async () => {
      order.push("archive");
    });

    const res = await createArchiveRouteHandlers(deps).POST(
      makeRequest({ archived: true }),
      makeParams(),
    );

    expect(res.status).toBe(200);
    expect(order).toEqual([
      `close:${JSON.stringify({ projectPath: "/home/projects/test-proj" })}:archived:true`,
      "dev-servers:s1",
      "archive",
      "closed",
    ]);
  });

  it("refuses the archive with 409, changing nothing, when the background work cannot be confirmed stopped", async () => {
    const deps = createTestDeps();
    deps.closeBackgroundWork = vi.fn(async () => {
      throw new BackgroundWorkUnstoppedError(
        "conv-kept",
        "the CLI did not exit",
      );
    });

    const res = await createArchiveRouteHandlers(deps).POST(
      makeRequest({ archived: true }),
      makeParams(),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "BACKGROUND_WORK_UNSTOPPED",
      details: { conversationId: "conv-kept" },
    });
    expect(deps.setProjectArchived).not.toHaveBeenCalled();
    expect(deps.stopAllForSession).not.toHaveBeenCalled();
  });

  it("closes nothing to unarchive a project", async () => {
    const deps = createTestDeps();

    await createArchiveRouteHandlers(deps).POST(
      makeRequest({ archived: false }),
      makeParams(),
    );

    expect(deps.closeBackgroundWork).not.toHaveBeenCalled();
  });
});
