import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ActiveWorkSection from "./ActiveWorkSection";
import type { ActiveWorkItem, AttentionItem } from "./active-work";

const NOW = Date.parse("2026-07-11T12:00:00Z");

const minutesAgo = (minutes: number): string =>
  new Date(NOW - minutes * 60_000).toISOString();

let sequence = 0;
function makeItem(overrides: Partial<ActiveWorkItem>): ActiveWorkItem {
  sequence += 1;
  return {
    id: `item-${sequence}`,
    kind: "job",
    title: "Merge auth-fix",
    projectName: "command-center",
    sessionName: "session-12",
    phase: "Validating…",
    href: "#",
    startedAt: minutesAgo(2),
    ...overrides,
  };
}

const runningMerge = makeItem({
  title: "Merge sidebar-refactor",
  phase: "Validating…",
  startedAt: minutesAgo(2),
});
const runningWorkflow = makeItem({
  kind: "workflow",
  title: "Implement service + validation",
  phase: "2 contexts active",
  progress: { completed: 4, total: 7 },
  startedAt: minutesAgo(38),
});
const runningCollab = makeItem({
  kind: "collab",
  title: "Collaboration",
  phase: "Initial draft (round 0)",
  startedAt: minutesAgo(6),
});
const readyToLand = makeItem({
  title: "Merge activity-panel",
  phase: "Ready to land",
  needsAction: {
    primary: { label: "Land", kind: "land" },
    secondary: { label: "Discard", kind: "discard" },
  },
  startedAt: minutesAgo(11),
});
const conflicts = makeItem({
  title: "Merge api-service",
  phase: "3 conflicts",
  needsAction: { primary: { label: "Resolve", kind: "resolve" } },
  startedAt: minutesAgo(25),
});

function makeAttention(overrides: Partial<AttentionItem>): AttentionItem {
  sequence += 1;
  return {
    id: `attention-${sequence}`,
    title: "Merge failed",
    detail: "pre-merge validation exited with code 1: typecheck failed",
    projectName: "command-center",
    sessionName: "session-09",
    occurredAt: minutesAgo(90),
    href: "#",
    ...overrides,
  };
}

const meta = {
  title: "Session/ActiveWorkSection",
  component: ActiveWorkSection,
  parameters: {
    a11y: { test: "error" },
  },
  args: {
    nowMs: NOW,
    onAction: fn(),
    onDismissAttention: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 308,
          background: "var(--bg-base)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
          paddingBottom: 8,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ActiveWorkSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleRunningMerge: Story = {
  args: { items: [runningMerge] },
};

export const MixedSources: Story = {
  args: { items: [runningMerge, runningWorkflow, runningCollab] },
};

export const NeedsAction: Story = {
  args: { items: [readyToLand, conflicts, runningMerge] },
};

export const OverflowFour: Story = {
  args: {
    items: [readyToLand, runningMerge, runningWorkflow, runningCollab],
  },
};

export const OverflowEightExpanded: Story = {
  args: {
    defaultExpanded: true,
    items: [
      readyToLand,
      conflicts,
      runningMerge,
      runningWorkflow,
      runningCollab,
      makeItem({
        title: "Commit panes-fixes",
        phase: "Committing…",
        startedAt: minutesAgo(1),
      }),
      makeItem({
        title: "Resolve conflicts feature-x",
        phase: "Resolving…",
        startedAt: minutesAgo(4),
      }),
      makeItem({
        kind: "workflow",
        title: "Ticket system spec",
        phase: "1 context active",
        progress: { completed: 1, total: 4 },
        startedAt: minutesAgo(120),
      }),
    ],
  },
};

export const WithAttention: Story = {
  args: {
    items: [runningMerge],
    attention: [
      makeAttention({}),
      makeAttention({
        title: "Workflow halted",
        detail:
          "circuit breaker tripped after 3 failed iterations in context impl-service",
        sessionName: "session-31",
      }),
    ],
  },
};

export const AttentionOnly: Story = {
  args: {
    items: [],
    attention: [makeAttention({})],
  },
};

export const LongLabels: Story = {
  args: {
    items: [
      makeItem({
        title:
          "Merge a-very-long-branch-name-that-should-truncate-with-an-ellipsis",
        phase:
          "Resolving conflicts in src/features/session/sidebar/ConversationSidebar.tsx and 12 other files",
        needsAction: { primary: { label: "Resolve", kind: "resolve" } },
        projectName: "a-rather-long-project-name",
        sessionName: "an-even-longer-session-name-7b0694",
      }),
      makeItem({
        kind: "workflow",
        title:
          "Implement cross-context validation + adversarial review + final publish",
        phase: "3 contexts active",
        progress: { completed: 11, total: 26 },
        startedAt: minutesAgo(300),
      }),
    ],
  },
};

export const EmptyHidden: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "With no active work and no attention items the section renders nothing — it auto-hides rather than showing an empty state.",
      },
    },
  },
  args: { items: [] },
};

// Placement context: how the section sits inside the sidebar, above the
// conversation groups it shares the rail with.
export const InSidebarContext: Story = {
  args: { items: [readyToLand, runningMerge, runningWorkflow] },
  render: (args) => (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="mb-header-content flex min-h-[28px] items-center border-x-0 border-t-0 border-b border-solid border-border-subtle px-[10px] pt-[10px] pb-[8px]">
        <span className="font-mono text-[0.72rem] leading-[1.2] font-semibold tracking-[0.1em] text-text-secondary uppercase">
          Active Conversations{" "}
          <span className="font-medium text-text-tertiary">(6)</span>
        </span>
      </div>
      <ActiveWorkSection {...args} />
      <div className="flex min-w-0 items-center gap-sm px-[12px] pt-[12px] pb-[4px] font-mono text-[0.7rem] leading-[1.2] font-semibold tracking-[0.12em] text-amber uppercase after:order-2 after:h-[1px] after:min-w-[16px] after:flex-1 after:[background-image:linear-gradient(to_right,var(--border-default),transparent)] after:content-['']">
        <span>Needs you</span>
        <span className="order-1 font-medium text-text-tertiary">(1)</span>
      </div>
      <div className="px-[12px] py-[8px] font-mono text-[0.72rem] text-text-secondary">
        …conversation rows…
      </div>
    </div>
  ),
};
