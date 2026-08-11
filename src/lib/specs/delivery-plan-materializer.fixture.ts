import {
  deliveryPlanDocumentSchema,
  type DeliveryPlanDocument,
} from "./delivery-plan";
import {
  deliveryPlanMaterializationCriteria,
  type DeliveryPlanMaterializationCriterion,
  type DeliveryPlanMaterializationInput,
} from "./delivery-plan-materializer";
import {
  specRevisionSnapshotSchema,
  type SpecRevisionSnapshot,
} from "./schemas";

/**
 * The authored plan the materializer tests read. It is deliberately a plan a
 * planner would recognize — two delivery contexts, one typed integration
 * context with no owned criteria, an explicit edge between them — because the
 * properties under test (copy, not synthesis) are only observable against a
 * document whose contract could plausibly have been inferred instead.
 */

export const SPEC = {
  id: "spec-materializer",
  slug: "exact-materialization",
  name: "Exact materialization",
} as const;

export const ATTEMPT_ID = "attempt-materializer";
export const PINNED_REVISION_ID = "revision-materializer-2";

export function planCriteria(): DeliveryPlanMaterializationCriterion[] {
  return deliveryPlanMaterializationCriteria(pinnedRevisionSnapshot());
}

const TS = "2026-08-07T00:00:00.000Z";

/**
 * The approved revision the plan pins, as the two requirements and three
 * criteria the fixture plan disposes. Stated as a snapshot rather than as
 * ready-made criteria because the handles a pack quotes are derived from the
 * revision's element numbering, and a fixture that hand-writes them cannot
 * catch a derivation that stops matching the rest of the spec surfaces.
 */
export function pinnedRevisionSnapshot(): SpecRevisionSnapshot {
  const rows: {
    id: string;
    kind: "requirement" | "criterion";
    number: number;
    parentElementId: string | null;
    payload: SpecRevisionSnapshot["elements"][number]["version"]["payload"];
  }[] = [
    {
      id: "requirement-exactness",
      kind: "requirement",
      number: 1,
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "The authored plan is materialized exactly.",
        priority: "must",
        risk: "high",
      },
    },
    {
      id: "criterion-copy",
      kind: "criterion",
      number: 1,
      parentElementId: "requirement-exactness",
      payload: {
        kind: "criterion",
        text: "The materializer copies the authored acceptance contract verbatim.",
        validationStrategy: {
          kinds: ["validator_verdict"],
          note: "A byte-equality test over the rendered contract.",
        },
      },
    },
    {
      id: "criterion-determinism",
      kind: "criterion",
      number: 2,
      parentElementId: "requirement-exactness",
      payload: {
        kind: "criterion",
        text: "Materializing the same snapshot twice is byte-identical.",
        validationStrategy: { kinds: ["test_run"] },
      },
    },
    {
      id: "requirement-preflight",
      kind: "requirement",
      number: 2,
      parentElementId: null,
      payload: {
        kind: "requirement",
        statement: "Nothing is persisted that cannot be run.",
        priority: "must",
        risk: "medium",
      },
    },
    {
      id: "criterion-preflight",
      kind: "criterion",
      number: 1,
      parentElementId: "requirement-preflight",
      payload: {
        kind: "criterion",
        text: "An unknown registered validation command refuses before persistence.",
        validationStrategy: {
          kinds: ["test_run", "validator_verdict"],
          note: "One failing case per refusal class.",
        },
      },
    },
  ];
  return specRevisionSnapshotSchema.parse({
    revision: {
      id: PINNED_REVISION_ID,
      specId: SPEC.id,
      number: 2,
      state: "approved",
      authoringStage: "plan",
      basedOnRevisionId: null,
      contentHash: "content-revision-materializer-2",
      proposedAt: TS,
      approvedAt: TS,
      externalDelivery: null,
      createdAt: TS,
    },
    elements: rows.map((row, index) => ({
      element: {
        id: row.id,
        specId: SPEC.id,
        kind: row.kind,
        number: row.number,
        parentElementId: row.parentElementId,
        createdAt: TS,
      },
      version: {
        revisionId: PINNED_REVISION_ID,
        elementId: row.id,
        position: index,
        payload: row.payload,
        payloadHash: `${row.id}-h1`,
        elementVersion: 1,
        createdAt: TS,
        updatedAt: TS,
      },
    })),
  });
}

