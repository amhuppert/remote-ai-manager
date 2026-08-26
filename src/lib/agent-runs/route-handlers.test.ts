import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import {
  createAgentRunHandlers,
  type AgentRunRouteDeps,
} from "./route-handlers";
import type { AgentRunStatusResponse } from "./schemas";

const WORKTREE = "/projects/cc/.worktrees/sess";

function makeConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    baseDir: "/projects",
    ignorePatterns: [],
    agentBackends: {
      claude: {
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
        timeoutMs: 45_000,
      },
      codex: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        timeoutMs: 60_000,
      },
      cursor: {
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        timeoutMs: null,
      },
    },
    defaultAgentBackend: "claude",
    pushNotification: {
      enabled: false,
      provider: "ntfy",
      serverUrl: "https://ntfy.sh",
      topic: "",
      triggers: {
        jobCompleted: true,
        waitingForInput: true,
        workflowCompleted: true,
        workflowHalted: true,
        conversationIdle: true,
        specApprovalRequested: true,
        specApprovalGranted: true,
        specPolicyAdmitted: true,
        planRepair: true,
      },
    },
    ...overrides,
  };
}

const allowAuth: AgentAuth = {
  async requireToken() {
    return null;
  },
  async validateOptionalToken() {
    return { kind: "valid" };
  },
};

function makeDeps(
  overrides: Partial<AgentRunRouteDeps> = {},
): AgentRunRouteDeps {
  return {
    auth: allowAuth,
    resolveProjectPath: vi.fn(async () => "/projects/cc"),
    getSession: vi.fn(async () => ({
      sessionName: "sess",
      worktreePath: WORKTREE,
    })),
    readConfig: vi.fn(async () => makeConfig()),
    admitModelSelection: vi.fn(async ({ modelSelection }) => ({
      ok: true as const,
      modelSelection,
    })),
    startRun: vi.fn(() => ({ runId: "run-1" })),
    getRun: vi.fn((): AgentRunStatusResponse | null => ({
      runId: "run-1",
      backend: "codex",
      status: "running",
    })),
    cancelRun: vi.fn(() => ({ found: true, status: "running" as const })),
    ...overrides,
  };
}

function req(body?: unknown): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const params = (extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ name: "cc", session: "sess", ...extra }),
});

