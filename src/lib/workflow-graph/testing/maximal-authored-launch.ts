import { z } from "zod";

import type { CharterInvariantAppliesTo } from "@/lib/workflows/charter-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import type { AuthoredAccountabilityCoverageGroup } from "../authored-accountability-coverage";
import {
  workflowDefinitionMutationSchema,
  type WorkflowDefinitionMutation,
} from "../definition-schemas";
import {
  createWorkflowDefinition,
  makeImplementerAssignment,
  makeValidatorAssignment,
} from "../test-fixtures";

function graphOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = JSON.parse(
    JSON.stringify(z.toJSONSchema(schema)),
  ) as Record<string, unknown>;

  function normalize(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(normalize);
      return;
    }
    if (node === null || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    delete record.$schema;
    delete record["~standard"];
    if (record.const !== undefined) delete record.type;
    Object.values(record).forEach(normalize);
  }

  normalize(jsonSchema);
  return jsonSchema;
}

const routeVerdictSchema = graphOutputSchema(
  z.object({ verdict: z.enum(["ship", "hold", "defer"]) }),
);
const loopProgressSchema = graphOutputSchema(
  z.object({ progress: z.number().int().min(0) }),
);
const loopApprovalSchema = graphOutputSchema(
  z.object({ approved: z.boolean() }),
);
const alternateSuccessSchema = graphOutputSchema(
  z.object({ success: z.boolean() }),
);
const auditAttestationSchema = graphOutputSchema(
  z.object({ audited: z.literal(true) }),
);

export const MAXIMAL_GRAPH_AFTER_ENVELOPE_CANARY = {
  contextIds: ["context-integrate"],
} as const satisfies CharterInvariantAppliesTo;

export const MAXIMAL_AUTHORED_LAUNCH_ACCOUNTABILITY_GROUPS = [
  {
    bindingKey: "stable-spawner",
    claimantContextIds: ["context-spawner"],
  },
  {
    bindingKey: "post-loop-integration",
    claimantContextIds: ["context-integrate"],
  },
  {
    bindingKey: "loop-template-is-not-claimable",
    claimantContextIds: ["context-loop-worker"],
  },
] as const satisfies readonly AuthoredAccountabilityCoverageGroup[];

