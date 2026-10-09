"use client";

import "@xyflow/react/dist/base.css";
import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import CanvasControls from "@/components/workflow-graph/CanvasControls";
import { StatusChip } from "@/components/ui/StatusChip";
import { BranchIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import { LoopIcon } from "@/components/runs/icons";
import {
  layoutDiagram,
  NODE_HEIGHT,
  NODE_WIDTH,
  type PlacedBand,
  type PlacedLoop,
} from "../diagram-layout";
import type {
  RunContext,
  RunEdge,
  RunLane,
  RunLoop,
} from "@/components/runs/model";
import {
  contextState,
  isSettled,
  laneState,
  loopState,
} from "@/components/runs/present";
import { Cost } from "@/components/runs/Cost";
import { ContextGlyph, SeatMark } from "./parts";

type ContextNodeData = {
  context: RunContext;
  selected: boolean;
  guards: string[];
  template: boolean;
};
type BandNodeData = { band: PlacedBand; width: number; template: boolean };
type LoopNodeData = { placed: PlacedLoop; template: boolean };
type DependencyData = {
  status: "satisfied" | "active" | "pending" | "not_taken" | "structure";
  dimmed: boolean;
  outputOnly: boolean;
};

const frameByTone: Record<ReturnType<typeof contextState>["tone"], string> = {
  neutral: "border-border-subtle",
  cyan: "border-[var(--cc-cyan-a25)]",
  amber: "border-[var(--cc-amber-a25)]",
  green: "border-[var(--cc-green-a20)]",
  red: "border-[var(--cc-red-a40)]",
  violet: "border-[var(--cc-codex-violet-a35)]",
};

const stateText: Record<ReturnType<typeof contextState>["tone"], string> = {
  neutral: "text-text-secondary",
  cyan: "text-cyan",
  amber: "text-amber",
  green: "text-green",
  red: "text-red",
  violet: "text-violet",
};

const HIDDEN_HANDLE = "size-[6px]! min-h-0! min-w-0! border-0! bg-transparent!";

function ContextNode({ data }: NodeProps<Node<ContextNodeData>>) {
  const { context, selected, guards, template } = data;
  const state = contextState(context.state);
  const skipped = context.state.kind === "skipped";
  // A route's condition lives on the context it guards, so the canvas carries no floating labels.
  const condition = guards.length > 0 ? guards.join(", ") : null;
  const stateLine =
    condition === null
      ? state.label
      : skipped
        ? `Not taken · ${condition}`
        : context.state.kind === "waiting"
          ? `${state.label} · if ${condition}`
          : state.label;
  return (
    <div style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}>
      <Handle
        type="target"
        position={Position.Left}
        className={HIDDEN_HANDLE}
        isConnectable={false}
      />
      <button
        type="button"
        aria-label={`Inspect ${context.title}`}
        aria-pressed={selected}
        data-selected={selected}
        className={cn(
          "nodrag nopan flex h-full w-full cursor-pointer flex-col justify-center gap-[4px] rounded-md border border-solid bg-bg-surface px-md py-[8px] text-left transition-[background-color,box-shadow,border-color] duration-150 hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
          template
            ? "border-border-default"
            : skipped
              ? "border-dashed border-border-default"
              : frameByTone[state.tone],
          "data-[selected=true]:border-cyan data-[selected=true]:bg-bg-raised data-[selected=true]:shadow-[0_0_0_1px_var(--color-cyan),0_0_18px_var(--color-cyan-glow)]",
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-sm">
          {template ? null : <ContextGlyph state={context.state} size={13} />}
          <span className="truncate font-mono text-[0.7rem] font-medium text-text-tertiary">
            {context.key}
          </span>
          {context.loop !== null ? (
            <span className="inline-flex shrink-0 items-center gap-[3px] font-mono text-[0.7rem] text-text-tertiary">
              <LoopIcon size={11} />
              {template
                ? null
                : `${context.loop.pass}/${context.loop.maxPasses}`}
            </span>
          ) : null}
          {template ? null : (
            <span className="ml-auto shrink-0 font-mono text-[0.7rem] text-text-tertiary">
              <Cost usd={context.costUsd} complete={context.costComplete} />
            </span>
          )}
        </span>
        <span
          className={cn(
            "truncate font-mono text-[0.78rem] leading-[1.4] font-medium",
            skipped ? "text-text-tertiary" : "text-text-primary",
          )}
          title={context.title}
        >
          {context.title}
        </span>
        {template ? (
          <span className="flex min-w-0 items-center gap-[6px] truncate font-mono text-[0.7rem] text-text-secondary">
            <SeatMark seat={context.implementer} showEffort={false} />
            {context.reviewers.length > 0 ? (
              <span className="shrink-0 text-text-tertiary">
                + {context.reviewers.length}
              </span>
            ) : null}
          </span>
        ) : (
          <span
            className={cn(
              "truncate font-mono text-[0.7rem] font-medium",
              stateText[state.tone],
            )}
            title={stateLine}
          >
            {stateLine}
          </span>
        )}
      </button>
      <Handle
        type="source"
        position={Position.Right}
        className={HIDDEN_HANDLE}
        isConnectable={false}
      />
    </div>
  );
}

function BandNode({ data }: NodeProps<Node<BandNodeData>>) {
  const { band, width, template } = data;
  const lane = band.lane;
  const state = lane !== null && !template ? laneState(lane.state) : null;
  return (
    <div
      className={cn(
        "pointer-events-none rounded-lg border border-solid",
        lane === null
          ? "border-border-dim bg-[var(--cc-cyan-a04)]"
          : "border-border-subtle bg-bg-base",
      )}
      style={{ width, height: band.height }}
    >
      <div className="flex items-center gap-sm px-lg pt-[12px]">
        <span className="text-text-tertiary">
          <BranchIcon size={12} />
        </span>
        <span className="font-mono text-[0.7rem] font-semibold tracking-[0.1em] text-text-secondary uppercase">
          {band.label}
        </span>
        {state !== null ? (
          <StatusChip tone={state.tone}>{state.label}</StatusChip>
        ) : null}
        {lane !== null && !template ? (
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            {lane.branch}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LoopNode({ data }: NodeProps<Node<LoopNodeData>>) {
  const { placed, template } = data;
  const state = template
    ? {
        label: `up to ${placed.loop.maxPasses} passes`,
        tone: "neutral" as const,
      }
    : loopState(placed.loop);
  return (
    <div
      className="pointer-events-none rounded-lg border border-dashed border-border-strong"
      style={{ width: placed.width, height: placed.height }}
    >
      <div className="flex items-center gap-[6px] px-sm pt-[4px] font-mono text-[0.7rem] text-text-secondary">
        <LoopIcon size={11} />
        <span>loop {placed.loop.key}</span>
        <span
          className={cn(
            state.tone === "cyan"
              ? "text-cyan"
              : state.tone === "red"
                ? "text-red"
                : "text-text-tertiary",
          )}
        >
          {state.label}
        </span>
      </div>
    </div>
  );
}

const edgeStroke: Record<DependencyData["status"] | "structure", string> = {
  structure: "stroke-border-strong!",
  satisfied: "stroke-green-dim!",
  active: "stroke-cyan-dim!",
  pending: "stroke-text-tertiary! [stroke-dasharray:4_4]",
  not_taken: "stroke-border-strong! [stroke-dasharray:2_6]",
};

function DependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
}: EdgeProps<Edge<DependencyData>>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  });
  const status = data?.status ?? "pending";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={cn(
          "stroke-[1.5px]! transition-opacity duration-150",
          edgeStroke[status],
          data?.outputOnly === true && "[stroke-dasharray:7_4_2_4]!",
          data?.dimmed === true && "opacity-25",
        )}
      />
    </>
  );
}

const nodeTypes = { context: ContextNode, band: BandNode, loop: LoopNode };
const edgeTypes = { dependency: DependencyEdge };

function edgeStatus(
  edge: RunEdge,
  byKey: Map<string, RunContext>,
): DependencyData["status"] {
  if (edge.guard?.state === "not_taken") return "not_taken";
  const source = byKey.get(edge.from);
  const target = byKey.get(edge.to);
  if (
    source === undefined ||
    target === undefined ||
    source.state.kind !== "succeeded"
  )
    return "pending";
  if (isSettled(target.state)) return "satisfied";
  const waiting = target.state.kind === "waiting";
  return waiting ? "pending" : "active";
}

/**
 * The run as a read-only dependency diagram: contexts by dependency depth,
 * placements as bands, loops framed, routes labelled with their guard. It
 * selects; it never edits.
 */
export function RunDiagram({
  contexts,
  edges,
  lanes,
  loops,
  selectedKey,
  onSelect,
  template = false,
}: {
  contexts: RunContext[];
  edges: RunEdge[];
  lanes: RunLane[];
  loops: RunLoop[];
  selectedKey: string | null;
  onSelect(key: string): void;
  /** A template's structure: no states or costs, each context's implementer instead. */
  template?: boolean;
}) {
  const { nodes, flowEdges } = useMemo(() => {
    const layout = layoutDiagram({ contexts, lanes, loops });
    const byKey = new Map(contexts.map((context) => [context.key, context]));
    const nodes: Node[] = [
      ...layout.bands.map(
        (band): Node<BandNodeData> => ({
          id: band.id,
          type: "band",
          position: { x: 0, y: band.y },
          data: { band, width: layout.width, template },
          draggable: false,
          selectable: false,
          zIndex: -2,
        }),
      ),
      ...layout.loops.map(
        (placed): Node<LoopNodeData> => ({
          id: `loop:${placed.loop.key}`,
          type: "loop",
          position: { x: placed.x, y: placed.y },
          data: { placed, template },
          draggable: false,
          selectable: false,
          zIndex: -1,
        }),
      ),
      ...layout.nodes.flatMap((placed): Array<Node<ContextNodeData>> => {
        const context = byKey.get(placed.key);
        return context === undefined
          ? []
          : [
              {
                id: placed.key,
                type: "context",
                position: { x: placed.x, y: placed.y },
                data: {
                  context,
                  selected: placed.key === selectedKey,
                  guards: edges.flatMap((edge) =>
                    edge.to === placed.key && edge.guard !== null
                      ? [edge.guard.label]
                      : [],
                  ),
                  template,
                },
                draggable: false,
              },
            ];
      }),
    ];
    const flowEdges: Array<Edge<DependencyData>> = edges.map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: "dependency",
      data: {
        status: template ? "structure" : edgeStatus(edge, byKey),
        outputOnly: edge.outputOnly,
        // With a context selected, its own dependencies stay lit and the rest recede.
        dimmed:
          selectedKey !== null &&
          edge.from !== selectedKey &&
          edge.to !== selectedKey,
      },
      selectable: false,
    }));
    return { nodes, flowEdges };
  }, [contexts, edges, lanes, loops, selectedKey, template]);

  return (
    <div className="relative h-full min-h-[420px] w-full overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-void">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          disableKeyboardA11y
          onNodeClick={(_, node) => {
            if (node.type === "context") onSelect(node.id);
          }}
          fitView
          fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="var(--color-border-subtle)"
          />
          <CanvasControls />
        </ReactFlow>
      </ReactFlowProvider>
      {edges.some((edge) => edge.outputOnly) ? (
        <div className="pointer-events-none absolute top-sm left-sm z-raised flex max-w-[calc(100%-16px)] items-center gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface px-sm py-[6px] font-mono text-[0.7rem] text-text-secondary">
          <svg
            aria-hidden="true"
            width="32"
            height="8"
            className="shrink-0 text-text-secondary"
          >
            <path
              d="M0 4H32"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="7 4 2 4"
            />
          </svg>
          Result only · no code dependency
        </div>
      ) : null}
    </div>
  );
}