describe("POST /agent-runs", () => {
  it("creates a run, defaulting workingDirectory to the session worktree and pulling codex config", async () => {
    const startRun = vi.fn(() => ({ runId: "run-xyz" }));
    const handlers = createAgentRunHandlers(makeDeps({ startRun }));

    const res = await handlers.POST(
      req({ backend: "codex", prompt: "analyze the code" }),
      params(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run-xyz" });

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        prompt: "analyze the code",
        worktreePath: WORKTREE,
        workingDirectory: WORKTREE,
        timeoutMs: 60_000,
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
        projectName: "cc",
        sessionName: "sess",
      }),
    );
  });

  // An agent run IS a one-shot task run, so a backend registering no task
  // facet has to be refused before anything is started — not discovered when
  // the registry throws looking for a runner it does not have (spec R15.2).
  it("refuses a backend with no task facet with a bounded 4xx naming the facet and starts nothing", async () => {
    const startRun = vi.fn(() => ({ runId: "never" }));
    const handlers = createAgentRunHandlers(makeDeps({ startRun }));

    const res = await handlers.POST(
      req({ backend: "cursor", prompt: "analyze the code" }),
      params(),
    );

    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      code: "backend-facet-unsupported",
      error: expect.stringContaining("task"),
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("runs a claude-backed job with the configured Claude profile", async () => {
    const startRun = vi.fn(() => ({ runId: "run-claude" }));
    const handlers = createAgentRunHandlers(makeDeps({ startRun }));

    const res = await handlers.POST(
      req({ backend: "claude", prompt: "p" }),
      params(),
    );
    expect(res.status).toBe(200);

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "claude",
        modelSelection: {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
        timeoutMs: 45_000,
      }),
    );
  });

  it("accepts a complete selection and timeout override", async () => {
    const startRun = vi.fn(() => ({ runId: "run-2" }));
    const handlers = createAgentRunHandlers(makeDeps({ startRun }));

    await handlers.POST(
      req({
        backend: "codex",
        prompt: "p",
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { reasoning: "high", fast: "true" },
        },
        timeoutMs: 1000,
      }),
      params(),
    );

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          modelId: "gpt-5.5",
          parameters: { reasoning: "high", fast: "true" },
        },
        timeoutMs: 1000,
      }),
    );
  });

  it("rejects an invalid selection with stable diagnostics before creating a durable run", async () => {
    const startRun = vi.fn(() => ({ runId: "never" }));
    const handlers = createAgentRunHandlers(
      makeDeps({
        startRun,
        admitModelSelection: vi.fn(async () => ({
          ok: false as const,
          code: "unsupported_value",
          message:
            'Value "turbo" is not supported for parameter "fast" on model "gpt-5.4".',
          modelId: "gpt-5.4",
          parameterId: "fast",
        })),
      }),
    );

    const res = await handlers.POST(
      req({
        backend: "codex",
        prompt: "p",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "turbo" },
        },
      }),
      params(),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        'Value "turbo" is not supported for parameter "fast" on model "gpt-5.4".',
      code: "unsupported_value",
      modelId: "gpt-5.4",
      parameterId: "fast",
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("creates the run with the canonical admitted selection", async () => {
    const startRun = vi.fn(() => ({ runId: "run-canonical" }));
    const handlers = createAgentRunHandlers(
      makeDeps({
        startRun,
        admitModelSelection: vi.fn(async () => ({
          ok: true as const,
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "true", reasoning: "high" },
          },
        })),
      }),
    );

    const res = await handlers.POST(
      req({
        backend: "codex",
        prompt: "p",
        modelSelection: {
          modelId: "gpt-latest",
          parameters: { reasoning: "high", fast: "true" },
        },
      }),
      params(),
    );

    expect(res.status).toBe(200);
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "true", reasoning: "high" },
        },
      }),
    );
  });

  it("401 when the token gate denies", async () => {
    const auth: AgentAuth = {
      async requireToken() {
        return NextResponse.json({ error: "no" }, { status: 401 });
      },
      async validateOptionalToken() {
        return { kind: "invalid" };
      },
    };
    const startRun = vi.fn(() => ({ runId: "x" }));
    const handlers = createAgentRunHandlers(makeDeps({ auth, startRun }));
    const res = await handlers.POST(
      req({ backend: "codex", prompt: "p" }),
      params(),
    );
    expect(res.status).toBe(401);
    expect(startRun).not.toHaveBeenCalled();
  });

  it("404 when the session is unknown", async () => {
    const handlers = createAgentRunHandlers(
      makeDeps({ getSession: vi.fn(async () => null) }),
    );
    const res = await handlers.POST(
      req({ backend: "codex", prompt: "p" }),
      params(),
    );
    expect(res.status).toBe(404);
  });

  it("always accepts a configured codex run without an enablement gate", async () => {
    const startRun = vi.fn(() => ({ runId: "x" }));
    const handlers = createAgentRunHandlers(makeDeps({ startRun }));
    const res = await handlers.POST(
      req({ backend: "codex", prompt: "p" }),
      params(),
    );
    expect(res.status).toBe(200);
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      }),
    );
  });

  it("400 with issues when backend is missing", async () => {
    const handlers = createAgentRunHandlers(makeDeps());
    const res = await handlers.POST(req({ prompt: "p" }), params());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(
      body.issues.some((i: { path: string }) => i.path === "backend"),
    ).toBe(true);
  });

  it("400 with issues on an invalid body (empty prompt)", async () => {
    const handlers = createAgentRunHandlers(makeDeps());
    const res = await handlers.POST(
      req({ backend: "codex", prompt: "" }),
      params(),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0].path).toBe("prompt");
  });

  it.each([
    ["effort", "high"],
    ["reasoning", "high"],
    ["fast", "true"],
    ["context", "max"],
    ["thinking", "enabled"],
  ])(
    "rejects a top-level %s model parameter instead of silently dropping it",
    async (field, value) => {
      const startRun = vi.fn(() => ({ runId: "never" }));
      const handlers = createAgentRunHandlers(makeDeps({ startRun }));

      const res = await handlers.POST(
        req({ backend: "codex", prompt: "p", [field]: value }),
        params(),
      );

      expect(res.status).toBe(400);
      expect(startRun).not.toHaveBeenCalled();
    },
  );

  it("400 when workingDirectory escapes the worktree", async () => {
    const startRun = vi.fn(() => ({ runId: "x" }));
    const handlers = createAgentRunHandlers(makeDeps({ startRun }));
    const res = await handlers.POST(
      req({ backend: "codex", prompt: "p", workingDirectory: "../../etc" }),
      params(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("worktree");
    expect(startRun).not.toHaveBeenCalled();
  });

  it("resolves a relative workingDirectory inside the worktree to an absolute path", async () => {
    const startRun = vi.fn(() => ({ runId: "x" }));
    const handlers = createAgentRunHandlers(makeDeps({ startRun }));
    await handlers.POST(
      req({ backend: "codex", prompt: "p", workingDirectory: "packages/api" }),
      params(),
    );
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: `${WORKTREE}/packages/api`,
      }),
    );
  });
});

describe("GET /agent-runs/[runId]", () => {
  it("returns the scoped run status", async () => {
    const getRun = vi.fn(
      (): AgentRunStatusResponse => ({
        runId: "run-1",
        backend: "codex",
        status: "completed",
        summary: "done",
        referenceDocuments: [{ filePath: "a.md", description: "d" }],
      }),
    );
    const handlers = createAgentRunHandlers(makeDeps({ getRun }));
    const res = await handlers.GET(
      new Request("http://localhost/x"),
      params({ runId: "run-1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "completed",
      summary: "done",
    });
    expect(getRun).toHaveBeenCalledWith("run-1", {
      projectName: "cc",
      sessionName: "sess",
    });
  });

  it("404 when the run is unknown or belongs to another session", async () => {
    const handlers = createAgentRunHandlers(
      makeDeps({ getRun: vi.fn(() => null) }),
    );
    const res = await handlers.GET(
      new Request("http://localhost/x"),
      params({ runId: "nope" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /agent-runs/[runId]/cancel", () => {
  it("acknowledges cancellation", async () => {
    const cancelRun = vi.fn(() => ({
      found: true,
      status: "running" as const,
    }));
    const handlers = createAgentRunHandlers(makeDeps({ cancelRun }));
    const res = await handlers.CANCEL(req(), params({ runId: "run-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(cancelRun).toHaveBeenCalledWith("run-1", {
      projectName: "cc",
      sessionName: "sess",
    });
  });

  it("404 when the run is unknown", async () => {
    const handlers = createAgentRunHandlers(
      makeDeps({ cancelRun: vi.fn(() => ({ found: false })) }),
    );
    const res = await handlers.CANCEL(req(), params({ runId: "nope" }));
    expect(res.status).toBe(404);
  });
});
