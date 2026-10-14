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
    imported?: boolean;
    pendingApprovals?: number;
  } = {},
): SpecSummaryView {
  const slug = `${phase.replace("_", "-")}-spec`;
  const pendingApprovals = overrides.pendingApprovals ?? 0;

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
    imported: overrides.imported ?? false,
    linkedWork: {
      tickets: index % 3,
      conversations: index % 2,
      sessions: 0,
    },
  };
}

const allPhaseFixtures = [
  fixture("draft", 1, { pendingApprovals: 3 }),
  fixture("approved", 3),
  fixture("draft", 4, {
    authoringFacet: "draft",
    pendingApprovals: 1,
  }),
  fixture("approved", 5, {}),
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
  args: { initialPhase: "draft" },
};

export const Exploratory: Story = {
  args: {
    specs: [fixture("draft", 7, { exploratory: true })],
  },
};

export const Imported: Story = {
  args: {
    specs: [fixture("approved", 8, { imported: true })],
  },
};

export const Empty: Story = {
  args: { specs: [] },
};
