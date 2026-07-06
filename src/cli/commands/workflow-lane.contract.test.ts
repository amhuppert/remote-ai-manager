import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LiveOccupancySnapshot } from "@/lib/conversations/live-occupancy";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import {
  createLaneRouteHandlers,
  type LaneRouteDeps,
} from "@/lib/workflow-graph/lane-route-handlers";
import { createGraphWorkflowExecutionToolContext } from "@/lib/workflow-graph/execution-tool-context";
import { createGraphWorkflowRuntimeEditService } from "@/lib/workflow-graph/runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "@/lib/workflow-graph/shared-documents";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type {
  GraphWorkflowToolServerContext,
  GraphWorkflowCollaborationContextBlock,
} from "@/lib/workflow-graph/lane-tool-service";
import type { PendingToolBlock } from "@/lib/workflow-graph/tool-dispatcher";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflows/schemas";
import { runCli } from "../core";
import type { CliEnv, CliHost } from "../shared";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real lane route
 * handlers (`createLaneRouteHandlers`) over the REAL execution tool context, so
 * the CLI's request shape — env-derived `executionId` in the body, the
 * `contexts/[contextId]/tasks/[taskId]` params, the shared-document catch-all —
 * is parsed by production code, and the response facts (`remainingTaskCount`,
 * `stopInstruction`, the 409 halt reason) round-trip back into the CLI's
 * hint-vs-stop rendering. Only the store's `mutateActive` and the halt/block
 * signals are controlled per test.
 */

const sessionTarget: ExecutionTarget = {
  worktreePath: "/repo/.worktrees/sess",
  branchName: "csm/sess",
  isolation: "session",
  laneId: null,
};

function makeClaudeLane(): GraphWorkflowAgentSessionState {
  return {
    engine: "claude",
    lane: "implementer",
    contextId: "context-plan",
    sessionRef: {
      engine: "claude",
      lane: "implementer",
      conversationId: "conv-bound",
    },
    lastContextTokens: null,
    lastContextWindowMax: null,
    rotateBeforeNextTurn: false,
    limitEvaluation: "disabled",
    lastUsedAt: "2026-03-27T11:00:00.000Z",
  };
}

function buildRunningExecution(
  options: { limit?: number } = {},
): GraphWorkflowExecution {
  // Id matches CC_WORKFLOW_EXECUTION_ID so the tool context's bound-execution
  // guard (`ensureBoundContextActive`) accepts the lane.
  const base = createWorkflowExecution({ id: "exec-7" });
  const planState = base.contextStates["context-plan"];
  if (!planState) throw new Error("fixture missing context-plan");
  const running: GraphWorkflowExecution = {
    ...base,
    status: "running",
    activeContextIds: ["context-plan"],
    contextStates: {
      ...base.contextStates,
      "context-plan": {
        ...planState,
        status: "running",
        worktreePath: null,
        branchName: null,
        isolation: "session",
      },
    },
    laneStates: {
      ...base.laneStates,
      "context-plan": { implementer: makeClaudeLane() },
    },
  };

  if (options.limit !== undefined) {
    running.workingDefinition = {
      ...running.workingDefinition,
      executionContexts: running.workingDefinition.executionContexts.map(
        (ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                iterationPolicy: {
                  ...ctx.iterationPolicy,
                  continuity: {
                    ...ctx.iterationPolicy.continuity,
                    contextLimitTokens: options.limit,
                  },
                },
              }
            : ctx,
      ),
    };
  }
  return running;
}

interface RealContextOptions {
  execution?: GraphWorkflowExecution;
  readLiveOccupancy?: (conversationId: string) => LiveOccupancySnapshot | null;
  allowAgentTaskAdd?: boolean;
  allowAgentCollaboration?: boolean;
  collaboration?: GraphWorkflowCollaborationContextBlock;
  pendingHaltReason?: GraphWorkflowHaltReason | null;
  pendingToolBlock?: PendingToolBlock | null;
}

/** A real tool context over a serialized in-memory `mutateActive`. */
function buildRealContext(
  options: RealContextOptions = {},
): GraphWorkflowToolServerContext {
  let current = structuredClone(options.execution ?? buildRunningExecution());
  let queue: Promise<unknown> = Promise.resolve();
  const factory = createGraphWorkflowExecutionToolContext({
    workflowManager: {
      async mutateActive(_projectPath, _sessionName, fn) {
        const next = queue.then(async () => {
          const draft = structuredClone(current);
          const result = await fn(draft);
          current = structuredClone(result);
          return current;
        });
        queue = next.catch(() => undefined);
        return next;
      },
    },
    runtimeEditService: createGraphWorkflowRuntimeEditService({
      createTaskId: () => "task-agent-generated",
      now: () => "2026-03-27T12:00:00.000Z",
    }),
    sharedDocumentRegistry: createGraphWorkflowSharedDocumentRegistryService({
      now: () => "2026-03-27T12:00:00.000Z",
      createDocumentId: () => "doc-1",
    }),
    readLiveOccupancy: options.readLiveOccupancy ?? (() => null),
    now: () => "2026-03-27T12:00:00.000Z",
  });
  const bound = factory.create({
    projectPath: "/repos/cc",
    sessionName: "sess",
    executionId: "exec-7",
    contextId: "context-plan",
    conversationId: "conv-bound",
    executionTarget: sessionTarget,
    executionContextTitle: "Plan",
    allowAgentTaskAdd: options.allowAgentTaskAdd ?? true,
    allowAgentCollaboration: options.allowAgentCollaboration ?? false,
    ...(options.collaboration ? { collaboration: options.collaboration } : {}),
  });
  return {
    ...bound,
    getPendingHaltReason: async () => options.pendingHaltReason ?? null,
    getPendingToolBlock: async () => options.pendingToolBlock ?? null,
  };
}

