import os from "node:os";
import path from "node:path";
import nodePath from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { unreviewedPlanReviewLookup } from "@/lib/shared/testing/graph-plan-review-fixture";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import {
  createAssignmentReferenceChecker,
  type AssignmentReferenceChecker,
} from "@/lib/workflow-graph/assignment-references";
import {
  createWorkflowDefinitionRouteHandlers,
  type WorkflowDefinitionRouteDeps,
} from "@/lib/workflows/definition-route-handlers";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";
import { createGraphWorkflowValidateHandlers } from "@/lib/workflow-graph/validate-route-handlers";
import { createTemplateLibraryRouteHandlers } from "@/lib/workflow-graph/template-library-route-handlers";
import {
  createGraphWorkflowExecutionRouteHandlers,
  type GraphWorkflowExecutionRouteDeps,
} from "@/lib/workflow-graph/execution-route-handlers";
import { createTemplateLibraryService } from "@/lib/workflow-graph/template-library-service";
import type { TemplateLibraryStorage } from "@/lib/workflow-graph/template-library-service";
import type {
  WorkflowDefinitionSummary,
  WorkflowScope,
} from "@/lib/workflow-graph/storage";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import type { GlobalConfig } from "@/lib/config/schemas";
import {
  CONVERSATION_CAPABILITY_ENV_VAR,
  CONVERSATION_CAPABILITY_HEADER,
  mintConversationCapability,
  verifyConversationCapability,
} from "@/lib/agent-gateway/conversation-capability";
import {
  LANE_CAPABILITY_ENV_VAR,
  LANE_CAPABILITY_HEADER,
  mintLaneCapability,
  verifyLaneCapability,
} from "@/lib/agent-gateway/lane-capability";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
  createWorkflowLayout,
} from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowLiveOutlineRouteHandlers } from "@/lib/workflow-graph/live-outline-route-handlers";
import { runCli } from "../core";
import type { CliEnv, CliHost } from "../shared";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real workflow
 * route handlers in-process (no HTTP). Proves the CLI parses the routes' actual
 * response shapes — the `{ items }` definition list, the tier-tagged template
 * merge, and the full `GraphWorkflowExecution` payload the status/start routes
 * emit (including the structured, non-string `haltReason`).
 */

const PROJECT_PATH = "/repos/cc";
const WORKTREE = `${PROJECT_PATH}/.worktrees/sess`;

function summary(
  overrides: Partial<WorkflowDefinitionSummary> = {},
): WorkflowDefinitionSummary {
  return {
    id: "wf-1",
    name: "Auth Setup",
    description: "OAuth2 workflow",
    revision: 3,
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T01:00:00.000Z",
    parameters: [],
    prerequisites: [],
    ...overrides,
  };
}

/** The ordinary session conversation `cctl` runs in. */
const CLI_CONVERSATION_ID = "conv-cli";
const LANE_CONVERSATION_ID = "conv-lane";
const CAPABILITY_SECRET = "server-only-capability-key";
const CLI_CONVERSATION: ConversationState = conversationStateSchema.parse({
  id: CLI_CONVERSATION_ID,
  scope: "session",
  transcriptPath: null,
  status: "idle",
  promptCount: 1,
  createdAt: "2026-03-27T12:00:00.000Z",
  lastActivityAt: "2026-03-27T12:00:00.000Z",
  agentBackend: "claude",
});
const LANE_CONVERSATION: ConversationState = conversationStateSchema.parse({
  ...CLI_CONVERSATION,
  id: LANE_CONVERSATION_ID,
});

function makeSession(): SessionState {
  return {
    sessionName: "sess",
    worktreePath: WORKTREE,
    branchName: "csm/sess",
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [CLI_CONVERSATION, LANE_CONVERSATION],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
}

/** Storage double the real template library merges across tiers. */
const templateStorage: TemplateLibraryStorage = {
  async list(scope: WorkflowScope) {
    return scope.kind === "global"
      ? [summary({ id: "g-1", name: "Global One" })]
      : [summary({ id: "p-1", name: "Project One" })];
  },
  async get() {
    return null;
  },
};

function notUsed(): never {
  throw new Error("route not exercised in this contract test");
}

const VALIDATION_GLOBAL_CONFIG = {
  validation: { concurrencyLimit: 8, defaultTimeoutMs: 600_000 },
} as GlobalConfig;

/** A supported-subset declaration: an object root with two named properties. */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["verdict"],
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    notes: { type: "string" },
  },
};

/**
 * The `wf-1` record `get` reads, with an output contract on `context-verify`
 * only — so one outline row must carry the shape summary and the others must
 * not.
 */
function definitionRecordWithOutputSchema() {
  const record = createWorkflowDefinitionRecord({ id: "wf-1", revision: 3 });
  return {
    ...record,
    definition: {
      ...record.definition,
      executionContexts: record.definition.executionContexts.map((context) =>
        context.id === "context-verify"
          ? { ...context, outputSchema: OUTPUT_SCHEMA }
          : context,
      ),
    },
  };
}

function makeExecutionDeps(
  overrides: Partial<GraphWorkflowExecutionRouteDeps>,
): GraphWorkflowExecutionRouteDeps {
  return {
    resolveProjectPath: async () => PROJECT_PATH,
    getSession: async () => makeSession(),
    readRepoConfig: async () => null,
    readConfig: async () => VALIDATION_GLOBAL_CONFIG,
    normalizeExecutionAfterRestart: async () => null,
    startExecution: notUsed,
    runExecution: notUsed,
    launchSpecDeliveryExecution: notUsed,
    pauseExecution: notUsed,
    resumeExecution: notUsed,
    abortExecution: notUsed,
    resetExecutionContext: notUsed,
    resetExecutionContextAssignment: notUsed,
    archiveExecution: notUsed,
    kickOffExecutionLoop: async () => {},
    getActiveExecution: async () => null,
    recordPendingHaltReason: notUsed,
    drainAndHalt: notUsed,
    recordApprovalDecision: notUsed,
    listArchivedExecutions: async () => [],
    // Drive the production signature verifiers over the exact headers cctl
    // sends. A verifier that returns a fixture principal without reading the
    // request would let the CLI silently drop the capability again.
    auth: { validateOptionalToken: async () => ({ kind: "valid" as const }) },
    verifyConversationCapability: async (request) =>
      verifyConversationCapability(
        request.headers.get(CONVERSATION_CAPABILITY_HEADER),
        CAPABILITY_SECRET,
      ),
    verifyLaneCapability: async (request) =>
      verifyLaneCapability(
        request.headers.get(LANE_CAPABILITY_HEADER),
        CAPABILITY_SECRET,
      ),
    ...overrides,
  };
}

interface RouteHostOverrides {
  /** Thrown by the start route, to drive a real start-failure response. */
  startError?: Error;
  /** Launch the fixture execution parked awaiting definition approval. */
  parkAwaitingApproval?: boolean;
  /** The async assignment-reference checker the validate route runs. */
  assignmentReferences?: AssignmentReferenceChecker;
  /**
   * Persistence deps for the definition routes. The default fakes echo a
   * summary; the acceptance-path tests replace them with the REAL storage
   * service so accept-time validation actually runs.
   */
  definitions?: Partial<WorkflowDefinitionRouteDeps>;
  executionDeps?: Partial<GraphWorkflowExecutionRouteDeps>;
}

