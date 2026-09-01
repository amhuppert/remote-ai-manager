import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  withTracing: (handler: unknown) => handler,
}));

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { StartTicketOutput, TicketError } from "./schemas";
import type { StartTicketServiceInput } from "./start-service";
import { createTicketStartRouteHandlers } from "./start-route-handlers";
import { ModelSelectionAdmissionError } from "@/lib/agent-backends/model-selection-admission";

const PROJECT_NAME = "command-center";

const sampleOutput: StartTicketOutput = {
  ticket: {
    id: "ticket-1",
    projectPath: "/repos/command-center",
    projectName: PROJECT_NAME,
    number: 12,
    title: "Fix the flaky gate",
    description: "It fails on Tuesdays.",
    workType: "bug",
    status: "in_progress",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:02.000Z",
    attachments: [],
    sessions: [
      {
        id: "link-1",
        ticketId: "ticket-1",
        projectPath: "/repos/command-center",
        sessionName: "ticket-12-fix-the-flaky-gate-1",
        sessionCreatedAt: "2026-07-10T00:00:01.000Z",
        startMode: "agent",
        linkedAt: "2026-07-10T00:00:02.000Z",
        endedAt: null,
        endReason: null,
      },
    ],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
  },
  sessionName: "ticket-12-fix-the-flaky-gate-1",
  conversationId: "11111111-1111-4111-8111-111111111111",
  initialPromptQueued: true,
};

function grantedAuth(): AgentAuth {
  return {
    async requireToken() {
      return null;
    },
    async validateOptionalToken() {
      return { kind: "absent" };
    },
  };
}

function rejectedAuth(): AgentAuth {
  return {
    async requireToken() {
      return Response.json({ error: "Invalid token" }, { status: 401 });
    },
    async validateOptionalToken() {
      return { kind: "invalid" };
    },
  };
}

function makeHandlers(
  options: {
    start?: (
      input: StartTicketServiceInput,
    ) => Promise<
      { ok: true; value: StartTicketOutput } | { ok: false; error: TicketError }
    >;
    auth?: AgentAuth;
  } = {},
) {
  const calls: StartTicketServiceInput[] = [];
  const handlers = createTicketStartRouteHandlers({
    getStartService: () => ({
      async start(input: StartTicketServiceInput) {
        calls.push(input);
        return options.start
          ? options.start(input)
          : { ok: true as const, value: sampleOutput };
      },
    }),
    auth: options.auth ?? grantedAuth(),
  });
  return { handlers, calls };
}

