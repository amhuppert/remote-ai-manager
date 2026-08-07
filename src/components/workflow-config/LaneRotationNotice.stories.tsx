import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type {
  ValidatorAssignment,
  ValidatorCohort,
} from "@/lib/workflow-graph/config-schemas";
import { LaneRotationNotice } from "./LaneRotationNotice";

function assignment(
  id: string,
  overrides: Partial<ValidatorAssignment> = {},
): ValidatorAssignment {
  return {
    id,
    profile: { tier: "builtin", id: "general-reviewer" },
    strategy: "conversation",
    authority: "blocking",
    continuity: { enabled: true },
    agent: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
    ...overrides,
  };
}

const BASE: ValidatorCohort = {
  enabled: true,
  assignments: [assignment("general"), assignment("security")],
};

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: 460, padding: 16, background: "var(--bg-surface)" }}>
      {children}
    </div>
  );
}

const meta = {
  title: "WorkflowConfig/LaneRotationNotice",
  component: LaneRotationNotice,
  args: { base: BASE, draft: BASE },
  render: (args) => (
    <Panel>
      <LaneRotationNotice {...args} />
    </Panel>
  ),
} satisfies Meta<typeof LaneRotationNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One seat's authority flipped: its lane cannot resume, so it is retired. */
export const OneSeatRotated: Story = {
  args: {
    base: BASE,
    draft: {
      ...BASE,
      assignments: [
        assignment("general"),
        assignment("security", { authority: "advisory" }),
      ],
    },
  },
};

/** Authority on one seat, instructions on another — both lanes rotate. */
export const SeveralSeatsRotated: Story = {
  args: {
    base: BASE,
    draft: {
      ...BASE,
      assignments: [
        assignment("general", { focus: "hot paths only" }),
        assignment("security", { authority: "advisory" }),
      ],
    },
  },
};

/** Nothing that identifies a lane moved — the notice renders nothing at all. */
export const NoRotation: Story = {
  args: { base: BASE, draft: BASE },
};
