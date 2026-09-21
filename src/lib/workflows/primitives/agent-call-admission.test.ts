import { describe, expect, it } from "vitest";
import type { ExecutionCatalogEntry } from "@/lib/agent-backends/execution-admission";
import {
  executeAgentCall,
  type AgentCallFacadeDeps,
} from "./agent-call-facade";

function harness() {
  const events: string[] = [];
  const entry: ExecutionCatalogEntry = {
    id: "cursor",
    label: "Cursor",
    facets: { conversation: true, tasks: true },
    execution: {
      conversation: {
        classes: ["ordinary-conversation"],
        instructionDelivery: "user-message",
        fsWriteRestriction: "unsupported",
      },
      tasks: {
        classes: ["nongoverned-task"],
        profiles: ["standard"],
        instructionDelivery: "user-message",
        fsWriteRestriction: "unsupported",
      },
    },
  };
  const deps: AgentCallFacadeDeps = {
    getExecutionEntry: () => entry,
    taskExecution: {
      workingDirectory: "/repo",
      resumeRef: { backend: "cursor", ref: "valid-ref" },
    },
    getTaskRunner: () => {
      events.push("resolve-runner");
      return {
        backend: "cursor",
        async run() {
          events.push("run");
          return {
            text: "{}",
            backendRef: { backend: "cursor", ref: "valid-ref" },
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      };
    },
    applyMcp: () => {
      events.push("mcp");
      return { ok: true };
    },
  };
  return { events, deps };
}

describe("AgentCall admission", () => {
  it("refuses a governed call before resolving a runner or applying MCP", async () => {
    const h = harness();
    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: "cursor",
        executionClass: "governed-execution",
        prompt: "validate",
        modelSelection: { modelId: "model", parameters: {} },
      },
      h.deps,
    );
    expect(result.outcome).toMatchObject({
      kind: "failed",
      error: {
        failureKind: "capability_unavailable",
        code: "backend-role-unsupported",
        retryable: false,
      },
    });
    expect(result.continuationDisposition).toBe("retain");
    expect(h.events).toEqual([]);
  });

  it("formats a standard call without requiring an isolated repair profile", async () => {
    const h = harness();
    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: "cursor",
        executionClass: "nongoverned-task",
        prompt: "format",
        outputSchema: { type: "object" },
        modelSelection: { modelId: "model", parameters: {} },
      },
      h.deps,
    );
    expect(result.outcome).toMatchObject({
      kind: "completed",
      structuredOutput: {},
    });
    expect(h.events).toEqual(["resolve-runner", "mcp", "run", "run"]);
  });
});
