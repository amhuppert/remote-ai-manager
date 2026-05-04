"use client";

import StateNode from "../canvas/StateNode";
import MachineCanvas from "../canvas/MachineCanvas";
import InitialMarker from "../canvas/InitialMarker";
import {
  bottomAnchor,
  box,
  rightAnchor,
  leftAnchor,
  topAnchor,
} from "../canvas/geometry";
import type { EdgeSpec } from "../canvas/types";

interface LayoutProps {
  selectedStateId: string | null;
  onSelectState: (id: string) => void;
}

const NODE_W = 220;
const NODE_H = 84;

/**
 * Optimistic — the simplest workflow. A horizontal three-step pipeline with
 * a shared `failed` terminal hanging below the middle. Designed to feel
 * approachable: clear left-to-right reading, generous spacing.
 */
export default function OptimisticLayout({
  selectedStateId,
  onSelectState,
}: LayoutProps): React.JSX.Element {
  const executing = box(80, 80, NODE_W, NODE_H);
  const dispatching = box(390, 80, NODE_W, NODE_H);
  const completed = box(700, 80, NODE_W, 56);
  const failed = box(390, 280, NODE_W, 56);

  const edges: EdgeSpec[] = [
    {
      id: "init-executing",
      from: { x: 50, y: executing.y + executing.height / 2 },
      to: leftAnchor(executing),
      routing: "straight",
      fromStateId: "__init__",
      toStateId: "executingPrompt",
    },
    {
      id: "exec-dispatch",
      from: rightAnchor(executing),
      to: leftAnchor(dispatching),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "executingPrompt",
      toStateId: "dispatchingMerge",
    },
    {
      id: "dispatch-completed",
      from: rightAnchor(dispatching),
      to: leftAnchor(completed),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "dispatchingMerge",
      toStateId: "completed",
    },
    {
      id: "exec-failed",
      from: bottomAnchor(executing, -40),
      to: topAnchor(failed, -40),
      routing: "curve",
      bow: "h",
      label: "onError",
      dashed: true,
      fromStateId: "executingPrompt",
      toStateId: "failed",
    },
    {
      id: "dispatch-failed",
      from: bottomAnchor(dispatching, 40),
      to: topAnchor(failed, 40),
      routing: "curve",
      bow: "h",
      label: "onError",
      dashed: true,
      fromStateId: "dispatchingMerge",
      toStateId: "failed",
    },
  ];

  return (
    <MachineCanvas
      width={960}
      height={400}
      edges={edges}
      selectedStateId={selectedStateId}
    >
      <InitialMarker x={50} y={executing.y + executing.height / 2} />
      <StateNode
        id="executingPrompt"
        label="executingPrompt"
        kind="atomic"
        status="initial"
        x={executing.x}
        y={executing.y}
        width={executing.width}
        height={executing.height}
        invokes={["executePrompt"]}
        selected={selectedStateId === "executingPrompt"}
        onClick={onSelectState}
      />
      <StateNode
        id="dispatchingMerge"
        label="dispatchingMerge"
        kind="atomic"
        x={dispatching.x}
        y={dispatching.y}
        width={dispatching.width}
        height={dispatching.height}
        invokes={["dispatchMerge"]}
        selected={selectedStateId === "dispatchingMerge"}
        onClick={onSelectState}
      />
      <StateNode
        id="completed"
        label="completed"
        kind="final"
        status="success"
        x={completed.x}
        y={completed.y}
        width={completed.width}
        height={completed.height}
        selected={selectedStateId === "completed"}
        onClick={onSelectState}
      />
      <StateNode
        id="failed"
        label="failed"
        kind="final"
        status="failure"
        x={failed.x}
        y={failed.y}
        width={failed.width}
        height={failed.height}
        selected={selectedStateId === "failed"}
        onClick={onSelectState}
      />
    </MachineCanvas>
  );
}
