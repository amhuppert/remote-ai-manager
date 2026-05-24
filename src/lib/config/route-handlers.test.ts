import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createConfigRouteHandlers,
  type ConfigRouteDeps,
} from "./route-handlers";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const fullConfig = {
  baseDir: "/home/user/projects",
  ignorePatterns: ["node_modules", ".next"],
  claudeTimeoutMs: 3_600_000,
  defaultModel: "opus" as const,
  defaultAgentBackend: "claude" as const,
  preMergeTimeoutMs: 300_000,
  maxConcurrentQueries: 3,
  tailscaleEnabled: true,
};

const rawConfig = {
  baseDir: "/home/user/projects",
  claudeTimeoutMs: 3_600_000,
};

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(): ConfigRouteDeps {
  return {
    readConfig: vi.fn().mockResolvedValue(fullConfig),
    readRawConfig: vi.fn().mockResolvedValue(rawConfig),
    writeRawConfig: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePutRequest(body: unknown): Request {
  return new Request("http://localhost/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: ConfigRouteDeps;
let handlers: ReturnType<typeof createConfigRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createConfigRouteHandlers(deps);
});

// ===========================================================================
// GET /api/config
// ===========================================================================

describe("GET /api/config", () => {
  it("returns { config, raw } shape", async () => {
    const response = await handlers.GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("config");
    expect(body).toHaveProperty("raw");
  });

  it("config contains full merged values (with defaults)", async () => {
    const response = await handlers.GET();
    const body = await response.json();

    expect(body.config).toEqual(fullConfig);
    expect(body.config.defaultModel).toBe("opus");
    expect(body.config.ignorePatterns).toEqual(["node_modules", ".next"]);
  });

  it("raw contains only explicitly set values", async () => {
    const response = await handlers.GET();
    const body = await response.json();

    expect(body.raw).toEqual(rawConfig);
    expect(body.raw).not.toHaveProperty("ignorePatterns");
  });

  it("returns 500 with { error } when readConfig throws", async () => {
    vi.mocked(deps.readConfig).mockRejectedValue(
      new Error("Disk read failure"),
    );

    const response = await handlers.GET();
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe("Disk read failure");
  });

  it("returns 500 with fallback message for non-Error throws", async () => {
    vi.mocked(deps.readConfig).mockRejectedValue("string error");

    const response = await handlers.GET();
    expect(response.status).toBe(500);

    const body = await response.json();
    expect(body.error).toBe("Failed to read config");
  });
});

// ===========================================================================
// PUT /api/config
// ===========================================================================

describe("PUT /api/config", () => {
  it("accepts valid partial config body and persists to disk", async () => {
    const input = { baseDir: "/new/path", claudeTimeoutMs: 120_000 };
    const response = await handlers.PUT(makePutRequest(input));

    expect(response.status).toBe(200);
    expect(deps.writeRawConfig).toHaveBeenCalledWith(input);
  });

  it("returns updated { config, raw } response after write", async () => {
    const updatedRaw = { baseDir: "/new/path" };
    vi.mocked(deps.readRawConfig).mockResolvedValue(updatedRaw);

    const response = await handlers.PUT(
      makePutRequest({ baseDir: "/new/path" }),
    );
    const body = await response.json();

    expect(body).toHaveProperty("config");
    expect(body).toHaveProperty("raw");
    expect(body.config).toEqual(fullConfig);
    expect(body.raw).toEqual(updatedRaw);
  });

  it("accepts partial workflowDefaults bodies with only changed blocks", async () => {
    const input = {
      workflowDefaults: {
        implementer: {
          backend: "claude" as const,
          model: "sonnet" as const,
          reasoningEffort: "medium" as const,
        },
      },
    };

    const response = await handlers.PUT(makePutRequest(input));

    expect(response.status).toBe(200);
    expect(deps.writeRawConfig).toHaveBeenCalledWith(input);
  });

  it("rejects invalid config body with 400 status and { error }", async () => {
    const response = await handlers.PUT(
      makePutRequest({ claudeTimeoutMs: "not-a-number" }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Invalid config/i);
  });

  it("handles write errors with 500 status and { error }", async () => {
    vi.mocked(deps.writeRawConfig).mockRejectedValue(
      new Error("Permission denied"),
    );

    const response = await handlers.PUT(
      makePutRequest({ baseDir: "/new/path" }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Permission denied");
  });
});