export function planDocument(): DeliveryPlanDocument {
  return deliveryPlanDocumentSchema.parse({
    dispositions: [
      {
        criterionElementId: "criterion-copy",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
      {
        criterionElementId: "criterion-determinism",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
      {
        criterionElementId: "criterion-preflight",
        disposition: "selected",
        deliveredByExecutionId: null,
        reaffirmation: null,
        note: null,
      },
    ],
    contexts: [
      {
        contextId: "ctx-copy",
        title: "Copy the authored contract",
        contextType: "delivery",
        criterionElementIds: ["criterion-copy", "criterion-determinism"],
        acceptanceContract: [
          "The rendered acceptanceCriteria bytes equal the authored contract.",
          "No criterion text, proof plan, or wiring entry is appended to it.",
        ],
        proofPlan: [
          {
            criterionElementId: "criterion-copy",
            evidenceKinds: ["validator_verdict"],
            note: "Byte equality against the authored contract.",
          },
          {
            criterionElementId: "criterion-determinism",
            evidenceKinds: ["test_run"],
            note: "Two materializations compared byte for byte.",
          },
        ],
      },
      {
        contextId: "ctx-preflight",
        title: "Refuse before persistence",
        contextType: "delivery",
        criterionElementIds: ["criterion-preflight"],
        acceptanceContract: [
          "An unknown registered command name refuses with its remedy named.",
        ],
        proofPlan: [
          {
            criterionElementId: "criterion-preflight",
            evidenceKinds: ["test_run", "validator_verdict"],
            note: "One failing case per refusal class.",
          },
        ],
      },
      {
        contextId: "ctx-closeout",
        title: "Close the materializer out",
        contextType: "integration",
        criterionElementIds: [],
        acceptanceContract: [
          "The two delivery contexts compose through the production propose path.",
        ],
        proofPlan: [],
      },
    ],
    tasks: [
      {
        taskId: "task-render",
        contextId: "ctx-copy",
        title: "Render the authored contract",
        instructions: "Copy the acceptance contract into acceptanceCriteria.",
        order: 0,
        contributesToCriterionElementIds: ["criterion-copy"],
      },
      {
        taskId: "task-determinism",
        contextId: "ctx-copy",
        title: "Make it deterministic",
        instructions: "Stable ids and ordering; two runs are byte-identical.",
        order: 1,
        contributesToCriterionElementIds: ["criterion-determinism"],
      },
      {
        taskId: "task-preflight",
        contextId: "ctx-preflight",
        title: "Preflight command names",
        instructions: "Refuse unknown registered validation command names.",
        order: 0,
        contributesToCriterionElementIds: ["criterion-preflight"],
      },
      {
        taskId: "task-closeout",
        contextId: "ctx-closeout",
        title: "Wire the propose path",
        instructions: "Compose lint, materialization, and one commit boundary.",
        order: 0,
        contributesToCriterionElementIds: [],
      },
    ],
    edges: [
      {
        edgeId: "edge-copy-to-closeout",
        fromContextId: "ctx-copy",
        toContextId: "ctx-closeout",
      },
      {
        edgeId: "edge-preflight-to-closeout",
        fromContextId: "ctx-preflight",
        toContextId: "ctx-closeout",
      },
    ],
    wiring: [
      {
        capabilityId: "delivery-plan-materializer",
        criterionElementIds: ["criterion-copy"],
        owner: {
          kind: "call_site",
          contextId: "ctx-preflight",
          locator: "src/lib/specs/delivery-plan-service.ts propose()",
        },
      },
      {
        capabilityId: "delivery-plan-preview",
        criterionElementIds: ["criterion-determinism"],
        owner: { kind: "downstream", contextId: "ctx-closeout" },
      },
    ],
    policyOverrides: [
      {
        key: "mutability.allowAgentTaskAdd",
        value: "true",
        rationale: "The materializer discovers guarantee work as it lands.",
      },
    ],
    touchedSurfaces: ["src/lib/specs/", "src/lib/state-store/"],
    governance: {
      mission:
        "Make the authored delivery plan the executed graph, materialized exactly.",
      charterInvariants: [
        {
          id: "exact-approval",
          statement:
            "The stored approved compiled candidate is immutable and launch uses it unchanged.",
        },
        {
          id: "durability-contracts",
          statement:
            "Every new persisted field lands with repository mapping and round-trip coverage.",
        },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "final-design",
          label: "Final agreed design",
          type: "document",
          locator: "command-center#47 attachment f7b542c4",
          description:
            "Section 5 owns compilation as persisted materialization.",
          appliesTo: "every context",
          accessPolicy: "external-readonly",
        },
        {
          rank: 2,
          id: "current-code",
          label: "Current codebase",
          type: "code",
          locator: "src/lib/specs/**",
          description:
            "Mechanics follow HEAD where the design cites file:line.",
          appliesTo: null,
          accessPolicy: "worktree-relative",
        },
      ],
      validationCommandNames: ["typecheck", "test"],
    },
  });
}

export const REGISTERED_COMMANDS = [
  "format",
  "lint",
  "typecheck",
  "test",
  "test-full-suite",
] as const;

export function materializationInput(
  overrides: Partial<DeliveryPlanMaterializationInput> = {},
): DeliveryPlanMaterializationInput {
  return {
    spec: SPEC,
    attemptId: ATTEMPT_ID,
    pinnedRevisionId: PINNED_REVISION_ID,
    draftRevision: 4,
    document: planDocument(),
    criteria: planCriteria(),
    registeredValidationCommandNames: [...REGISTERED_COMMANDS],
    defaults: {
      approvalRequired: true,
      workflowConfig: {
        mutability: {
          allowAgentTaskAdd: false,
          allowAgentContextAdd: false,
        },
        agentValidation: {
          implementer: { mode: "all", except: [] },
          contextValidator: { mode: "only", commands: [] },
        },
      },
    },
    ...overrides,
  };
}
