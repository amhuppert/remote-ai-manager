import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { FileItem, GlobalConfig } from "@/types";
import type { ScanResult } from "./file-scanner";
import {
  createFilesRouteHandlers,
  type FilesRouteDeps,
} from "./files-route-handlers";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

const testFiles: FileItem[] = [
  { path: "src/index.ts" },
  { path: "src/app.tsx" },
  { path: "package.json" },
];

const testScanResult: ScanResult = {
  items: testFiles,
  truncated: false,
  scannedCount: 3,
};

const testIgnorePatterns = ["node_modules", "dist"];

function fakeConfig(): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: testIgnorePatterns,
    claudeTimeoutMs: 60_000,
    defaultModel: "opus",
    defaultAgentBackend: "claude",
  } as GlobalConfig;
}

function createTestDeps(): FilesRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    scanProjectFiles: vi.fn().mockResolvedValue(testScanResult),
    readConfig: vi.fn().mockResolvedValue(fakeConfig()),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(): NextRequest {
  return new Request("http://localhost/api/projects/my-project/files", {
    method: "GET",
  }) as unknown as NextRequest;
}

function makeParams(name = "my-project") {
  return { params: Promise.resolve({ name }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: FilesRouteDeps;
let handlers: ReturnType<typeof createFilesRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createFilesRouteHandlers(deps);
});

// ===========================================================================
// GET /api/projects/[name]/files
// ===========================================================================

describe("GET /api/projects/[name]/files", () => {
  it("returns 200 with correct response shape", async () => {
    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: FileItem[];
      truncated: boolean;
      scannedCount: number;
    };
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toEqual({ path: "src/index.ts" });
    expect(body.truncated).toBe(false);
    expect(body.scannedCount).toBe(3);
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Project not found");
  });

  it("returns 500 on scanner error", async () => {
    vi.mocked(deps.scanProjectFiles).mockRejectedValue(
      new Error("Permission denied"),
    );

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Permission denied");
  });

  it("returns empty items for project with no files", async () => {
    vi.mocked(deps.scanProjectFiles).mockResolvedValue({
      items: [],
      truncated: false,
      scannedCount: 0,
    });

    const response = await handlers.GET(makeRequest(), makeParams());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: FileItem[] };
    expect(body.items).toEqual([]);
  });

  it("passes project path and ignorePatterns from config to scanProjectFiles", async () => {
    await handlers.GET(makeRequest(), makeParams());

    expect(deps.scanProjectFiles).toHaveBeenCalledWith("/projects/my-project", {
      ignorePatterns: testIgnorePatterns,
    });
  });
});
