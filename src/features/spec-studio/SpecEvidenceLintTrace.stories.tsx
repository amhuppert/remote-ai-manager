import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import {
  evidenceEvaluatedStateSchema,
  type SpecCriterionDispositionRow,
} from "@/lib/specs/schemas";

import { executionViewFixture } from "./SpecControls.fixtures";

import {
  SpecEvidencePanel,
  SpecLintPanel,
  TraceabilityGraph,
  type CriterionProofView,
  type TraceabilityInput,
} from "./SpecEvidenceLintTrace";

const NOW = "2026-07-18T12:00:00.000Z";

const provenCriterion: CriterionProofView = {
  elementId: "criterion-1",
  handle: "R1.1",
  text: "A copied reference resolves after the spec slug changes.",
  validationStrategy: {
    kinds: ["test_run"],
    note: "Run the alias resolution contract test.",
  },
  evidence: [
    {
      id: "evidence-alias-test",
      spec_id: "spec-native-sdd",
      criterion_element_id: "criterion-1",
      revision_id: "revision-4",
      kind: "test_run",
      ref_json: JSON.stringify({
        type: "workflow_event",
        workflowExecutionId: "workflow-12",
        eventId: 42,
        contextId: "validation",
      }),
      evaluated_state_json: JSON.stringify(
        evidenceEvaluatedStateSchema.parse({
          commitSha: "af31c2d",
          relevantPaths: ["src/lib/alias.ts"],
          relevantTreeHash: "tree-af31c2d",
        }),
      ),
      producer_json: JSON.stringify({ kind: "agent" }),
      execution_id: "execution-12",
      source_event_id: 42,
      created_at: NOW,
    },
  ],
  verdicts: [
    {
      id: "verdict-alias-test",
      spec_id: "spec-native-sdd",
      criterion_element_id: "criterion-1",
      revision_id: "revision-4",
      execution_id: "execution-12",
      verdict_kind: "deterministic_validator",
      evidence_ids_json: JSON.stringify(["evidence-alias-test"]),
      verdict_at: NOW,
      stale_at: null,
      stale_reason: null,
    },
  ],
  waiver: null,
  isPending: false,
  error: null,
};

const unprovenCriterion: CriterionProofView = {
  elementId: "criterion-2",
  handle: "R1.2",
  text: "The changed indicator is visible in the transcript.",
  validationStrategy: { kinds: ["validator_verdict"] },
  evidence: [],
  verdicts: [],
  waiver: null,
  isPending: false,
  error: null,
};

const pendingCriterion: CriterionProofView = {
  ...unprovenCriterion,
  elementId: "criterion-3",
  handle: "R2.1",
  text: "The evidence query remains legible while it is pending.",
  validationStrategy: { kinds: ["test_run"] },
  isPending: true,
};

const staleCriterion: CriterionProofView = {
  ...unprovenCriterion,
  elementId: "criterion-4",
  handle: "R2.2",
  text: "A verdict against an earlier revision remains auditable as stale.",
  verdicts: [
    {
      id: "verdict-stale",
      spec_id: "spec-native-sdd",
      criterion_element_id: "criterion-4",
      revision_id: "revision-4",
      execution_id: "execution-12",
      verdict_kind: "deterministic_validator",
      evidence_ids_json: JSON.stringify([]),
      verdict_at: NOW,
      stale_at: NOW,
      stale_reason: "The approved requirement changed.",
    },
  ],
};

const waivedCriterion: CriterionProofView = {
  ...unprovenCriterion,
  elementId: "criterion-5",
  handle: "R2.3",
  text: "The unavailable hardware capture has an explicit waiver.",
  validationStrategy: { kinds: ["validator_verdict"] },
  waiver: {
    id: "waiver-hardware",
    spec_id: "spec-native-sdd",
    criterion_element_id: "criterion-5",
    revision_id: "revision-4",
    reason: "The hardware fixture is unavailable in this execution.",
    waived_at: NOW,
    stale: 0,
  },
};

const deferredCriterion: CriterionProofView = {
  ...unprovenCriterion,
  elementId: "criterion-6",
  handle: "R3.1",
  text: "The CLI export path is explicitly deferred from this execution.",
};

const deliveredElsewhereCriterion: CriterionProofView = {
  ...unprovenCriterion,
  elementId: "criterion-7",
  handle: "R3.2",
  text: "The reference resolver was delivered by a prior execution.",
  validationStrategy: { kinds: ["validator_verdict"] },
};

const criterionDispositions: SpecCriterionDispositionRow[] = [
  {
    execution_id: "execution-12",
    criterion_element_id: "criterion-5",
    disposition: "waived",
    waiver_id: "waiver-hardware",
    delivered_by_execution_id: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    execution_id: "execution-12",
    criterion_element_id: "criterion-6",
    disposition: "deferred",
    waiver_id: null,
    delivered_by_execution_id: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    execution_id: "execution-12",
    criterion_element_id: "criterion-7",
    disposition: "delivered_elsewhere",
    waiver_id: null,
    delivered_by_execution_id: "execution-8",
    created_at: NOW,
    updated_at: NOW,
  },
];

