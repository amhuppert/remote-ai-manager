/**
 * Route-handler tests for Collaboration Mode.
 *
 * Tests assert the HTTP contract independent of Next.js routing: the factory
 * is invoked with stubbed deps, requests are constructed via the standard
 * Web `Request` API, and assertions read the response body and status. No
 * `vi.mock` — every dependency is injected.
 */
import { describe, it, expect, vi } from "vitest";

import { createCollaborationRouteHandlers } from "./route-handlers";
import {
  CollaborationConversationMismatchError,
  CollaborationConversationNotFoundError,
  CollaborationNotPausedError,
  CollaborationNotStoppableError,
  CollaborationResumeTokenMismatchError,
  CollaborationSessionNotFoundError,
  CollaborationWorkflowNotFoundError,
  type CollaborationManager,
} from "./manager";
import type { WorkflowEnvelope } from "@/lib/workflows/primitives/workflow-envelope-vocabulary";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";

function buildEnvelope(
  overrides: Partial<WorkflowEnvelope> = {},
): WorkflowEnvelope {
  return {
    workflowId: "wf-1",
    workflowType: "collaboration",
    status: "running",
    phase: "round_1",
    createdAt: "2026-04-28T10:00:00.000Z",
    updatedAt: "2026-04-28T10:00:00.000Z",
    featureSnapshot: { brief: "design X", round: 1 },
    ...overrides,
  };
}

interface ScriptedManagerOptions {
  startResult?: { workflowId: string; status: "started" };
  startError?: Error;
  listResult?: WorkflowEnvelope[];
  listError?: Error;
  envelope?: WorkflowEnvelope | null;
  resumeResult?: { workflowId: string; status: "resumed" };
  resumeError?: Error;
  stopResult?: { workflowId: string; status: "stopped" };
  stopError?: Error;
}

function buildScriptedManager(options: ScriptedManagerOptions = {}): {
  manager: CollaborationManager;
  startCalls: Parameters<CollaborationManager["start"]>[0][];
  listCalls: Parameters<CollaborationManager["listActive"]>[0][];
  resumeCalls: Parameters<CollaborationManager["resume"]>[0][];
  stopCalls: Parameters<CollaborationManager["stop"]>[0][];
} {
  const startCalls: Parameters<CollaborationManager["start"]>[0][] = [];
  const listCalls: Parameters<CollaborationManager["listActive"]>[0][] = [];
  const resumeCalls: Parameters<CollaborationManager["resume"]>[0][] = [];
  const stopCalls: Parameters<CollaborationManager["stop"]>[0][] = [];

  const manager: CollaborationManager = {
    start: vi.fn(
      async (
        input: Parameters<CollaborationManager["start"]>[0],
      ): Promise<{ workflowId: string; status: "started" }> => {
        startCalls.push(input);
        if (options.startError) throw options.startError;
        return options.startResult ?? { workflowId: "wf-1", status: "started" };
      },
    ),
    listActive: vi.fn(
      async (
        input: Parameters<CollaborationManager["listActive"]>[0],
      ): Promise<WorkflowEnvelope[]> => {
        listCalls.push(input);
        if (options.listError) throw options.listError;
        return options.listResult ?? [];
      },
    ),
    listAll: vi.fn(
      async (
        input: Parameters<CollaborationManager["listAll"]>[0],
      ): Promise<WorkflowEnvelope[]> => {
        listCalls.push(input);
        if (options.listError) throw options.listError;
        return options.listResult ?? [];
      },
    ),
    getEnvelope: vi.fn(async () => options.envelope ?? null),
    resume: vi.fn(
      async (
        input: Parameters<CollaborationManager["resume"]>[0],
      ): Promise<{ workflowId: string; status: "resumed" }> => {
        resumeCalls.push(input);
        if (options.resumeError) throw options.resumeError;
        return (
          options.resumeResult ?? {
            workflowId: input.workflowId,
            status: "resumed",
          }
        );
      },
    ),
    stop: vi.fn(
      async (
        input: Parameters<CollaborationManager["stop"]>[0],
      ): Promise<{ workflowId: string; status: "stopped" }> => {
        stopCalls.push(input);
        if (options.stopError) throw options.stopError;
        return (
          options.stopResult ?? {
            workflowId: input.workflowId,
            status: "stopped",
          }
        );
      },
    ),
  };

  return { manager, startCalls, listCalls, resumeCalls, stopCalls };
}

