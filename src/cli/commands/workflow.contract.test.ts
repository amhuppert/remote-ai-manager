import os from "node:os";
import { describe, expect, it } from "vitest";
import { createWorkflowDefinitionRouteHandlers } from "@/lib/workflows/definition-route-handlers";
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
import { WorkflowDefinitionApprovalRequiredError } from "@/lib/workflow-graph/workflow-manager";
import type { SessionState } from "@/lib/sessions/schemas";
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

function makeSession(): SessionState {
  return {
    sessionName: "sess",
    worktreePath: WORKTREE,
    branchName: "csm/sess",
    createdAt: "2026-03-27T12:00:00.000Z",
    lastActivityAt: "2026-03-27T12:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
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
    normalizeExecutionAfterRestart: async () => null,
    startExecution: notUsed,
    pauseExecution: notUsed,
    resumeExecution: notUsed,
    abortExecution: notUsed,
    resetExecutionContext: notUsed,
    archiveExecution: notUsed,
    kickOffExecutionLoop: async () => {},
    getActiveExecution: async () => null,
    recordPendingHaltReason: notUsed,
    drainAndHalt: notUsed,
    recordApprovalDecision: notUsed,
    listArchivedExecutions: async () => [],
    ...overrides,
  };
}

function routeHost(
  execution: GraphWorkflowExecution | null,
  files: Record<string, string> = {},
  startError?: Error,
): CliHost {
  const definitionHandlers = createWorkflowDefinitionRouteHandlers({
    resolveProjectPath: async () => PROJECT_PATH,
    readConfig: notUsed,
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
        return execution;
      },
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
        if (action === "execution") {
          return executionHandlers.EXECUTION(request, {
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

  it("status reports no active execution when the route returns null", async () => {
    const result = await runCli(["workflow", "status"], env, routeHost(null));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no active graph workflow");
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

  it("start treats the real approval-required route response as a successfully parked execution", async () => {
    const result = await runCli(
      ["workflow", "start", "wf-1", "--json"],
      env,
      routeHost(
        null,
        {},
        new WorkflowDefinitionApprovalRequiredError(
          "execution-review",
          "definition-review",
          1,
        ),
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
