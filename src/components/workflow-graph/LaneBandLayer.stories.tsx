import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import type { Node, NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/base.css";

import type { EphemeralLane } from "@/lib/workflow-graph/ephemeral-lanes";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
} from "@/lib/workflow-graph/layout";

import {
  LANE_BAND_CONTENT_OFFSET_X,
  LANE_BAND_PADDING_Y,
} from "@/lib/workflow-graph/lane-band-geometry";
import type { LaneBand } from "@/lib/workflow-graph/lane-bands";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";

import CanvasControls from "./CanvasControls";
import type { ExecutionContextNodeData } from "./derive-graph";
import type { ContextWaitState } from "./derive-wait-state";
import ExecutionContextNode from "./ExecutionContextNode";
import LaneBandLayer, { type LaneBandMode } from "./LaneBandLayer";
import LaneDropOverlay from "./LaneDropOverlay";
import "./workflow-graph.css";

const nodeTypes = {
  executionContext: ExecutionContextNode,
} as unknown as NodeTypes;

/** The canonical bundle fixture (README §3.2), laid out as B1/E1 show it. */
interface MemberSpec {
  id: string;
  title: string;
  lane: string;
  laneState: ExecutionContextNodeData["laneState"];
  column: number;
  ownedPaths?: string[];
  /** The reserved lane admits read-only members only. */
  readOnly?: boolean;
  /** How the member reads once the run is live. */
  waitState?: ContextWaitState;
  taskCount: number;
}

const ROW_HEIGHT = 240;

function placementFor(spec: MemberSpec): ContextPlacement {
  if (spec.readOnly) return { lane: spec.lane, mode: "readOnly" };
  if (spec.ownedPaths)
    return { lane: spec.lane, mode: "owned", ownedPaths: spec.ownedPaths };
  return { lane: spec.lane, mode: "full" };
}

function makeNode(
  spec: MemberSpec,
  bandIndex: number,
): Node<ExecutionContextNodeData> {
  const placement = placementFor(spec);

  return {
    id: spec.id,
    type: "executionContext",
    position: {
      x: LANE_BAND_CONTENT_OFFSET_X + spec.column * 294,
      y: LANE_BAND_PADDING_Y + bandIndex * ROW_HEIGHT,
    },
    data: {
      context: {
        id: spec.id,
        title: spec.title,
        acceptanceCriteria: "TBD",
        placement,
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        },
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 3, continuity: { enabled: true } },
      },
      tasks: Array.from({ length: spec.taskCount }, (_, index) => ({
        id: `${spec.id}-t${index + 1}`,
        contextId: spec.id,
        order: index + 1,
        title: `Task ${index + 1}`,
        instructions: "",
        source: "user" as const,
      })),
      mode: "builder",
      laneState: spec.laneState,
      configOverrides: [],
    },
  };
}

const MEMBERS: MemberSpec[] = [
  {
    id: "ctx_plan",
    taskCount: 3,
    title: "Plan the migration",
    lane: "plan",
    laneState: "merged",
    column: 0,
    waitState: { kind: "completed" },
  },
  {
    id: "ctx_rules",
    taskCount: 2,
    title: "Evaluate rules engine",
    lane: "candidate-rules",
    laneState: "merged",
    column: 0,
    ownedPaths: ["docs/eval"],
    waitState: { kind: "completed" },
  },
  {
    id: "ctx_checkout",
    taskCount: 5,
    title: "Implement checkout",
    lane: "delivery",
    laneState: "active",
    column: 0,
    ownedPaths: ["src/checkout", "src/risk"],
    waitState: { kind: "running" },
  },
  {
    id: "ctx_settings",
    taskCount: 3,
    title: "Settings surface",
    lane: "delivery",
    laneState: "active",
    column: 1,
    ownedPaths: ["src/settings"],
    waitState: { kind: "running" },
  },
  {
    id: "ctx_rollout",
    taskCount: 2,
    title: "Rollout switch",
    lane: "delivery",
    laneState: "active",
    column: 2,
    // A full-grade member waits for the lane to itself — the node's amber
    // notice is derived from that, not authored on the story.
    waitState: { kind: "waiting-for-lane", laneId: "delivery" },
  },
  {
    id: "ctx_notes",
    taskCount: 2,
    title: "Release notes",
    lane: "session",
    laneState: "session",
    column: 0,
    readOnly: true,
    waitState: {
      kind: "dependency-blocked",
      unmetDependencyIds: ["ctx_rollout"],
      blockedByApproval: false,
    },
  },
];

