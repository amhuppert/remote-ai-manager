import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { CommandItem } from "@/types";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { resolveProjectPathMock, getSessionMock, discoverCommandsMock } =
  vi.hoisted(() => ({
    resolveProjectPathMock: vi.fn(),
    getSessionMock: vi.fn(),
    discoverCommandsMock: vi.fn(),
  }));

vi.mock("@/lib/project-resolver", () => ({
  resolveProjectPath: resolveProjectPathMock,
}));

vi.mock("@/lib/state", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/commands", () => ({
  discoverCommands: discoverCommandsMock,
}));

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

const testSession = {
  sessionName: "test-session",
  worktreePath: "/projects/my-project/.worktrees/test-session",
  branchName: "csm/test-session",
  claudeSessionId: null,
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

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  resolveProjectPathMock.mockResolvedValue("/projects/my-project");
  getSessionMock.mockResolvedValue(testSession);
  discoverCommandsMock.mockResolvedValue(testCommands);
});

// ===========================================================================
// GET /api/projects/[name]/sessions/[session]/commands
// ===========================================================================

describe("GET /api/projects/[name]/sessions/[session]/commands", () => {
  it("returns 200 with correct response shape", async () => {
    const { GET } =
      await import("@/app/api/projects/[name]/sessions/[session]/commands/route");
    const response = await GET(makeRequest(), makeParams());

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
    resolveProjectPathMock.mockResolvedValue(null);

    const { GET } =
      await import("@/app/api/projects/[name]/sessions/[session]/commands/route");
    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Project not found");
  });

  it("returns 404 when session not found", async () => {
    getSessionMock.mockResolvedValue(null);

    const { GET } =
      await import("@/app/api/projects/[name]/sessions/[session]/commands/route");
    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Session not found");
  });

  it("returns 500 on discovery error", async () => {
    discoverCommandsMock.mockRejectedValue(new Error("Scan failed"));

    const { GET } =
      await import("@/app/api/projects/[name]/sessions/[session]/commands/route");
    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Scan failed");
  });

  it("returns empty items for project with no commands", async () => {
    discoverCommandsMock.mockResolvedValue([]);

    const { GET } =
      await import("@/app/api/projects/[name]/sessions/[session]/commands/route");
    const response = await GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: CommandItem[] };
    expect(body.items).toEqual([]);
  });

  it("passes worktreePath from session to discoverCommands", async () => {
    const { GET } =
      await import("@/app/api/projects/[name]/sessions/[session]/commands/route");
    await GET(makeRequest(), makeParams());

    expect(discoverCommandsMock).toHaveBeenCalledWith(testSession.worktreePath);
  });
});
