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

/**
 * Conversation — three logical zones:
 *   • Spine (left): idle → acquiringResources → executing → finalizingTurn
 *     → waitingForInput (when a registered question survives the turn)
 *   • externalExecuting branches off idle to the right of the spine
 *   • debug (right): the attached debug workflow's flat parking state —
 *     the 6-phase progression lives in context.debugMode, driven by
 *     DEBUG_COMMAND events
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

  // debug parking state (right column)
  const debug = box(680, 360, SPINE_W + 40, NODE_H + 40);

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
      from: { x: idle.x + idle.width, y: idle.y + 60 },
      to: topAnchor(debug),
      routing: "curve",
      bow: "v",
      label: "DEBUG_COMMAND · enter",
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

    // debug → idle (exit command / passed cleanup verification clears
    // debugMode; the always-transition settles back to idle)
    {
      id: "debug-idle-exit",
      from: { x: debug.x + 60, y: debug.y },
      to: rightAnchor(idle),
      routing: "curve",
      bow: "v",
      control: { x: (debug.x + idle.x + idle.width) / 2, y: 120 },
      label: "always · !debugMode.active",
      fromStateId: "debug",
      toStateId: "idle",
      labelOffset: { x: 0, y: -48 },
    },

    // debug → acquiringResources (next debug turn, or retry of the
    // preserved failed turn)
    {
      id: "debug-acquiring-submit",
      from: leftAnchor(debug),
      to: {
        x: acquiring.x + acquiring.width,
        y: acquiring.y + acquiring.height - 18,
      },
      routing: "curve",
      bow: "v",
      control: {
        x: (debug.x + acquiring.x + acquiring.width) / 2,
        y: 480,
      },
      label: "SUBMIT_PROMPT / retry_turn",
      fromStateId: "debug",
      toStateId: "acquiringResources",
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

    // finalizingTurn → idle (default)
    {
      id: "finalizing-idle",
      from: leftAnchor(finalizing),
      to: { x: idle.x, y: idle.y + idle.height - 20 },
      routing: "curve",
      bow: "h",
      control: { x: 20, y: (finalizing.y + idle.y) / 2 },
      label: "always",
      guard: "default",
      dashed: true,
      fromStateId: "finalizingTurn",
      toStateId: "idle",
      labelOffset: { x: 90, y: 30 },
    },

    // finalizingTurn → debug (debug workflow interprets the turn outcome)
    {
      id: "finalizing-debug",
      from: { x: finalizing.x + finalizing.width, y: finalizing.y + 24 },
      to: bottomAnchor(debug),
      routing: "curve",
      bow: "v",
      control: {
        x: (finalizing.x + finalizing.width + debug.x) / 2,
        y: 700,
      },
      label: "always",
      guard: "debugMode.active",
      dashed: true,
      fromStateId: "finalizingTurn",
      toStateId: "debug",
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
      <StateNode
        id="debug"
        label="debug"
        kind="atomic"
        status="warning"
        x={debug.x}
        y={debug.y}
        width={debug.width}
        height={debug.height}
        selected={selectedStateId === "debug"}
        onClick={onSelectState}
      />
    </MachineCanvas>
  );
}
