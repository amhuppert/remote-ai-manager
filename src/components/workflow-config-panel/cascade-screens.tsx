"use client";

import {
  AgentsGroupScreen,
  CollaborationScreen,
  COLLABORATION_SCREEN_ID,
  ImplementerScreen,
  IMPLEMENTER_SCREEN_ID,
} from "./AgentsScreens";
import type { ConfigCascadeEditor } from "./cascade-editor";
import {
  AgentValidationScreen,
  LaneMergeValidationScreen,
  ScriptValidatorScreen,
} from "./CommandGateScreens";
import { overrideCountLabel, type ConfigPath } from "./config-cascade";
import {
  AGENT_VALIDATION_PATHS,
  AGENT_VALIDATION_SCREEN_ID,
  LANE_MERGE_PATHS,
  LANE_MERGE_SCREEN_ID,
  QualityGatesScreen,
  SCRIPT_SCREEN_ID,
  VALIDATOR_SCREEN_ID,
  ValidatorCohortScreen,
  ValidatorSeatScreen,
} from "./GatesScreens";
import { SEAT_SCREEN_PREFIX } from "./navigation-ids";
import {
  ExecutionPolicyScreen,
  PLAN_REPAIR_SCREEN_ID,
  PlanRepairScreen,
} from "./PolicyScreens";
import type { ConfigScreenDefinition } from "./screen-registry";

/**
 * The cascading screens both hosts register: what a context is run BY, and
 * under which gates and policy.
 *
 * Handed to `createConfigScreenRegistry` alongside the structural screens
 * rather than composed into a registry here — a host mounts one panel over both
 * families, and only the host knows which cascade it is editing.
 */

/** A screen badges only the paths it opens, so its count is its own. */
function badge(
  editor: ConfigCascadeEditor,
  paths: readonly ConfigPath[],
): string | null {
  const counts = editor.cascade.counts(paths);
  return counts.block + counts.role + counts.field > 0
    ? overrideCountLabel(counts)
    : null;
}

const COLLABORATION_PATHS: readonly ConfigPath[] = [
  "collaboration.enabled",
  "collaboration.secondAgent",
  "collaboration.negotiationRounds",
  "collaboration.autonomousResolutionThreshold",
];

const AGENT_PATHS: readonly ConfigPath[] = [
  "implementer",
  ...COLLABORATION_PATHS,
];

const POLICY_PATHS: readonly ConfigPath[] = [
  "iterationPolicy",
  "circuitBreaker",
  "planRepair",
  "mutability",
];

const CONTEXT_GATE_PATHS: readonly ConfigPath[] = [
  "contextValidator",
  "scriptValidator",
  ...AGENT_VALIDATION_PATHS,
  "humanApprovalGate",
  "askUserQuestions",
];

export function cascadeScreens(
  editor: ConfigCascadeEditor,
): ConfigScreenDefinition[] {
  // The lane-merge gate has no context tier at all, so a context scope must not
  // be able to REACH its screen — not merely lack the row that opens it.
  const laneMergeScreens: ConfigScreenDefinition[] =
    editor.cascade.scope === "workflow"
      ? [
          {
            id: LANE_MERGE_SCREEN_ID,
            title: "Lane-merge validation",
            overrideLabel: badge(editor, LANE_MERGE_PATHS),
            render: () => <LaneMergeValidationScreen editor={editor} />,
          },
        ]
      : [];

  return [
    {
      id: "agents",
      title: "Agents",
      overrideLabel: badge(editor, AGENT_PATHS),
      render: ({ navigate }) => (
        <AgentsGroupScreen editor={editor} onOpen={navigate} />
      ),
    },
    {
      id: IMPLEMENTER_SCREEN_ID,
      title: "Implementer",
      overrideLabel: badge(editor, ["implementer"]),
      render: () => <ImplementerScreen editor={editor} />,
    },
    {
      id: COLLABORATION_SCREEN_ID,
      title: "Collaboration",
      overrideLabel: badge(editor, COLLABORATION_PATHS),
      render: () => <CollaborationScreen editor={editor} />,
    },
    {
      id: "gates",
      title: "Quality gates",
      overrideLabel: badge(editor, [
        ...CONTEXT_GATE_PATHS,
        // A context has no lane-merge tier, so its cascade lists neither path
        // and counting them here adds nothing.
        ...LANE_MERGE_PATHS,
      ]),
      render: ({ navigate }) => (
        <QualityGatesScreen editor={editor} onOpen={navigate} />
      ),
    },
    {
      id: VALIDATOR_SCREEN_ID,
      title: "Validator cohort",
      overrideLabel: badge(editor, ["contextValidator"]),
      render: ({ navigate }) => (
        <ValidatorCohortScreen editor={editor} onOpen={navigate} />
      ),
    },
    {
      // Parametric: the segment after `seat:` is the assignment id, which is
      // also the seat's title — it is the identity a verdict cites.
      id: SEAT_SCREEN_PREFIX,
      title: (seatId) => seatId,
      overrideLabel: badge(editor, ["contextValidator"]),
      render: ({ param }) => (
        <ValidatorSeatScreen editor={editor} seatId={param} />
      ),
    },
    {
      id: SCRIPT_SCREEN_ID,
      title: "Script validator",
      overrideLabel: badge(editor, ["scriptValidator"]),
      render: () => <ScriptValidatorScreen editor={editor} />,
    },
    {
      id: AGENT_VALIDATION_SCREEN_ID,
      title: "Agent validation",
      overrideLabel: badge(editor, AGENT_VALIDATION_PATHS),
      render: () => <AgentValidationScreen editor={editor} />,
    },
    ...laneMergeScreens,
    {
      id: "policy",
      title: "Execution policy",
      overrideLabel: badge(editor, POLICY_PATHS),
      render: ({ navigate }) => (
        <ExecutionPolicyScreen editor={editor} onOpen={navigate} />
      ),
    },
    {
      id: PLAN_REPAIR_SCREEN_ID,
      title: "Plan repair",
      overrideLabel: badge(editor, ["planRepair"]),
      render: () => <PlanRepairScreen editor={editor} />,
    },
  ];
}
