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
const TRANSIENT_H = 50;
const TERMINAL_H = 56;

/**
 * Smart Merge — the most spatially complex layout. Three logical bands:
 *
 *   1. Setup (top)        : routing → checkUnc/commitUnc → mergingMain
 *   2. Validation (left)  : validating → squashMerging → completed,
 *                            with the fix-and-retry loop on the bottom-left
 *   3. Conflict (right)   : conflictsDetected → resolve / analyze paths,
 *                            terminating in `conflicts` if manual or partial
 *
 * Failed sits at the bottom-right; many onError edges land there. To keep the
 * picture readable we draw only the structurally distinct onError edges (the
 * ones with no equally-informative onDone neighbor).
 */
export default function MergeLayout({
  selectedStateId,
  onSelectState,
}: LayoutProps): React.JSX.Element {
  // Setup band
  const routing = box(560, 40, 200, TRANSIENT_H);
  const checkUnc = box(560, 140, NODE_W, NODE_H);
  const commitUnc = box(260, 140, NODE_W, NODE_H);
  const mergingMain = box(560, 290, NODE_W, NODE_H);

  // Conflict band (right)
  const conflictsDetected = box(870, 305, 200, TRANSIENT_H);
  const resolvingConflicts = box(870, 410, NODE_W, NODE_H);
  const analyzingConflicts = box(1170, 410, NODE_W, NODE_H);
  const committingResolution = box(870, 550, NODE_W, NODE_H);
  const conflicts = box(1170, 580, NODE_W, TERMINAL_H);

  // Validation band (left)
  const validating = box(560, 440, NODE_W, NODE_H);
  const fixingValidation = box(260, 580, NODE_W, NODE_H);
  const checkingFixChanges = box(260, 720, NODE_W, NODE_H);
  const committingFix = box(40, 720, NODE_W, NODE_H);
  const revalidating = box(260, 860, NODE_W, NODE_H);
  const squashMerging = box(560, 860, NODE_W, NODE_H);

  // Terminals
  const completed = box(560, 1000, NODE_W, TERMINAL_H);
  const failed = box(870, 1000, NODE_W, TERMINAL_H);

  const edges: EdgeSpec[] = [
    // Init
    {
      id: "init",
      from: { x: routing.x + routing.width / 2, y: 15 },
      to: topAnchor(routing),
      routing: "straight",
      toStateId: "routing",
    },

    // Setup band
    {
      id: "routing-checking",
      from: bottomAnchor(routing),
      to: topAnchor(checkUnc),
      routing: "straight",
      label: "always",
      dashed: true,
      fromStateId: "routing",
      toStateId: "checkingUncommitted",
    },
    {
      id: "routing-resolving",
      from: rightAnchor(routing),
      to: topAnchor(resolvingConflicts, 30),
      routing: "curve",
      bow: "v",
      label: "always",
      guard: "isResolveConflictsJob",
      dashed: true,
      fromStateId: "routing",
      toStateId: "resolvingConflicts",
      labelOffset: { x: 130, y: -180 },
    },
    {
      id: "checking-commitUnc",
      from: leftAnchor(checkUnc),
      to: rightAnchor(commitUnc),
      routing: "straight",
      label: "onDone",
      guard: "hasUncommittedChanges",
      dashed: true,
      fromStateId: "checkingUncommitted",
      toStateId: "committingUncommitted",
      labelOffset: { x: 0, y: -70 },
    },
    {
      id: "checking-merging",
      from: bottomAnchor(checkUnc),
      to: topAnchor(mergingMain),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "checkingUncommitted",
      toStateId: "mergingMain",
    },
    {
      id: "commitUnc-merging",
      from: bottomAnchor(commitUnc),
      to: leftAnchor(mergingMain),
      routing: "curve",
      label: "onDone",
      dashed: true,
      fromStateId: "committingUncommitted",
      toStateId: "mergingMain",
    },

    // mergingMain branches
    {
      id: "merging-validating",
      from: bottomAnchor(mergingMain),
      to: topAnchor(validating),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "mergingMain",
      toStateId: "validating",
    },
    {
      id: "merging-conflicts",
      from: rightAnchor(mergingMain),
      to: leftAnchor(conflictsDetected),
      routing: "straight",
      label: "onDone",
      guard: "mergeHadConflicts",
      dashed: true,
      fromStateId: "mergingMain",
      toStateId: "conflictsDetected",
      labelOffset: { x: 0, y: -70 },
    },

    // Conflict band
    {
      id: "conflictsDetected-resolving",
      from: bottomAnchor(conflictsDetected),
      to: topAnchor(resolvingConflicts),
      routing: "straight",
      label: "always",
      guard: "shouldAutoResolve",
      dashed: true,
      fromStateId: "conflictsDetected",
      toStateId: "resolvingConflicts",
    },
    {
      id: "conflictsDetected-analyzing",
      from: rightAnchor(conflictsDetected),
      to: topAnchor(analyzingConflicts),
      routing: "curve",
      label: "always",
      dashed: true,
      fromStateId: "conflictsDetected",
      toStateId: "analyzingConflicts",
    },
    {
      id: "resolving-committingRes",
      from: bottomAnchor(resolvingConflicts),
      to: topAnchor(committingResolution),
      routing: "straight",
      label: "onDone",
      guard: "resolutionSucceeded",
      dashed: true,
      fromStateId: "resolvingConflicts",
      toStateId: "committingResolution",
    },
    {
      id: "resolving-conflicts",
      from: rightAnchor(resolvingConflicts),
      to: leftAnchor(conflicts),
      routing: "curve",
      bow: "v",
      label: "onDone",
      dashed: true,
      fromStateId: "resolvingConflicts",
      toStateId: "conflicts",
    },
    {
      id: "analyzing-conflicts",
      from: bottomAnchor(analyzingConflicts),
      to: topAnchor(conflicts),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "analyzingConflicts",
      toStateId: "conflicts",
    },
    {
      id: "committingRes-validating",
      from: leftAnchor(committingResolution),
      to: rightAnchor(validating),
      routing: "curve",
      bow: "v",
      label: "onDone",
      dashed: true,
      fromStateId: "committingResolution",
      toStateId: "validating",
    },

    // Validation band
    {
      id: "validating-squash",
      from: bottomAnchor(validating, 30),
      to: topAnchor(squashMerging, 30),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "validating",
      toStateId: "squashMerging",
    },
    {
      id: "validating-fixing",
      from: leftAnchor(validating),
      to: topAnchor(fixingValidation),
      routing: "curve",
      label: "onError",
      guard: "shouldAutoResolve",
      dashed: true,
      fromStateId: "validating",
      toStateId: "fixingValidation",
    },
    {
      id: "fixing-checking",
      from: bottomAnchor(fixingValidation),
      to: topAnchor(checkingFixChanges),
      routing: "straight",
      label: "onDone",
      guard: "fixSucceeded",
      dashed: true,
      fromStateId: "fixingValidation",
      toStateId: "checkingFixChanges",
      labelOffset: { x: 100, y: 0 },
    },
    {
      id: "checking-committingFix",
      from: leftAnchor(checkingFixChanges),
      to: rightAnchor(committingFix),
      routing: "straight",
      label: "onDone",
      guard: "hasUncommittedChanges",
      dashed: true,
      fromStateId: "checkingFixChanges",
      toStateId: "committingFix",
      labelOffset: { x: 0, y: -70 },
    },
    {
      id: "checking-revalidating",
      from: bottomAnchor(checkingFixChanges),
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
      to: leftAnchor(revalidating),
      routing: "curve",
      label: "onDone",
      dashed: true,
      fromStateId: "committingFix",
      toStateId: "revalidating",
    },
    {
      id: "revalidating-squash",
      from: rightAnchor(revalidating),
      to: leftAnchor(squashMerging),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "revalidating",
      toStateId: "squashMerging",
    },
    {
      id: "revalidating-fixing-loop",
      from: { x: revalidating.x, y: revalidating.y + 20 },
      to: {
        x: fixingValidation.x,
        y: fixingValidation.y + fixingValidation.height - 20,
      },
      routing: "loop",
      loopSide: "left",
      label: "onError",
      guard: "hasFixRetriesRemaining",
      fromStateId: "revalidating",
      toStateId: "fixingValidation",
      labelOffset: { x: -130, y: -180 },
    },

    // Squash → completed
    {
      id: "squash-completed",
      from: bottomAnchor(squashMerging),
      to: topAnchor(completed),
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "squashMerging",
      toStateId: "completed",
    },

    // Failures (only the structurally distinct ones to avoid clutter)
    {
      id: "merging-failed",
      from: rightAnchor(mergingMain, 25),
      to: topAnchor(failed),
      routing: "curve",
      label: "onError",
      dashed: true,
      fromStateId: "mergingMain",
      toStateId: "failed",
    },
    {
      id: "validating-failed",
      from: rightAnchor(validating, 25),
      to: leftAnchor(failed),
      routing: "curve",
      bow: "v",
      label: "onError",
      dashed: true,
      fromStateId: "validating",
      toStateId: "failed",
    },
    {
      id: "revalidating-failed",
      from: bottomAnchor(revalidating, 30),
      to: leftAnchor(failed, 10),
      routing: "curve",
      label: "onError",
      dashed: true,
      fromStateId: "revalidating",
      toStateId: "failed",
      labelOffset: { x: -60, y: -22 },
    },
  ];

  return (
    <MachineCanvas
      width={1440}
      height={1100}
      edges={edges}
      selectedStateId={selectedStateId}
    >
      <InitialMarker x={routing.x + routing.width / 2} y={15} />

      <StateNode
        id="routing"
        label="routing"
        kind="transient"
        status="initial"
        x={routing.x}
        y={routing.y}
        width={routing.width}
        height={routing.height}
        selected={selectedStateId === "routing"}
        onClick={onSelectState}
      />
      <StateNode
        id="checkingUncommitted"
        label="checkingUncommitted"
        kind="atomic"
        x={checkUnc.x}
        y={checkUnc.y}
        width={checkUnc.width}
        height={checkUnc.height}
        invokes={["checkUncommitted"]}
        selected={selectedStateId === "checkingUncommitted"}
        onClick={onSelectState}
      />
      <StateNode
        id="committingUncommitted"
        label="committingUncommitted"
        kind="atomic"
        x={commitUnc.x}
        y={commitUnc.y}
        width={commitUnc.width}
        height={commitUnc.height}
        invokes={["commitChanges"]}
        selected={selectedStateId === "committingUncommitted"}
        onClick={onSelectState}
      />
      <StateNode
        id="mergingMain"
        label="mergingMain"
        kind="atomic"
        x={mergingMain.x}
        y={mergingMain.y}
        width={mergingMain.width}
        height={mergingMain.height}
        invokes={["mergeMain"]}
        selected={selectedStateId === "mergingMain"}
        onClick={onSelectState}
      />

      <StateNode
        id="conflictsDetected"
        label="conflictsDetected"
        kind="transient"
        status="warning"
        x={conflictsDetected.x}
        y={conflictsDetected.y}
        width={conflictsDetected.width}
        height={conflictsDetected.height}
        selected={selectedStateId === "conflictsDetected"}
        onClick={onSelectState}
      />
      <StateNode
        id="resolvingConflicts"
        label="resolvingConflicts"
        kind="atomic"
        x={resolvingConflicts.x}
        y={resolvingConflicts.y}
        width={resolvingConflicts.width}
        height={resolvingConflicts.height}
        invokes={["resolveConflicts"]}
        selected={selectedStateId === "resolvingConflicts"}
        onClick={onSelectState}
      />
      <StateNode
        id="analyzingConflicts"
        label="analyzingConflicts"
        kind="atomic"
        x={analyzingConflicts.x}
        y={analyzingConflicts.y}
        width={analyzingConflicts.width}
        height={analyzingConflicts.height}
        invokes={["analyzeConflicts"]}
        selected={selectedStateId === "analyzingConflicts"}
        onClick={onSelectState}
      />
      <StateNode
        id="committingResolution"
        label="committingResolution"
        kind="atomic"
        x={committingResolution.x}
        y={committingResolution.y}
        width={committingResolution.width}
        height={committingResolution.height}
        invokes={["commitChanges"]}
        selected={selectedStateId === "committingResolution"}
        onClick={onSelectState}
      />
      <StateNode
        id="conflicts"
        label="conflicts"
        kind="final"
        status="warning"
        x={conflicts.x}
        y={conflicts.y}
        width={conflicts.width}
        height={conflicts.height}
        selected={selectedStateId === "conflicts"}
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
        x={fixingValidation.x}
        y={fixingValidation.y}
        width={fixingValidation.width}
        height={fixingValidation.height}
        invokes={["fixValidation"]}
        selected={selectedStateId === "fixingValidation"}
        onClick={onSelectState}
      />
      <StateNode
        id="checkingFixChanges"
        label="checkingFixChanges"
        kind="atomic"
        x={checkingFixChanges.x}
        y={checkingFixChanges.y}
        width={checkingFixChanges.width}
        height={checkingFixChanges.height}
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
        id="squashMerging"
        label="squashMerging"
        kind="atomic"
        x={squashMerging.x}
        y={squashMerging.y}
        width={squashMerging.width}
        height={squashMerging.height}
        invokes={["squashMerge"]}
        selected={selectedStateId === "squashMerging"}
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
