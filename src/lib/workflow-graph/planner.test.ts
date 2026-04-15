import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/types";
import { createWorkflowDefinitionRecord } from "./test-fixtures";

let capturedToolHandler: ((args: unknown) => Promise<unknown>) | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn(() => {
      return {
        async *[Symbol.asyncIterator]() {
          if (capturedToolHandler) {
            await capturedToolHandler({
              executionContexts: [
                {
                  id: "context-plan",
                  title: "Plan",
                  description: "Inspect the current implementation surface.",
                  agent: {
                    backend: "claude",
                    model: "opus",
                    reasoningEffort: "high",
                  },
                  mutability: { allowAgentTaskAdd: true },
                  circuitBreaker: { consecutiveFailureThreshold: 3 },
                  iterationPolicy: { maxIterations: 3 },
                },
                {
                  id: "context-implement",
                  title: "Implement",
                  description: "Apply the changes.",
                  agent: {
                    backend: "claude",
                    model: "sonnet",
                    reasoningEffort: "medium",
                  },
                  mutability: { allowAgentTaskAdd: false },
                  circuitBreaker: {},
                  iterationPolicy: { maxIterations: 4 },
                },
              ],
              tasks: [
                {
                  id: "task-plan-1",
                  contextId: "context-plan",
                  order: 1,
                  title: "Inspect",
                  instructions: "Read the existing implementation.",
                  source: "user",
                },
                {
                  id: "task-implement-1",
                  contextId: "context-implement",
                  order: 1,
                  title: "Implement",
                  instructions: "Make the requested change.",
                  source: "user",
                },
              ],
              edges: [
                {
                  id: "edge-1",
                  sourceContextId: "context-plan",
                  targetContextId: "context-implement",
                },
              ],
            });
          }
        },
      };
    }),
    createSdkMcpServer: vi.fn(
      (config: {
        tools: Array<{
          name: string;
          handler: (args: unknown) => Promise<unknown>;
        }>;
      }) => {
        for (const tool of config.tools) {
          if (tool.name === "submit_workflow_draft") {
            capturedToolHandler = tool.handler;
          }
        }
        return { __mock: true };
      },
    ),
    tool: vi.fn(
      (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: unknown) => Promise<unknown>,
      ) => ({ name, handler }),
    ),
  };
});

describe("workflow graph planner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedToolHandler = null;
  });

  it("generates a validated draft with deterministic layout", async () => {
    const { createWorkflowPlannerService } = await import("./planner");
    const service = createWorkflowPlannerService({
      loadSeedDefinition: vi.fn(async () => null),
      runPlannerQuery: vi.fn(
        async (): Promise<WorkflowSemanticDefinition> => ({
          schemaVersion: 1,
          executionContexts: [
            {
              id: "context-plan",
              title: "Plan",
              description: "Inspect the current implementation surface.",
              agent: {
                backend: "claude",
                model: "opus",
                reasoningEffort: "high",
              },
              mutability: { allowAgentTaskAdd: true },
              circuitBreaker: {},
              iterationPolicy: {
                maxIterations: 3,
                continuity: { enabled: true },
              },
            },
            {
              id: "context-implement",
              title: "Implement",
              description: "Apply the changes.",
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
              mutability: { allowAgentTaskAdd: false },
              circuitBreaker: {},
              iterationPolicy: {
                maxIterations: 4,
                continuity: { enabled: true },
              },
            },
          ],
          tasks: [
            {
              id: "task-plan-1",
              contextId: "context-plan",
              order: 1,
              title: "Inspect",
              instructions: "Read the existing implementation.",
              source: "user",
            },
            {
              id: "task-implement-1",
              contextId: "context-implement",
              order: 1,
              title: "Implement",
              instructions: "Make the requested change.",
              source: "user",
            },
          ],
          edges: [
            {
              id: "edge-1",
              sourceContextId: "context-plan",
              targetContextId: "context-implement",
            },
          ],
        }),
      ),
    });

    const result = await service.generateDraft({
      objective: "Implement workflow definition CRUD",
      references: [
        {
          filePath: "src/lib/state.ts",
          description: "Current persistence patterns",
        },
      ],
    });

    expect(result.definition.executionContexts).toHaveLength(2);
    expect(result.validationErrors).toEqual([]);
    expect(result.layout.contextPositions["context-plan"]).toBeDefined();
    expect(result.layout.contextPositions["context-implement"]).toBeDefined();
  });

  it("returns validation errors alongside the generated draft", async () => {
    const { createWorkflowPlannerService } = await import("./planner");
    const service = createWorkflowPlannerService({
      loadSeedDefinition: vi.fn(async () => null),
      runPlannerQuery: vi.fn(
        async (): Promise<WorkflowSemanticDefinition> => ({
          schemaVersion: 1,
          executionContexts: [
            {
              id: "context-1",
              title: "Broken",
              agent: {
                backend: "claude",
                model: "opus",
                reasoningEffort: "high",
              },
              mutability: { allowAgentTaskAdd: false },
              circuitBreaker: {},
              iterationPolicy: {
                maxIterations: 1,
                continuity: { enabled: true },
              },
            },
          ],
          tasks: [
            {
              id: "task-1",
              contextId: "missing-context",
              order: 1,
              title: "Broken",
              instructions: "Invalid output",
              source: "user",
            },
          ],
          edges: [],
        }),
      ),
    });

    const result = await service.generateDraft({
      objective: "Generate an invalid draft",
      references: [],
    });

    expect(result.validationErrors.map((error) => error.code)).toContain(
      "unknown-task-context",
    );
    expect(result.definition.tasks[0]?.contextId).toBe("missing-context");
  });

  it("includes seed definition context when a seed id is provided", async () => {
    const { createWorkflowPlannerService } = await import("./planner");
    const loadSeedDefinition = vi.fn<
      (seedDefinitionId: string) => Promise<WorkflowDefinitionRecord | null>
    >(async () => createWorkflowDefinitionRecord());
    const runPlannerQuery = vi.fn(
      async (): Promise<WorkflowSemanticDefinition> => ({
        schemaVersion: 1,
        executionContexts: [],
        tasks: [],
        edges: [],
      }),
    );
    const service = createWorkflowPlannerService({
      loadSeedDefinition,
      runPlannerQuery,
    });

    await service.generateDraft({
      objective: "Extend the existing workflow",
      references: [],
      seedDefinitionId: "workflow-1",
    });

    expect(loadSeedDefinition).toHaveBeenCalledWith("workflow-1");
  });
});
