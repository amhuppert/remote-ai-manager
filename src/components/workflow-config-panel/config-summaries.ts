import { lintOutputSchemaText } from "@/components/workflow-config/OutputSchemaField";
import { getModelsForBackend } from "@/lib/agent-backends/catalog";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { GraphWorkflowAgentConfig } from "@/lib/workflow-graph/config-schemas";
import {
  CONFIG_PATH_GRANULARITY,
  type ConfigCascade,
  type ConfigPath,
  type ConfigPathValues,
} from "./config-cascade";
import {
  chipPart,
  dotPart,
  textPart,
  valuePart,
  backendChipTone,
  type ConfigValuePart,
} from "./value-parts";

/**
 * The one-line summary each config block collapses to, shared by the root
 * cards and the drill rows that open the same block (Config Panel `parts()`).
 * Every number here is read off the resolved value or the parsed schema text;
 * nothing is restated as a literal.
 */

export type ConfigSummaryBlock =
  | "implementer"
  | "collaboration"
  | "contextValidator"
  | "scriptValidator"
  | "agentValidation"
  | "laneMergeValidation"
  | "humanApprovalGate"
  | "askUserQuestions"
  | "iterationPolicy"
  | "circuitBreaker"
  | "planRepair"
  | "mutability";

export interface OutputSchemaCounts {
  fields: number;
  required: number;
}

/**
 * Selectors hold the short model id; everything the reader sees is the
 * catalog's canonical long name, so the panel, the node and the transcript can
 * never disagree about which model a block names.
 */
export function modelDisplayName(
  backend: AgentBackendId,
  model: string,
): string {
  const listed = getModelsForBackend(backend).find(
    (option) => option.id === model,
  );
  return listed?.label ?? model;
}

/**
 * The chip a runtime collapses to: the canonical model name in the backend's
 * own identity colour. Shared with the roster, whose seats show the same chip
 * their block's summary line does.
 */