function routeHost(
  execution: GraphWorkflowExecution | null,
  files: Record<string, string> = {},
  overrides: RouteHostOverrides = {},
): CliHost {
  const {
    startError,
    parkAwaitingApproval,
    assignmentReferences,
    executionDeps,
  } = overrides;
  const definitionHandlers = createWorkflowDefinitionRouteHandlers({
    planReviews: unreviewedPlanReviewLookup,
    resolveProjectPath: async () => PROJECT_PATH,
    readConfig: async () => VALIDATION_GLOBAL_CONFIG,
    readRepoConfig: async () => null,
    listDefinitions: async () => [summary()],
    // A real record backs `get`/`edit`: revision 3, the fixture graph.
    getDefinition: async (_projectPath, workflowId) =>
      workflowId === "wf-1"
        ? createWorkflowDefinitionRecord({ id: "wf-1", revision: 3 })
        : null,
    // Echo a summary so the CLI parses the real 201 `{ item }` shape (id/name
    // for the start hint); the create-path Zod + structural validation the
    // handler runs before this is exercised for real by the invalid-plan case.
    createDefinition: async () => summary({ id: "wf-new", name: "Auth Setup" }),
    updateDefinition: async (_projectPath, workflowId) =>
      summary({ id: workflowId, name: "Auth Setup", revision: 4 }),
    deleteDefinition: async (_projectPath, workflowId) => workflowId === "wf-1",
    ...overrides.definitions,
  });
  const validateHandlers = createGraphWorkflowValidateHandlers({
    auth: {
      async requireToken() {
        return null;
      },
      async validateOptionalToken() {
        return { kind: "valid" as const };
      },
    },
    resolveProjectPath: async () => PROJECT_PATH,
    getSession: async () => ({ sessionName: "sess" }),
    readRepoConfig: async () => null,
    readConfig: async () => VALIDATION_GLOBAL_CONFIG,
    ...(assignmentReferences ? { assignmentReferences } : {}),
  });
  const templateHandlers = createTemplateLibraryRouteHandlers({
    resolveProjectPath: async () => PROJECT_PATH,
    readConfig: notUsed,
    list: (projectPath) =>
      createTemplateLibraryService({ storage: templateStorage }).list(
        projectPath,
      ),
    listGlobal: notUsed,
    createGlobal: notUsed,
    getGlobal: notUsed,
    updateGlobal: notUsed,
    deleteGlobal: notUsed,
  });
  const executionHandlers = createGraphWorkflowExecutionRouteHandlers(
    makeExecutionDeps({
      getActiveExecution: async () => execution,
      startExecution: async () => {
        if (startError) throw startError;
        if (!execution) throw new Error("no execution fixture");
        return {
          execution,
          awaitingDefinitionApproval: parkAwaitingApproval === true,
        };
      },
      ...executionDeps,
    }),
  );
  const liveOutlineHandlers = createGraphWorkflowLiveOutlineRouteHandlers({
    resolveProjectPath: async () => PROJECT_PATH,
    getSession: async () => makeSession(),
    getActiveExecution: async () => execution,
  });

  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // segments: api projects <name> (workflows|workflow-templates|sessions ...)
      const name = decodeURIComponent(segments[2] ?? "");
      const resource = segments[3];
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });

      if (resource === "workflows") {
        const workflowId = decodeURIComponent(segments[4] ?? "");
        if (init.method === "DELETE") {
          return definitionHandlers.DELETE(request, {
            params: Promise.resolve({ name, workflowId }),
          });
        }
        if (init.method === "POST") {
          return definitionHandlers.CREATE(request, {
            params: Promise.resolve({ name }),
          });
        }
        if (init.method === "PUT") {
          return definitionHandlers.UPDATE(request, {
            params: Promise.resolve({ name, workflowId }),
          });
        }
        if (init.method === "PATCH") {
          return definitionHandlers.EDIT(request, {
            params: Promise.resolve({ name, workflowId }),
          });
        }
        // The pre-existing GET-by-id handler needs a full GlobalConfig to compute
        // `resolved`; the CLI's outline/selectors are a projection over `item`, so
        // this returns the real GET response shape directly.
        if (init.method === "GET" && workflowId) {
          const record =
            workflowId === "wf-1" ? definitionRecordWithOutputSchema() : null;
          if (!record) {
            return new Response(
              JSON.stringify({ error: "Workflow not found" }),
              {
                status: 404,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return new Response(
            JSON.stringify({ item: record, resolved: null }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return definitionHandlers.LIST(request, {
          params: Promise.resolve({ name }),
        });
      }

      if (resource === "workflow-templates") {
        return templateHandlers.LIST_TEMPLATES(request, {
          params: Promise.resolve({ name }),
        });
      }

      if (resource === "sessions") {
        const session = decodeURIComponent(segments[4] ?? "");
        const action = segments[6]; // graph-workflow[/execution|/validate]
        if (action === "run") {
          return executionHandlers.RUN(request, {
            params: Promise.resolve({ name, session }),
          });
        }
        if (action === "execution") {
          return executionHandlers.EXECUTION(request, {
            params: Promise.resolve({ name, session }),
          });
        }
        if (action === "executions" && segments[8] === "result") {
          return executionHandlers.EXECUTION_RESULT(request, {
            params: Promise.resolve({
              name,
              session,
              executionId: decodeURIComponent(segments[7] ?? ""),
            }),
          });
        }
        if (action === "executions") {
          return executionHandlers.EXECUTION_BY_ID(request, {
            params: Promise.resolve({
              name,
              session,
              executionId: decodeURIComponent(segments[7] ?? ""),
            }),
          });
        }
        if (action === "abandon") {
          return executionHandlers.ABANDON(request, {
            params: Promise.resolve({ name, session }),
          });
        }
        if (action === "validate") {
          return validateHandlers.POST(request, {
            params: Promise.resolve({ name, session }),
          });
        }
        if (action === "live-outline") {
          return liveOutlineHandlers.GET(request, {
            params: Promise.resolve({ name, session }),
          });
        }
        if (action === "pause") {
          return executionHandlers.PAUSE(request, {
            params: Promise.resolve({ name, session }),
          });
        }
        if (init.method === "POST") {
          return executionHandlers.START(request, {
            params: Promise.resolve({ name, session }),
          });
        }
      }

      throw new Error(`unhandled ${init.method} ${parsed.pathname}`);
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

const env: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "t",
  CC_PROJECT: "cc",
  CC_SESSION: "sess",
  CC_CONVERSATION_ID: CLI_CONVERSATION_ID,
  [CONVERSATION_CAPABILITY_ENV_VAR]: mintConversationCapability(
    { sessionName: "sess", conversationId: CLI_CONVERSATION_ID },
    CAPABILITY_SECRET,
    1_760_000_000_000,
  ),
};

const laneEnv: CliEnv = {
  ...env,
  CC_CONVERSATION_ID: LANE_CONVERSATION_ID,
  [CONVERSATION_CAPABILITY_ENV_VAR]: undefined,
  [LANE_CAPABILITY_ENV_VAR]: mintLaneCapability(
    {
      laneKind: "implementer",
      executionId: "execution-active",
      contextId: "context-plan",
      conversationId: LANE_CONVERSATION_ID,
    },
    CAPABILITY_SECRET,
    1_760_000_000_000,
  ),
};

describe("cctl workflow against the real workflow route handlers", () => {
  it("list parses the definition route's { items } shape", async () => {
    const result = await runCli(
      ["workflow", "list", "--json"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.workflows[0].id).toBe("wf-1");
    expect(envelope.workflows[0].name).toBe("Auth Setup");
  });

  it("templates lists BOTH tiers via the real cross-tier merge", async () => {
    const result = await runCli(
      ["workflow", "templates"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(0);
    // The real template library merged global + project storage, tier-tagged.
    expect(result.stdout).toContain("global  g-1");
    expect(result.stdout).toContain("project  p-1");
  });

  it("templates --tier project filters to the project tier only", async () => {
    const result = await runCli(
      ["workflow", "templates", "--tier", "project"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("p-1");
    expect(result.stdout).not.toContain("g-1");
  });

  it("delete maps to the real DELETE route", async () => {
    const result = await runCli(
      ["workflow", "delete", "wf-1"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deleted wf-1");
  });

  it("delete exits 2 for an unknown workflow (real 404)", async () => {
    const result = await runCli(
      ["workflow", "delete", "nope"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(2);
  });

  it("status parses the full execution route incl. a structured haltReason", async () => {
    const execution = createWorkflowExecution({
      id: "execution-active",
      status: "halted",
      haltReason: {
        type: "max_iterations",
        contextId: "context-plan",
        iterationCount: 7,
        summary: null,
      },
    });
    const result = await runCli(
      ["workflow", "status"],
      env,
      routeHost(execution),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("execution-active");
    // A row per definition context, with completed/total task counts.
    expect(result.stdout).toContain("context-plan");
    expect(result.stdout).toContain("0/1");
    // The structured (non-string) haltReason rendered as its short type label.
    expect(result.stdout).toContain("halted: max_iterations");
  });

  it("status --json bounds the real route payload to the table's own projection", async () => {
    const execution = createWorkflowExecution({
      id: "execution-active",
      status: "running",
      activeContextIds: ["context-plan"],
    });
    const bounded = await runCli(
      ["workflow", "status", "--json"],
      env,
      routeHost(execution),
    );
    const full = await runCli(
      ["workflow", "status", "--full", "--json"],
      env,
      routeHost(execution),
    );

    const envelope = JSON.parse(bounded.stdout);
    expect(envelope.view).toBe("summary");
    expect(envelope.execution).toEqual({
      id: "execution-active",
      status: "running",
      halted: false,
      haltType: null,
      activeContextIds: ["context-plan"],
    });
    expect(
      envelope.contexts.map((context: { id: string }) => context.id),
    ).toEqual(execution.workingDefinition.executionContexts.map((c) => c.id));
    // The charter and the task prose the record carries are a different
    // disclosure level, and --full is where they stay reachable.
    expect(bounded.stdout).not.toContain("charter");
    expect(bounded.stdout).not.toContain("instructions");
    expect(JSON.parse(full.stdout).execution).toEqual(
      JSON.parse(JSON.stringify(execution)),
    );
  });

  it("status reports no active execution when the route returns null", async () => {
    const result = await runCli(["workflow", "status"], env, routeHost(null));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no active graph workflow");
  });

  it("reads the same durable projection by explicit id from Current or History without capability authority", async () => {
    const execution = createWorkflowExecution({
      id: "execution-by-id",
      status: "completed",
      completedAt: "2026-08-14T12:00:00.000Z",
    });
    const capabilityFreeEnv = {
      ...env,
      [CONVERSATION_CAPABILITY_ENV_VAR]: undefined,
    };
    // --full is the selector that carries the whole durable record; the
    // bounded default answers the same address with the table's projection.
    const invocation = [
      "workflow",
      "status",
      execution.id,
      "--project",
      "another-project",
      "--session",
      "archived-session",
      "--full",
      "--json",
    ];

    for (const location of ["Current", "History"]) {
      const result = await runCli(
        invocation,
        capabilityFreeEnv,
        routeHost(
          null,
          {},
          {
            executionDeps: {
              getExecutionById: async (
                _projectPath,
                sessionName,
                executionId,
              ) => {
                expect(sessionName, location).toBe("archived-session");
                expect(executionId, location).toBe(execution.id);
                return execution;
              },
            },
          },
        ),
      );

      expect(result.exitCode, location).toBe(0);
      expect(JSON.parse(result.stdout).execution, location).toEqual(
        JSON.parse(JSON.stringify(execution)),
      );
    }
  });

  it("start parses summarizeExecution and prints the run id + hint", async () => {
    const execution = createWorkflowExecution({
      id: "execution-active",
      status: "running",
    });
    const result = await runCli(
      ["workflow", "start", "wf-1"],
      env,
      routeHost(execution),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("execution-active");
    expect(
      result.stdout
        .trimEnd()
        .endsWith("track progress with 'cctl workflow status'"),
    ).toBe(true);
  });

  it("forwards a lane capability so the real start route refuses nesting", async () => {
    const result = await runCli(
      ["workflow", "start", "wf-1", "--json"],
      laneEnv,
      routeHost(null),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "workflow_nesting_refused",
    });
  });

  it("runs a one-off plan through the real route and preserves the launch receipt without a definition id", async () => {
    const planPath = "/tmp/one-off-plan.json";
    const inputsPath = "/tmp/one-off-inputs.json";
    const base = createWorkflowExecution({
      id: "execution-one-off",
      status: "running",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      origin: { kind: "one_off", planName: "One-off audit" },
      ownerConversationId: CLI_CONVERSATION_ID,
    };
    const plan = {
      name: "One-off audit",
      description: "Inspect the current session",
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    };
    const result = await runCli(
      ["workflow", "run", "--file", planPath, "--inputs", inputsPath, "--json"],
      env,
      routeHost(
        execution,
        {
          [planPath]: JSON.stringify(plan),
          [inputsPath]: JSON.stringify({ target: "staging" }),
        },
        {
          executionDeps: {
            runExecution: async (input) => {
              expect(input.plan.name).toBe("One-off audit");
              expect(input.inputs).toEqual({ target: "staging" });
              expect(input.ownerConversationId).toBe(CLI_CONVERSATION_ID);
              return { execution, awaitingDefinitionApproval: false };
            },
          },
        },
      ),
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      executionId: "execution-one-off",
      status: "running",
      origin: { kind: "one_off", planName: "One-off audit" },
      originConversationId: CLI_CONVERSATION_ID,
    });
    expect(envelope.deepLink).toContain("execution=execution-one-off");
    expect(result.stdout).not.toContain("definitionId");
  });

  it("forwards a lane capability so the real run route returns the shared blocker-free nesting refusal", async () => {
    const planPath = "/tmp/nested-plan.json";
    const plan = {
      name: "Nested run",
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    };
    const result = await runCli(
      ["workflow", "run", "--file", planPath, "--json"],
      laneEnv,
      routeHost(null, { [planPath]: JSON.stringify(plan) }),
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "workflow_nesting_refused",
      details: { remedy: expect.stringContaining("conversation") },
    });
  });

  it("reattaches by durable cursor through a reconstructed route host after the first wait times out", async () => {
    const execution = createWorkflowExecution({
      id: "execution-restart-wait",
      status: "completed",
      completedAt: "2026-08-14T12:02:00.000Z",
    });
    const boundary = {
      cursor: 42,
      occurredAt: "2026-08-14T12:02:00.000Z",
      executionId: execution.id,
      boundaryKind: "completion" as const,
      status: "completed" as const,
      contextId: null,
      pendingActions: [],
      outputs: { kind: "no_declared_structured_result" as const },
      name: "Restart-safe run",
      origin: execution.origin,
      originConversationId: execution.ownerConversationId,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      haltReason: execution.haltReason,
      abandonment: execution.abandonment,
      documents: execution.sharedDocuments,
      deepLink:
        "/projects/cc/sessions/sess/workflow?execution=execution-restart-wait",
    };

    const timedOut = await runCli(
      [
        "workflow",
        "wait",
        execution.id,
        "--cursor",
        "41",
        "--timeout",
        "1ms",
        "--json",
      ],
      env,
      routeHost(
        execution,
        {},
        {
          executionDeps: {
            getExecutionById: async () => execution,
            getBoundaryResultAfter: async () => null,
          },
        },
      ),
    );
    expect(timedOut.exitCode).toBe(1);

    // A new route host stands in for the restarted server process. The cursor
    // is the durable hand-off; no in-memory waiter survives between the calls.
    const reattached = await runCli(
      [
        "workflow",
        "wait",
        execution.id,
        "--cursor",
        "41",
        "--timeout",
        "1s",
        "--json",
      ],
      env,
      routeHost(
        execution,
        {},
        {
          executionDeps: {
            getExecutionById: async () => execution,
            getBoundaryResultAfter: async (
              _projectPath,
              _sessionName,
              _executionId,
              cursor,
            ) => {
              expect(cursor).toBe(41);
              return boundary;
            },
          },
        },
      ),
    );

    expect(reattached.exitCode).toBe(0);
    expect(JSON.parse(reattached.stdout)).toEqual({
      ok: true,
      result: boundary,
    });
  });

  it("forwards a lane capability so the current lane can pause its own run", async () => {
    const base = createWorkflowExecution({
      id: "execution-active",
      status: "running",
    });
    const execution: GraphWorkflowExecution = {
      ...base,
      ownerConversationId: CLI_CONVERSATION_ID,
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "running",
          lastConversationId: LANE_CONVERSATION_ID,
        },
      },
    };
    let pauseCount = 0;
    const result = await runCli(
      ["workflow", "live", "pause"],
      laneEnv,
      routeHost(
        execution,
        {},
        {
          executionDeps: {
            pauseExecution: async () => {
              pauseCount += 1;
              return { ...execution, status: "paused" };
            },
          },
        },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(pauseCount).toBe(1);
  });

  it("abandons an explicitly addressed resumable halt through the signed production route", async () => {
    const baseExecution = createWorkflowExecution({
      id: "execution-abandon",
      status: "halted",
      haltReason: {
        type: "max_iterations",
        contextId: "context-plan",
        iterationCount: 7,
        summary: null,
      },
    });
    const execution: GraphWorkflowExecution = {
      ...baseExecution,
      ownerConversationId: CLI_CONVERSATION_ID,
    };
    const abandonedExecution: GraphWorkflowExecution = {
      ...execution,
      abandonment: {
        abandonedAt: "2026-08-14T12:30:00.000Z",
        reason: "superseded",
        actor: {
          kind: "conversation",
          conversationId: CLI_CONVERSATION_ID,
        },
      },
    };
    const result = await runCli(
      ["workflow", "abandon", execution.id, "--reason", "superseded", "--json"],
      env,
      routeHost(
        execution,
        {},
        {
          executionDeps: {
            abandonExecution: async (input) => {
              expect(input).toMatchObject({
                executionId: execution.id,
                reason: "superseded",
                actor: {
                  kind: "conversation",
                  conversationId: CLI_CONVERSATION_ID,
                },
              });
              return { ok: true, execution: abandonedExecution };
            },
          },
        },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      abandoned: true,
      execution: {
        executionId: execution.id,
        status: "halted",
        archived: true,
      },
    });
  });

  it("start treats the real approval-required route response as a successfully parked execution", async () => {
    const result = await runCli(
      ["workflow", "start", "wf-1", "--json"],
      env,
      routeHost(
        createWorkflowExecution({ id: "execution-review", status: "pending" }),
        {},
        { parkAwaitingApproval: true },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      executionId: "execution-review",
      status: "awaiting_definition_approval",
    });
  });

  it("get prints the compact outline by default (sizes, not bodies)", async () => {
    const result = await runCli(
      ["workflow", "get", "wf-1"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'workflow wf-1 "Workflow Graph Builder" rev 3',
    );
    expect(result.stdout).toContain("contexts (3):");
    expect(result.stdout).toContain("tasks:");
    // The full instruction prose never appears in the outline.
    expect(result.stdout).not.toContain("Read the relevant files.");
  });

  it("get --task slices one task's full instructions", async () => {
    const result = await runCli(
      ["workflow", "get", "wf-1", "--task", "task-plan-1", "--json"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.section).toBe("task");
    expect(envelope.value.instructions).toBe("Read the relevant files.");
  });

  it("get rejects more than one section selector (exit 2)", async () => {
    const result = await runCli(
      ["workflow", "get", "wf-1", "--charter", "--config"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("at most one");
  });

  it("edit applies a valid batch via the real PATCH handler", async () => {
    const ops = "/tmp/ops.json";
    const result = await runCli(
      ["workflow", "edit", "wf-1", "--file", ops],
      env,
      routeHost(null, {
        [ops]: JSON.stringify({
          baseRevision: 3,
          operations: [
            {
              type: "update-task",
              taskId: "task-plan-1",
              instructions: "Read the new files.",
            },
          ],
        }),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 operation applied");
    expect(result.stdout).toContain("revision 4");
  });

  it("edit exits 1 with revision_conflict on a stale baseRevision", async () => {
    const ops = "/tmp/ops.json";
    const result = await runCli(
      ["workflow", "edit", "wf-1", "--file", ops, "--json"],
      env,
      routeHost(null, {
        [ops]: JSON.stringify({
          baseRevision: 2,
          operations: [{ type: "update-workflow", name: "x" }],
        }),
      }),
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.code).toBe("revision_conflict");
  });

  it("edit exits 1 with a locator issue for a semantic rejection", async () => {
    const ops = "/tmp/ops.json";
    const result = await runCli(
      ["workflow", "edit", "wf-1", "--file", ops, "--json"],
      env,
      routeHost(null, {
        [ops]: JSON.stringify({
          baseRevision: 3,
          operations: [{ type: "update-task", taskId: "missing", title: "x" }],
        }),
      }),
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.code).toBe("invalid_edit");
    expect(envelope.issues[0].path).toBe("operations[0]");
  });

  it("edit --dry-run reports the outcome without persisting", async () => {
    const ops = "/tmp/ops.json";
    const result = await runCli(
      ["workflow", "edit", "wf-1", "--file", ops, "--dry-run"],
      env,
      routeHost(null, {
        [ops]: JSON.stringify({
          baseRevision: 3,
          operations: [
            {
              type: "update-task",
              taskId: "task-plan-1",
              title: "Renamed",
            },
          ],
        }),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry-run OK");
  });
});

describe("cctl workflow author flow against the real create-path validation", () => {
  const PLAN = "/tmp/plan.json";

  function validPlan(): string {
    return JSON.stringify({
      name: "Auth Setup",
      description: "OAuth2 workflow",
      definition: createWorkflowDefinition(),
      layout: createWorkflowLayout(),
    });
  }

  /** The fixture graph plus a back-edge that closes a dependency cycle. */
  function cyclicPlan(): string {
    const definition = createWorkflowDefinition();
    return JSON.stringify({
      name: "Auth Setup",
      description: "OAuth2 workflow",
      definition: {
        ...definition,
        edges: [
          ...definition.edges,
          {
            id: "edge-verify-plan",
            sourceContextId: "context-verify",
            targetContextId: "context-plan",
          },
        ],
      },
      layout: createWorkflowLayout(),
    });
  }

  it("validate → { ok } for a well-formed plan via the real validate handler", async () => {
    const result = await runCli(
      ["workflow", "validate", "--file", PLAN],
      env,
      routeHost(null, { [PLAN]: validPlan() }),
    );
    expect(result.exitCode).toBe(0);
    expect(
      result.stdout
        .trimEnd()
        .endsWith(
          `valid — create it with 'cctl workflow create --file ${PLAN}'`,
        ),
    ).toBe(true);
  });

  it("validate exits 2 with JSON-path issues for a cyclic graph", async () => {
    const result = await runCli(
      ["workflow", "validate", "--file", PLAN],
      env,
      routeHost(null, { [PLAN]: cyclicPlan() }),
    );
    expect(result.exitCode).toBe(2);
    // The real structural validator flags the cycle; the CLI renders its path.
    expect(result.stderr).toContain("definition.edges");
  });

  it("create posts through the real create-path validation and prints the start hint", async () => {
    const result = await runCli(
      ["workflow", "create", "--file", PLAN],
      env,
      routeHost(null, { [PLAN]: validPlan() }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wf-new");
    expect(
      result.stdout
        .trimEnd()
        .endsWith("start it with 'cctl workflow start wf-new'"),
    ).toBe(true);
  });

  it("create exits 2 when the real create-path validation rejects a cyclic graph", async () => {
    const result = await runCli(
      ["workflow", "create", "--file", PLAN],
      env,
      routeHost(null, { [PLAN]: cyclicPlan() }),
    );
    expect(result.exitCode).toBe(2);
    // Normalized {error, issues}: the create route now matches validate's shape,
    // so the CLI renders the structural cycle at its issue path (doc 04 §5.3).
    expect(result.stderr).toContain("Workflow plan is invalid");
    expect(result.stderr).toContain("definition.edges");
  });

  it("replace maps to the real PUT route and reports the new revision", async () => {
    const result = await runCli(
      ["workflow", "replace", "wf-1", "--file", PLAN],
      env,
      routeHost(null, { [PLAN]: validPlan() }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("revision: 4");
    expect(result.stdout).not.toContain("hint:");
  });
});

/**
 * R13.1: assignment errors arrive from TWO validation layers — shape/grammar
 * from the synchronous schema pass, reference existence and the tier-scope rule
 * from the async project-scoped checker — and an author must not be able to
 * tell which layer refused from how the refusal reads. Both layers run for real
 * here (the real validate handler over a real library service on a temp profile
 * dir), so these assert the rendered CLI contract end to end rather than the
 * CLI's ability to echo a canned issue list.
 */
describe("cctl workflow validate assignment error contract (R13.1)", () => {
  const PLAN = "/tmp/plan.json";
  /** `  <json path>: <message>` — the one located-issue line both layers emit. */
  const LOCATED_LINE = /^ {2}definition\.[\w.[\]]+: \S.*$/;

  let profileDir: string;
  let checker: AssignmentReferenceChecker;

  beforeEach(async () => {
    profileDir = await mkdtemp(path.join(os.tmpdir(), "cc-wf-cli-profiles-"));
    checker = createAssignmentReferenceChecker({
      library: createAgentProfileLibraryService({
        storage: createAgentProfileStorage({
          resolveConfigDir: () => profileDir,
        }),
      }),
    });
  });

  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  /** The fixture graph with `context-implement` staffed by one cohort. */
  function planWithCohort(assignments: unknown[]): string {
    const definition = createWorkflowDefinition();
    return JSON.stringify({
      name: "Auth Setup",
      description: "OAuth2 workflow",
      definition: {
        ...definition,
        executionContexts: definition.executionContexts.map((context) =>
          context.id === "context-implement"
            ? { ...context, contextValidator: { enabled: true, assignments } }
            : context,
        ),
      },
      layout: createWorkflowLayout(),
    });
  }

  function reviewer(overrides: Record<string, unknown> = {}) {
    return {
      id: "security",
      profile: { tier: "builtin", id: "general-reviewer" },
      strategy: "conversation",
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      continuity: { enabled: true },
      ...overrides,
    };
  }

  /** The `  path: message` detail lines the CLI rendered, in order. */
  function locatedLines(stderr: string): string[] {
    return stderr.split("\n").filter((line) => LOCATED_LINE.test(line));
  }

  async function validate(plan: string, ...extraArgs: string[]) {
    return runCli(
      ["workflow", "validate", "--file", PLAN, ...extraArgs],
      env,
      routeHost(null, { [PLAN]: plan }, { assignmentReferences: checker }),
    );
  }

  it("names the qualified ref and the exact use site for a dangling reference", async () => {
    const result = await validate(
      planWithCohort([
        reviewer({ profile: { tier: "global", id: "missing-reviewer" } }),
      ]),
    );

    expect(result.exitCode).toBe(2);
    const lines = locatedLines(result.stderr);
    expect(lines).toHaveLength(1);
    // The path locates the offending field; the message carries the qualified
    // tier:id spelling AND the use site, so a fix needs no second lookup.
    expect(lines[0]).toContain(
      "definition.executionContexts.1.contextValidator.assignments.0.profile:",
    );
    expect(lines[0]).toContain("global:missing-reviewer");
    expect(lines[0]).toContain('validator assignment "security"');
    expect(lines[0]).toContain('context "context-implement"');
  });

  it("locates a malformed assignment in the same line shape, also exit 2", async () => {
    const result = await validate(
      planWithCohort([reviewer(), reviewer({ focus: "hot paths" })]),
    );

    expect(result.exitCode).toBe(2);
    const lines = locatedLines(result.stderr);
    // The duplicate id is a SHAPE error, found by the other layer — and it
    // carries the same payload: qualified ref, context, role, assignment id.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "definition.executionContexts.1.contextValidator.assignments.1.id:",
    );
    expect(lines[0]).toContain("builtin:general-reviewer");
    expect(lines[0]).toContain('context "context-implement"');
    expect(lines[0]).toContain('validator assignment "security"');
  });

  it("locates a malformed assignment id on the offending assignment", async () => {
    const result = await validate(
      planWithCohort([reviewer({ id: "Security Reviewer" })]),
    );

    expect(result.exitCode).toBe(2);
    const lines = locatedLines(result.stderr);
    expect(lines[0]).toContain(
      "definition.executionContexts.1.contextValidator.assignments.0.id:",
    );
    expect(lines[0]).toContain("builtin:general-reviewer");
    expect(lines[0]).toContain('context "context-implement"');
  });

  /**
   * The anti-drift guard for the whole contract: the SAME assignment refused by
   * each layer must be named with a byte-identical use-site phrase. Both runs
   * go through the real CLI, so a future edit that reworded either layer's
   * message independently fails here rather than in a planning agent's face.
   */
  it("names the use site identically whichever layer refused", async () => {
    const shape = await validate(
      planWithCohort([reviewer(), reviewer({ focus: "hot paths" })]),
    );
    const reference = await validate(
      planWithCohort([
        reviewer({ profile: { tier: "global", id: "missing-reviewer" } }),
      ]),
    );

    const useSite = 'the context "context-implement" validator assignment';
    expect(locatedLines(shape.stderr)[0]).toContain(`${useSite} "security"`);
    expect(locatedLines(reference.stderr)[0]).toContain(
      `${useSite} "security"`,
    );
  });

  it("renders the scope refusal for a project-tier ref in a global document", async () => {
    const result = await validate(
      planWithCohort([
        reviewer({ profile: { tier: "project", id: "house-reviewer" } }),
      ]),
      "--tier",
      "global",
    );

    expect(result.exitCode).toBe(2);
    const lines = locatedLines(result.stderr);
    expect(lines[0]).toContain(
      "definition.executionContexts.1.contextValidator.assignments.0.profile:",
    );
    expect(lines[0]).toContain("project:house-reviewer");
    expect(lines[0]).toContain('validator assignment "security"');
  });

  it("locates a dangling implementer reference at the implementer use site", async () => {
    const definition = createWorkflowDefinition();
    const plan = JSON.stringify({
      name: "Auth Setup",
      definition: {
        ...definition,
        executionContexts: definition.executionContexts.map((context) =>
          context.id === "context-plan"
            ? {
                ...context,
                implementer: {
                  ...context.implementer,
                  profile: { tier: "global", id: "gone-implementer" },
                },
              }
            : context,
        ),
      },
      layout: createWorkflowLayout(),
    });

    const result = await validate(plan);

    expect(result.exitCode).toBe(2);
    const lines = locatedLines(result.stderr);
    expect(lines[0]).toContain(
      "definition.executionContexts.0.implementer.profile:",
    );
    expect(lines[0]).toContain("global:gone-implementer");
    expect(lines[0]).toContain('implementer assignment "implementer"');
  });

  it("accepts a cohort whose references all resolve", async () => {
    const result = await validate(
      planWithCohort([
        reviewer({ id: "security", focus: "auth boundaries" }),
        reviewer({ id: "performance", focus: "hot paths" }),
      ]),
    );

    expect(result.exitCode).toBe(0);
  });

  /**
   * The located-issue contract is ONE LINE PER ISSUE, and the use site quotes
   * values straight out of an untrusted file. A raw newline in an authored id
   * would split one issue across two lines, and the second would be
   * indistinguishable from a genuine located issue — a plan file could forge
   * diagnostics about paths it never touched. Malformed ids are exactly the
   * case this enrichment exists for, so the escaping is load-bearing.
   */
  describe("malformed values cannot forge a located line", () => {
    const FORGERY = "\n  definition.tasks.0.contextId: this issue is fake";

    it("keeps a newline-bearing assignment id to a single line", async () => {
      const result = await validate(
        planWithCohort([reviewer({ id: `evil${FORGERY}` })]),
      );

      expect(result.exitCode).toBe(2);
      expect(locatedLines(result.stderr)).toHaveLength(1);
      expect(result.stderr).not.toContain("this issue is fake\n");
      // Escaped, not stripped: the author still sees what they wrote.
      expect(result.stderr).toContain("\\n");
    });

    it("keeps a newline-bearing profile ref to a single line", async () => {
      const result = await validate(
        planWithCohort([
          reviewer({ profile: { tier: "builtin", id: `x${FORGERY}` } }),
        ]),
      );

      expect(result.exitCode).toBe(2);
      expect(locatedLines(result.stderr)).toHaveLength(1);
    });

    it("keeps a newline-bearing context id to a single line", async () => {
      const definition = createWorkflowDefinition();
      const plan = JSON.stringify({
        name: "Auth Setup",
        definition: {
          ...definition,
          executionContexts: definition.executionContexts.map((context) =>
            context.id === "context-implement"
              ? {
                  ...context,
                  id: `context-implement${FORGERY}`,
                  contextValidator: {
                    enabled: true,
                    assignments: [reviewer(), reviewer()],
                  },
                }
              : context,
          ),
        },
        layout: createWorkflowLayout(),
      });

      const result = await validate(plan);

      expect(result.exitCode).toBe(2);
      // The forged text survives (escaped) inside a real message, but it can
      // never BE a located line: nothing is addressed to the path it names.
      expect(
        locatedLines(result.stderr).some((line) =>
          line.startsWith("  definition.tasks.0.contextId:"),
        ),
      ).toBe(false);
    });

    it("escapes a quote in an id so the use site stays unambiguous", async () => {
      const result = await validate(
        planWithCohort([reviewer({ id: 'ev"il' })]),
      );

      expect(result.exitCode).toBe(2);
      const lines = locatedLines(result.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('validator assignment "ev\\"il"');
    });

    /**
     * The duplicate-id refusal quotes the id from INSIDE the cohort schema,
     * before the use-site enrichment appends anything — so escaping only the
     * appended text leaves this one message able to break the line contract.
     * Every line this renders must still address the cohort it came from.
     */
    it("keeps duplicate newline-bearing assignment ids to one line each", async () => {
      const id = `evil${FORGERY}`;

      const result = await validate(
        planWithCohort([reviewer({ id }), reviewer({ id })]),
      );

      expect(result.exitCode).toBe(2);
      const lines = locatedLines(result.stderr);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).toMatch(
          /^ {2}definition\.executionContexts\.1\.contextValidator\.assignments\.\d+\.id: /,
        );
      }
      expect(result.stderr).toContain("\\n");
    });

    it("leaves a well-formed use site byte-identical", async () => {
      const result = await validate(
        planWithCohort([reviewer(), reviewer({ focus: "hot paths" })]),
      );

      const lines = locatedLines(result.stderr);
      // No escaping artifacts on the values this renders every day.
      expect(lines[0]).toContain(
        'the context "context-implement" validator assignment "security"',
      );
      expect(lines[0]).toContain("agent profile builtin:general-reviewer.");
    });
  });
});

/**
 * R13.1's second half: `validate` is advisory, but ACCEPTANCE is what protects
 * the stored document — and a profile can be deleted between the two. So every
 * write surface (create, replace, targeted edit) re-checks at accept time and
 * must refuse with the SAME located payload validate rendered.
 *
 * The real storage service runs here over a temp config dir, so accept-time
 * validation genuinely executes; a fake persister would prove only that the
 * route forwards whatever it was handed.
 */
describe("cctl workflow acceptance assignment error contract (R13.1)", () => {
  const PLAN = "/tmp/plan.json";
  const EDIT = "/tmp/edit.json";
  const LOCATED_LINE = /^ {2}definition\.[\w.[\]]+: \S.*$/;

  let profileDir: string;
  let workflowDir: string;
  let storage: ReturnType<typeof createWorkflowStorageService>;

  beforeEach(async () => {
    profileDir = await mkdtemp(
      path.join(os.tmpdir(), "cc-wf-accept-profiles-"),
    );
    workflowDir = await mkdtemp(path.join(os.tmpdir(), "cc-wf-accept-store-"));
    storage = createWorkflowStorageService({
      resolveConfigDir: () => workflowDir,
      listActiveExecutions: async () => new Map(),
      assignmentReferences: createAssignmentReferenceChecker({
        library: createAgentProfileLibraryService({
          storage: createAgentProfileStorage({
            resolveConfigDir: () => profileDir,
          }),
        }),
      }),
    });
  });

  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
    await rm(workflowDir, { recursive: true, force: true });
  });

  const scope = { kind: "project" as const, projectPath: PROJECT_PATH };

  /** The real storage service behind the definition routes. */
  function acceptanceHost(files: Record<string, string>): CliHost {
    return routeHost(null, files, {
      definitions: {
        getDefinition: (_projectPath, workflowId) =>
          storage.get(scope, workflowId),
        createDefinition: (_projectPath, draft) => storage.create(scope, draft),
        updateDefinition: (_projectPath, workflowId, draft) =>
          storage.update(scope, workflowId, draft),
      },
    });
  }

  const DANGLING = { tier: "global", id: "missing-reviewer" };

  function planJson(assignments: unknown[]): string {
    const definition = createWorkflowDefinition();
    return JSON.stringify({
      name: "Auth Setup",
      definition: {
        ...definition,
        executionContexts: definition.executionContexts.map((context) =>
          context.id === "context-implement"
            ? { ...context, contextValidator: { enabled: true, assignments } }
            : context,
        ),
      },
      layout: createWorkflowLayout(),
    });
  }

  function reviewer(profile: unknown) {
    return {
      id: "security",
      profile,
      strategy: "conversation",
      agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      continuity: { enabled: true },
    };
  }

  function locatedLines(stderr: string): string[] {
    return stderr.split("\n").filter((line) => LOCATED_LINE.test(line));
  }

  /** Every located line names the ref AND the full use site. */
  function expectLocatedRefusal(stderr: string): void {
    const lines = locatedLines(stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "definition.executionContexts.1.contextValidator.assignments.0.profile:",
    );
    expect(lines[0]).toContain("global:missing-reviewer");
    expect(lines[0]).toContain('context "context-implement"');
    expect(lines[0]).toContain('validator assignment "security"');
  }

  it("refuses create with the located ref and use site", async () => {
    const result = await runCli(
      ["workflow", "create", "--file", PLAN],
      env,
      acceptanceHost({ [PLAN]: planJson([reviewer(DANGLING)]) }),
    );

    expect(result.exitCode).toBe(2);
    expectLocatedRefusal(result.stderr);
  });

  it("refuses replace with the same located payload, not a 404", async () => {
    const created = await runCli(
      ["workflow", "create", "--file", PLAN],
      env,
      acceptanceHost({
        [PLAN]: planJson([
          reviewer({ tier: "builtin", id: "general-reviewer" }),
        ]),
      }),
    );
    expect(created.exitCode).toBe(0);
    const saved = await storage.list(scope);
    const workflowId = saved[0]?.id ?? "";

    const result = await runCli(
      ["workflow", "replace", workflowId, "--file", PLAN],
      env,
      acceptanceHost({ [PLAN]: planJson([reviewer(DANGLING)]) }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("not found");
    expectLocatedRefusal(result.stderr);
  });

  it("refuses a targeted edit that introduces a dangling reference", async () => {
    const created = await runCli(
      ["workflow", "create", "--file", PLAN],
      env,
      acceptanceHost({
        [PLAN]: planJson([
          reviewer({ tier: "builtin", id: "general-reviewer" }),
        ]),
      }),
    );
    expect(created.exitCode).toBe(0);
    const saved = await storage.list(scope);
    const workflowId = saved[0]?.id ?? "";
    const record = await storage.get(scope, workflowId);

    const edit = JSON.stringify({
      baseRevision: record?.revision,
      operations: [
        {
          type: "update-context",
          contextId: "context-implement",
          contextValidator: {
            enabled: true,
            assignments: [reviewer(DANGLING)],
          },
        },
      ],
    });

    const result = await runCli(
      ["workflow", "edit", workflowId, "--file", EDIT],
      env,
      acceptanceHost({ [EDIT]: edit }),
    );

    // A code-bearing rejection of valid-shaped ops → exit 1 (doc 05), with the
    // identical located lines. What must NOT happen is an unmapped throw.
    expect(result.exitCode).toBe(1);
    expectLocatedRefusal(result.stderr);
    // The refusal is atomic: the stored definition still has the good cohort.
    const after = await storage.get(scope, workflowId);
    expect(after?.revision).toBe(record?.revision);
  });

  it("accepts a create whose references all resolve", async () => {
    const result = await runCli(
      ["workflow", "create", "--file", PLAN],
      env,
      acceptanceHost({
        [PLAN]: planJson([
          reviewer({ tier: "builtin", id: "general-reviewer" }),
        ]),
      }),
    );

    expect(result.exitCode).toBe(0);
  });
});

/**
 * R13.1: the two staffing shapes, driven through the REAL saved-definition GET
 * and the REAL live-outline projection in one place — because the contract is
 * the CONTRAST between them, and asserting each surface separately would let
 * them drift into saying the same thing.
 */
describe("cctl workflow assignment provenance (R13.1)", () => {
  it("workflow get shows references — tier:id, strategy, runtime, no revision", async () => {
    const result = await runCli(
      ["workflow", "get", "wf-1"],
      env,
      routeHost(null),
    );

    expect(result.exitCode).toBe(0);
    const staffing = result.stdout
      .split("staffing (references):\n")[1]
      ?.split("\n")
      .filter((line) => line.startsWith("  "));

    expect(staffing?.length).toBeGreaterThan(0);
    expect(staffing?.join("\n")).toContain("builtin:general-implementer");
    // A saved definition resolved nothing: no seeded revision, no hash.
    for (const row of staffing ?? []) {
      expect(row).not.toMatch(/@\d/);
      expect(row).not.toContain("#");
    }
  });

  it("workflow live get shows snapshots — the same rows plus revision and hash", async () => {
    const result = await runCli(
      ["workflow", "live", "get"],
      env,
      routeHost(createWorkflowExecution()),
    );

    expect(result.exitCode).toBe(0);
    const staffing = result.stdout
      .split("staffing (snapshots):\n")[1]
      ?.split("\n")
      .filter((line) => line.startsWith("  "));

    expect(staffing?.length).toBeGreaterThan(0);
    // The seeded fixture snapshot: revision 1, the `b`-digest resolved hash.
    for (const row of staffing ?? []) {
      expect(row).toMatch(/@\d+/);
      expect(row).toContain("#bbbbbbbbbbbb");
    }
  });
});

/**
 * R7.2: the CLI read paths for per-context structured output, driven end to end
 * — the real saved-definition GET and the real live-outline projection, with the
 * three states a reader must be able to tell apart (captured / pending /
 * declares none).
 */
describe("cctl workflow output-schema read paths (R7.2)", () => {
  /**
   * `context-plan` declared a contract and CAPTURED one; `context-implement`
   * declares one and still owes it; `context-verify` declares none.
   */
  function executionWithOutputs(): GraphWorkflowExecution {
    const base = createResolvedWorkflowDefinition();
    return createWorkflowExecution({
      status: "running",
      workingDefinition: {
        ...base,
        executionContexts: base.executionContexts.map((context) =>
          context.id === "context-plan" || context.id === "context-implement"
            ? { ...context, outputSchema: OUTPUT_SCHEMA }
            : context,
        ),
      },
      contextOutputs: {
        "context-plan": {
          value: { verdict: "pass", notes: "all green" },
          capturedAt: "2026-07-30T10:00:00.000Z",
          iteration: 2,
          parse: { source: "fenced", repaired: true, repairAttempts: 1 },
        },
      },
    });
  }

  it("workflow get summarizes a declared outputSchema without printing it", async () => {
    const result = await runCli(
      ["workflow", "get", "wf-1"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(0);
    const rows = result.stdout.split("\n");
    expect(rows.find((row) => row.includes("context-verify"))).toContain(
      "output schema: object · 2 fields",
    );
    expect(rows.find((row) => row.includes("context-plan  "))).not.toContain(
      "output schema",
    );
    // The declaration itself belongs to the `--context` slice, not the outline.
    expect(result.stdout).not.toContain("additionalProperties");
  });

  it("workflow live get summarizes it on the live outline rows too", async () => {
    const result = await runCli(
      ["workflow", "live", "get"],
      env,
      routeHost(executionWithOutputs()),
    );
    expect(result.exitCode).toBe(0);
    const rows = result.stdout.split("\n");
    expect(rows.find((row) => row.startsWith("  context-plan "))).toContain(
      "output schema: object · 2 fields",
    );
    expect(
      rows.find((row) => row.startsWith("  context-verify ")),
    ).not.toContain("output schema");
    expect(result.stdout).not.toContain("additionalProperties");
  });

  it("workflow live get --outputs returns a captured payload with provenance", async () => {
    const result = await runCli(
      ["workflow", "live", "get", "--outputs"],
      env,
      routeHost(executionWithOutputs()),
    );
    expect(result.exitCode).toBe(0);
    const capturedRow = result.stdout
      .split("\n")
      .find((row) => row.trimStart().startsWith("context-plan "));
    expect(capturedRow).toContain("captured");
    expect(result.stdout).toContain('"verdict": "pass"');
    expect(result.stdout).toContain('"notes": "all green"');
    expect(result.stdout).toContain("iteration 2");
    expect(result.stdout).toContain("captured 2026-07-30T10:00:00.000Z");
    expect(result.stdout).toContain("parse fenced (repaired ×1)");
  });

  it("workflow live get --outputs reports a declared-but-unproduced context as pending", async () => {
    const result = await runCli(
      ["workflow", "live", "get", "--outputs", "--json"],
      env,
      routeHost(executionWithOutputs()),
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    const pending = envelope.outputs.find(
      (entry: { contextId: string }) => entry.contextId === "context-implement",
    );
    expect(pending.capture).toEqual({ kind: "pending" });
    expect(pending.schema).toEqual({ type: "object", fieldCount: 2 });
  });

  it("workflow live get --outputs omits contexts that declare no schema", async () => {
    const result = await runCli(
      ["workflow", "live", "get", "--outputs", "--json"],
      env,
      routeHost(executionWithOutputs()),
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(
      envelope.outputs.map((entry: { contextId: string }) => entry.contextId),
    ).toEqual(["context-plan", "context-implement"]);
  });

  it("workflow live get --outputs says so when nothing declares a schema", async () => {
    const result = await runCli(
      ["workflow", "live", "get", "--outputs"],
      env,
      routeHost(createWorkflowExecution({ status: "running" })),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no context declares an outputSchema");
  });

  it("workflow live get --outputs exits 2 with no active execution", async () => {
    const result = await runCli(
      ["workflow", "live", "get", "--outputs"],
      env,
      routeHost(null),
    );
    expect(result.exitCode).toBe(2);
  });
});

/**
 * R13.2: the CLI live outline reports the four D4 decisions an operator has to
 * be able to read — edge guards, skips with their recorded reasons, loop pass
 * counters against their budgets, and expansion provenance — driven end to end
 * through the real live-outline projection and route handler.
 */
describe("cctl workflow live get — D4 read surfaces (R13.2)", () => {
  const GUARD_SCHEMA = {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
  };

  /**
   * `context-plan` classified and banked `verdict: "fine"`, so the guarded edge
   * into `context-implement` resolved false and that branch skipped. One
   * accepted expansion and one refusal sit in the ledgers.
   */
  function routedExecution(): GraphWorkflowExecution {
    const base = createResolvedWorkflowDefinition();
    const execution = createWorkflowExecution({
      status: "running",
      workingDefinition: {
        ...base,
        executionContexts: base.executionContexts.map((context) =>
          context.id === "context-plan"
            ? { ...context, outputSchema: GUARD_SCHEMA }
            : context,
        ),
        edges: base.edges.map((edge) =>
          edge.id === "edge-plan-implement"
            ? {
                ...edge,
                when: {
                  schema: { properties: { verdict: { const: "broken" } } },
                },
              }
            : edge,
        ),
      },
      contextOutputs: {
        "context-plan": {
          value: { verdict: "fine" },
          capturedAt: "2026-07-30T10:00:00.000Z",
          iteration: 1,
          parse: { source: "native" },
        },
      },
      expansionReceipts: {
        accepted: [
          {
            requestId: "req-1",
            payloadHash: "a".repeat(64),
            invokerContextId: "context-plan",
            initiatorConversationId: "conv-1",
            rationale: "Fan out three candidate designs",
            addedContextIds: ["context-verify"],
            addedTaskIds: [],
            rejoinContextIds: ["context-implement"],
            liveRevision: 3,
            acceptedAt: "2026-07-30T10:05:00.000Z",
          },
        ],
        refusals: [
          {
            requestId: "req-2",
            payloadHash: "b".repeat(64),
            invokerContextId: "context-plan",
            refusalCode: "expansion-context-cap-exceeded",
            refusedAt: "2026-07-30T10:06:00.000Z",
          },
        ],
      },
    });
    return {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...execution.contextStates["context-plan"]!,
          status: "completed",
        },
        "context-implement": {
          ...execution.contextStates["context-implement"]!,
          status: "skipped",
          skipReason: {
            at: "2026-07-30T10:10:00.000Z",
            edgeEvaluations: [
              { edgeId: "edge-plan-implement", verdict: "inactive" },
            ],
          },
        },
      },
    };
  }

  /** A concluded loop whose logical exit is satisfied by pass 2's instance. */
  function loopExecution(): GraphWorkflowExecution {
    const base = createResolvedWorkflowDefinition();
    const [plan, implement, verify] = base.executionContexts;
    const execution = createWorkflowExecution({
      status: "running",
      workingDefinition: {
        ...base,
        executionContexts: [
          plan!,
          { ...implement!, id: "loop-a__p2__context-implement" },
          { ...verify!, id: "loop-a__p2__context-verify" },
        ],
        tasks: [],
        edges: [
          {
            id: "edge-verify-plan",
            sourceContextId: "context-verify",
            targetContextId: "context-plan",
          },
        ],
        loopGroups: [
          {
            id: "loop-a",
            entryContextId: "context-implement",
            exitContextId: "context-verify",
            until: { schema: { properties: { done: { const: true } } } },
            maxPasses: 4,
            templateVersion: 2,
            template: {
              contexts: [implement!, verify!],
              tasks: [],
              edges: [],
            },
            planRepair: { enabled: false, maxAttemptsPerContext: 0 },
          },
        ],
      },
      loopStates: {
        "loop-a": {
          loopGroupId: "loop-a",
          activation: "concluded",
          loopControlRevision: 1,
          passCount: 2,
          slotLedger: [],
          boundaryInputs: null,
          decisions: {},
          passTemplateVersions: { "1": 1, "2": 2 },
          concludingExitContextId: "loop-a__p2__context-verify",
          activatedAt: "2026-07-30T09:00:00.000Z",
          settledAt: "2026-07-30T11:00:00.000Z",
        },
      },
    });
    return {
      ...execution,
      taskStates: {},
      contextStates: {
        "context-plan": execution.contextStates["context-plan"]!,
        "loop-a__p2__context-implement": {
          ...execution.contextStates["context-implement"]!,
          contextId: "loop-a__p2__context-implement",
        },
        "loop-a__p2__context-verify": {
          ...execution.contextStates["context-verify"]!,
          contextId: "loop-a__p2__context-verify",
        },
      },
    };
  }

  it("renders a routes block naming each guard and its verdict", async () => {
    const result = await runCli(
      ["workflow", "live", "get"],
      env,
      routeHost(routedExecution()),
    );
    expect(result.exitCode).toBe(0);
    const row = result.stdout
      .split("\n")
      .find((line) => line.trimStart().startsWith("edge-plan-implement "));
    expect(row).toContain("context-plan → context-implement");
    // The guard column prints the projection's own vocabulary (schema | else),
    // so the text view and the `--json` payload name one thing one way.
    expect(row).toContain("schema");
    expect(row).toContain("inactive");
  });

  it("renders the skipped context's row with its recorded reason", async () => {
    const result = await runCli(
      ["workflow", "live", "get"],
      env,
      routeHost(routedExecution()),
    );
    const row = result.stdout
      .split("\n")
      .find((line) => line.startsWith("  context-implement "));
    expect(row).toContain("skipped");
    expect(row).toContain("skip=edge-plan-implement:inactive");
  });

  it("renders expansion provenance on the row and in the ledger", async () => {
    const result = await runCli(
      ["workflow", "live", "get"],
      env,
      routeHost(routedExecution()),
    );
    expect(
      result.stdout
        .split("\n")
        .find((line) => line.startsWith("  context-verify ")),
    ).toContain("added-by=req-1");
    expect(result.stdout).toContain("expansions:");
    expect(result.stdout).toContain("Fan out three candidate designs");
    expect(result.stdout).toContain("expansion-context-cap-exceeded");
  });

  it("renders loop pass counters, budgets and the concluding instance", async () => {
    const result = await runCli(
      ["workflow", "live", "get"],
      env,
      routeHost(loopExecution()),
    );
    expect(result.exitCode).toBe(0);
    const loopRow = result.stdout
      .split("\n")
      .find((line) => line.trimStart().startsWith("loop-a "));
    expect(loopRow).toContain("concluded");
    expect(loopRow).toContain("pass 2/4");
    expect(loopRow).toContain("exit=context-verify");
    expect(loopRow).toContain("loop-a__p2__context-verify");

    const instanceRow = result.stdout
      .split("\n")
      .find((line) => line.startsWith("  loop-a__p2__context-implement "));
    expect(instanceRow).toContain("loop=loop-a pass 2/4");
  });

  it("renders the logical exit's outgoing edge with its effective instance", async () => {
    const result = await runCli(
      ["workflow", "live", "get"],
      env,
      routeHost(loopExecution()),
    );
    const row = result.stdout
      .split("\n")
      .find((line) => line.trimStart().startsWith("edge-verify-plan "));
    expect(row).toContain("context-verify → context-plan");
    expect(row).toContain("via loop-a__p2__context-verify");
  });

  it("prints no D4 blocks for an execution with no guards, loops or expansions", async () => {
    const result = await runCli(
      ["workflow", "live", "get"],
      env,
      routeHost(createWorkflowExecution({ status: "running" })),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("routes:");
    expect(result.stdout).not.toContain("loops:");
    expect(result.stdout).not.toContain("expansions:");
    expect(result.stdout).not.toContain("skip=");
  });
});

describe("the generic clear/release pair is gone, not aliased", () => {
  /**
   * D7 decision D5 deletes CLEAR and `workflow live release` outright. Under the
   * lease, completed/aborted/non-resumably-halted runs release automatically and
   * abandon covers the resumable-halt case with a mandatory audit — so the pair's
   * one remaining job no longer exists. A surviving alias would be a second
   * mutation path on a launched execution with no audit contract, which is
   * exactly what the one-explicit-act rule forbids.
   *
   * Source-level rather than behavioural because "this verb does not exist" is
   * not something an invocation can prove: an unknown subcommand and a deleted
   * one fail identically.
   */
  const REPO_ROOT = nodePath.resolve(__dirname, "../../..");

  function read(relativePath: string): string {
    return readFileSync(nodePath.join(REPO_ROOT, relativePath), "utf-8");
  }

  const ABSENT_ROUTE_FILES = [
    "src/app/api/projects/[name]/sessions/[session]/graph-workflow/release/route.ts",
    "src/app/api/projects/[name]/sessions/[session]/graph-workflow/clear/route.ts",
  ];

  for (const routeFile of ABSENT_ROUTE_FILES) {
    it(`${routeFile} no longer exists`, () => {
      expect(existsSync(nodePath.join(REPO_ROOT, routeFile))).toBe(false);
    });
  }

  it("no surviving surface offers a release verb as a remedy", () => {
    // Help text and refusal remedies alike: a deleted verb named as the way out
    // of a refusal is an impossible recovery, which is worse than no remedy at
    // all — the operator follows it and gets an unknown-command error.
    for (const source of [
      "src/cli/commands/workflow.ts",
      "src/cli/commands/workflow.help.ts",
      "src/cli/commands/spec/spec.help.ts",
      "src/lib/specs/execution-service.ts",
      "src/lib/specs/abandon-coordinator.ts",
      "src/lib/specs/workflow-cleanup-port.ts",
      "src/lib/workflow-graph/execution-route-handlers.ts",
    ]) {
      expect(
        read(source),
        `${source} names a deleted release verb`,
      ).not.toMatch(/workflow live release|live release/);
    }
  });

  it("the route handlers export no clear or release act", () => {
    const source = read("src/lib/workflow-graph/execution-route-handlers.ts");
    expect(source).not.toContain("clearGraphWorkflowExecution");
    expect(source).not.toContain("releaseGraphWorkflowExecution");
    expect(source).not.toContain("releaseGraphWorkflowExecutionForSession");
  });

  it("the browser exposes no clear mutation", () => {
    expect(read("src/lib/workflows/mutations.ts")).not.toContain(
      "useClearGraphWorkflowMutation",
    );
  });

  it("spec abandonment keeps no release_slot phase or release remedy", () => {
    for (const source of [
      "src/lib/specs/abandon-coordinator.ts",
      "src/lib/specs/schemas.ts",
      "src/lib/specs/execution-service.ts",
      "src/lib/specs/export.ts",
      "src/lib/specs/workflow-cleanup-port.ts",
      "src/lib/state-store/state-db.ts",
    ]) {
      expect(read(source)).not.toContain("release_slot");
    }
  });
});