const BAND_ORDER = ["plan", "candidate-rules", "delivery", "session"];

function nodesForMode(mode: LaneBandMode): Node<ExecutionContextNodeData>[] {
  return MEMBERS.map((member) => {
    const node = makeNode(member, BAND_ORDER.indexOf(member.lane));
    if (mode === "builder") {
      // A draft graph has no runtime: no wait state, and every lane reads
      // as pending except the reserved one.
      return {
        ...node,
        data: {
          ...node.data,
          laneState: member.readOnly
            ? ("session" as const)
            : ("pending" as const),
        },
      };
    }
    return {
      ...node,
      data: {
        ...node.data,
        mode: "execution" as const,
        laneState: member.laneState,
        waitState: member.waitState,
      },
    };
  });
}

interface BandSpec {
  laneName: string;
  reserved: boolean;
  memberContextIds: string[];
  gradeSummary: string;
  runtimeState: LaneBand["state"];
  runtime: NonNullable<LaneBand["runtime"]>;
}

const BAND_SPECS: BandSpec[] = [
  {
    laneName: "plan",
    reserved: false,
    memberContextIds: ["ctx_plan"],
    gradeSummary: "1 full",
    runtimeState: "merged",
    runtime: {
      status: "merged",
      branchLabel: "csm/checkout-v2.plan",
      worktreeLabel: null,
      joinLabel: "joined → session",
      publicationLabel: null,
    },
  },
  {
    laneName: "candidate-rules",
    reserved: false,
    memberContextIds: ["ctx_rules"],
    gradeSummary: "1 owning",
    runtimeState: "merged",
    runtime: {
      status: "merged",
      branchLabel: "csm/checkout-v2.candidate-rules",
      worktreeLabel: null,
      joinLabel: "joined → delivery",
      publicationLabel: null,
    },
  },
  {
    laneName: "delivery",
    reserved: false,
    memberContextIds: ["ctx_checkout", "ctx_settings", "ctx_rollout"],
    gradeSummary: "2 owning · 1 full",
    runtimeState: "active",
    runtime: {
      status: "active",
      branchLabel: "csm/checkout-v2.delivery",
      worktreeLabel: ".worktrees/checkout-v2.delivery",
      joinLabel: null,
      publicationLabel: "publishes → session",
    },
  },
  {
    laneName: "session",
    reserved: true,
    memberContextIds: ["ctx_notes"],
    gradeSummary: "1 read-only",
    runtimeState: "session",
    runtime: {
      status: "pending",
      branchLabel: null,
      worktreeLabel: "the session worktree",
      joinLabel: null,
      publicationLabel: "publication target",
    },
  },
];

function bandsForMode(mode: LaneBandMode): LaneBand[] {
  return BAND_SPECS.map((spec) => ({
    laneName: spec.laneName,
    // A draft lane has no runtime state; only the reserved session lane is
    // already true before anything runs.
    state:
      mode === "execution"
        ? spec.runtimeState
        : spec.reserved
          ? ("session" as const)
          : ("pending" as const),
    reserved: spec.reserved,
    memberContextIds: spec.memberContextIds,
    memberCount: spec.memberContextIds.length,
    membershipLabel:
      spec.memberContextIds.length === 1
        ? "1 member"
        : `${spec.memberContextIds.length} members`,
    gradeSummary: spec.gradeSummary,
    runtime: mode === "execution" ? spec.runtime : null,
  }));
}

function BandStory({ mode }: { mode: LaneBandMode }) {
  const bands = bandsForMode(mode);

  return (
    <ReactFlowProvider>
      <div style={{ width: 1100, height: 700, background: "var(--bg-void)" }}>
        <ReactFlow
          nodes={nodesForMode(mode)}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.05 }}
        >
          <LaneBandLayer bands={bands} mode={mode} />
          <CanvasControls />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}