function buildContext(
  projectName: string,
  sessionName: string,
): { params: Promise<Record<string, string>> } {
  return {
    params: Promise.resolve({
      name: projectName,
      session: sessionName,
    }),
  };
}

function buildWorkflowContext(
  projectName: string,
  sessionName: string,
  workflowId: string,
): { params: Promise<Record<string, string>> } {
  return {
    params: Promise.resolve({
      name: projectName,
      session: sessionName,
      workflowId,
    }),
  };
}

function buildArtifactContext(
  projectName: string,
  sessionName: string,
  workflowId: string,
  artifactType: string,
): { params: Promise<Record<string, string>> } {
  return {
    params: Promise.resolve({
      name: projectName,
      session: sessionName,
      workflowId,
      type: artifactType,
    }),
  };
}

describe("collaboration route handlers — START", () => {
  it("returns 404 when the project cannot be resolved", async () => {
    const { manager } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => null,
      manager,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design X",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-1",
        }),
      }),
      buildContext("missing-project", "sess-1"),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Project not found");
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const { manager } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Request body must be valid JSON");
  });

  it("returns 400 when Zod validation fails", async () => {
    const { manager, startCalls } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-1",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: { path: unknown; message: string }[];
    };
    expect(body.error).toBe("Invalid request body");
    expect(body.issues.length).toBeGreaterThan(0);
    expect(startCalls).toHaveLength(0);
  });

  it("returns 400 when conversationId is missing from the body", async () => {
    const { manager, startCalls } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design X",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      issues: { path: unknown; message: string }[];
    };
    expect(body.error).toBe("Invalid request body");
    expect(
      body.issues.some((i) => String(i.path).includes("conversationId")),
    ).toBe(true);
    expect(startCalls).toHaveLength(0);
  });

  it("returns 404 when the conversation does not exist", async () => {
    const { manager } = buildScriptedManager({
      startError: new CollaborationConversationNotFoundError(
        "/projects/example",
        "sess-1",
        "conv-missing",
      ),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design X",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-missing",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("conv-missing");
  });

  it("returns 404 when the session does not exist", async () => {
    const { manager } = buildScriptedManager({
      startError: new CollaborationSessionNotFoundError(
        "/projects/example",
        "sess-1",
      ),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design X",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-1",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("sess-1");
  });

  it("returns 202 with the workflowId when start succeeds", async () => {
    const { manager, startCalls } = buildScriptedManager({
      startResult: { workflowId: "wf-abc", status: "started" },
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design Y",
          negotiationRounds: 5,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-Y",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      workflowId: string;
      status: string;
      statusUrl: string;
    };
    expect(body).toEqual({
      workflowId: "wf-abc",
      status: "started",
      statusUrl: "/api/projects/example/sessions/sess-1/collaboration/wf-abc",
    });

    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]).toEqual({
      projectPath: "/projects/example",
      sessionName: "sess-1",
      brief: "design Y",
      negotiationRounds: 5,
      autonomousResolutionThreshold: "major",
      conversationId: "conv-Y",
    });
  });

  it("persists the /collab user prompt to the transcript before invoking the manager", async () => {
    const { manager, startCalls } = buildScriptedManager({
      startResult: { workflowId: "wf-xyz", status: "started" },
    });
    const order: string[] = [];
    const appendTranscriptEntry = vi.fn(async (...args) => {
      order.push("transcript");
      return args;
    });
    const wrappedManager: CollaborationManager = {
      ...manager,
      start: vi.fn(async (input) => {
        order.push("manager.start");
        return manager.start(input);
      }),
    };

    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager: wrappedManager,
      appendTranscriptEntry,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "investigate flaky test",
          negotiationRounds: 4,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-trans",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(202);
    expect(appendTranscriptEntry).toHaveBeenCalledTimes(1);
    const [convId, entry, meta] = appendTranscriptEntry.mock.calls[0]!;
    expect(convId).toBe("conv-trans");
    expect(entry).toMatchObject({
      type: "user",
      role: "user",
      content: [{ type: "text", text: "/collab investigate flaky test" }],
    });
    expect(meta).toEqual({ projectName: "example", sessionName: "sess-1" });
    expect(order).toEqual(["transcript", "manager.start"]);
    expect(startCalls).toHaveLength(1);
  });

  it("updates conversation metadata so a fresh /collab-started conversation leaves the new status with a transcriptPath (verified by reload through the real store)", async () => {
    const { manager, startCalls } = buildScriptedManager({
      startResult: { workflowId: "wf-meta", status: "started" },
    });

    const projectPath = "/projects/example";
    const sessionName = "sess-1";
    const conversationId = "conv-meta";

    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(projectPath);
      fixture.seedSession(projectPath, sessionName);
      await fixture.seedConversation(
        projectPath,
        sessionName,
        conversationStateSchema.parse({
          id: conversationId,
          transcriptPath: null,
          status: "new",
          promptCount: 0,
          createdAt: "2026-04-28T09:00:00.000Z",
          lastActivityAt: "2026-04-28T09:00:00.000Z",
        }),
      );

      const handlers = createCollaborationRouteHandlers({
        resolveProjectPath: async () => projectPath,
        manager,
        getTranscriptPath: async (id) => `/transcripts/${id}.jsonl`,
        mutateConversation: fixture.deps.mutateConversation,
      });

      const response = await handlers.START(
        new Request("http://test/collab", {
          method: "POST",
          body: JSON.stringify({
            brief: "kick off a new design",
            negotiationRounds: 3,
            autonomousResolutionThreshold: "major",
            conversationId,
          }),
        }),
        buildContext("example", sessionName),
      );

      expect(response.status).toBe(202);
      expect(startCalls).toHaveLength(1);

      const reloaded = await fixture.deps.getConversation(
        projectPath,
        sessionName,
        conversationId,
      );
      expect(reloaded).not.toBeNull();
      expect(reloaded!.transcriptPath).toBe("/transcripts/conv-meta.jsonl");
      expect(reloaded!.status).not.toBe("new");
      expect(reloaded!.promptCount).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });

  it("returns 500 when the manager throws an unexpected error", async () => {
    const { manager } = buildScriptedManager({
      startError: new Error("disk full"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design Y",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-1",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(500);
  });

  it("decodes URL-encoded session names", async () => {
    const { manager, startCalls } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design Y",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-1",
        }),
      }),
      buildContext("example", "feature%2Fnew%20design"),
    );

    expect(startCalls[0]?.sessionName).toBe("feature/new design");
  });

  it("adopts the requested backend on the conversation before invoking the manager", async () => {
    const { manager, startCalls } = buildScriptedManager({
      startResult: { workflowId: "wf-adopt", status: "started" },
    });
    const order: string[] = [];
    const setConversationBackend = vi.fn(async () => {
      order.push("setConversationBackend");
    });
    const wrappedManager: CollaborationManager = {
      ...manager,
      start: vi.fn(async (input) => {
        order.push("manager.start");
        return manager.start(input);
      }),
    };

    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager: wrappedManager,
      setConversationBackend,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design Z",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-adopt",
          backend: "codex",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(202);
    expect(setConversationBackend).toHaveBeenCalledWith(
      "/projects/example",
      "sess-1",
      "conv-adopt",
      "codex",
    );
    expect(order).toEqual(["setConversationBackend", "manager.start"]);
    expect(startCalls).toHaveLength(1);
  });

  it("does not call setConversationBackend when no backend is provided", async () => {
    const { manager, startCalls } = buildScriptedManager();
    const setConversationBackend = vi.fn(async () => {});

    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
      setConversationBackend,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design Z",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-no-backend",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(202);
    expect(setConversationBackend).not.toHaveBeenCalled();
    expect(startCalls).toHaveLength(1);
  });

  it("returns 409 when the requested backend conflicts with a locked conversation", async () => {
    const { manager, startCalls } = buildScriptedManager();
    const setConversationBackend = vi.fn(async () => {
      throw new Error(
        'Cannot change backend after prompts have been sent (conversation "conv-locked")',
      );
    });

    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
      setConversationBackend,
    });

    const response = await handlers.START(
      new Request("http://test/collab", {
        method: "POST",
        body: JSON.stringify({
          brief: "design Z",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
          conversationId: "conv-locked",
          backend: "codex",
        }),
      }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(409);
    expect(startCalls).toHaveLength(0);
  });
});

