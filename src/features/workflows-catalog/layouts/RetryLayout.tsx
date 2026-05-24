"use client";

import StateNode from "../canvas/StateNode";
import MachineCanvas from "../canvas/MachineCanvas";
import InitialMarker from "../canvas/InitialMarker";
import {
  bottomAnchor,
  box,
  leftAnchor,
  rightAnchor,
  topAnchor,
} from "../canvas/geometry";
import type { EdgeSpec } from "../canvas/types";

interface LayoutProps {
  selectedStateId: string | null;
  onSelectState: (id: string) => void;
}

const NODE_W = 200;
const NODE_H = 84;
const TERMINAL_H = 56;

/**
 * Retry — a generic factory machine. Diamond-shaped layout that emphasizes
 * the loop: attempting at the top, the optional fix step on the right,
 * succeeded/exhausted as terminal anchors at the bottom.
 */
export default function RetryLayout({
  selectedStateId,
  onSelectState,
}: LayoutProps): React.JSX.Element {
  const attempting = box(300, 60, NODE_W, NODE_H);
  const fixing = box(580, 220, NODE_W, NODE_H);
  const succeeded = box(60, 420, NODE_W, TERMINAL_H);
  const exhausted = box(580, 420, NODE_W, TERMINAL_H);

  const attemptingRight = rightAnchor(attempting);
  const attemptingLeft = leftAnchor(attempting);
  const attemptingBottom = bottomAnchor(attempting);
  const fixingTop = topAnchor(fixing);
  const fixingBottom = bottomAnchor(fixing);
  const succeededTop = topAnchor(succeeded);

  const edges: EdgeSpec[] = [
    {
      id: "init-attempting",
      from: { x: attempting.x + attempting.width / 2, y: 20 },
      to: topAnchor(attempting),
      routing: "straight",
      toStateId: "attempting",
    },
    {
      id: "attempting-fixing",
      from: attemptingRight,
      to: fixingTop,
      routing: "curve",
      label: "onError",
      guard: "hasRetriesLeft",
      dashed: true,
      fromStateId: "attempting",
      toStateId: "fixing",
    },
    {
      id: "fixing-attempting",
      from: { x: fixing.x, y: fixing.y + 20 },
      to: {
        x: attempting.x + attempting.width,
        y: attempting.y + attempting.height - 20,
      },
      routing: "curve",
      bow: "v",
      label: "onDone",
      dashed: true,
      fromStateId: "fixing",
      toStateId: "attempting",
      labelOffset: { x: -60, y: 0 },
    },
    {
      id: "attempting-succeeded",
      from: attemptingLeft,
      to: succeededTop,
      routing: "curve",
      label: "onDone",
      dashed: true,
      fromStateId: "attempting",
      toStateId: "succeeded",
    },
    {
      id: "attempting-exhausted",
      from: attemptingBottom,
      to: { x: exhausted.x + exhausted.width / 2 - 30, y: exhausted.y },
      routing: "curve",
      bow: "h",
      label: "onError",
      dashed: true,
      fromStateId: "attempting",
      toStateId: "exhausted",
    },
    {
      id: "fixing-exhausted",
      from: fixingBottom,
      to: { x: exhausted.x + exhausted.width / 2 + 30, y: exhausted.y },
      routing: "straight",
      label: "onError",
      dashed: true,
      fromStateId: "fixing",
      toStateId: "exhausted",
    },
  ];

  return (
    <MachineCanvas
      width={840}
      height={540}
      edges={edges}
      selectedStateId={selectedStateId}
    >
      <InitialMarker x={attempting.x + attempting.width / 2} y={20} />
      <StateNode
        id="attempting"
        label="attempting"
        kind="atomic"
        status="initial"
        x={attempting.x}
        y={attempting.y}
        width={attempting.width}
        height={attempting.height}
        invokes={["work"]}
        selected={selectedStateId === "attempting"}
        onClick={onSelectState}
      />
      <StateNode
        id="fixing"
        label="fixing"
        kind="atomic"
        status="warning"
        x={fixing.x}
        y={fixing.y}
        width={fixing.width}
        height={fixing.height}
        invokes={["fix"]}
        selected={selectedStateId === "fixing"}
        onClick={onSelectState}
      />
      <StateNode
        id="succeeded"
        label="succeeded"
        kind="final"
        status="success"
        x={succeeded.x}
        y={succeeded.y}
        width={succeeded.width}
        height={succeeded.height}
        selected={selectedStateId === "succeeded"}
        onClick={onSelectState}
      />
      <StateNode
        id="exhausted"
        label="exhausted"
        kind="final"
        status="failure"
        x={exhausted.x}
        y={exhausted.y}
        width={exhausted.width}
        height={exhausted.height}
        selected={selectedStateId === "exhausted"}
        onClick={onSelectState}
      />
    </MachineCanvas>
  );
}
