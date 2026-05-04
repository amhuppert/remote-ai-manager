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

const NODE_W = 220;
const NODE_H = 84;
const TERMINAL_H = 56;

/**
 * Smart Commit — vertical pipeline on the left, fix-and-retry loop on the
 * right. The retry arc back to fixingValidation deliberately curves around
 * the right edge so it reads as "go back up and try again".
 */
export default function CommitLayout({
  selectedStateId,
  onSelectState,
}: LayoutProps): React.JSX.Element {
  const committing = box(60, 60, NODE_W, NODE_H);
  const validating = box(60, 220, NODE_W, NODE_H);
  const completed = box(60, 760, NODE_W, TERMINAL_H);

  const fixing = box(380, 280, NODE_W, NODE_H);
  const checking = box(380, 440, NODE_W, NODE_H);
  const committingFix = box(700, 440, NODE_W, NODE_H);
  const revalidating = box(380, 600, NODE_W, NODE_H);

  const failed = box(700, 760, NODE_W, TERMINAL_H);

  const edges: EdgeSpec[] = [
    {
      id: "init",
      from: { x: committing.x + committing.width / 2, y: 20 },
      to: topAnchor(committing),
      routing: "straight",
      toStateId: "committing",
    },
    {
      id: "committing-validating",
      from: bottomAnchor(committing),
      to: topAnchor(validating),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "committing",
      toStateId: "validating",
    },
    {
      id: "validating-completed",
      from: leftAnchor(validating),
      to: leftAnchor(completed),
      routing: "curve",
      bow: "h",
      control: { x: -120, y: (validating.y + completed.y) / 2 },
      label: "onDone",
      dashed: true,
      fromStateId: "validating",
      toStateId: "completed",
      labelOffset: { x: 115, y: 0 },
    },
    {
      id: "validating-fixing",
      from: rightAnchor(validating),
      to: leftAnchor(fixing),
      routing: "curve",
      label: "onError",
      dashed: true,
      fromStateId: "validating",
      toStateId: "fixingValidation",
    },
    {
      id: "fixing-checking",
      from: bottomAnchor(fixing),
      to: topAnchor(checking),
      routing: "straight",
      label: "onDone",
      guard: "fixSucceeded",
      dashed: true,
      fromStateId: "fixingValidation",
      toStateId: "checkingFixChanges",
    },
    {
      id: "fixing-failed",
      from: rightAnchor(fixing),
      to: { x: failed.x + failed.width - 30, y: failed.y },
      routing: "curve",
      bow: "v",
      label: "fix failed",
      dashed: true,
      fromStateId: "fixingValidation",
      toStateId: "failed",
    },
    {
      id: "checking-committingFix",
      from: rightAnchor(checking),
      to: leftAnchor(committingFix),
      routing: "straight",
      label: "onDone",
      guard: "hasUncommittedChanges",
      dashed: true,
      fromStateId: "checkingFixChanges",
      toStateId: "committingFix",
      labelOffset: { x: 0, y: -75 },
    },
    {
      id: "checking-revalidating",
      from: bottomAnchor(checking),
      to: topAnchor(revalidating),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "checkingFixChanges",
      toStateId: "revalidating",
    },
    {
      id: "committingFix-revalidating",
      from: bottomAnchor(committingFix),
      to: rightAnchor(revalidating),
      routing: "curve",
      bow: "v",
      label: "onDone",
      dashed: true,
      fromStateId: "committingFix",
      toStateId: "revalidating",
    },
    {
      id: "revalidating-completed",
      from: leftAnchor(revalidating),
      to: rightAnchor(completed),
      routing: "curve",
      bow: "v",
      label: "onDone",
      dashed: true,
      fromStateId: "revalidating",
      toStateId: "completed",
    },
    {
      id: "revalidating-fixing-loop",
      from: { x: revalidating.x + revalidating.width, y: revalidating.y + 20 },
      to: { x: fixing.x + fixing.width, y: fixing.y + fixing.height - 20 },
      routing: "loop",
      loopSide: "right",
      label: "onError",
      guard: "hasFixRetriesRemaining",
      fromStateId: "revalidating",
      toStateId: "fixingValidation",
      labelOffset: { x: 210, y: -180 },
    },
    {
      id: "revalidating-failed",
      from: bottomAnchor(revalidating),
      to: leftAnchor(failed),
      routing: "curve",
      label: "onError",
      dashed: true,
      fromStateId: "revalidating",
      toStateId: "failed",
    },
    {
      id: "committing-failed",
      from: rightAnchor(committing),
      to: { x: failed.x, y: failed.y + failed.height / 2 - 18 },
      routing: "curve",
      bow: "v",
      label: "onError",
      dashed: true,
      fromStateId: "committing",
      toStateId: "failed",
      labelOffset: { x: 160, y: -330 },
    },
  ];

  return (
    <MachineCanvas
      width={1000}
      height={870}
      edges={edges}
      selectedStateId={selectedStateId}
    >
      <InitialMarker x={committing.x + committing.width / 2} y={20} />
      <StateNode
        id="committing"
        label="committing"
        kind="atomic"
        status="initial"
        x={committing.x}
        y={committing.y}
        width={committing.width}
        height={committing.height}
        invokes={["commitChanges"]}
        selected={selectedStateId === "committing"}
        onClick={onSelectState}
      />
      <StateNode
        id="validating"
        label="validating"
        kind="atomic"
        x={validating.x}
        y={validating.y}
        width={validating.width}
        height={validating.height}
        invokes={["runValidation"]}
        selected={selectedStateId === "validating"}
        onClick={onSelectState}
      />
      <StateNode
        id="fixingValidation"
        label="fixingValidation"
        kind="atomic"
        status="warning"
        x={fixing.x}
        y={fixing.y}
        width={fixing.width}
        height={fixing.height}
        invokes={["fixValidation"]}
        selected={selectedStateId === "fixingValidation"}
        onClick={onSelectState}
      />
      <StateNode
        id="checkingFixChanges"
        label="checkingFixChanges"
        kind="atomic"
        x={checking.x}
        y={checking.y}
        width={checking.width}
        height={checking.height}
        invokes={["checkUncommitted"]}
        selected={selectedStateId === "checkingFixChanges"}
        onClick={onSelectState}
      />
      <StateNode
        id="committingFix"
        label="committingFix"
        kind="atomic"
        x={committingFix.x}
        y={committingFix.y}
        width={committingFix.width}
        height={committingFix.height}
        invokes={["commitChanges"]}
        selected={selectedStateId === "committingFix"}
        onClick={onSelectState}
      />
      <StateNode
        id="revalidating"
        label="revalidating"
        kind="atomic"
        x={revalidating.x}
        y={revalidating.y}
        width={revalidating.width}
        height={revalidating.height}
        invokes={["runValidation"]}
        selected={selectedStateId === "revalidating"}
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