const evidenceStates = [
  provenCriterion,
  unprovenCriterion,
  pendingCriterion,
  staleCriterion,
  waivedCriterion,
  deferredCriterion,
  deliveredElsewhereCriterion,
];

const findings = [
  {
    ruleId: "9.3.uncovered-criterion",
    severity: "blocks_propose" as const,
    elementHandle: "R1.2",
    message: "R1.2 has no covering task.",
  },
  {
    ruleId: "9.9.open-question",
    severity: "advisory" as const,
    elementHandle: "R1",
    message: "R1 cites an open question.",
  },
];

const traceability: TraceabilityInput = {
  projectName: "command-center",
  slug: "native-sdd",
  requirements: [
    {
      elementId: "requirement-1",
      handle: "R1",
      label: "References remain stable",
      criterionElementIds: ["criterion-1", "criterion-2"],
      approval: "stale",
    },
    {
      elementId: "requirement-2",
      handle: "R2",
      label: "Proof remains revision-aware",
      criterionElementIds: ["criterion-3", "criterion-4", "criterion-5"],
      approval: "valid",
    },
    {
      elementId: "requirement-3",
      handle: "R3",
      label: "Execution scope stays auditable",
      criterionElementIds: ["criterion-6", "criterion-7"],
      approval: "unapproved",
    },
  ],
  decisions: [
    {
      elementId: "decision-1",
      handle: "D1",
      label: "Alias-aware lookup",
      tracedRequirementElementIds: ["requirement-1"],
    },
  ],
  tasks: [
    {
      elementId: "task-1",
      handle: "T1",
      label: "Implement reference resolution",
      tracedRequirementElementIds: ["requirement-1"],
      tracedDecisionElementIds: ["decision-1"],
      coveredCriterionElementIds: ["criterion-1"],
      isNewInRevision: true,
      revisionNumber: 4,
    },
    {
      elementId: "task-2",
      handle: "T2",
      label: "Render revision-aware evidence state",
      tracedRequirementElementIds: ["requirement-1", "requirement-2"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-2", "criterion-3"],
      isNewInRevision: false,
      revisionNumber: 4,
    },
    {
      elementId: "task-3",
      handle: "T3",
      label: "Distinguish stale proof and waivers",
      tracedRequirementElementIds: ["requirement-2"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-4", "criterion-5"],
      isNewInRevision: true,
      revisionNumber: 4,
    },
    {
      elementId: "task-4",
      handle: "T4",
      label: "Persist auditable execution scope",
      tracedRequirementElementIds: ["requirement-3"],
      tracedDecisionElementIds: [],
      coveredCriterionElementIds: ["criterion-6", "criterion-7"],
      isNewInRevision: false,
      revisionNumber: 4,
    },
  ],
  executions: [
    executionViewFixture({
      id: "execution-12",
      specId: "spec-native-sdd",
      revisionId: "revision-4",
      revisionNumber: 4,
      scope: {
        selectedTaskIds: ["task-1", "task-2", "task-3", "task-4"],
        selectedCriterionIds: evidenceStates.map(
          (criterion) => criterion.elementId,
        ),
        exclusionDispositions: [],
      },
      state: "running",
      workflowExecutionId: "workflow-12",
      sessionName: "native-sdd-run",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ],
  criteria: evidenceStates,
  findings,
};

const meta = {
  title: "Specs/Studio/EvidenceLintTraceability",
  component: SpecEvidencePanel,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="h-screen overflow-y-auto bg-bg-void p-xl text-text-primary max-768:p-md">
        <h1 className="sr-only">Spec evidence and traceability</h1>
        <Story />
      </main>
    ),
  ],
  args: {
    criteria: evidenceStates,
    dispositions: criterionDispositions,
    revisionLabel: "Pinned revision 4",
  },
} satisfies Meta<typeof SpecEvidencePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ProofComplete: Story = {
  args: { criteria: [provenCriterion], dispositions: [] },
};

export const NothingProvesItYet: Story = {
  args: { criteria: [unprovenCriterion], dispositions: [] },
};

export const EmptyRevision: Story = {
  args: {
    criteria: [],
    dispositions: [],
    revisionLabel: null,
  },
};

export const MobileUnproven: Story = {
  args: {
    criteria: evidenceStates,
    dispositions: criterionDispositions,
    initialFilter: "unproven",
  },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const LintFindings: Story = {
  render: () => (
    <SpecLintPanel
      projectName="command-center"
      slug="native-sdd"
      revisionId="revision-4"
      findings={findings}
      isPending={false}
      error={null}
    />
  ),
};

export const Traceability: Story = {
  render: () => <TraceabilityGraph input={traceability} />,
};

export const TraceabilityMobile: Story = {
  render: () => <TraceabilityGraph input={traceability} />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