describe("collaboration route handlers — LIST", () => {
  it("returns 404 when the project cannot be resolved", async () => {
    const { manager } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => null,
      manager,
    });

    const response = await handlers.LIST(
      new Request("http://test/collab", { method: "GET" }),
      buildContext("missing", "sess-1"),
    );

    expect(response.status).toBe(404);
  });

  it("returns the active envelopes from the manager", async () => {
    const envelope = buildEnvelope({ workflowId: "wf-active" });
    const { manager } = buildScriptedManager({ listResult: [envelope] });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.LIST(
      new Request("http://test/collab", { method: "GET" }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      envelopes: Array<{ workflowId: string }>;
    };
    expect(body.envelopes).toHaveLength(1);
    expect(body.envelopes[0]?.workflowId).toBe("wf-active");
  });

  it("returns 500 when listActive throws", async () => {
    const { manager } = buildScriptedManager({
      listError: new Error("repo unavailable"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.LIST(
      new Request("http://test/collab", { method: "GET" }),
      buildContext("example", "sess-1"),
    );

    expect(response.status).toBe(500);
  });
});

describe("collaboration route handlers — RESUME", () => {
  it("returns 404 when the project cannot be resolved", async () => {
    const { manager } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => null,
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-1/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "tok",
          conversationId: "conv-1",
          userAnswers: {},
        }),
      }),
      buildWorkflowContext("missing", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Project not found");
  });

  it("returns 400 when the workflowId is missing", async () => {
    const { manager } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab//resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "tok",
          conversationId: "conv-1",
          userAnswers: {},
        }),
      }),
      buildWorkflowContext("example", "sess-1", ""),
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const { manager } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-1/resume", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Request body must be valid JSON");
  });

  it("returns 400 when Zod validation fails on resumeToken", async () => {
    const { manager, resumeCalls } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-1/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "",
          conversationId: "conv-1",
          userAnswers: {},
        }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(400);
    expect(resumeCalls).toHaveLength(0);
  });

  it("returns 404 when the workflow does not exist", async () => {
    const { manager } = buildScriptedManager({
      resumeError: new CollaborationWorkflowNotFoundError("wf-missing"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-missing/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "tok",
          conversationId: "conv-1",
          userAnswers: {},
        }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-missing"),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("wf-missing");
  });

  it("returns 403 when the resume token does not match", async () => {
    const { manager, resumeCalls } = buildScriptedManager({
      resumeError: new CollaborationResumeTokenMismatchError("wf-1"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-1/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "wrong-token",
          conversationId: "conv-1",
          userAnswers: { q1: "yes" },
        }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("wf-1");
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toMatchObject({
      projectPath: "/projects/example",
      sessionName: "sess-1",
      workflowId: "wf-1",
      resumeToken: "wrong-token",
      conversationId: "conv-1",
    });
  });

  it("returns 403 when the conversationId does not match the workflow", async () => {
    const { manager } = buildScriptedManager({
      resumeError: new CollaborationConversationMismatchError(
        "wf-1",
        "conv-A",
        "conv-B",
      ),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-1/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "tok",
          conversationId: "conv-B",
          userAnswers: {},
        }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("conv-B");
  });

  it("returns 409 when the workflow is not paused", async () => {
    const { manager } = buildScriptedManager({
      resumeError: new CollaborationNotPausedError("wf-1", "running"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-1/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "tok",
          conversationId: "conv-1",
          userAnswers: {},
        }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(409);
  });

  it("returns 200 with workflowId on successful resume", async () => {
    const { manager, resumeCalls } = buildScriptedManager({
      resumeResult: { workflowId: "wf-1", status: "resumed" },
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-1/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "good-tok",
          conversationId: "conv-1",
          userAnswers: { question_a: "answer-a" },
        }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflowId: string;
      status: string;
    };
    expect(body).toEqual({ workflowId: "wf-1", status: "resumed" });

    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toEqual({
      projectPath: "/projects/example",
      sessionName: "sess-1",
      workflowId: "wf-1",
      resumeToken: "good-tok",
      conversationId: "conv-1",
      userAnswers: { question_a: "answer-a" },
    });
  });

  it("returns 500 when the manager throws an unexpected error", async () => {
    const { manager } = buildScriptedManager({
      resumeError: new Error("disk full"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.RESUME(
      new Request("http://test/collab/wf-1/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "tok",
          conversationId: "conv-1",
          userAnswers: {},
        }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(500);
  });

  it("decodes URL-encoded workflow IDs", async () => {
    const { manager, resumeCalls } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    await handlers.RESUME(
      new Request("http://test/collab/wf%2Fabc/resume", {
        method: "POST",
        body: JSON.stringify({
          resumeToken: "tok",
          conversationId: "conv-1",
          userAnswers: {},
        }),
      }),
      buildWorkflowContext("example", "sess-1", "wf%2Fabc"),
    );

    expect(resumeCalls[0]?.workflowId).toBe("wf/abc");
  });
});

describe("collaboration route handlers — STOP", () => {
  it("returns 404 when the project cannot be resolved", async () => {
    const { manager } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => null,
      manager,
    });

    const response = await handlers.STOP(
      new Request("http://test/collab/wf-1/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: "conv-1" }),
      }),
      buildWorkflowContext("missing", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Project not found");
  });

  it("returns 400 when the body is not valid JSON", async () => {
    const { manager } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.STOP(
      new Request("http://test/collab/wf-1/stop", {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Request body must be valid JSON");
  });

  it("returns 400 when conversationId is missing", async () => {
    const { manager, stopCalls } = buildScriptedManager();
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.STOP(
      new Request("http://test/collab/wf-1/stop", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(400);
    expect(stopCalls).toHaveLength(0);
  });

  it("returns 404 when the workflow does not exist", async () => {
    const { manager } = buildScriptedManager({
      stopError: new CollaborationWorkflowNotFoundError("wf-missing"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.STOP(
      new Request("http://test/collab/wf-missing/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: "conv-1" }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-missing"),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("wf-missing");
  });

  it("returns 403 when the conversationId does not own the workflow", async () => {
    const { manager } = buildScriptedManager({
      stopError: new CollaborationConversationMismatchError(
        "wf-1",
        "conv-A",
        "conv-B",
      ),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.STOP(
      new Request("http://test/collab/wf-1/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: "conv-B" }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("conv-B");
  });

  it("returns 409 when the workflow is not stoppable", async () => {
    const { manager } = buildScriptedManager({
      stopError: new CollaborationNotStoppableError("wf-1", "completed"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.STOP(
      new Request("http://test/collab/wf-1/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: "conv-1" }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(409);
  });

  it("returns 200 with workflowId on successful stop", async () => {
    const { manager, stopCalls } = buildScriptedManager({
      stopResult: { workflowId: "wf-1", status: "stopped" },
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.STOP(
      new Request("http://test/collab/wf-1/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: "conv-1" }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflowId: string;
      status: string;
    };
    expect(body).toEqual({ workflowId: "wf-1", status: "stopped" });

    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]).toEqual({
      projectPath: "/projects/example",
      sessionName: "sess-1",
      workflowId: "wf-1",
      conversationId: "conv-1",
    });
  });

  it("returns 500 when the manager throws an unexpected error", async () => {
    const { manager } = buildScriptedManager({
      stopError: new Error("disk full"),
    });
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
    });

    const response = await handlers.STOP(
      new Request("http://test/collab/wf-1/stop", {
        method: "POST",
        body: JSON.stringify({ conversationId: "conv-1" }),
      }),
      buildWorkflowContext("example", "sess-1", "wf-1"),
    );

    expect(response.status).toBe(500);
  });
});

describe("collaboration route handlers — GET_ARTIFACT", () => {
  it("rejects workflow IDs that would escape the collaboration artifact directory", async () => {
    const { manager } = buildScriptedManager();
    const readArtifactFile = vi.fn(async () => "secret");
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => "/projects/example",
      manager,
      getSession: async () =>
        ({
          worktreePath: "/worktrees/session",
        }) as never,
      readArtifactFile,
    });

    const response = await handlers.GET_ARTIFACT(
      new Request("http://test/collab/..%2F..%2Foutside/artifacts/transcript"),
      buildArtifactContext(
        "example",
        "sess-1",
        "..%2F..%2Foutside",
        "transcript",
      ),
    );

    expect(response.status).toBe(400);
    expect(readArtifactFile).not.toHaveBeenCalled();
  });
});
