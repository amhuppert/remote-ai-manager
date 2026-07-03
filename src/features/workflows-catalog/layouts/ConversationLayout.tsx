"use client";

import StateNode from "../canvas/StateNode";
import CompoundGroup from "../canvas/CompoundGroup";
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

const SPINE_W = 260;
const NODE_H = 84;
const TRANSIENT_H = 68;
const DEBUG_W = 260;

/**
 * Conversation — the most spatially complex of the five. Three logical zones:
 *   • Spine (left): idle → acquiringResources → executing → finalizingTurn
 *     → waitingForInput (when a registered question survives the turn)
 *   • externalExecuting branches off idle to the right of the spine
 *   • Debug compound (right): six phases stacked vertically
 *
 * finalizingTurn fans out to six visual destinations (idle + waitingForInput
 * + four debug targets); the individual `always` transitions are consolidated
 * by shared target so guard text remains readable.
 */
export default function ConversationLayout({
  selectedStateId,
  onSelectState,
}: LayoutProps): React.JSX.Element {
  // Spine (left column)
  const idle = box(80, 100, SPINE_W, NODE_H);
  const acquiring = box(80, 360, SPINE_W, NODE_H);

  // executing compound branches on activeTurn.kind
  const executingGroup = box(60, 520, 440, 220);
  const convTurn = box(90, 620, 200, NODE_H);
  const taskRun = box(310, 620, 180, NODE_H);

  const finalizing = box(80, 800, 400, TRANSIENT_H);
  const waiting = box(80, 920, SPINE_W + 60, NODE_H);

  // externalExecuting branches off the spine
  const external = box(400, 100, SPINE_W, NODE_H);

  // Debug compound (right column)
  const debugGroup = box(640, 60, 360, 920);
  const hyp = box(680, 140, DEBUG_W, NODE_H);
  const awRepro = box(680, 280, DEBUG_W, NODE_H);
  const analyzing = box(680, 420, DEBUG_W, NODE_H);
  const awVerify = box(680, 560, DEBUG_W, NODE_H);
  const cleanup = box(680, 700, DEBUG_W, NODE_H);

  const edges: EdgeSpec[] = [
    // Initial entry
    {
      id: "init-idle",
      from: { x: idle.x + idle.width / 2, y: 30 },
      to: topAnchor(idle),
      routing: "straight",
      toStateId: "idle",
    },

    // idle outgoing
    {
      id: "idle-acquiring",
      from: bottomAnchor(idle),
      to: topAnchor(acquiring),
      routing: "straight",
      label: "SUBMIT_PROMPT",
      fromStateId: "idle",
      toStateId: "acquiringResources",
    },
    {
      id: "idle-external",
      from: rightAnchor(idle),
      to: leftAnchor(external),
      routing: "straight",
      label: "EXTERNAL_TURN_STARTED",
      fromStateId: "idle",
      toStateId: "externalExecuting",
      labelOffset: { x: 0, y: -65 },
    },
    {
      id: "idle-debug",
      from: { x: idle.x + idle.width, y: idle.y + 20 },
      to: { x: debugGroup.x, y: debugGroup.y + 30 },
      routing: "curve",
      bow: "v",
      label: "ENTER_DEBUG_MODE",
      fromStateId: "idle",
      toStateId: "debug",
      labelOffset: { x: 110, y: -30 },
    },

    // externalExecuting → finalizingTurn
    {
      id: "external-finalizing",
      from: bottomAnchor(external),
      to: { x: finalizing.x + finalizing.width - 60, y: finalizing.y },
      routing: "curve",
      bow: "h",
      label: "EXTERNAL_TURN_COMPLETED",
      fromStateId: "externalExecuting",
      toStateId: "finalizingTurn",
    },

    // acquiringResources outgoing
    {
      id: "acquiring-executing",
      from: bottomAnchor(acquiring),
      to: {
        x: executingGroup.x + executingGroup.width / 2,
        y: executingGroup.y,
      },
      routing: "straight",
      label: "onDone",
      dashed: true,
      fromStateId: "acquiringResources",
      toStateId: "executing",
    },
    {
      id: "acquiring-finalizing-error",
      from: leftAnchor(acquiring),
      to: { x: finalizing.x, y: finalizing.y + 20 },
      routing: "curve",
      bow: "h",
      control: { x: -120, y: (acquiring.y + finalizing.y) / 2 },
      label: "onError",
      dashed: true,
      fromStateId: "acquiringResources",
      toStateId: "finalizingTurn",
      labelOffset: { x: 110, y: 0 },
    },

    // executing → finalizingTurn (compound-level)
    {
      id: "executing-finalizing",
      from: {
        x: executingGroup.x + executingGroup.width / 2,
        y: executingGroup.y + executingGroup.height,
      },
      to: topAnchor(finalizing),
      routing: "straight",
      label: "PROMPT_COMPLETED / FAILED / ABORT",
      fromStateId: "executing",
      toStateId: "finalizingTurn",
    },

    // debug compound → idle (EXIT_DEBUG_MODE)
    {
      id: "debug-idle-exit",
      from: { x: debugGroup.x, y: debugGroup.y + 60 },
      to: rightAnchor(idle),
      routing: "curve",
      bow: "v",
      control: { x: (debugGroup.x + idle.x + idle.width) / 2, y: 50 },
      label: "EXIT_DEBUG_MODE",
      fromStateId: "debug",
      toStateId: "idle",
      labelOffset: { x: 0, y: -48 },
    },

    // debug compound → acquiringResources (consolidated SUBMIT_PROMPT
    // edge representing the per-phase transitions back through the spine)
    {
      id: "debug-acquiring-submit",
      from: { x: debugGroup.x, y: debugGroup.y + debugGroup.height - 80 },
      to: {
        x: acquiring.x + acquiring.width,
        y: acquiring.y + acquiring.height - 18,
      },
      routing: "curve",
      bow: "v",
      control: {
        x: (debugGroup.x + acquiring.x + acquiring.width) / 2,
        y: 1010,
      },
      label: "SUBMIT_PROMPT (any phase)",
      fromStateId: "debug",
      toStateId: "acquiringResources",
    },

    // Debug internal transitions
    {
      id: "awRepro-analyzing",
      from: bottomAnchor(awRepro),
      to: topAnchor(analyzing),
      routing: "straight",
      label: "MARK_REPRODUCED",
      fromStateId: "debug.awaitingReproduction",
      toStateId: "debug.analyzingEvidence",
    },
    {
      id: "awVerify-cleanup",
      from: bottomAnchor(awVerify),
      to: topAnchor(cleanup),
      routing: "straight",
      label: "MARK_FIX_VERIFIED",
      fromStateId: "debug.awaitingVerification",
      toStateId: "debug.cleanupInstrumentation",
    },

    // finalizingTurn → waitingForInput (a registered question survived the turn)
    {
      id: "finalizing-waiting",
      from: bottomAnchor(finalizing),
      to: topAnchor(waiting),
      routing: "straight",
      label: "always",
      guard: "pendingQuestion != null",
      dashed: true,
      fromStateId: "finalizingTurn",
      toStateId: "waitingForInput",
    },

    // waitingForInput → acquiringResources (answer or superseding prompt
    // claims the next turn; the pending question is cleared at claim)
    {
      id: "waiting-acquiring",
      from: leftAnchor(waiting),
      to: { x: acquiring.x, y: acquiring.y + acquiring.height - 12 },
      routing: "curve",
      bow: "h",
      control: { x: 8, y: (waiting.y + acquiring.y) / 2 },
      label: "SUBMIT_PROMPT",
      fromStateId: "waitingForInput",
      toStateId: "acquiringResources",
      labelOffset: { x: 70, y: 40 },
    },

    // finalizingTurn → idle (default + cleanup consolidated)
    {
      id: "finalizing-idle",
      from: leftAnchor(finalizing),
      to: { x: idle.x, y: idle.y + idle.height - 20 },
      routing: "curve",
      bow: "h",
      control: { x: 20, y: (finalizing.y + idle.y) / 2 },
      label: "always",
      guard: "default · isDebugCleanup",
      dashed: true,
      fromStateId: "finalizingTurn",
      toStateId: "idle",
      labelOffset: { x: 90, y: 30 },
    },

    // finalizingTurn → debug.hypothesizing
    {
      id: "finalizing-hyp",
      from: { x: finalizing.x + finalizing.width, y: finalizing.y + 12 },
      to: leftAnchor(hyp),
      routing: "curve",
      bow: "v",
      control: { x: (finalizing.x + finalizing.width + hyp.x) / 2, y: 200 },
      label: "always",
      guard: "isDebugAnalyzing && loopBack",
      dashed: true,
      fromStateId: "finalizingTurn",
      toStateId: "debug.hypothesizing",
      labelOffset: { x: 0, y: -10 },
    },

    // finalizingTurn → debug.awaitingReproduction
    {
      id: "finalizing-awRepro",
      from: { x: finalizing.x + finalizing.width, y: finalizing.y + 24 },
      to: leftAnchor(awRepro),
      routing: "curve",
      bow: "v",
      control: { x: (finalizing.x + finalizing.width + awRepro.x) / 2, y: 350 },
      label: "always",
      guard: "isDebugHypothesizing · awaitingRepro",
      dashed: true,
      fromStateId: "finalizingTurn",
      toStateId: "debug.awaitingReproduction",
      labelOffset: { x: -20, y: 0 },
    },

    // finalizingTurn → debug.awaitingVerification (analysis applied a fix)
    {
      id: "finalizing-awVerify",
      from: { x: finalizing.x + finalizing.width, y: finalizing.y + 52 },
      to: leftAnchor(awVerify),
      routing: "curve",
      bow: "v",
      control: {
        x: (finalizing.x + finalizing.width + awVerify.x) / 2,
        y: 620,
      },
      label: "always",
      guard: "isDebugAnalyzing · fixApplied",
      dashed: true,
      fromStateId: "finalizingTurn",
      toStateId: "debug.awaitingVerification",
      labelOffset: { x: -20, y: 0 },
    },
  ];

  return (
    <MachineCanvas
      width={1080}
      height={1040}
      edges={edges}
      selectedStateId={selectedStateId}
    >
      <InitialMarker x={idle.x + idle.width / 2} y={30} />
      <StateNode
        id="idle"
        label="idle"
        kind="atomic"
        status="initial"
        x={idle.x}
        y={idle.y}
        width={idle.width}
        height={idle.height}
        selected={selectedStateId === "idle"}
        onClick={onSelectState}
      />
      <StateNode
        id="externalExecuting"
        label="externalExecuting"
        kind="atomic"
        status="warning"
        x={external.x}
        y={external.y}
        width={external.width}
        height={external.height}
        selected={selectedStateId === "externalExecuting"}
        onClick={onSelectState}
      />
      <StateNode
        id="acquiringResources"
        label="acquiringResources"
        kind="atomic"
        x={acquiring.x}
        y={acquiring.y}
        width={acquiring.width}
        height={acquiring.height}
        invokes={["prepareTurn"]}
        selected={selectedStateId === "acquiringResources"}
        onClick={onSelectState}
      />
      <CompoundGroup
        x={executingGroup.x}
        y={executingGroup.y}
        width={executingGroup.width}
        height={executingGroup.height}
        label="executing"
        hint="compound · branches on activeTurn.kind"
        stateId="executing"
        onClickHeader={onSelectState}
        selected={selectedStateId === "executing"}
      >
        <StateNode
          id="executing.conversationTurn"
          label="conversationTurn"
          kind="atomic"
          status="initial"
          x={convTurn.x}
          y={convTurn.y}
          width={convTurn.width}
          height={convTurn.height}
          invokes={["executePrompt"]}
          selected={selectedStateId === "executing.conversationTurn"}
          onClick={onSelectState}
        />
        <StateNode
          id="executing.taskRun"
          label="taskRun"
          kind="atomic"
          x={taskRun.x}
          y={taskRun.y}
          width={taskRun.width}
          height={taskRun.height}
          invokes={["runTaskRun"]}
          selected={selectedStateId === "executing.taskRun"}
          onClick={onSelectState}
        />
      </CompoundGroup>
      <StateNode
        id="finalizingTurn"
        label="finalizingTurn"
        kind="transient"
        x={finalizing.x}
        y={finalizing.y}
        width={finalizing.width}
        height={finalizing.height}
        selected={selectedStateId === "finalizingTurn"}
        onClick={onSelectState}
      />
      <StateNode
        id="waitingForInput"
        label="waitingForInput"
        kind="atomic"
        status="warning"
        x={waiting.x}
        y={waiting.y}
        width={waiting.width}
        height={waiting.height}
        selected={selectedStateId === "waitingForInput"}
        onClick={onSelectState}
      />
      <CompoundGroup
        x={debugGroup.x}
        y={debugGroup.y}
        width={debugGroup.width}
        height={debugGroup.height}
        label="debug"
        hint="compound · 6-phase workflow"
        status="warning"
        stateId="debug"
        onClickHeader={onSelectState}
        selected={selectedStateId === "debug"}
      >
        <StateNode
          id="debug.hypothesizing"
          label="hypothesizing"
          kind="atomic"
          status="initial"
          x={hyp.x}
          y={hyp.y}
          width={hyp.width}
          height={hyp.height}
          selected={selectedStateId === "debug.hypothesizing"}
          onClick={onSelectState}
        />
        <StateNode
          id="debug.awaitingReproduction"
          label="awaitingReproduction"
          kind="atomic"
          status="warning"
          x={awRepro.x}
          y={awRepro.y}
          width={awRepro.width}
          height={awRepro.height}
          selected={selectedStateId === "debug.awaitingReproduction"}
          onClick={onSelectState}
        />
        <StateNode
          id="debug.analyzingEvidence"
          label="analyzingEvidence"
          kind="atomic"
          x={analyzing.x}
          y={analyzing.y}
          width={analyzing.width}
          height={analyzing.height}
          selected={selectedStateId === "debug.analyzingEvidence"}
          onClick={onSelectState}
        />
        <StateNode
          id="debug.awaitingVerification"
          label="awaitingVerification"
          kind="atomic"
          status="warning"
          x={awVerify.x}
          y={awVerify.y}
          width={awVerify.width}
          height={awVerify.height}
          selected={selectedStateId === "debug.awaitingVerification"}
          onClick={onSelectState}
        />
        <StateNode
          id="debug.cleanupInstrumentation"
          label="cleanupInstrumentation"
          kind="atomic"
          status="success"
          x={cleanup.x}
          y={cleanup.y}
          width={cleanup.width}
          height={cleanup.height}
          selected={selectedStateId === "debug.cleanupInstrumentation"}
          onClick={onSelectState}
        />
      </CompoundGroup>
    </MachineCanvas>
  );
}