export function agentModelChip(
  agent: GraphWorkflowAgentConfig,
): ConfigValuePart {
  return chipPart(
    modelDisplayName(agent.backend, agent.model),
    backendChipTone(agent.backend),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field and required counts read off the parsed document `lintOutputSchemaText`
 * exposes — the module that owns what an acceptable output schema is. Text that
 * is empty or not accepted has no counts to show, so the caller renders the
 * lint's own refusal instead.
 */
export function outputSchemaCounts(text: string): OutputSchemaCounts | null {
  const lint = lintOutputSchemaText(text);
  if (lint.stage !== "ok" || lint.schema === null) return null;
  const properties = lint.schema.properties;
  const required = lint.schema.required;
  return {
    fields: isRecord(properties) ? Object.keys(properties).length : 0,
    required: Array.isArray(required) ? required.length : 0,
  };
}

function selectorSummary(
  selector: ConfigPathValues["agentValidation.implementer"],
): string {
  if (selector.mode === "all") {
    return selector.except.length > 0
      ? `all except ${selector.except.length}`
      : "all";
  }
  return selector.commands.length > 0
    ? `only ${selector.commands.length}`
    : "none";
}

/** `1200` reads as `1k`; an unset limit reads as the runtime's own `auto`. */
export function tokenCount(value: number | undefined): string {
  if (value === undefined) return "auto";
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

export function blockSummaryParts(
  cascade: ConfigCascade,
  block: ConfigSummaryBlock,
): readonly ConfigValuePart[] {
  switch (block) {
    case "implementer": {
      const value = cascade.resolve("implementer").value;
      return [
        agentModelChip(value.agent),
        textPart(value.agent.reasoningEffort),
        textPart(value.profile.id, "dim"),
      ];
    }
    case "collaboration": {
      if (!cascade.resolve("collaboration.enabled").value) {
        return [textPart("off", "dim")];
      }
      return [
        chipPart("on", "green"),
        agentModelChip(cascade.resolve("collaboration.secondAgent").value),
        textPart(
          `${cascade.resolve("collaboration.negotiationRounds").value} rounds`,
        ),
        textPart(
          cascade.resolve("collaboration.autonomousResolutionThreshold").value,
          "dim",
        ),
      ];
    }
    case "contextValidator": {
      const cohort = cascade.resolve("contextValidator").value;
      if (!cohort.enabled) {
        return [
          chipPart("disabled", "red"),
          textPart(
            `${cohort.assignments.length} seat${cohort.assignments.length === 1 ? "" : "s"} kept`,
            "dim",
          ),
        ];
      }
      return cohort.assignments.map((assignment) =>
        chipPart(
          assignment.id,
          assignment.authority === "blocking" ? "amber" : "neutral",
        ),
      );
    }
    case "scriptValidator": {
      const commands = cascade.resolve("scriptValidator").value.commands;
      return commands.length > 0
        ? commands.map((command) => chipPart(command))
        : [textPart("off — empty selection", "dim")];
    }
    case "agentValidation":
      return [
        textPart("impl", "dim"),
        chipPart(
          selectorSummary(cascade.resolve("agentValidation.implementer").value),
        ),
        textPart("val", "dim"),
        chipPart(
          selectorSummary(
            cascade.resolve("agentValidation.contextValidator").value,
          ),
        ),
      ];
    case "laneMergeValidation": {
      const commands = cascade.resolve("laneMergeValidation.commands").value;
      return [
        chipPart(cascade.resolve("laneMergeValidation.strategy").value),
        commands.mode === "project"
          ? textPart("project default", "dim")
          : textPart(`${commands.commands.length} commands`),
      ];
    }
    case "humanApprovalGate":
      return cascade.resolve("humanApprovalGate").value.enabled
        ? [chipPart("parks before merge", "amber")]
        : [textPart("off", "dim")];
    case "askUserQuestions":
      return cascade.resolve("askUserQuestions").value.enabled
        ? [chipPart("on", "green")]
        : [textPart("off", "dim")];
    case "iterationPolicy": {
      const value = cascade.resolve("iterationPolicy").value;
      return [
        textPart("max", "dim"),
        valuePart(String(value.maxIterations)),
        value.continuity.enabled
          ? chipPart(
              `continuity ${tokenCount(value.continuity.contextLimitTokens)}`,
            )
          : textPart("no continuity", "dim"),
      ];
    }
    case "circuitBreaker":
      return [
        textPart("halt after", "dim"),
        valuePart(
          String(
            cascade.resolve("circuitBreaker").value.consecutiveFailureThreshold,
          ),
        ),
        textPart("fails", "dim"),
      ];
    case "planRepair": {
      const value = cascade.resolve("planRepair").value;
      return value.enabled
        ? [
            chipPart("on", "green"),
            valuePart(`${value.maxAttemptsPerContext}/ctx`),
          ]
        : [textPart("off", "dim")];
    }
    case "mutability": {
      const value = cascade.resolve("mutability").value;
      return [
        textPart("task add", "dim"),
        textPart(
          value.allowAgentTaskAdd ? "allowed" : "blocked",
          value.allowAgentTaskAdd ? "green" : "red",
        ),
      ];
    }
  }
}

const MARKER_NOUN = {
  block: ["block", "blocks"],
  role: ["role", "roles"],
  field: ["field", "fields"],
} as const;

/**
 * The cyan dot a collapsed summary wears when the block behind it is set at
 * the current tier, naming how many of what granularity — a partly-overridden
 * block reads `2 fields`, not `1 block`.
 */
export function setHereMarkers(
  cascade: ConfigCascade,
  block: ConfigSummaryBlock,
): readonly ConfigValuePart[] {
  const owned = cascade.paths.filter(
    (path: ConfigPath) =>
      (path === block || path.startsWith(`${block}.`)) && cascade.own(path),
  );
  const first = owned[0];
  if (first === undefined) return [];
  const [one, many] = MARKER_NOUN[CONFIG_PATH_GRANULARITY[first]];
  return [
    dotPart(
      `${owned.length} ${owned.length === 1 ? one : many} set on this ${cascade.scope}`,
    ),
  ];
}
