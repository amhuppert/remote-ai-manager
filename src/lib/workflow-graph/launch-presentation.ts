import {
  workflowDefinitionMutationSchema,
  type WorkflowDefinitionMutation,
} from "./definition-schemas";

/**
 * A copyable ordinary-workflow example for surfaces that document the launch
 * contract. The graph domain owns the authored fields; consumers receive the
 * complete launch as one opaque value.
 */
export function graphWorkflowLaunchExample(): WorkflowDefinitionMutation {
  return workflowDefinitionMutationSchema.parse({
    name: "Workflow Graph Builder",
    description: "Deliver one bounded change and validate the result",
    definition: {
      schemaVersion: 1,
      workflowConfig: {},
      charter: {
        mission: "Deliver the planned change with evidence",
        conventions: [],
        nonGoals: [],
        vocabulary: [],
        testStrategy: "Run the validation required by the acceptance criteria",
        knownAmbiguities: [],
        invariants: [],
        sourcesOfTruth: [
          {
            rank: 1,
            id: "delivery-plan",
            label: "Delivery plan",
            type: "spec",
            locator: "cctl spec plan read",
            description: "The approved delivery-plan attempt",
          },
        ],
      },
      parameters: [],
      prerequisites: [],
      executionContexts: [
        {
          id: "context-implement",
          title: "Implement",
          description: "Implement and validate the planned change",
          acceptanceCriteria:
            "The planned behavior is implemented and verified",
          placement: { lane: "implementation", mode: "full" },
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            agent: {
              backend: "claude",
              modelSelection: {
                modelId: "sonnet",
                parameters: { effort: "medium" },
              },
            },
          },
          mutability: {
            allowAgentTaskAdd: false,
            allowAgentContextAdd: false,
          },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 3,
          },
        },
      ],
      tasks: [
        {
          id: "task-implement",
          contextId: "context-implement",
          order: 1,
          title: "Implement the planned change",
          instructions:
            "Make the scoped change and verify its acceptance criteria.",
          source: "user",
        },
      ],
      edges: [],
    },
    layout: {
      workflowId: "workflow-1",
      contextPositions: { "context-implement": { x: 0, y: 0 } },
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  });
}
