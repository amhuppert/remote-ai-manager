import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import type { GraphWorkflowExecutionToolContextDeps } from "@/lib/workflow-graph/execution-tool-context";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import {
  createLaneRouteHandlers,
  type LaneRouteDeps,
} from "@/lib/workflow-graph/lane-route-handlers";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionToolContext } from "@/lib/workflow-graph/execution-tool-context";
import { createGraphWorkflowRuntimeEditService } from "@/lib/workflow-graph/runtime-edits";
import { createGraphWorkflowSharedDocumentRegistryService } from "@/lib/workflow-graph/shared-documents";
import { hashSharedDocumentContent } from "@/lib/workflow-graph/shared-document-store";
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
} from "@/lib/workflow-graph/schemas";
import { runCcWithHost } from "../../testing/domain-runtime";
import type { CliEnv, CliHost } from "../../transport";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real lane route
 * handlers (`createLaneRouteHandlers`) over the REAL execution tool context, so
 * the CLI's request shape — env-derived `executionId` in the body, the
 * `contexts/[contextId]/tasks/[taskId]` params, the shared-document catch-all —
 * is parsed by production code, and the response facts (`remainingTaskCount`,
 * the 409 halt reason) round-trip back into the CLI's
 * hint-vs-stop rendering. The store's `mutateActive`, document capture, and
 * halt/block signals are controlled per test.
 */

const sessionTarget: ExecutionTarget = {
  worktreePath: "/repo/.worktrees/sess",
  branchName: "csm/sess",
  isolation: "session",
  laneId: null,
};

function makeClaudeLane(): GraphWorkflowAgentSessionState {
  return {
    backend: "claude",
    lane: "implementer",
    contextId: "context-plan",
    workflowConversationId: "conv-bound",
    metrics: {},
    lastUsedAt: "2026-03-27T11:00:00.000Z",
  };
}

function buildRunningExecution(
  options: { limit?: number; iterationCount?: number } = {},
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
        iterationCount: options.iterationCount ?? planState.iterationCount,
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

  return running;
}

interface RealContextOptions {
  documentContents?: string;
  execution?: GraphWorkflowExecution;
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
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast: () => undefined,
    now: () => "2026-03-27T12:00:00.000Z",
  });
  // Serialized read-modify-write backing the sync `mutateActive`; awaits `fn`
  // so a synchronous reducer is applied and its result handled like production.
  const mutateActiveImpl: GraphWorkflowExecutionToolContextDeps["executionRepository"]["mutateActive"] =
    async (_projectPath, _sessionName, fn) => {
      const next = queue.then(async () => {
        return applyFixtureMutation(current, fn, (next) => {
          current = structuredClone(next);
        });
      });
      queue = next.catch(() => undefined);
      return next;
    };
  const factory = createGraphWorkflowExecutionToolContext({
    executionContract: createTestGraphExecutionContract(),
    executionRepository: {
      mutateActive: mutateActiveImpl,
    },
    runtimeEditService: createGraphWorkflowRuntimeEditService({
      createTaskId: () => "task-agent-generated",
      now: () => "2026-03-27T12:00:00.000Z",
    }),
    sharedDocumentRegistry: createGraphWorkflowSharedDocumentRegistryService({
      now: () => "2026-03-27T12:00:00.000Z",
      createDocumentId: () => "doc-1",
      async captureDocumentContent() {
        if (options.documentContents === undefined) {
          throw new Error("No document bytes supplied by this fixture");
        }
        return {
          contentHash: hashSharedDocumentContent(options.documentContents),
        };
      },
    }),
    publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
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
    async readLaneIdentity() {
      return { kind: "absent" as const };
    },
    async expandGraph() {
      throw new Error("expandGraph is not wired in this fixture");
    },
    publishExpansionRefusal() {},
    async resolveProjectPath() {
      return "/repos/cc";
    },
    async loadLaneToolContext() {
      return {
        ok: true,
        context,
        reminderState: {
          iterationCount: 0,
          circuitBreakerThreshold: 3,
          remainingTaskCount: 1,
        },
      };
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
    async readFileBytes() {
      return null;
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
    const result = await runCcWithHost(
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
    expect(result.stdout).toContain("Completed task-plan-1");
    // The fixture context has one task; completing it leaves zero remaining.
    expect(result.stdout).toContain("0 tasks remain");
  });

  it("task complete prints the real 409 halt reason verbatim and exits 1", async () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    };
    const result = await runCcWithHost(
      ["workflow", "task", "complete", "task-plan-1", "--summary", "done"],
      laneEnv,
      laneRouteHost(buildRealContext({ pendingHaltReason: haltReason })),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("iteration halted: circuit_breaker");
  });

  it("renders server-computed lane reminders on a near-threshold success", async () => {
    // iterationCount 2, default threshold 3 → the real completeTask handler
    // computes iteration-budget + (this being the fixture's final task) the
    // final-task self-check; the CLI renders them verbatim.
    const result = await runCcWithHost(
      ["workflow", "task", "complete", "task-plan-1", "--summary", "done"],
      laneEnv,
      laneRouteHost(
        buildRealContext({
          execution: buildRunningExecution({ iterationCount: 2 }),
        }),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Completed task-plan-1");
    expect(result.stdout).toContain(
      "reminder: This context has used 2 of 3 iterations",
    );
    expect(result.stdout).toContain(
      "reminder: That was the last remaining task",
    );
  });

  it("surfaces the server-computed halted-stop reminder on the real 409 halt", async () => {
    const haltReason: GraphWorkflowHaltReason = {
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    };
    const result = await runCcWithHost(
      [
        "workflow",
        "task",
        "complete",
        "task-plan-1",
        "--summary",
        "done",
        "--json",
      ],
      laneEnv,
      laneRouteHost(buildRealContext({ pendingHaltReason: haltReason })),
    );

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.reminders).toHaveLength(1);
    expect(envelope.reminders[0]).toContain(
      "This workflow is halted: iteration halted: circuit_breaker",
    );
    expect(envelope.reminders[0]).toContain("end your turn");
  });

  it("task add is rejected by the real capability gate (403) → exit 1", async () => {
    const result = await runCcWithHost(
      ["workflow", "task", "add", "--title", "T", "--instructions", "Do it."],
      laneEnv,
      laneRouteHost(buildRealContext({ allowAgentTaskAdd: false })),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not allow agent-added tasks");
  });

  it("shared-doc upsert round-trips the catch-all path into the real registry", async () => {
    const docFile = "/tmp/doc.json";
    const result = await runCcWithHost(
      [
        "workflow",
        "shared-doc",
        "upsert",
        ".cc/graph-workflow-docs/api-contract.md",
        "--file",
        docFile,
      ],
      laneEnv,
      laneRouteHost(
        buildRealContext({ documentContents: "# API contract\n" }),
        {
          [docFile]: JSON.stringify({
            description: "API contract",
            readWhen: "before implementing any route",
          }),
        },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".cc/graph-workflow-docs/api-contract.md");
  });

  it("exits 3 through the real token gate when the token is wrong", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cctl-lane-"));
    try {
      await writeFile(path.join(dir, "api-token"), "expected-token\n", {
        mode: 0o600,
      });
      const result = await runCcWithHost(
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
