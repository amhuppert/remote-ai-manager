import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { createWorkflowExecution } from "./test-fixtures";
import {
  createGraphWorkflowLiveOutlineRouteHandlers,
  type GraphWorkflowLiveOutlineRouteDeps,
} from "./live-outline-route-handlers";

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";

function makeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function makeRequest(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/repo/sessions/session-1/graph-workflow/live-outline${query}`,
    { method: "GET" },
  );
}

function buildDeps(
  execution: GraphWorkflowExecution | null,
  overrides: Partial<GraphWorkflowLiveOutlineRouteDeps> = {},
): GraphWorkflowLiveOutlineRouteDeps {
  return {
    resolveProjectPath: async (name) => (name === "repo" ? PROJECT_PATH : null),
    getSession: async () => ({ name: SESSION_NAME }) as unknown as SessionState,
    getActiveExecution: async () => execution,
    ...overrides,
  };
}

const routeParams = makeContext({ name: "repo", session: "session-1" });

describe("graph workflow live-outline route handlers", () => {
  it("returns 404 when the project cannot be resolved", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" })),
    );
    const response = await handlers.GET(
      makeRequest(),
      makeContext({ name: "unknown", session: "session-1" }),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session is unknown", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" }), {
        getSession: async () => null,
      }),
    );
    const response = await handlers.GET(makeRequest(), routeParams);
    expect(response.status).toBe(404);
  });

  it("returns 404 when there is no active execution", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(null),
    );
    const response = await handlers.GET(makeRequest(), routeParams);
    expect(response.status).toBe(404);
  });

  it("returns the compact outline by default", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" })),
    );
    const response = await handlers.GET(makeRequest(), routeParams);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.section).toBe("outline");
    expect(body.outline.header).toMatchObject({
      executionId: "execution-1",
      liveRevision: 1,
      status: "running",
      editable: true,
    });
    expect(body.outline.contexts.map((c: { id: string }) => c.id)).toEqual([
      "context-plan",
      "context-implement",
      "context-verify",
    ]);
    expect(Array.isArray(body.outline.tasks)).toBe(true);
    expect(Array.isArray(body.outline.config)).toBe(true);
  });

  it("returns a context section for ?context=", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" })),
    );
    const response = await handlers.GET(
      makeRequest("?context=context-implement"),
      routeParams,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.section).toBe("context");
    expect(body.context.id).toBe("context-implement");
    expect(body.context.tasks[0].instructions).toBe("Implement the feature.");
  });

  it("returns a task section for ?task=", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" })),
    );
    const response = await handlers.GET(
      makeRequest("?task=task-implement-1"),
      routeParams,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.section).toBe("task");
    expect(body.task.id).toBe("task-implement-1");
    expect(body.task.instructions).toBe("Implement the feature.");
  });

  it("returns a config section for ?config=", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" })),
    );
    const response = await handlers.GET(
      makeRequest("?config=context-plan"),
      routeParams,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.section).toBe("config");
    expect(body.config.contextId).toBe("context-plan");
    expect(body.config.implementer.backend).toBe("claude");
  });

  it("returns the full execution for ?full=true", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" })),
    );
    const response = await handlers.GET(makeRequest("?full=true"), routeParams);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.section).toBe("full");
    expect(body.contexts).toHaveLength(3);
  });

  it("returns 404 for an unknown context selector", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" })),
    );
    const response = await handlers.GET(
      makeRequest("?context=ghost"),
      routeParams,
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when more than one selector is combined", async () => {
    const handlers = createGraphWorkflowLiveOutlineRouteHandlers(
      buildDeps(createWorkflowExecution({ status: "running" })),
    );
    const response = await handlers.GET(
      makeRequest("?context=context-plan&task=task-plan-1"),
      routeParams,
    );
    expect(response.status).toBe(400);
  });
});
