import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { FileItem } from "@/lib/files/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ScanResult } from "./file-scanner";
import {
  createSessionFilesRouteHandlers,
  type SessionFilesRouteDeps,
} from "./session-route-handlers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testFiles: FileItem[] = [
  { path: "src/index.ts" },
  { path: "src/session-only.ts" },
];

const testScanResult: ScanResult = {
  items: testFiles,
  truncated: false,
  scannedCount: 2,
};

const testIgnorePatterns = ["node_modules", "dist"];

function fakeConfig(): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: testIgnorePatterns,
    agentBackends: {
      claude: {
        model: "opus",
        reasoningEffort: "high",
        timeoutMs: 60_000,
      },
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "high",
        fastMode: false,
        timeoutMs: null,
      },
      cursor: { model: "composer-2.5", timeoutMs: null },
    },
    defaultAgentBackend: "claude",
  };
}

function fakeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    name: "feature-x",
    branch: "csm/feature-x",
    projectPath: "/projects/my-project",
    worktreePath: "/projects/my-project/.worktrees/feature-x",
    createdAt: new Date().toISOString(),
    conversations: [],
    referenceDocuments: [],
    ...overrides,
  } as SessionState;
}

function createTestDeps(): SessionFilesRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession: vi.fn().mockResolvedValue(fakeSession()),
    scanProjectFiles: vi.fn().mockResolvedValue(testScanResult),
    readConfig: vi.fn().mockResolvedValue(fakeConfig()),
  };
}

function makeRequest(): NextRequest {
  return new Request(
    "http://localhost/api/projects/my-project/sessions/feature-x/files",
    { method: "GET" },
  ) as unknown as NextRequest;
}

function makeParams(name = "my-project", session = "feature-x") {
  return { params: Promise.resolve({ name, session }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: SessionFilesRouteDeps;
let handlers: ReturnType<typeof createSessionFilesRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createSessionFilesRouteHandlers(deps);
});

// ===========================================================================
// GET /api/projects/[name]/sessions/[session]/files
// ===========================================================================

describe("GET /api/projects/[name]/sessions/[session]/files", () => {
  it("returns 200 with response shape matching projectFilesResponseSchema", async () => {
    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: FileItem[];
      truncated: boolean;
      scannedCount: number;
    };
    expect(body.items).toHaveLength(2);
    expect(body.truncated).toBe(false);
    expect(body.scannedCount).toBe(2);
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

  it("calls scanProjectFiles with session.worktreePath, not projectPath", async () => {
    await handlers.GET(makeRequest(), makeParams());

    expect(deps.scanProjectFiles).toHaveBeenCalledWith(
      "/projects/my-project/.worktrees/feature-x",
      { ignorePatterns: testIgnorePatterns },
    );
    expect(deps.scanProjectFiles).not.toHaveBeenCalledWith(
      "/projects/my-project",
      expect.anything(),
    );
  });

  it("passes ignorePatterns from config to scanner", async () => {
    const customPatterns = ["custom-pattern", "**/*.snap"];
    vi.mocked(deps.readConfig).mockResolvedValue({
      ...fakeConfig(),
      ignorePatterns: customPatterns,
    });

    await handlers.GET(makeRequest(), makeParams());

    expect(deps.scanProjectFiles).toHaveBeenCalledWith(expect.any(String), {
      ignorePatterns: customPatterns,
    });
  });

  it("looks up the session by the resolved project path and session name", async () => {
    await handlers.GET(makeRequest(), makeParams("my-project", "feature-x"));

    expect(deps.getSession).toHaveBeenCalledWith(
      "/projects/my-project",
      "feature-x",
    );
  });

  it("returns 500 on scanner error", async () => {
    vi.mocked(deps.scanProjectFiles).mockRejectedValue(new Error("EACCES"));

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("EACCES");
  });
});
