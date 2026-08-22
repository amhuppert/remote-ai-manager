import type {
  ContextPlacement,
  GraphWorkflowExecutionContextDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  overrideCountLabel,
  type ConfigCascade,
  type ConfigPath,
} from "./config-cascade";
import {
  blockSummaryParts,
  outputSchemaCounts,
  setHereMarkers,
  type ConfigSummaryBlock,
} from "./config-summaries";
import type { ConfigRootCard, ConfigSummaryLine } from "./ConfigRootCardList";
import {
  chipPart,
  textPart,
  valuePart,
  type ConfigValuePart,
} from "./value-parts";

/**
 * The root screen for each scope: one card per configuration group, its badge
 * counting only its own paths and its summary lines read off the resolved
 * configuration and the entity's own content.
 */

export interface ConfigParameterSummary {
  id: string;
  type: string;
  required: boolean;
  /** The declared default, or null when the parameter has none. */
  defaultValue: string | null;
}

export interface ContextRootCardsInput {
  cascade: ConfigCascade;
  context: GraphWorkflowExecutionContextDefinition;
  /** The authored schema text, linted for its field and required counts. */
  outputSchemaText: string;
  upstreamInputCount: number;
  taskCount: number;
  nextTaskTitle: string | null;
}

export interface WorkflowRootCardsInput {
  cascade: ConfigCascade;
  invariantCount: number;
  sourceCount: number;
  parameters: readonly ConfigParameterSummary[];
}

const AGENT_PATHS: readonly ConfigPath[] = [
  "implementer",
  "collaboration.enabled",
  "collaboration.secondAgent",
  "collaboration.negotiationRounds",
  "collaboration.autonomousResolutionThreshold",
];

const CONTEXT_GATE_PATHS: readonly ConfigPath[] = [
  "contextValidator",
  "scriptValidator",
  "agentValidation.implementer",
  "agentValidation.contextValidator",
  "humanApprovalGate",
  "askUserQuestions",
];

const WORKFLOW_GATE_PATHS: readonly ConfigPath[] = [
  ...CONTEXT_GATE_PATHS,
  "laneMergeValidation.strategy",
  "laneMergeValidation.commands",
];

const POLICY_PATHS: readonly ConfigPath[] = [
  "iterationPolicy",
  "circuitBreaker",
  "planRepair",
  "mutability",
];

const GRADE_CHIP: Record<ContextPlacement["mode"], ConfigValuePart> = {
  full: chipPart("full", "amber"),
  owned: chipPart("owning"),
  readOnly: chipPart("read-only"),
};

/** A card badges only the paths it opens, so its count is its own. */
function badgeFor(
  cascade: ConfigCascade,
  paths?: readonly ConfigPath[],
): string | null {
  if (paths === undefined) return null;
  const counts = cascade.counts(paths);
  return counts.block + counts.role + counts.field > 0
    ? overrideCountLabel(counts)
    : null;
}

function blockLine(
  cascade: ConfigCascade,
  key: string,
  block: ConfigSummaryBlock,
): ConfigSummaryLine {
  return {
    key,
    parts: [
      ...blockSummaryParts(cascade, block),
      ...setHereMarkers(cascade, block),
    ],
  };
}

function agentLines(cascade: ConfigCascade): ConfigSummaryLine[] {
  return [
    blockLine(cascade, "implementer", "implementer"),
    blockLine(cascade, "collaboration", "collaboration"),
  ];
}

function gateLines(
  cascade: ConfigCascade,
  includeLaneMerge: boolean,
): ConfigSummaryLine[] {
  const lines = [
    blockLine(cascade, "validator", "contextValidator"),
    blockLine(cascade, "script", "scriptValidator"),
    blockLine(cascade, "agent val", "agentValidation"),
  ];
  if (includeLaneMerge) {
    lines.push(blockLine(cascade, "lane merge", "laneMergeValidation"));
  }
  lines.push(
    blockLine(cascade, "approval", "humanApprovalGate"),
    blockLine(cascade, "questions", "askUserQuestions"),
  );
  return lines;
}

function policyLines(cascade: ConfigCascade): ConfigSummaryLine[] {
  return [
    blockLine(cascade, "iterations", "iterationPolicy"),
    blockLine(cascade, "breaker", "circuitBreaker"),
    blockLine(cascade, "plan repair", "planRepair"),
    blockLine(cascade, "mutability", "mutability"),
  ];
}

