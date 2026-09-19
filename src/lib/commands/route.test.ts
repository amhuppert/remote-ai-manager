import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { CommandItem } from "@/lib/commands/schemas";
import { CapabilityRouteNotFoundError } from "@/lib/agent-capabilities/route-handlers";
import { DEFAULT_AGENT_BACKEND_ID } from "@/lib/shared/schemas";
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

function makeSessionRequest(backend: string): NextRequest {
  const url = new URL(
    "http://localhost/api/projects/my-project/sessions/test-session/commands",
  );
  url.searchParams.set("backend", backend);
  return new NextRequest(url, { method: "GET" });
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
      expect.objectContaining({
        level: "session",
        projectPath: "/projects/my-project",
        sessionName: "test-session",
      }),
    );
  });

  it("scopes discovery to the requested session conversation", async () => {
    const request = makeSessionRequest("codex");
    request.nextUrl.searchParams.set("conversationId", "conv-session");
    await handlers.GET(new NextRequest(request.nextUrl), makeParams());

    expect(deps.discoverCommands).toHaveBeenCalledWith(
      testSession.worktreePath,
      "codex",
      {
        level: "conversation",
        projectName: "my-project",
        projectPath: "/projects/my-project",
        conversationScope: "session",
        sessionName: "test-session",
        conversationId: "conv-session",
      },
    );
  });

  it("returns 404 for a conversation outside the requested session", async () => {
    vi.mocked(deps.discoverCommands).mockRejectedValue(
      new CapabilityRouteNotFoundError("Conversation not found"),
    );
    const response = await handlers.GET(
      makeSessionRequest("codex"),
      makeParams(),
    );
    expect(response.status).toBe(404);
  });

  it("returns empty items for project with no commands", async () => {
    vi.mocked(deps.discoverCommands).mockResolvedValue([]);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: CommandItem[] };
    expect(body.items).toEqual([]);
  });

  it("uses the default backend when the backend query is absent", async () => {
    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    expect(deps.discoverCommands).toHaveBeenCalledWith(
      testSession.worktreePath,
      DEFAULT_AGENT_BACKEND_ID,
      expect.objectContaining({
        level: "session",
        projectPath: "/projects/my-project",
        sessionName: "test-session",
      }),
    );
  });

  it("passes an explicit claude backend to command discovery", async () => {
    await handlers.GET(makeSessionRequest("claude"), makeParams());

    expect(deps.discoverCommands).toHaveBeenCalledWith(
      testSession.worktreePath,
      "claude",
      expect.objectContaining({
        level: "session",
        projectPath: "/projects/my-project",
        sessionName: "test-session",
      }),
    );
  });

  it("passes an explicit cursor backend to command discovery and returns its bounded empty result", async () => {
    // Cursor is registered and parses canonically, and the SDK exposes no
    // command surface — so the honest answer is an empty result reached
    // WITHOUT scanning another backend's directories. The discoverer's
    // no-scan behaviour is pinned in service.test.ts; here the contract is
    // that the route passes cursor through rather than coercing it.
    vi.mocked(deps.discoverCommands).mockResolvedValue([]);

    const response = await handlers.GET(
      makeSessionRequest("cursor"),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.discoverCommands).toHaveBeenCalledWith(
      testSession.worktreePath,
      "cursor",
      expect.objectContaining({
        level: "session",
        projectPath: "/projects/my-project",
        sessionName: "test-session",
      }),
    );
    const body = (await response.json()) as { items: CommandItem[] };
    expect(body.items).toEqual([]);
  });

  it("rejects an unknown backend with a bounded 400 instead of defaulting", async () => {
    const response = await handlers.GET(
      makeSessionRequest("not-a-registered-backend"),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(deps.discoverCommands).not.toHaveBeenCalled();
    const body = (await response.json()) as { error: string; code?: string };
    expect(body.code).toBe("INVALID_BACKEND");
    expect(body.error).toContain("backend");
  });

  it("does not echo an unbounded unknown backend value in the error", async () => {
    const oversized = "x".repeat(5000);

    const response = await handlers.GET(
      makeSessionRequest(oversized),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(deps.discoverCommands).not.toHaveBeenCalled();
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain(oversized);
    expect(body.error.length).toBeLessThan(200);
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
      expect.objectContaining({
        level: "project",
        projectPath: "/projects/my-project",
      }),
    );
  });

  it("scopes discovery to the requested project conversation", async () => {
    const projectDeps = createProjectTestDeps();
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);
    const response = await projectHandlers.GET(
      makeProjectRequest(
        "http://localhost/api/projects/my-project/commands?backend=codex&conversationId=conv-project",
      ),
      { params: Promise.resolve({ name: "my-project" }) },
    );
    expect(response.status).toBe(200);
    expect(projectDeps.discoverCommands).toHaveBeenCalledWith(
      "/projects/my-project",
      "codex",
      {
        level: "conversation",
        projectName: "my-project",
        projectPath: "/projects/my-project",
        conversationScope: "project",
        conversationId: "conv-project",
      },
    );
  });

  it("returns 404 for a conversation outside the requested project", async () => {
    const projectDeps = createProjectTestDeps();
    vi.mocked(projectDeps.discoverCommands).mockRejectedValue(
      new CapabilityRouteNotFoundError("Project conversation not found"),
    );
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);
    const response = await projectHandlers.GET(makeProjectRequest(), {
      params: Promise.resolve({ name: "my-project" }),
    });
    expect(response.status).toBe(404);
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
      expect.objectContaining({
        level: "project",
        projectPath: "/projects/my-project",
      }),
    );
  });

  it("uses the default backend when the backend query is absent", async () => {
    const projectDeps = createProjectTestDeps();
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);

    const response = await projectHandlers.GET(makeProjectRequest(), {
      params: Promise.resolve({ name: "my-project" }),
    });

    expect(response.status).toBe(200);
    expect(projectDeps.discoverCommands).toHaveBeenCalledWith(
      "/projects/my-project",
      DEFAULT_AGENT_BACKEND_ID,
      expect.objectContaining({
        level: "project",
        projectPath: "/projects/my-project",
      }),
    );
  });

  it("passes an explicit claude backend to command discovery", async () => {
    const projectDeps = createProjectTestDeps();
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);

    await projectHandlers.GET(
      makeProjectRequest(
        "http://localhost/api/projects/my-project/commands?backend=claude",
      ),
      { params: Promise.resolve({ name: "my-project" }) },
    );

    expect(projectDeps.discoverCommands).toHaveBeenCalledWith(
      "/projects/my-project",
      "claude",
      expect.objectContaining({
        level: "project",
        projectPath: "/projects/my-project",
      }),
    );
  });

  it("passes an explicit cursor backend to command discovery and returns its bounded empty result", async () => {
    const projectDeps = createProjectTestDeps();
    vi.mocked(projectDeps.discoverCommands).mockResolvedValue([]);
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);

    const response = await projectHandlers.GET(
      makeProjectRequest(
        "http://localhost/api/projects/my-project/commands?backend=cursor",
      ),
      { params: Promise.resolve({ name: "my-project" }) },
    );

    expect(response.status).toBe(200);
    expect(projectDeps.discoverCommands).toHaveBeenCalledWith(
      "/projects/my-project",
      "cursor",
      expect.objectContaining({
        level: "project",
        projectPath: "/projects/my-project",
      }),
    );
    const body = (await response.json()) as { items: CommandItem[] };
    expect(body.items).toEqual([]);
  });

  it("rejects an unknown backend with a bounded 400 instead of defaulting", async () => {
    const projectDeps = createProjectTestDeps();
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);

    const response = await projectHandlers.GET(
      makeProjectRequest(
        "http://localhost/api/projects/my-project/commands?backend=not-a-registered-backend",
      ),
      { params: Promise.resolve({ name: "my-project" }) },
    );

    expect(response.status).toBe(400);
    expect(projectDeps.discoverCommands).not.toHaveBeenCalled();
    const body = (await response.json()) as { error: string; code?: string };
    expect(body.code).toBe("INVALID_BACKEND");
    expect(body.error).toContain("backend");
  });

  it("does not echo an unbounded unknown backend value in the error", async () => {
    const projectDeps = createProjectTestDeps();
    const projectHandlers = createProjectCommandsRouteHandlers(projectDeps);
    const oversized = "x".repeat(5000);
    const url = new URL("http://localhost/api/projects/my-project/commands");
    url.searchParams.set("backend", oversized);

    const response = await projectHandlers.GET(
      makeProjectRequest(url.toString()),
      { params: Promise.resolve({ name: "my-project" }) },
    );

    expect(response.status).toBe(400);
    expect(projectDeps.discoverCommands).not.toHaveBeenCalled();
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain(oversized);
    expect(body.error.length).toBeLessThan(200);
  });
});
