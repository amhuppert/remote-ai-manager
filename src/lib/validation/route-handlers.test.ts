import { afterEach, describe, expect, it } from "vitest";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { ConversationState } from "@/lib/conversations/schemas";
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
  createValidationCommandsRouteHandlers,
  sessionValidationPOST,
} from "./route-handlers";
import { validationCommandsResponseSchema } from "./schemas";

const PROJECT_PATH = "/repos/cc";
const CONVERSATION_ID = "conv-1";
const SESSION_NAME = "feature";

function conversation(): ConversationState {
  return { id: CONVERSATION_ID } as unknown as ConversationState;
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
} {
  const submissions: ValidationSubmitRequest[] = [];
  const listCallers: ValidationSubmitRequest["caller"][] = [];
  const polls: Array<{ runId: string; leaseToken?: string }> = [];
  const cancels: Array<{ runId: string; leaseToken: string }> = [];
  const listed: ValidationListResult = {
    kind: "ok",
    commands: [
      {
        name: "test",
        cost: 4,
        description: "Run focused tests",
        scopeArgs: "paths",
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
    service: {
      whenReady: async () => {},
      isAvailable: () => true,
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
      poll(runId, leaseToken) {
        polls.push({
          runId,
          ...(leaseToken === undefined ? {} : { leaseToken }),
        });
        return {
          status: "queued",
          position: 2,
          result: null,
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
    });
    expect(fake.polls).toEqual([{ runId: "vrun-1", leaseToken: "lease-1" }]);
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
                    command: "scripts/tc.sh",
                    cost: 2,
                    scopeArgs: "forbid",
                  },
                  test: {
                    command: "scripts/test.sh",
                    cost: 4,
                    description: "Scoped vitest",
                    scopeArgs: "paths",
                  },
                },
                preMerge: [],
              },
            }
          : null,
    });

    const response = await GET();
    expect(response.status).toBe(200);
    const body = validationCommandsResponseSchema.parse(await response.json());
    expect(body).toEqual({
      projects: [
        {
          projectName: "alpha",
          commands: [
            { name: "test", cost: 4, description: "Scoped vitest" },
            { name: "typecheck", cost: 2 },
          ],
        },
        // No CommandCenter.json → readable-but-empty registry, still listed.
        { projectName: "beta", commands: [] },
      ],
    });
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
