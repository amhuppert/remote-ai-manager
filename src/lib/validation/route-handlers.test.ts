import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { DiscoveredProject } from "@/lib/projects/schemas";
import {
  _resetValidationServiceForTesting,
  _validationSingletonHostForTesting,
} from "./singleton";
import type {
  ValidationListResult,
  ValidationService,
  ValidationSubmitRequest,
} from "./service";
import {
  VALIDATION_LEASE_HEADER,
  _resetValidationProductionRouteDepsForTesting,
  _setValidationProductionRouteDepsForTesting,
  createProjectValidationHandlers,
  createSessionValidationHandlers,
  createValidationBudgetRouteHandlers,
  createValidationCommandsRouteHandlers,
  sessionValidationPOST,
} from "./route-handlers";
import {
  VALIDATION_POLL_MAX_WAIT_MS,
  validationBudgetResponseSchema,
  validationPollResponseSchema,
} from "./api-schemas";
import { validationCommandsResponseSchema } from "./schemas";

const PROJECT_PATH = "/repos/cc";
const CONVERSATION_ID = "conv-1";
const SESSION_NAME = "feature";

function conversation(): ConversationState {
  return makeConversationState({ id: CONVERSATION_ID });
}

function auth(): AgentAuth {
  return {
    requireToken: async () => null,
    validateOptionalToken: async () => ({ kind: "valid" }),
  };
}