const meta = {
  title: "WorkflowGraph/LaneBands",
  component: BandStory,
  parameters: { layout: "centered", backgrounds: { default: "dark" } },
} satisfies Meta<typeof BandStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** B1: neutral draft bands; the reserved session band is dashed. */
export const BuilderBands: Story = { args: { mode: "builder" } };

/**
 * E1: merged bands take the green left accent, the live band the cyan accent
 * and fill, and the session band stays dashed and read-only. Every header
 * states its members' grades as a summary — never a grade of the lane's own.
 */
export const ExecutionBands: Story = { args: { mode: "execution" } };

/**
 * B2 — dragging a context across a lane boundary, the one approved behaviour
 * change. The band the node is being dragged over is the only thing that says
 * whether the drop can land; the node it left keeps its band pinned in place.
 */
interface DragSpec {
  /** The context being dragged, and the band it is being dragged over. */
  contextId: string;
  targetLane: string;
  accepted: boolean;
  /** Where the card currently sits, in flow coordinates. */
  position: { x: number; y: number };
  label: string;
  ephemeralLanes?: EphemeralLane[];
}

function DragStory({ spec }: { spec: DragSpec }) {
  const nodes = nodesForMode("builder");
  const origin = nodes.find((node) => node.id === spec.contextId)!;
  const size = { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };

  return (
    <ReactFlowProvider>
      <div style={{ width: 1100, height: 760, background: "var(--bg-void)" }}>
        <ReactFlow
          nodes={nodes.map((node) =>
            node.id === spec.contextId
              ? { ...node, position: spec.position }
              : node,
          )}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.05 }}
        >
          <LaneBandLayer
            bands={bandsForMode("builder")}
            mode="builder"
            dropTarget={{
              laneName: spec.targetLane,
              accepted: spec.accepted,
            }}
            pinnedNode={{
              id: spec.contextId,
              x: origin.position.x,
              y: origin.position.y,
            }}
            ephemeralLanes={spec.ephemeralLanes}
            onRenameEphemeralLane={fn()}
            onMergeEphemeralLane={fn()}
            onRemoveEphemeralLane={fn()}
          />
          <LaneDropOverlay
            ghost={{
              x: origin.position.x,
              y: origin.position.y,
              width: size.width,
              height: size.height,
              laneName: origin.data.context.placement!.lane,
            }}
            preview={{
              x: spec.position.x,
              y: spec.position.y,
              label: spec.label,
              accepted: spec.accepted,
            }}
          />
          <CanvasControls />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}

/**
 * B2, valid drop: a read-only context moving off the session lane. The preview
 * names the whole pending change — target lane, the grade being carried, and
 * that the grade is unchanged.
 */
export const DragValidDrop: StoryObj<typeof DragStory> = {
  render: (args) => <DragStory {...args} />,
  args: {
    spec: {
      contextId: "ctx_notes",
      targetLane: "delivery",
      accepted: true,
      position: { x: 784, y: 560 },
      label: "Re-place → lane: delivery · grade: read-only · unchanged",
    },
  },
};

/**
 * B2, refused drop: an owning context over the reserved session lane. Nothing
 * is written — the band says it cannot accept the context and the node returns
 * to its lane on release.
 */
export const DragRefusedDrop: StoryObj<typeof DragStory> = {
  render: (args) => <DragStory {...args} />,
  args: {
    spec: {
      contextId: "ctx_checkout",
      targetLane: "session",
      accepted: false,
      position: { x: 490, y: 780 },
      label:
        "Re-place → lane: session · grade: owned (src/checkout, src/risk) · unchanged",
    },
  },
};

/**
 * B2, ephemeral lane: an empty band an author has drawn. It is client-only
 * draft UI — nothing about it is serialized, and it is a drop target from the
 * moment it appears, which is the only way it can ever hold anything.
 */
export const DragOntoEphemeralLane: StoryObj<typeof DragStory> = {
  render: (args) => <DragStory {...args} />,
  args: {
    spec: {
      contextId: "ctx_checkout",
      targetLane: "rollback",
      accepted: true,
      position: { x: 490, y: 1020 },
      label:
        "Re-place → lane: rollback · grade: owned (src/checkout, src/risk) · unchanged",
      ephemeralLanes: [{ id: "ephemeral-lane-1", name: "rollback" }],
    },
  },
};
