import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { CommandItem } from "@/lib/commands/schemas";
import {
  createCommandsRouteHandlers,
  createProjectCommandsRouteHandlers,
  type CommandsRouteDeps,
  type ProjectCommandsRouteDeps,
} from "./route-handlers";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

const testSession = {
  sessionName: "test-session",
  worktreePath: "/projects/my-project/.worktrees/test-session",
  branchName: "csm/test-session",
  transcriptPath: null,
  status: "ready" as const,
  createdAt: "2024-01-01T00:00:00Z",
  lastActivityAt: "2024-01-01T00:00:00Z",
  promptCount: 0,
  archived: false,
  finished: false,
  messages: [],
};

const testCommands: CommandItem[] = [
  {
    name: "/commit",
    description: "Create a commit",
    type: "command",
    source: "project",
  },
  {
    name: "/review",
    description: "Review recent changes",
    type: "command",
    source: "project",
  },
];

function createTestDeps(): CommandsRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession: vi.fn().mockResolvedValue(testSession),
    discoverCommands: vi.fn().mockResolvedValue(testCommands),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(): NextRequest {
  return new Request(
    "http://localhost/api/projects/my-project/sessions/test-session/commands",
    { method: "GET" },
  ) as unknown as NextRequest;
}

function makeParams(name = "my-project", session = "test-session") {
  return { params: Promise.resolve({ name, session }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: CommandsRouteDeps;
let handlers: ReturnType<typeof createCommandsRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createCommandsRouteHandlers(deps);
});

// ===========================================================================
// GET /api/projects/[name]/sessions/[session]/commands
// ===========================================================================

describe("GET /api/projects/[name]/sessions/[session]/commands", () => {
  it("returns 200 with correct response shape", async () => {
    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: CommandItem[] };
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual(
      expect.objectContaining({
        name: "/commit",
        type: "command",
        source: "project",
      }),
    );
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Project not found");
  });

  it("returns 404 when session not found", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(null);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("returns 500 on discovery error", async () => {
    vi.mocked(deps.discoverCommands).mockRejectedValue(
      new Error("Scan failed"),
    );

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Scan failed");
  });

  it("passes the requested backend to command discovery", async () => {
    const request = new Request(
      "http://localhost/api/projects/my-project/sessions/test-session/commands?backend=codex",
      { method: "GET" },
    ) as unknown as NextRequest;

    await handlers.GET(request, makeParams());

    expect(deps.discoverCommands).toHaveBeenCalledWith(
      testSession.worktreePath,
      "codex",
    );
  });

  it("returns empty items for project with no commands", async () => {
    vi.mocked(deps.discoverCommands).mockResolvedValue([]);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: CommandItem[] };
    expect(body.items).toEqual([]);
  });
});

// ===========================================================================
// GET /api/projects/[name]/commands
// ===========================================================================

describe("GET /api/projects/[name]/commands", () => {
  function createProjectTestDeps(): ProjectCommandsRouteDeps {
    return {
      resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
      discoverCommands: vi.fn().mockResolvedValue(testCommands),
    };
  }

  function makeProjectRequest(
    url = "http://localhost/api/projects/my-project/commands",
  ) {
    return new Request(url, { method: "GET" });
  }

  it("discovers commands from the project root", async () => {
    const projectDeps = createProjectTestDeps();
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);

    const response = await projectHandlers.GET(makeProjectRequest(), {
      params: Promise.resolve({ name: "my-project" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: CommandItem[] };
    expect(body.items).toEqual(testCommands);
    expect(projectDeps.discoverCommands).toHaveBeenCalledWith(
      "/projects/my-project",
      "claude",
    );
  });

  it("passes the requested backend to command discovery", async () => {
    const projectDeps = createProjectTestDeps();
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);

    await projectHandlers.GET(
      makeProjectRequest(
        "http://localhost/api/projects/my-project/commands?backend=codex",
      ),
      { params: Promise.resolve({ name: "my-project" }) },
    );

    expect(projectDeps.discoverCommands).toHaveBeenCalledWith(
      "/projects/my-project",
      "codex",
    );
  });
});