function serviceFake(overrides: Partial<ValidationService> = {}): {
  service: ValidationService;
  submissions: ValidationSubmitRequest[];
  listCallers: ValidationSubmitRequest["caller"][];
  polls: Array<{ runId: string; leaseToken?: string }>;
  cancels: Array<{ runId: string; leaseToken: string }>;
  statusWaits: Array<{ runId: string; signal: AbortSignal | undefined }>;
} {
  const submissions: ValidationSubmitRequest[] = [];
  const listCallers: ValidationSubmitRequest["caller"][] = [];
  const polls: Array<{ runId: string; leaseToken?: string }> = [];
  const cancels: Array<{ runId: string; leaseToken: string }> = [];
  const statusWaits: Array<{
    runId: string;
    signal: AbortSignal | undefined;
  }> = [];
  const listed: ValidationListResult = {
    kind: "ok",
    commands: [
      {
        name: "test",
        cost: 4,
        description: "Run focused tests",
        pathArgs: "paths",
        changedScope: "native",
        timeoutMs: null,
        enabled: true,
      },
    ],
    capacity: { limit: 8, inUse: 4, queueDepth: 1 },
    runs: [],
  };

  return {
    submissions,
    listCallers,
    polls,
    cancels,
    statusWaits,
    service: {
      whenReady: async () => {},
      isAvailable: () => true,
      budget: async () => ({
        available: true,
        capacity: { limit: 8, inUse: 4, queueDepth: 1 },
        runs: [],
      }),
      async submit(request) {
        submissions.push(request);
        return {
          kind: "accepted",
          runId: "vrun-1",
          status: "queued",
          position: 0,
          lease: {
            runId: "vrun-1",
            token: "lease-1",
            expiresAt: "2026-08-05T12:00:00.000Z",
          },
          requestedScope: "changed",
          effectiveScope: "changed",
        };
      },
      async list(caller) {
        listCallers.push(caller);
        return listed;
      },
      async submitSystem() {
        throw new Error("submitSystem is not used by route-handler tests");
      },
      async waitForCompletion() {
        throw new Error("waitForCompletion is not used by route-handler tests");
      },
      // Production-shaped: the waiter settles only when the run moves or the
      // caller's signal aborts, so a handler that forgets to bound its wait
      // hangs the test instead of passing quietly.
      waitForStatusChange(runId, signal) {
        statusWaits.push({ runId, signal });
        return new Promise((resolve) => {
          if (signal === undefined) return;
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      poll(runId, leaseToken) {
        polls.push({
          runId,
          ...(leaseToken === undefined ? {} : { leaseToken }),
        });
        return {
          status: "queued",
          position: 2,
          result: null,
          requestedScope: "changed",
          effectiveScope: "changed",
        };
      },
      async cancel(runId, leaseToken) {
        cancels.push({ runId, leaseToken });
        return { authorization: "authorized" };
      },
      cancelSystemOwned: async () => false,
      sweepExpiredLeases: async () => 0,
      shutdown: async () => {},
      ...overrides,
    },
  };
}

function context(extra: Record<string, string> = {}) {
  return {
    params: Promise.resolve({
      name: "cc",
      session: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      ...extra,
    }),
  };
}

describe("validation route composition", () => {
  afterEach(() => {
    _resetValidationProductionRouteDepsForTesting();
    _resetValidationServiceForTesting();
  });

  it("drives session submit through route resolution into the service with authoritative paths", async () => {
    const fake = serviceFake();
    const handlers = createSessionValidationHandlers({
      auth: auth(),
      service: fake.service,
      resolveProjectPath: async () => PROJECT_PATH,
      getSession: async () => ({ conversations: [conversation()] }),
    });

    const response = await handlers.POST(
      new Request("http://cc.test/validation", {
        method: "POST",
        body: JSON.stringify({
          commandName: "test",
          wait: true,
          scopePaths: ["src/example.test.ts"],
          workflowExecutionId: "exec-1",
          workflowContextId: "api",
        }),
      }),
      context(),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      kind: "accepted",
      runId: "vrun-1",
      position: 0,
    });
    expect(fake.submissions).toEqual([
      {
        source: "agent_cli",
        commandName: "test",
        scope: "changed",
        wait: true,
        scopePaths: ["src/example.test.ts"],
        nestedValidationRunId: null,
        caller: {
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          conversationId: CONVERSATION_ID,
          claimedWorkflow: {
            executionId: "exec-1",
            contextId: "api",
          },
        },
      },
    ]);
  });

  it("uses the project conversation adapter for list without inventing a session", async () => {
    const fake = serviceFake();
    const handlers = createProjectValidationHandlers({
      auth: auth(),
      service: fake.service,
      resolveProjectPath: async () => PROJECT_PATH,
      getProjectConversation: async () => conversation(),
    });

    const response = await handlers.GET(
      new Request("http://cc.test/validation"),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      commands: [{ name: "test", enabled: true }],
      capacity: { limit: 8, inUse: 4, queueDepth: 1 },
    });
    expect(fake.listCallers).toEqual([
      {
        projectPath: PROJECT_PATH,
        sessionName: null,
        conversationId: CONVERSATION_ID,
      },
    ]);
  });

  it("polls with the submitter lease and exposes queue position", async () => {
    const fake = serviceFake();
    const handlers = createSessionValidationHandlers({
      auth: auth(),
      service: fake.service,
      resolveProjectPath: async () => PROJECT_PATH,
      getSession: async () => ({ conversations: [conversation()] }),
    });

    const response = await handlers.POLL(
      new Request("http://cc.test/validation/vrun-1", {
        headers: { [VALIDATION_LEASE_HEADER]: "lease-1" },
      }),
      context({ runId: "vrun-1" }),
    );

    expect(await response.json()).toEqual({
      runId: "vrun-1",
      status: "queued",
      position: 2,
      result: null,
      requestedScope: "changed",
      effectiveScope: "changed",
    });
    expect(fake.polls).toEqual([{ runId: "vrun-1", leaseToken: "lease-1" }]);
  });

  it.each([
    "path_args_forbidden",
    "path_args_rejected",
    "path_args_require_changed",
  ] as const)("maps %s to its stable HTTP 400 code", async (reason) => {
    const fake = serviceFake({
      submit: async () => ({ kind: "invalid", reason, message: "refused" }),
    });
    const handlers = createSessionValidationHandlers({
      auth: auth(),
      service: fake.service,
      resolveProjectPath: async () => PROJECT_PATH,
      getSession: async () => ({ conversations: [conversation()] }),
    });

    const response = await handlers.POST(
      new Request("http://cc.test/validation", {
        method: "POST",
        body: JSON.stringify({ commandName: "test" }),
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: `validation_${reason}`,
    });
  });

  it("maps cancel authorization failures to stable error codes", async () => {
    const fake = serviceFake({
      cancel: async () => ({ authorization: "not_owner" }),
    });
    const handlers = createProjectValidationHandlers({
      auth: auth(),
      service: fake.service,
      resolveProjectPath: async () => PROJECT_PATH,
      getProjectConversation: async () => conversation(),
    });

    const response = await handlers.CANCEL(
      new Request("http://cc.test/validation/vrun-1/cancel", {
        method: "POST",
        headers: { [VALIDATION_LEASE_HEADER]: "wrong" },
      }),
      context({ runId: "vrun-1" }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "The validation run lease does not belong to this caller",
      code: "validation_not_owner",
      issues: [],
    });
  });

  it("drives the exported production HTTP handler through the process-wide singleton", async () => {
    const fake = serviceFake();
    const host = _validationSingletonHostForTesting() as {
      instance: ValidationService | null;
    };
    host.instance = fake.service;
    _setValidationProductionRouteDepsForTesting({
      auth: auth(),
      resolveProjectPath: async () => PROJECT_PATH,
      getSession: async () => ({ conversations: [conversation()] }),
    });

    const response = await sessionValidationPOST(
      new Request("http://cc.test/validation", {
        method: "POST",
        body: JSON.stringify({ commandName: "test" }),
      }),
      context(),
    );

    expect(response.status).toBe(202);
    expect(fake.submissions).toEqual([
      expect.objectContaining({
        commandName: "test",
        caller: {
          projectPath: PROJECT_PATH,
          sessionName: SESSION_NAME,
          conversationId: CONVERSATION_ID,
        },
      }),
    ]);
  });
});

// ============================================================
// Status long-poll: the server holds the request until the run
// moves, so `cctl validate --wait` stops polling every second.
// ============================================================

type PolledStatus = ReturnType<ValidationService["poll"]>;

const RUN_ID = "vrun-1";

const RUNNING: PolledStatus = {
  status: "running",
  position: null,
  result: null,
  requestedScope: "changed",
  effectiveScope: "changed",
};

const PASSED: PolledStatus = {
  status: "passed",
  position: null,
  result: {
    kind: "passed",
    runId: RUN_ID,
    exitCode: 0,
    output: "ok",
    filesMatched: 3,
  },
  requestedScope: "changed",
  effectiveScope: "changed",
};

/** Answer each poll from the script, repeating its last entry. */
function pollScript(
  steps: PolledStatus[],
  polls: Array<{ runId: string; leaseToken?: string }>,
): ValidationService["poll"] {
  return (runId, leaseToken) => {
    polls.push({ runId, ...(leaseToken === undefined ? {} : { leaseToken }) });
    return steps[Math.min(polls.length - 1, steps.length - 1)] ?? RUNNING;
  };
}

function pollRequest(query = "", signal?: AbortSignal): Request {
  return new Request(`http://cc.test/validation/${RUN_ID}${query}`, {
    headers: { [VALIDATION_LEASE_HEADER]: "lease-1" },
    ...(signal === undefined ? {} : { signal }),
  });
}

type ValidationHandlers = ReturnType<typeof createSessionValidationHandlers>;

const handlerFactories: Array<{
  surface: string;
  create(service: ValidationService): ValidationHandlers;
}> = [
  {
    surface: "session",
    create: (service) =>
      createSessionValidationHandlers({
        auth: auth(),
        service,
        resolveProjectPath: async () => PROJECT_PATH,
        getSession: async () => ({ conversations: [conversation()] }),
      }),
  },
  {
    surface: "project",
    create: (service) =>
      createProjectValidationHandlers({
        auth: auth(),
        service,
        resolveProjectPath: async () => PROJECT_PATH,
        getProjectConversation: async () => conversation(),
      }),
  },
];

describe.each(handlerFactories)(
  "validation status long-poll ($surface handlers)",
  ({ create }) => {
    it("answers as soon as the run reaches a terminal verdict", async () => {
      const fake = serviceFake();
      const service: ValidationService = {
        ...fake.service,
        poll: pollScript([RUNNING, PASSED], fake.polls),
        async waitForStatusChange(runId) {
          fake.statusWaits.push({ runId, signal: undefined });
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      };

      const response = await create(service).POLL(
        pollRequest("?waitMs=25000"),
        context({ runId: RUN_ID }),
      );

      const body = validationPollResponseSchema.parse(await response.json());
      expect(body.status).toBe("passed");
      expect(body.result).toMatchObject({ kind: "passed", exitCode: 0 });
      expect(fake.statusWaits.map((wait) => wait.runId)).toEqual([RUN_ID]);
      // Entry poll renews the lease before the hold; the exit poll reads the
      // state the wait was woken for.
      expect(fake.polls).toEqual([
        { runId: RUN_ID, leaseToken: "lease-1" },
        { runId: RUN_ID, leaseToken: "lease-1" },
      ]);
    });

    it("short-circuits an already-terminal run without waiting", async () => {
      const fake = serviceFake({ poll: pollScript([PASSED], []) });

      const response = await create(fake.service).POLL(
        pollRequest("?waitMs=25000"),
        context({ runId: RUN_ID }),
      );

      const body = validationPollResponseSchema.parse(await response.json());
      expect(body.status).toBe("passed");
      expect(fake.statusWaits).toEqual([]);
    });

    it("does not hang on a terminal status whose in-memory result was lost to a restart", async () => {
      const fake = serviceFake({
        poll: pollScript([{ ...PASSED, result: null }], []),
      });

      const response = await create(fake.service).POLL(
        pollRequest("?waitMs=25000"),
        context({ runId: RUN_ID }),
      );

      const body = validationPollResponseSchema.parse(await response.json());
      expect(body).toMatchObject({ status: "passed", result: null });
      expect(fake.statusWaits).toEqual([]);
    });

    it("returns the current non-terminal state when the wait budget expires", async () => {
      const fake = serviceFake();
      const service: ValidationService = {
        ...fake.service,
        poll: pollScript([RUNNING], fake.polls),
      };

      const response = await create(service).POLL(
        pollRequest("?waitMs=20"),
        context({ runId: RUN_ID }),
      );

      expect(response.status).toBe(200);
      const body = validationPollResponseSchema.parse(await response.json());
      expect(body).toMatchObject({ status: "running", result: null });
      expect(fake.polls).toHaveLength(2);
    });

    it("deregisters the waiter on every expired hold", async () => {
      const fake = serviceFake();
      const service: ValidationService = {
        ...fake.service,
        poll: pollScript([RUNNING], fake.polls),
      };
      const handlers = create(service);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await handlers.POLL(
          pollRequest("?waitMs=10"),
          context({ runId: RUN_ID }),
        );
      }

      expect(fake.statusWaits).toHaveLength(3);
      for (const wait of fake.statusWaits) {
        expect(wait.signal?.aborted).toBe(true);
      }
    });

    it("abandons the hold when the client disconnects", async () => {
      const fake = serviceFake();
      const service: ValidationService = {
        ...fake.service,
        poll: pollScript([RUNNING], fake.polls),
      };
      const client = new AbortController();

      const pending = create(service).POLL(
        pollRequest("?waitMs=25000", client.signal),
        context({ runId: RUN_ID }),
      );
      await Promise.resolve();
      client.abort();

      const response = await pending;
      expect(response.status).toBe(200);
      expect(fake.statusWaits[0]?.signal?.aborted).toBe(true);
    });

    it("clamps an over-cap budget to the server ceiling", async () => {
      vi.useFakeTimers();
      try {
        const fake = serviceFake();
        const service: ValidationService = {
          ...fake.service,
          poll: pollScript([RUNNING], fake.polls),
        };

        const pending = create(service).POLL(
          pollRequest("?waitMs=600000"),
          context({ runId: RUN_ID }),
        );
        let settled = false;
        void pending.then(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(VALIDATION_POLL_MAX_WAIT_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2);

        const response = await pending;
        expect(response.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it("404s an unknown run immediately rather than holding the request", async () => {
      const fake = serviceFake({
        poll: () => ({
          status: null,
          position: null,
          result: null,
          requestedScope: null,
          effectiveScope: null,
        }),
      });

      const response = await create(fake.service).POLL(
        pollRequest("?waitMs=25000"),
        context({ runId: "vrun-missing" }),
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: "validation_run_not_found",
      });
      expect(fake.statusWaits).toEqual([]);
    });

    it("answers from current state when waitMs is absent, as an older CLI expects", async () => {
      const fake = serviceFake();

      const response = await create(fake.service).POLL(
        pollRequest(),
        context({ runId: RUN_ID }),
      );

      const body = validationPollResponseSchema.parse(await response.json());
      expect(body).toMatchObject({ status: "queued", position: 2 });
      expect(fake.statusWaits).toEqual([]);
      expect(fake.polls).toEqual([{ runId: RUN_ID, leaseToken: "lease-1" }]);
    });

    it("refuses an uninterpretable wait budget", async () => {
      const fake = serviceFake();

      const response = await create(fake.service).POLL(
        pollRequest("?waitMs=soon"),
        context({ runId: RUN_ID }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "validation_invalid_request",
      });
      expect(fake.statusWaits).toEqual([]);
    });
  },
);

function project(name: string): DiscoveredProject {
  return {
    name,
    path: `/repos/${name}`,
    activeSessions: 0,
    hasRunningSession: false,
  };
}

describe("GET /api/validation-commands", () => {
  it("aggregates each project's registry into sorted summaries", async () => {
    const { GET } = createValidationCommandsRouteHandlers({
      discoverProjects: async () => [project("alpha"), project("beta")],
      readRepoConfig: async (repoRoot) =>
        repoRoot === "/repos/alpha"
          ? {
              validation: {
                commands: {
                  typecheck: {
                    command: { full: "scripts/tc.sh" },
                    cost: 2,
                    pathArgs: "forbid",
                  },
                  test: {
                    command: {
                      full: "scripts/test-full.sh",
                      changed: "scripts/test.sh",
                    },
                    cost: 4,
                    description: "Scoped vitest",
                    pathArgs: "paths",
                  },
                },
                preMerge: [],
              },
            }
          : null,
    });

    const response = await GET();
    expect(response.status).toBe(200);
    const rawBody: unknown = await response.json();
    expect(JSON.stringify(rawBody)).not.toContain("scripts/");
    const body = validationCommandsResponseSchema.parse(rawBody);
    expect(body).toEqual({
      projects: [
        {
          projectName: "alpha",
          commands: [
            {
              name: "test",
              cost: 4,
              description: "Scoped vitest",
              pathArgs: "paths",
              changedScope: "native",
            },
            {
              name: "typecheck",
              cost: 2,
              pathArgs: "forbid",
              changedScope: "full_fallback",
            },
          ],
        },
        // No CommandCenter.json → readable-but-empty registry, still listed.
        { projectName: "beta", commands: [] },
      ],
    });
  });

  it("projects a scope-aware cost table to its maximum declared weight", async () => {
    const { GET } = createValidationCommandsRouteHandlers({
      discoverProjects: async () => [project("alpha")],
      readRepoConfig: async () => ({
        validation: {
          commands: {
            test: {
              command: {
                full: "scripts/test-full.sh",
                changed: "scripts/test.sh",
              },
              cost: { full: 5, changed: 4, paths: { base: 2, perPath: 1 } },
              pathArgs: "paths",
            },
          },
          preMerge: [],
        },
      }),
    });

    const response = await GET();
    const rawBody: unknown = await response.json();
    const body = validationCommandsResponseSchema.parse(rawBody);
    expect(body.projects[0]?.commands).toEqual([
      {
        name: "test",
        cost: 5,
        pathArgs: "paths",
        changedScope: "native",
      },
    ]);
  });

  it("omits a project whose CommandCenter.json cannot be read", async () => {
    const { GET } = createValidationCommandsRouteHandlers({
      discoverProjects: async () => [project("broken"), project("ok")],
      readRepoConfig: async (repoRoot) => {
        if (repoRoot === "/repos/broken") throw new Error("parse failure");
        return null;
      },
    });

    const response = await GET();
    const body = validationCommandsResponseSchema.parse(await response.json());
    expect(body.projects.map((entry) => entry.projectName)).toEqual(["ok"]);
  });

  it("returns 500 when discovery itself fails", async () => {
    const { GET } = createValidationCommandsRouteHandlers({
      discoverProjects: async () => {
        throw new Error("no base dir");
      },
      readRepoConfig: async () => null,
    });

    const response = await GET();
    expect(response.status).toBe(500);
  });
});

describe("GET /api/validation-budget", () => {
  it("answers the service snapshot in the wire shape", async () => {
    const { GET } = createValidationBudgetRouteHandlers({
      service: {
        budget: async () => ({
          available: true,
          capacity: { limit: 8, inUse: 7, queueDepth: 9 },
          runs: [
            {
              runId: "vrun-1",
              commandName: "test",
              status: "running" as const,
              cost: 4,
              projectName: "command-center",
              sessionName: "csm/budget",
              conversationId: "conv-1",
              position: null,
            },
          ],
        }),
      },
    });

    const response = await GET();
    // Parsing with the wire schema is the point: it fails if the service's
    // snapshot and the contract the client parses ever drift apart.
    const body = validationBudgetResponseSchema.parse(await response.json());
    expect(body.capacity).toEqual({ limit: 8, inUse: 7, queueDepth: 9 });
    expect(body.runs[0]?.projectName).toBe("command-center");
  });

  it("returns 500 when the budget read fails", async () => {
    const { GET } = createValidationBudgetRouteHandlers({
      service: {
        budget: async () => {
          throw new Error("config unreadable");
        },
      },
    });

    const response = await GET();
    expect(response.status).toBe(500);
  });
});
