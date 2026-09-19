import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import type { LaneBand } from "@/lib/workflow-graph/lane-bands";
import type { ExecutionContextNodeData } from "./derive-graph";
import WorkflowMobileGraph, {
  type WorkflowMobileGraphNode,
} from "./WorkflowMobileGraph";

/**
 * The M1/M2 Graph panel at a phone viewport: lanes stack, members scroll
 * horizontally inside their band, and the fit/zoom cluster floats clear of the
 * bottom toolbar. A lane still states membership and a summary OF its members —
 * never a grade of its own (README §4).
 */
function node(
  id: string,
  title: string,
  placement: Placement,
  overrides: Partial<ExecutionContextNodeData> = {},
): WorkflowMobileGraphNode {
  return {
    id,
    data: {
      context: {
        id,
        title,
        acceptanceCriteria: "A verdict is recorded.",
        placement,
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "medium" },
            },
          },
        },
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 3 },
      },
      tasks: [],
      mode: "builder",
      laneState: "pending",
      configOverrides: [],
      ...overrides,
    },
  };
}

function band(overrides: Partial<LaneBand> = {}): LaneBand {
  return {
    laneName: "delivery",
    state: "pending",
    reserved: false,
    memberContextIds: [],
    memberCount: 0,
    membershipLabel: "0 members",
    gradeSummary: "",
    runtime: null,
    ...overrides,
  };
}

const BUILDER_BANDS: LaneBand[] = [
  band({
    laneName: "delivery",
    memberContextIds: ["ctx_checkout", "ctx_settings"],
    memberCount: 2,
    membershipLabel: "2 members",
    gradeSummary: "2 owning",
  }),
  band({
    laneName: "plan",
    memberContextIds: ["ctx_plan"],
    memberCount: 1,
    membershipLabel: "1 member",
    gradeSummary: "1 full",
  }),
  band({
    laneName: "session",
    reserved: true,
    memberContextIds: ["ctx_notes"],
    memberCount: 1,
    membershipLabel: "1 member",
    gradeSummary: "read-only only",
  }),
];

type Placement = ExecutionContextNodeData["context"]["placement"];

const DELIVERY_CHECKOUT: Placement = {
  lane: "delivery",
  mode: "owned",
  ownedPaths: ["src/checkout", "src/risk"],
};
const DELIVERY_SETTINGS: Placement = {
  lane: "delivery",
  mode: "owned",
  ownedPaths: ["src/settings"],
};
const PLAN_FULL: Placement = { lane: "plan", mode: "full" };

const BUILDER_NODES = [
  node("ctx_checkout", "Implement checkout", DELIVERY_CHECKOUT),
  node("ctx_settings", "Settings surface", DELIVERY_SETTINGS),
  node("ctx_plan", "Plan the migration", PLAN_FULL),
  node("ctx_notes", "Release notes", { lane: "session", mode: "readOnly" }),
];

const meta = {
  title: "WorkflowGraph/WorkflowMobileGraph",
  component: WorkflowMobileGraph,
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    backgrounds: { default: "dark" },
    layout: "fullscreen",
  },
  args: { onSelectContext: fn() },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          height: 640,
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowMobileGraph>;

export default meta;
type Story = StoryObj<typeof meta>;

/** M1 — the builder's Graph panel, nothing selected. */
export const BuilderGraph: Story = {
  args: {
    mode: "builder",
    bands: BUILDER_BANDS,
    nodes: BUILDER_NODES,
    selectedContextId: null,
  },
};

/**
 * M1 with the touch re-placement route on every card: the long-press has no
 * keyboard form, so the control is the accessible equivalent.
 */
export const BuilderWithReplacementControls: Story = {
  args: {
    ...BuilderGraph.args,
    renderMemberActions: (contextId: string) => (
      <button
        type="button"
        aria-label={`Move ${contextId} to a lane`}
        className="inline-flex min-h-[44px] w-full cursor-pointer items-center justify-center rounded-md border border-solid border-border-subtle bg-bg-surface font-mono text-[0.7rem] font-medium text-text-secondary"
      >
        Move to lane…
      </button>
    ),
  },
};

/** M1 — an empty lane the author drew but nothing has landed in yet (§2.2). */
export const BuilderWithEmptyLane: Story = {
  args: { ...BuilderGraph.args, emptyLaneNames: ["candidate-rules"] },
};

/** M2 — the execution's Graph panel: lanes carry a runtime dot and a state. */
export const ExecutionGraph: Story = {
  args: {
    mode: "execution",
    selectedContextId: "ctx_checkout",
    bands: [
      band({
        laneName: "delivery",
        state: "active",
        memberContextIds: ["ctx_checkout", "ctx_settings"],
        memberCount: 2,
        membershipLabel: "2 members",
        gradeSummary: "2 owning",
      }),
      band({
        laneName: "plan",
        state: "merged",
        memberContextIds: ["ctx_plan"],
        memberCount: 1,
        membershipLabel: "1 member",
        gradeSummary: "1 full",
      }),
    ],
    nodes: [
      node("ctx_checkout", "Implement checkout", DELIVERY_CHECKOUT, {
        mode: "execution",
        laneState: "active",
      }),
      node("ctx_settings", "Settings surface", DELIVERY_SETTINGS, {
        mode: "execution",
        laneState: "active",
      }),
      node("ctx_plan", "Plan the migration", PLAN_FULL, {
        mode: "execution",
        laneState: "merged",
      }),
    ],
  },
};
