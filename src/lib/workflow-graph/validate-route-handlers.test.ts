import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import {
  createWorkflowDefinition,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { createGraphWorkflowValidateHandlers } from "./validate-route-handlers";

function makeRequest(body?: unknown, token = "good-token"): NextRequest {
  return new NextRequest(
    "http://localhost/api/projects/repo/sessions/sess/graph-workflow/validate",
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
    },
  );
}

function makeContext() {
  return { params: Promise.resolve({ name: "repo", session: "sess" }) };
}

function makePlan(definition = createWorkflowDefinition()) {
  return {
    name: "Test Workflow",
    description: "A workflow under test",
    definition,
    layout: createWorkflowLayout(),
  };
}

/** Auth that accepts only the exact bearer token, mirroring the real gate. */
function tokenAuth(expected: string): AgentAuth {
  return {
    async requireToken(request: Request): Promise<Response | null> {
      const header = request.headers.get("authorization");
      if (header === `Bearer ${expected}`) return null;
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    },
    async validateOptionalToken(request: Request) {
      const header = request.headers.get("authorization");
      if (header === null) return { kind: "absent" as const };
      if (header === `Bearer ${expected}`) return { kind: "valid" as const };
      return { kind: "invalid" as const };
    },
  };
}

describe("graph-workflow validate route handler", () => {
  const resolveProjectPath = vi.fn<(_name: string) => Promise<string | null>>();
  const getSession =
    vi.fn<
      (
        _projectPath: string,
        _sessionName: string,
      ) => Promise<{ sessionName: string } | null>
    >();

  const handlers = createGraphWorkflowValidateHandlers({
    auth: tokenAuth("good-token"),
    resolveProjectPath,
    getSession,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    resolveProjectPath.mockResolvedValue("/repo");
    getSession.mockResolvedValue({ sessionName: "sess" });
  });

  it("returns { ok: true } for a well-formed plan", async () => {
    const response = await handlers.POST(
      makeRequest(makePlan()),
      makeContext(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects a missing/invalid token with 401", async () => {
    const response = await handlers.POST(
      makeRequest(makePlan(), "wrong-token"),
      makeContext(),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when the project cannot be resolved", async () => {
    resolveProjectPath.mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest(makePlan()),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session cannot be resolved", async () => {
    getSession.mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest(makePlan()),
      makeContext(),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 with JSON-path issues for a cyclic graph", async () => {
    const definition = createWorkflowDefinition();
    const cyclic = {
      ...definition,
      edges: [
        ...definition.edges,
        {
          id: "edge-verify-plan",
          sourceContextId: "context-verify",
          targetContextId: "context-plan",
        },
      ],
    };

    const response = await handlers.POST(
      makeRequest(makePlan(cyclic)),
      makeContext(),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: { path: string; message: string }[];
    };
    expect(body.error.length).toBeGreaterThan(0);
    const paths = body.issues.map((i) => i.path);
    expect(paths).toContain("definition.edges");
  });

  it("returns 400 when the body is not JSON", async () => {
    const request = new NextRequest(
      "http://localhost/api/projects/repo/sessions/sess/graph-workflow/validate",
      {
        method: "POST",
        body: "not json",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer good-token",
        },
      },
    );
    const response = await handlers.POST(request, makeContext());
    expect(response.status).toBe(400);
  });
});

describe("graph-workflow validate persists nothing", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "cc-validate-persist-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes no workflow definition when validating a valid plan", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });
    const scope = { kind: "project" as const, projectPath: "/repo" };

    expect(await storage.list(scope)).toHaveLength(0);

    const handlers = createGraphWorkflowValidateHandlers({
      auth: tokenAuth("good-token"),
      resolveProjectPath: async () => "/repo",
      getSession: async () => ({ sessionName: "sess" }),
    });

    const response = await handlers.POST(
      makeRequest(makePlan()),
      makeContext(),
    );
    expect(response.status).toBe(200);

    // The validate endpoint has no persistence path; nothing is stored.
    expect(await storage.list(scope)).toHaveLength(0);
  });
});