function request(body: unknown): Request {
  return new Request(
    `http://localhost/api/projects/${PROJECT_NAME}/tickets/12/start`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

function context(name = PROJECT_NAME, number = "12") {
  return { params: Promise.resolve({ name, number }) };
}

describe("POST /api/projects/:name/tickets/:number/start", () => {
  it("starts the ticket with the requested mode and returns the output body", async () => {
    const { handlers, calls } = makeHandlers();

    const response = await handlers.startPOST(
      request({
        mode: "agent",
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { fast: "true", reasoning: "ultra" },
        },
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      JSON.parse(JSON.stringify(sampleOutput)),
    );
    expect(calls).toEqual([
      {
        projectName: PROJECT_NAME,
        number: 12,
        mode: "agent",
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.6-sol",
          parameters: { fast: "true", reasoning: "ultra" },
        },
      },
    ]);
  });

  it("accepts prepared mode", async () => {
    const { handlers, calls } = makeHandlers({
      start: async () => ({
        ok: true,
        value: { ...sampleOutput, initialPromptQueued: false },
      }),
    });

    const response = await handlers.startPOST(
      request({ mode: "prepared" }),
      context(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as StartTicketOutput;
    expect(body.initialPromptQueued).toBe(false);
    expect(calls[0]?.mode).toBe("prepared");
  });

  it("returns a bounded stable diagnostic for a model admission refusal", async () => {
    const { handlers } = makeHandlers({
      start: async () => {
        throw new ModelSelectionAdmissionError({
          code: "unsupported_combination",
          message:
            'The selected parameter combination is not supported for model "claude-opus-5".',
          modelId: "claude-opus-5",
          parameterId: "thinking",
        });
      },
    });

    const response = await handlers.startPOST(
      request({
        mode: "agent",
        backend: "claude",
        modelSelection: {
          modelId: "claude-opus-5",
          parameters: { effort: "max", thinking: "false" },
        },
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'The selected parameter combination is not supported for model "claude-opus-5".',
      code: "unsupported_combination",
      modelId: "claude-opus-5",
      parameterId: "thinking",
    });
  });

  it("rejects an invalid mode with 400 before reaching the service", async () => {
    const { handlers, calls } = makeHandlers();

    const response = await handlers.startPOST(
      request({ mode: "yolo" }),
      context(),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("validation_failed");
    expect(calls).toEqual([]);
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
      const { handlers, calls } = makeHandlers();

      const response = await handlers.startPOST(
        request({ mode: "agent", backend: "cursor", [field]: value }),
        context(),
      );

      expect(response.status).toBe(400);
      expect(calls).toEqual([]);
    },
  );

  it("rejects a non-object body with 400", async () => {
    const { handlers, calls } = makeHandlers();

    const response = await handlers.startPOST(
      new Request("http://localhost/api/projects/x/tickets/12/start", {
        method: "POST",
        body: "not json",
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("returns 401 for an invalid token", async () => {
    const { handlers, calls } = makeHandlers({ auth: rejectedAuth() });

    const response = await handlers.startPOST(
      request({ mode: "agent" }),
      context(),
    );

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("maps ticket_not_found to 404", async () => {
    const { handlers } = makeHandlers({
      start: async () => ({
        ok: false,
        error: { code: "ticket_not_found", identifier: "command-center#12" },
      }),
    });

    const response = await handlers.startPOST(
      request({ mode: "agent" }),
      context(),
    );
    expect(response.status).toBe(404);
  });

  it("maps the active-session conflict to 409 naming the session", async () => {
    const { handlers } = makeHandlers({
      start: async () => ({
        ok: false,
        error: { code: "active_session", sessionName: "ticket-12-live-1" },
      }),
    });

    const response = await handlers.startPOST(
      request({ mode: "agent" }),
      context(),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("ticket-12-live-1");
  });

  it("maps a concurrent start to 409 start_in_progress", async () => {
    const { handlers } = makeHandlers({
      start: async () => ({
        ok: false,
        error: { code: "start_in_progress", identifier: "command-center#12" },
      }),
    });

    const response = await handlers.startPOST(
      request({ mode: "agent" }),
      context(),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("start_in_progress");
  });

  it("maps a content-phase preparation failure to 422", async () => {
    const { handlers } = makeHandlers({
      start: async () => ({
        ok: false,
        error: {
          code: "context_preparation_failed",
          phase: "content",
          reason: "compaction timed out",
        },
      }),
    });

    const response = await handlers.startPOST(
      request({ mode: "agent" }),
      context(),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("context_preparation_failed");
  });

  it("maps a post-provision preparation failure to 500", async () => {
    const { handlers } = makeHandlers({
      start: async () => ({
        ok: false,
        error: {
          code: "context_preparation_failed",
          phase: "preparation",
          reason: "charter unavailable",
        },
      }),
    });

    const response = await handlers.startPOST(
      request({ mode: "agent" }),
      context(),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("context_preparation_failed");
  });

  it("maps session_provision_failed to 500", async () => {
    const { handlers } = makeHandlers({
      start: async () => ({
        ok: false,
        error: {
          code: "session_provision_failed",
          reason: "worktree add failed",
        },
      }),
    });

    const response = await handlers.startPOST(
      request({ mode: "agent" }),
      context(),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("session_provision_failed");
  });

  it("treats a non-numeric :number as validation_failed", async () => {
    const { handlers, calls } = makeHandlers();

    const response = await handlers.startPOST(
      request({ mode: "agent" }),
      context(PROJECT_NAME, "abc"),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
