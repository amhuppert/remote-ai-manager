/**
 * Migration safety net: the planner was switched from `executeAgentCall` to
 * `executeWorkflowTaskRun` bound to the reserved `__planner__` session. The
 * canonical contract is the `WorkflowSemanticDefinition` written to the
 * `planner-draft-registry`, and that should be unchanged by the route swap.
 *
 * This test stubs the `executeWorkflowTaskRun` boundary, registers a fixed
 * `WorkflowSemanticDefinition` fixture via the planner-draft-registry deps,
 * runs the planner end-to-end through `createWorkflowPlannerService`, and
 * snapshots the resulting `WorkflowGeneratedDraft` (definition + layout +
 * validationErrors). Any drift in the planner→draft contract surfaces here.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowSemanticDefinition } from "@/lib/workflows/schemas";
import {
  createDefaultPlannerRunner,
  createWorkflowPlannerService,
} from "./planner";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

const FIXTURE_DRAFT: WorkflowSemanticDefinition = {
  schemaVersion: 1,
  workflowConfig: {},
  charter: makeTestCharter(),
  executionContexts: [
    {
      id: "context-plan",
      title: "Plan",
      description: "Inspect the implementation surface.",
      acceptanceCriteria:
        "plan.md describes the change in implementable detail.",
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: {
        maxIterations: 2,
        continuity: { enabled: true },
      },
    },
    {
      id: "context-implement",
      title: "Implement",
      description: "Apply the planned change.",
      acceptanceCriteria:
        "feature behaves as described when exercised end-to-end.",
      implementer: {
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
      title: "Inspect current code",
      instructions: "Read the modules touched by the objective.",
      source: "user",
    },
    {
      id: "task-implement-1",
      contextId: "context-implement",
      order: 1,
      title: "Implement change",
      instructions: "Apply the change as described in plan.md.",
      source: "user",
    },
  ],
  edges: [
    {
      id: "edge-plan-to-impl",
      sourceContextId: "context-plan",
      targetContextId: "context-implement",
    },
  ],
};

describe("planner workflow generation — fixture snapshot", () => {
  it("produces the same canonical WorkflowGeneratedDraft for a fixed planner draft", async () => {
    const runPlannerQuery = createDefaultPlannerRunner({
      executeWorkflowTaskRun: async () => ({
        kind: "text",
        text: "free-form planner narration — not the contract",
        usage: {
          costUsd: null,
          durationMs: null,
          contextTokens: null,
          contextWindowMax: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
        },
        backendRef: null,
      }),
      createPlannerDraftSubmission: () => ({ draftId: "snapshot-draft" }),
      consumePlannerDraft: () => FIXTURE_DRAFT,
      deletePlannerDraft: () => undefined,
      buildWorkflowDraftPortableMcp: () => ({
        servers: [
          {
            id: "cc-workflow-draft",
            transport: "streamable-http",
            url: "http://stub.invalid/mcp",
          },
        ],
      }),
    });

    const service = createWorkflowPlannerService({
      loadSeedDefinition: async () => null,
      runPlannerQuery,
    });

    const draft = await service.generateDraft({
      objective: "Implement workflow definition CRUD",
      references: [
        {
          filePath: "src/lib/state.ts",
          description: "Current persistence patterns",
        },
      ],
      projectPath: "/projects/remote-ai-manager",
      sessionName: "__planner__",
      conversationId: "planner-conv-snapshot",
    });

    expect(draft).toMatchInlineSnapshot(`
      {
        "definition": {
          "charter": {
            "conventions": [
              "Prefer early returns",
              "Zod schemas are the source of truth",
            ],
            "knownAmbiguities": [
              "scope of the AeroTrainer floor/round case",
            ],
            "mission": "Deliver the feature with a single authority model",
            "nonGoals": [
              "Backward compatibility with pre-charter records",
            ],
            "ownershipMap": "schemas owned by the platform team",
            "sourcesOfTruth": [
              {
                "accessPolicy": "worktree-relative",
                "appliesTo": "all execution contexts",
                "description": "The authoritative architecture for this workflow",
                "id": "design-doc",
                "label": "Approved design document",
                "locator": ".kiro/specs/workflow-charter/design.md",
                "rank": 1,
                "type": "document",
              },
              {
                "accessPolicy": "worktree-relative",
                "description": "Context-level criteria; defer to higher-ranked sources",
                "id": "acceptance-criteria",
                "label": "Per-context acceptance criteria",
                "locator": "context.acceptanceCriteria",
                "rank": 2,
                "type": "spec",
              },
            ],
            "testStrategy": "TDD red-green-refactor with round-trip durability contracts",
            "vocabulary": [
              "charter: the workflow-global source-of-truth brief",
            ],
          },
          "edges": [
            {
              "id": "edge-plan-to-impl",
              "sourceContextId": "context-plan",
              "targetContextId": "context-implement",
            },
          ],
          "executionContexts": [
            {
              "acceptanceCriteria": "plan.md describes the change in implementable detail.",
              "circuitBreaker": {},
              "description": "Inspect the implementation surface.",
              "id": "context-plan",
              "implementer": {
                "backend": "claude",
                "model": "opus",
                "reasoningEffort": "high",
              },
              "iterationPolicy": {
                "continuity": {
                  "enabled": true,
                },
                "maxIterations": 2,
              },
              "mutability": {
                "allowAgentTaskAdd": false,
              },
              "title": "Plan",
            },
            {
              "acceptanceCriteria": "feature behaves as described when exercised end-to-end.",
              "circuitBreaker": {},
              "description": "Apply the planned change.",
              "id": "context-implement",
              "implementer": {
                "backend": "claude",
                "model": "sonnet",
                "reasoningEffort": "medium",
              },
              "iterationPolicy": {
                "continuity": {
                  "enabled": true,
                },
                "maxIterations": 4,
              },
              "mutability": {
                "allowAgentTaskAdd": false,
              },
              "title": "Implement",
            },
          ],
          "schemaVersion": 1,
          "tasks": [
            {
              "contextId": "context-plan",
              "id": "task-plan-1",
              "instructions": "Read the modules touched by the objective.",
              "order": 1,
              "source": "user",
              "title": "Inspect current code",
            },
            {
              "contextId": "context-implement",
              "id": "task-implement-1",
              "instructions": "Apply the change as described in plan.md.",
              "order": 1,
              "source": "user",
              "title": "Implement change",
            },
          ],
          "workflowConfig": {},
        },
        "layout": {
          "contextPositions": {
            "context-implement": {
              "x": 360,
              "y": 0,
            },
            "context-plan": {
              "x": 0,
              "y": 0,
            },
          },
          "viewport": {
            "x": 0,
            "y": 0,
            "zoom": 1,
          },
          "workflowId": "generated",
        },
        "validationErrors": [],
      }
    `);
  });
});