/** Route host: the CLI's requests dispatched into the real lane handlers. */
function laneRouteHost(
  context: GraphWorkflowToolServerContext,
  files: Record<string, string> = {},
  auth?: LaneRouteDeps["auth"],
): CliHost {
  const deps: LaneRouteDeps = {
    auth: auth ?? {
      async requireToken() {
        return null;
      },
      async validateOptionalToken() {
        return { kind: "valid" as const };
      },
    },
    async resolveProjectPath() {
      return "/repos/cc";
    },
    async loadLaneToolContext() {
      return { ok: true, context };
    },
  };
  const handlers = createLaneRouteHandlers(deps);

  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const name = decodeURIComponent(segments[2] ?? "");
      const session = decodeURIComponent(segments[4] ?? "");
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      // …/graph-workflow (segments[5]) / contexts|shared-documents (6) / …
      const kind = segments[6];
      if (kind === "shared-documents") {
        const docPath = segments.slice(7).map((s) => decodeURIComponent(s));
        return handlers.upsertSharedDocument(request, {
          params: Promise.resolve({ name, session, docPath }),
        });
      }
      if (kind === "contexts") {
        const contextId = decodeURIComponent(segments[7] ?? "");
        const leaf = segments[segments.length - 1];
        if (leaf === "complete") {
          const taskId = decodeURIComponent(segments[9] ?? "");
          return handlers.completeTask(request, {
            params: Promise.resolve({ name, session, contextId, taskId }),
          });
        }
        if (leaf === "collaboration-requests") {
          return handlers.requestCollaboration(request, {
            params: Promise.resolve({ name, session, contextId }),
          });
        }
        if (leaf === "tasks") {
          return handlers.addTask(request, {
            params: Promise.resolve({ name, session, contextId }),
          });
        }
      }
      throw new Error(`unhandled ${init.method} ${parsed.pathname}`);
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const laneEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:4999",
  CC_API_TOKEN: "t",
  CC_PROJECT: "cc",
  CC_SESSION: "sess",
  CC_WORKFLOW_EXECUTION_ID: "exec-7",
  CC_WORKFLOW_CONTEXT_ID: "context-plan",
};

describe("cctl workflow lane verbs against the real lane route handlers", () => {
  it("task complete runs the real mutation and reports the remaining count", async () => {
    const result = await runCli(
      [
        "workflow",
        "task",
        "complete",
        "task-plan-1",
        "--summary",
        "Wrote the plan.",
      ],
      laneEnv,
      laneRouteHost(buildRealContext()),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("completed task-plan-1");
    // The fixture context has one task; completing it leaves zero remaining.
    expect(result.stdout).toContain("hint: 0 tasks remain in this context");
  });

  it("task complete surfaces the real rotation-gate stop instruction, no hint", async () => {
    const result = await runCli(
      ["workflow", "task", "complete", "task-plan-1", "--summary", "done"],
      laneEnv,
      laneRouteHost(
        buildRealContext({
          execution: buildRunningExecution({ limit: 100 }),
          readLiveOccupancy: () => ({
            contextTokens: 200,
            compactedThisTurn: false,
          }),
        }),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CONTEXT LIMIT REACHED");
    expect(result.stdout).not.toContain("hint:");
  });

  it("task complete prints the real 409 halt reason verbatim and exits 1", async () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    };
    const result = await runCli(
      ["workflow", "task", "complete", "task-plan-1", "--summary", "done"],
      laneEnv,
      laneRouteHost(buildRealContext({ pendingHaltReason: haltReason })),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("iteration halted: circuit_breaker");
  });

  it("task add is rejected by the real capability gate (403) → exit 1", async () => {
    const result = await runCli(
      ["workflow", "task", "add", "--title", "T", "--instructions", "Do it."],
      laneEnv,
      laneRouteHost(buildRealContext({ allowAgentTaskAdd: false })),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not allow agent-added tasks");
  });

  it("shared-doc upsert round-trips the catch-all path into the real registry", async () => {
    const docFile = "/tmp/doc.json";
    const result = await runCli(
      [
        "workflow",
        "shared-doc",
        "upsert",
        ".cc/graph-workflow-docs/api-contract.md",
        "--file",
        docFile,
      ],
      laneEnv,
      laneRouteHost(buildRealContext(), {
        [docFile]: JSON.stringify({
          description: "API contract",
          readWhen: "before implementing any route",
        }),
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "registered shared document .cc/graph-workflow-docs/api-contract.md",
    );
  });

  it("exits 3 through the real token gate when the token is wrong", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cctl-lane-"));
    try {
      await writeFile(path.join(dir, "api-token"), "expected-token\n", {
        mode: 0o600,
      });
      const result = await runCli(
        [
          "workflow",
          "task",
          "complete",
          "task-plan-1",
          "--summary",
          "Wrote the plan.",
        ],
        { ...laneEnv, CC_API_TOKEN: "wrong" },
        laneRouteHost(
          buildRealContext(),
          {},
          createAgentAuth({ configDir: dir }),
        ),
      );

      expect(result.exitCode).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
