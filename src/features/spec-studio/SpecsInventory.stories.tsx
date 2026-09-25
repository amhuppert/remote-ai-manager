import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import type { SpecPhasePrimary } from "@/lib/specs/phase";
import type { SpecSummaryView } from "@/lib/specs/queries";

import SpecsInventory from "./SpecsInventory";

const UPDATED_AT = "2026-07-18T12:00:00.000Z";

function fixture(
  phase: SpecPhasePrimary,
  index: number,
  overrides: {
    authoringFacet?: "draft";
    exploratory?: boolean;
    /** Criteria delivered outside this system, on an import's testimony. */
    deliveredExternally?: number;
    pendingApprovals?: number;
    proven?: number;
    scope?: number;
    workflows?: number;
  } = {},
): SpecSummaryView {
  const slug = `${phase.replace("_", "-")}-spec`;
  const pendingApprovals = overrides.pendingApprovals ?? 0;
  const deliveredExternally = overrides.deliveredExternally ?? 0;

  return {
    spec: {
      id: `spec-${index}`,
      projectPath: "/repos/command-center",
      slug,
      name: `${phase.replace("_", " ")} lifecycle contract`,
      gatePolicy: {
        preset: overrides.exploratory ? "exploratory" : "contract-bearing",
      },
      abandonedAt: phase === "abandoned" ? UPDATED_AT : null,
      abandonedReason:
        phase === "abandoned" ? "Superseded by the delivery spec" : null,
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: UPDATED_AT,
    },
    phase: {
      primary: phase,
      ...(overrides.authoringFacet === undefined
        ? {}
        : { authoringFacet: overrides.authoringFacet }),
    },
    currentRevision: null,
    counts: {
      requirements: 3 + index,
      criteria: 5 + index,
      decisions: 1 + (index % 2),
      tasks: 4 + index,
    },
    pendingApprovalCount: pendingApprovals,
    approvalState: pendingApprovals > 0 ? "pending" : "complete",
    delivery: {
      allWaived: false,
      deliveredCount: (overrides.proven ?? 0) + deliveredExternally,
      provenCount: overrides.proven ?? 0,
      deliveredExternallyCriterionIds: Array.from(
        { length: deliveredExternally },
        (_unused, position) => `criterion-${position + 1}`,
      ),
      totalInScope: overrides.scope ?? 5,
    },
    imported: deliveredExternally > 0,
    linkedWork: {
      tickets: index % 3,
      conversations: index % 2,
      sessions: 0,
      workflowExecutions: overrides.workflows ?? 0,
      mergeJobs: phase === "delivered" ? 1 : 0,
    },
  };
}

const allPhaseFixtures = [
  fixture("draft", 1, { pendingApprovals: 3 }),
  fixture("approved", 3),
  fixture("executing", 4, {
    authoringFacet: "draft",
    pendingApprovals: 1,
    proven: 7,
    scope: 12,
    workflows: 1,
  }),
  fixture("delivered", 5, { proven: 8, scope: 8 }),
  fixture("abandoned", 6),
];

const meta = {
  title: "Specs/Studio/Inventory",
  component: SpecsInventory,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-bg-void text-text-primary">
        <h1 className="sr-only">Spec inventory</h1>
        <Story />
      </main>
    ),
  ],
  args: {
    specs: allPhaseFixtures,
    projectName: "command-center",
  },
} satisfies Meta<typeof SpecsInventory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllPhases: Story = {};

export const PhaseFiltered: Story = {
  args: { initialPhase: "executing" },
};

export const Exploratory: Story = {
  args: {
    specs: [fixture("draft", 7, { exploratory: true })],
  },
};

export const ImportedDelivered: Story = {
  args: {
    specs: [fixture("delivered", 8, { deliveredExternally: 4, scope: 4 })],
  },
};

export const Empty: Story = {
  args: { specs: [] },
};
