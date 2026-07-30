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
        model: "sonnet",
        reasoningEffort: "medium",
        timeoutMs: 45_000,
      },
      codex: {
        model: "gpt-5.4",
        reasoningEffort: "high",
        fastMode: false,
        timeoutMs: 60_000,
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
        model: "gpt-5.4",
        projectName: "cc",
        sessionName: "sess",
      }),
    );
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
        model: "sonnet",
        reasoningEffort: "medium",
        timeoutMs: 45_000,
      }),
    );
  });

  it("mirrors the original tool input: model + reasoning_effort + timeout override", async () => {
    const startRun = vi.fn(() => ({ runId: "run-2" }));
    const handlers = createAgentRunHandlers(makeDeps({ startRun }));

    await handlers.POST(
      req({
        backend: "codex",
        prompt: "p",
        model: "gpt-5.5",
        reasoning_effort: "high",
        timeoutMs: 1000,
      }),
      params(),
    );

    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.5",
        reasoningEffort: "high",
        timeoutMs: 1000,
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
      expect.objectContaining({ backend: "codex", model: "gpt-5.4" }),
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
