import type { Meta, StoryObj } from "@storybook/nextjs-vite";

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
      evaluated_state_json: JSON.stringify({
        commitHash: "af31c2d",
        relevantTreeHash: "tree-af31c2d",
        surfaceHash: null,
        mergeCandidateRef: null,
      }),
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
  validationStrategy: { kinds: ["screenshot"] },
  evidence: [],
  verdicts: [],
  waiver: null,
  isPending: false,
  error: null,
};

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
    },
  ],
  executions: [
    {
      id: "execution-12",
      spec_id: "spec-native-sdd",
      revision_id: "revision-4",
      scope_json: JSON.stringify({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-1"],
        exclusionDispositions: [],
      }),
      state: "running",
      workflow_definition_id: "workflow-definition-12",
      workflow_execution_id: "workflow-12",
      session_name: "native-sdd-run",
      delivered_at: null,
      abandoned_reason: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  criteria: [provenCriterion, unprovenCriterion],
  findings,
};

const meta = {
  title: "Specs/Studio/EvidenceLintTraceability",
  component: SpecEvidencePanel,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-bg-void p-xl text-text-primary max-768:p-md">
        <Story />
      </div>
    ),
  ],
  args: { criteria: [provenCriterion, unprovenCriterion] },
} satisfies Meta<typeof SpecEvidencePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NothingProvesItYet: Story = {
  args: { criteria: [unprovenCriterion] },
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