function schemaParts(text: string): ConfigValuePart[] {
  const counts = outputSchemaCounts(text);
  if (counts === null) return [textPart("—", "dim")];
  return [
    valuePart(String(counts.fields)),
    textPart("fields", "dim"),
    valuePart(String(counts.required)),
    textPart("required", "dim"),
  ];
}

function ownedPathParts(placement: ContextPlacement): ConfigValuePart[] {
  if (placement.mode !== "owned") return [textPart("—", "dim")];
  return placement.ownedPaths.map((path) => chipPart(path));
}

export function buildContextRootCards({
  cascade,
  context,
  outputSchemaText,
  upstreamInputCount,
  taskCount,
  nextTaskTitle,
}: ContextRootCardsInput): readonly ConfigRootCard[] {
  const criteriaCount = Array.isArray(context.acceptanceCriteria)
    ? context.acceptanceCriteria.length
    : 1;

  return [
    {
      screenId: "brief",
      title: "Brief",
      overrideLabel: null,
      lines: [
        { key: "title", parts: [valuePart(context.title)] },
        {
          key: "criteria",
          parts: [valuePart(String(criteriaCount)), textPart("ordered", "dim")],
        },
        { key: "schema", parts: schemaParts(outputSchemaText) },
        {
          key: "upstream",
          parts: [
            valuePart(String(upstreamInputCount)),
            textPart("inputs", "dim"),
          ],
        },
      ],
    },
    {
      screenId: "placement",
      title: "Placement",
      overrideLabel: null,
      lines: [
        { key: "lane", parts: [chipPart(context.placement.lane)] },
        { key: "grade", parts: [GRADE_CHIP[context.placement.mode]] },
        { key: "owned paths", parts: ownedPathParts(context.placement) },
      ],
    },
    {
      screenId: "agents",
      title: "Agents",
      overrideLabel: badgeFor(cascade, AGENT_PATHS),
      lines: agentLines(cascade),
    },
    {
      screenId: "gates",
      title: "Quality gates",
      overrideLabel: badgeFor(cascade, CONTEXT_GATE_PATHS),
      lines: gateLines(cascade, false),
    },
    {
      screenId: "policy",
      title: "Execution policy",
      overrideLabel: badgeFor(cascade, POLICY_PATHS),
      lines: policyLines(cascade),
    },
    {
      screenId: "tasks",
      title: "Tasks",
      overrideLabel: null,
      lines: [
        {
          key: "tasks",
          parts: [valuePart(String(taskCount)), textPart("ordered", "dim")],
        },
        {
          key: "next",
          parts: [
            nextTaskTitle === null
              ? textPart("—", "dim")
              : textPart(nextTaskTitle),
          ],
        },
      ],
    },
  ];
}

export function buildWorkflowRootCards({
  cascade,
  invariantCount,
  sourceCount,
  parameters,
}: WorkflowRootCardsInput): readonly ConfigRootCard[] {
  return [
    {
      screenId: "charter",
      title: "Charter",
      overrideLabel: null,
      lines: [
        {
          key: "invariants",
          parts: [
            valuePart(String(invariantCount)),
            textPart("declared", "dim"),
          ],
        },
        {
          key: "sources",
          parts: [valuePart(String(sourceCount)), textPart("ranked", "dim")],
        },
      ],
    },
    {
      screenId: "params",
      title: "Launch parameters",
      overrideLabel: null,
      lines: parameters.map((parameter) => ({
        key: parameter.id,
        parts: [
          chipPart(parameter.type),
          ...(parameter.required ? [chipPart("required", "amber")] : []),
          parameter.defaultValue === null
            ? textPart("—", "dim")
            : textPart(parameter.defaultValue),
        ],
      })),
    },
    {
      screenId: "agents",
      title: "Agents",
      overrideLabel: badgeFor(cascade, AGENT_PATHS),
      lines: agentLines(cascade),
    },
    {
      screenId: "gates",
      title: "Quality gates",
      overrideLabel: badgeFor(cascade, WORKFLOW_GATE_PATHS),
      lines: gateLines(cascade, true),
    },
    {
      screenId: "policy",
      title: "Execution policy",
      overrideLabel: badgeFor(cascade, POLICY_PATHS),
      lines: policyLines(cascade),
    },
  ];
}