export function createMaximalAuthoredWorkflowLaunchFixture(): WorkflowDefinitionMutation {
  const base = createWorkflowDefinition();
  const spawnerBase = base.executionContexts[0]!;
  const workerBase = base.executionContexts[1]!;
  const verifierBase = base.executionContexts[2]!;
  const validator = makeValidatorAssignment({
    id: "security",
    focus: "Review maximal graph behavior",
  });

  const definition = {
    ...base,
    approvalRequired: false,
    origin: { sourceUri: "workflow://maximal-canary", label: "Maximal canary" },
    lockedRegions: [
      {
        paths: ["/charter"],
        sourceUri: "workflow://maximal-canary",
        reason: "The fixture exercises authored lock metadata.",
        instruction: "Update the canonical test fixture.",
      },
    ],
    workflowConfig: {
      implementer: makeImplementerAssignment(
        { backend: "claude", model: "opus", reasoningEffort: "high" },
        { focus: "Exercise the complete graph launch dialect" },
      ),
      contextValidator: { enabled: false, assignments: [validator] },
      scriptValidator: { commands: ["lint"] },
      laneMergeValidation: {
        strategy: "every-merge",
        commands: { mode: "only", commands: ["lint"] },
      },
      iterationPolicy: {
        maxIterations: 7,
        continuity: { enabled: true, contextLimitTokens: 4_096 },
      },
      circuitBreaker: { consecutiveFailureThreshold: 3 },
      mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
      planRepair: {
        enabled: true,
        maxAttemptsPerContext: 3,
        agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
      },
      collaboration: {
        enabled: true,
        secondAgent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        negotiationRounds: 2,
        autonomousResolutionThreshold: "minor",
      },
      humanApprovalGate: { enabled: true },
      askUserQuestions: { enabled: true },
      agentValidation: {
        implementer: { mode: "all", except: ["format"] },
        contextValidator: { mode: "only", commands: ["lint"] },
      },
    },
    charter: makeTestCharter({
      invariants: [
        {
          id: "global-foundation",
          statement: "The shared graph contract remains authoritative.",
        },
        {
          id: "graph-after-envelope-canary",
          statement: "The integration context carries the scoped canary.",
          appliesTo: MAXIMAL_GRAPH_AFTER_ENVELOPE_CANARY,
        },
      ],
    }),
    parameters: [
      {
        type: "string" as const,
        name: "ticket",
        label: "Ticket",
        required: true,
        default: "CC-66",
        minLength: 1,
        maxLength: 80,
      },
      {
        type: "text" as const,
        name: "brief",
        label: "Brief",
        required: false,
        default: "Exercise {{inputs.ticket}}",
        minLength: 1,
        maxLength: 240,
      },
      {
        type: "enum" as const,
        name: "mode",
        label: "Mode",
        required: false,
        options: ["fast", "careful"],
        default: "careful",
      },
    ],
    prerequisites: [
      { kind: "path" as const, path: "src", label: "Source tree" },
      {
        kind: "skill" as const,
        skill: "graph-workflow-planning",
        backend: "claude" as const,
        label: "Graph authoring skill",
      },
    ],
    executionContexts: [
      {
        ...spawnerBase,
        id: "context-spawner",
        title: "Spawn and classify",
        description: "Classify the route and optionally expand the graph.",
        acceptanceCriteria:
          "A route verdict is captured for {{inputs.ticket}}.",
        placement: { lane: "orchestration", mode: "full" as const },
        outputSchema: routeVerdictSchema,
        routing: { cardinality: "independent" as const },
        implementer: makeImplementerAssignment(
          { backend: "claude", model: "opus", reasoningEffort: "high" },
          { focus: "Classify and expand" },
        ),
        contextValidator: { enabled: false, assignments: [validator] },
        scriptValidator: { commands: ["lint"] },
        mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
        circuitBreaker: { consecutiveFailureThreshold: 4 },
        iterationPolicy: {
          maxIterations: 6,
          continuity: { enabled: true, contextLimitTokens: 2_048 },
        },
        planRepair: {
          enabled: false,
          maxAttemptsPerContext: 1,
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
        collaboration: {
          enabled: false,
          negotiationRounds: 1,
          autonomousResolutionThreshold: "none" as const,
        },
        humanApprovalGate: { enabled: false },
        askUserQuestions: { enabled: false },
        agentValidation: {
          implementer: { mode: "only" as const, commands: ["lint"] },
          contextValidator: { mode: "only" as const, commands: [] },
        },
        origin: { sourceUri: "workflow://maximal-canary/spawner" },
        metadata: { fixtureRole: "stable-expansion-spawner" },
      },
      {
        ...workerBase,
        id: "context-loop-worker",
        title: "Loop worker",
        description: "Perform one refinement pass.",
        acceptanceCriteria: "The pass emits progress.",
        placement: {
          lane: "implementation",
          mode: "owned" as const,
          ownedPaths: ["src/lib/workflow-graph"],
        },
        outputSchema: loopProgressSchema,
        origin: { sourceUri: "workflow://maximal-canary/loop-worker" },
        metadata: { fixtureRole: "non-claimable-loop-template" },
      },
      {
        ...verifierBase,
        id: "context-loop-judge",
        title: "Loop judge",
        description: "Decide whether refinement is complete.",
        acceptanceCriteria: "The pass records an approval verdict.",
        placement: { lane: "verification", mode: "readOnly" as const },
        outputSchema: loopApprovalSchema,
        origin: { sourceUri: "workflow://maximal-canary/loop-judge" },
        metadata: { fixtureRole: "non-claimable-loop-template" },
      },
      {
        ...workerBase,
        id: "context-alternate",
        title: "Alternate route",
        description: "Exercise schema and else routing.",
        acceptanceCriteria: "The alternate route emits success.",
        placement: {
          lane: "alternate",
          mode: "owned" as const,
          ownedPaths: ["docs"],
        },
        outputSchema: alternateSuccessSchema,
        origin: { sourceUri: "workflow://maximal-canary/alternate" },
        metadata: { fixtureRole: "guard-source" },
      },
      {
        ...verifierBase,
        id: "context-audit",
        title: "Audit alternate success",
        description: "Audit the successful alternate route.",
        acceptanceCriteria: "The successful route is audited.",
        placement: { lane: "audit", mode: "readOnly" as const },
        outputSchema: auditAttestationSchema,
        origin: { sourceUri: "workflow://maximal-canary/audit" },
        metadata: { fixtureRole: "schema-guard-target" },
      },
      {
        ...spawnerBase,
        id: "context-fallback",
        title: "Fallback route",
        description: "Handle the else branch.",
        acceptanceCriteria: "The else route is handled.",
        placement: { lane: "fallback", mode: "full" as const },
        origin: { sourceUri: "workflow://maximal-canary/fallback" },
        metadata: { fixtureRole: "else-guard-target" },
      },
      {
        ...workerBase,
        id: "context-integrate",
        title: "Integrate",
        description: "Attest whichever route completed and integrate it.",
        acceptanceCriteria: "All selected work is integrated.",
        placement: {
          lane: "integration",
          mode: "owned" as const,
          ownedPaths: ["src", "docs"],
        },
        origin: { sourceUri: "workflow://maximal-canary/integrate" },
        metadata: { fixtureRole: "stable-post-loop-accountability" },
      },
    ],
    tasks: [
      {
        id: "task-spawn",
        contextId: "context-spawner",
        order: 1,
        title: "Classify route",
        instructions: "Classify {{inputs.ticket}} and expand when needed.",
        metadata: { fixtureRole: "parameterized-user-task" },
        source: "user" as const,
      },
      {
        id: "task-loop-worker",
        contextId: "context-loop-worker",
        order: 1,
        title: "Refine",
        instructions: "Perform one refinement pass.",
        metadata: { fixtureRole: "loop-worker" },
        source: "agent" as const,
      },
      {
        id: "task-loop-judge",
        contextId: "context-loop-judge",
        order: 1,
        title: "Judge",
        instructions: "Judge the current pass.",
        metadata: { fixtureRole: "loop-judge" },
        source: "agent" as const,
      },
      {
        id: "task-alternate",
        contextId: "context-alternate",
        order: 1,
        title: "Run alternate",
        instructions: "Run the alternate route.",
        metadata: { fixtureRole: "guard-source" },
        source: "user" as const,
      },
      {
        id: "task-audit",
        contextId: "context-audit",
        order: 1,
        title: "Audit",
        instructions: "Audit the successful result.",
        metadata: { fixtureRole: "guard-target" },
        source: "agent" as const,
      },
      {
        id: "task-fallback",
        contextId: "context-fallback",
        order: 1,
        title: "Handle fallback",
        instructions: "Handle the unsuccessful alternate result.",
        metadata: { fixtureRole: "else-target" },
        source: "agent" as const,
      },
      {
        id: "task-integrate",
        contextId: "context-integrate",
        order: 1,
        title: "Integrate",
        instructions: "Integrate and attest the completed route.",
        metadata: { fixtureRole: "post-loop" },
        source: "user" as const,
      },
    ],
    edges: [
      {
        id: "edge-spawner-loop",
        sourceContextId: "context-spawner",
        targetContextId: "context-loop-worker",
        when: {
          schema: {
            type: "object",
            properties: { verdict: { const: "ship" } },
            required: ["verdict"],
          },
        },
      },
      {
        id: "edge-spawner-alternate",
        sourceContextId: "context-spawner",
        targetContextId: "context-alternate",
        when: {
          schema: {
            type: "object",
            properties: { verdict: { const: "hold" } },
            required: ["verdict"],
          },
        },
      },
      {
        id: "edge-spawner-integrate",
        sourceContextId: "context-spawner",
        targetContextId: "context-integrate",
      },
      {
        id: "edge-loop-worker-judge",
        sourceContextId: "context-loop-worker",
        targetContextId: "context-loop-judge",
      },
      {
        id: "edge-loop-judge-integrate",
        sourceContextId: "context-loop-judge",
        targetContextId: "context-integrate",
      },
      {
        id: "edge-alternate-audit",
        sourceContextId: "context-alternate",
        targetContextId: "context-audit",
        when: {
          schema: {
            type: "object",
            properties: { success: { const: true } },
            required: ["success"],
          },
        },
      },
      {
        id: "edge-alternate-fallback",
        sourceContextId: "context-alternate",
        targetContextId: "context-fallback",
        when: { else: true as const },
      },
      {
        id: "edge-audit-integrate",
        sourceContextId: "context-audit",
        targetContextId: "context-integrate",
      },
      {
        id: "edge-fallback-integrate",
        sourceContextId: "context-fallback",
        targetContextId: "context-integrate",
      },
    ],
    loopGroups: [
      {
        id: "refine",
        title: "Refine until approved",
        bodyContextIds: ["context-loop-worker", "context-loop-judge"],
        entryContextId: "context-loop-worker",
        exitContextId: "context-loop-judge",
        until: {
          schema: {
            type: "object",
            properties: { approved: { const: true } },
            required: ["approved"],
          },
        },
        maxPasses: 3,
      },
    ],
  };

  return workflowDefinitionMutationSchema.parse({
    name: "Maximal authored graph launch",
    description:
      "Exercises every admitted graph surface and edit-carried field.",
    definition,
    layout: {
      workflowId: "maximal-authored-graph-launch",
      contextPositions: {
        "context-spawner": { x: 0, y: 0 },
        "context-loop-worker": { x: 320, y: -180 },
        "context-loop-judge": { x: 640, y: -180 },
        "context-alternate": { x: 320, y: 180 },
        "context-audit": { x: 640, y: 100 },
        "context-fallback": { x: 640, y: 260 },
        "context-integrate": { x: 960, y: 0 },
      },
      viewport: { x: 24, y: 36, zoom: 0.85 },
    },
  });
}
