import type {
  GraphWorkflowCommandSelector,
  GraphWorkflowLaneMergeCommandSelector,
} from "./config-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "./definition-schemas";
import {
  validationCostExceedsLimit,
  type ValidationCommandPreflight,
} from "@/lib/validation/preflight";
import { expandCommandSelector } from "./resolve-config";

// Command selections must fail at the earliest project-bound boundary when a
// name is unknown or its configured cost exceeds the global limit. This module
// is the one selector walker every boundary shares, including path attribution
// for explicit entries and implicit mode:"all" expansion.
export const UNKNOWN_VALIDATION_COMMAND_CODE = "unknown-validation-command";
export const ENVELOPED_SCRIPT_VALIDATION_NOT_COVERED_CODE =
  "enveloped-script-validation-not-covered";

interface NamedEntry {
  name: string;
  field: string;
}

function listEntries(
  names: readonly string[] | undefined,
  prefix: string,
): NamedEntry[] {
  return (names ?? []).map((name, index) => ({
    name,
    field: `${prefix}.${index}`,
  }));
}

// `{mode:"project"}` (lane merge) carries no names — it resolves against
// current project config at merge submission, so there is nothing to preflight.
function selectorEntries(
  selector:
    | GraphWorkflowCommandSelector
    | GraphWorkflowLaneMergeCommandSelector
    | undefined,
  prefix: string,
): NamedEntry[] {
  if (!selector) return [];
  if (selector.mode === "only") {
    return listEntries(selector.commands, `${prefix}.commands`);
  }
  if (selector.mode === "all") {
    return listEntries(selector.except, `${prefix}.except`);
  }
  return [];
}

function selectedSelectorEntries(
  selector:
    | GraphWorkflowCommandSelector
    | GraphWorkflowLaneMergeCommandSelector
    | undefined,
  prefix: string,
  registeredNames: readonly string[],
  frozenNames?: readonly string[],
): NamedEntry[] {
  if (!selector || selector.mode === "project") return [];
  if (selector.mode === "only") {
    return listEntries(frozenNames ?? selector.commands, `${prefix}.commands`);
  }
  const selectedNames =
    frozenNames ??
    registeredNames.filter((name) => !selector.except.includes(name));
  return selectedNames.map((name) => ({
    name,
    field: `${prefix}.mode`,
  }));
}

function contextEntries(
  context: Pick<
    GraphWorkflowExecutionContextDefinition,
    "scriptValidator" | "agentValidation"
  >,
  prefix: string,
): NamedEntry[] {
  return [
    ...listEntries(
      context.scriptValidator?.commands,
      `${prefix}.scriptValidator.commands`,
    ),
    ...selectorEntries(
      context.agentValidation?.implementer,
      `${prefix}.agentValidation.implementer`,
    ),
    ...selectorEntries(
      context.agentValidation?.contextValidator,
      `${prefix}.agentValidation.contextValidator`,
    ),
  ];
}

function toIssues(
  entries: NamedEntry[],
  registeredNames: readonly string[],
  contextId?: string,
): WorkflowGraphValidationError[] {
  const known = new Set(registeredNames);
  const registered =
    registeredNames.length > 0 ? registeredNames.join(", ") : "(none)";
  return entries
    .filter((entry) => !known.has(entry.name))
    .map((entry) => ({
      code: UNKNOWN_VALIDATION_COMMAND_CODE,
      message: `Unknown validation command "${entry.name}"; registered commands: ${registered}`,
      field: entry.field,
      ...(contextId !== undefined ? { contextId } : {}),
    }));
}

function toCostIssues(
  entries: NamedEntry[],
  preflight: ValidationCommandPreflight,
  contextId?: string,
): WorkflowGraphValidationError[] {
  return entries.flatMap((entry) => {
    const rejection = validationCostExceedsLimit(entry.name, preflight);
    if (!rejection) return [];
    return [
      {
        code: rejection.code,
        message: rejection.message,
        field: entry.field,
        ...(contextId !== undefined ? { contextId } : {}),
      },
    ];
  });
}

function laneMergeBarrierCommands(
  selector: GraphWorkflowLaneMergeCommandSelector,
  preflight: ValidationCommandPreflight,
): readonly string[] {
  return selector.mode === "only"
    ? selector.commands
    : (preflight.laneMergeCommands ?? []);
}

export function collectEnvelopedScriptCoverageIssues(input: {
  context: Pick<GraphWorkflowExecutionContextDefinition, "id" | "placement">;
  commands: readonly string[];
  commandField: string;
  barrierCommands: readonly string[];
}): WorkflowGraphValidationError[] {
  if (input.context.placement.mode === "full") return [];
  if (input.commands.length === 0) return [];

  const barrier = new Set(input.barrierCommands);
  return input.commands.flatMap((command, index) => {
    if (barrier.has(command)) return [];
    return [
      {
        code: ENVELOPED_SCRIPT_VALIDATION_NOT_COVERED_CODE,
        message: `Enveloped context "${input.context.id}" selects script-validator command "${command}", but that command is absent from the lane-merge barrier. Make the context's script-validator selection empty or add the command to laneMergeValidation.`,
        contextId: input.context.id,
        field: `${input.commandField}.${index}`,
      },
    ];
  });
}

function collectAuthoredEnvelopedScriptCoverageIssues(
  definition: Pick<
    WorkflowSemanticDefinition,
    "workflowConfig" | "executionContexts"
  >,
  preflight: ValidationCommandPreflight,
): WorkflowGraphValidationError[] {
  const workflowConfig = definition.workflowConfig;
  const barrierSelector = workflowConfig?.laneMergeValidation?.commands;
  if (!barrierSelector || barrierSelector.mode !== "project") {
    // Explicit command sets are project-independent and belong to the shared
    // structural definition validator. An absent selector is global-cascade
    // state and is checked after resolution at execution start.
    return [];
  }
  const barrierCommands = laneMergeBarrierCommands(barrierSelector, preflight);

  return definition.executionContexts.flatMap((context, index) => {
    const contextCommands = context.scriptValidator?.commands;
    const workflowCommands = workflowConfig.scriptValidator?.commands;
    const commands = contextCommands ?? workflowCommands;
    if (commands === undefined) {
      // As above, the unresolved global script selection is checked after the
      // config cascade at execution start.
      return [];
    }
    const commandField =
      contextCommands !== undefined
        ? `executionContexts.${index}.scriptValidator.commands`
        : "workflowConfig.scriptValidator.commands";
    return collectEnvelopedScriptCoverageIssues({
      context,
      commands,
      commandField,
      barrierCommands,
    });
  });
}

function authoredSelectedEntries(
  definition: Pick<
    WorkflowSemanticDefinition,
    "workflowConfig" | "executionContexts"
  >,
  registeredNames: readonly string[],
): Array<{ entries: NamedEntry[]; contextId?: string }> {
  const config = definition.workflowConfig ?? {};
  const groups: Array<{ entries: NamedEntry[]; contextId?: string }> = [
    {
      entries: [
        ...listEntries(
          config.scriptValidator?.commands,
          "workflowConfig.scriptValidator.commands",
        ),
        ...selectedSelectorEntries(
          config.agentValidation?.implementer,
          "workflowConfig.agentValidation.implementer",
          registeredNames,
        ),
        ...selectedSelectorEntries(
          config.agentValidation?.contextValidator,
          "workflowConfig.agentValidation.contextValidator",
          registeredNames,
        ),
        ...selectedSelectorEntries(
          config.laneMergeValidation?.commands,
          "workflowConfig.laneMergeValidation.commands",
          registeredNames,
        ),
      ],
    },
  ];

  definition.executionContexts.forEach((context, index) => {
    const prefix = `executionContexts.${index}`;
    groups.push({
      contextId: context.id,
      entries: [
        ...listEntries(
          context.scriptValidator?.commands,
          `${prefix}.scriptValidator.commands`,
        ),
        ...selectedSelectorEntries(
          context.agentValidation?.implementer,
          `${prefix}.agentValidation.implementer`,
          registeredNames,
        ),
        ...selectedSelectorEntries(
          context.agentValidation?.contextValidator,
          `${prefix}.agentValidation.contextValidator`,
          registeredNames,
        ),
      ],
    });
  });
  return groups;
}

/**
 * Preflight an AUTHORED definition's command selections against a project's
 * validation registry. Covers every selector surface: the workflow-tier
 * script gate, both agent-validation role selectors, the (workflow-only)
 * lane-merge selection, and each context's overrides. Field paths are
 * definition-relative (`workflowConfig.…` / `executionContexts.<index>.…`) so
 * the plan-validation issue mapper roots them at `definition.…` and annotates
 * each indexed segment with the record's id.
 */
export function collectUnknownValidationCommandIssues(
  definition: Pick<
    WorkflowSemanticDefinition,
    "workflowConfig" | "executionContexts"
  >,
  registeredNames: readonly string[],
): WorkflowGraphValidationError[] {
  const config = definition.workflowConfig ?? {};
  const issues = toIssues(
    [
      ...listEntries(
        config.scriptValidator?.commands,
        "workflowConfig.scriptValidator.commands",
      ),
      ...selectorEntries(
        config.agentValidation?.implementer,
        "workflowConfig.agentValidation.implementer",
      ),
      ...selectorEntries(
        config.agentValidation?.contextValidator,
        "workflowConfig.agentValidation.contextValidator",
      ),
      ...selectorEntries(
        config.laneMergeValidation?.commands,
        "workflowConfig.laneMergeValidation.commands",
      ),
    ],
    registeredNames,
  );

  definition.executionContexts.forEach((context, index) => {
    issues.push(
      ...toIssues(
        contextEntries(context, `executionContexts.${index}`),
        registeredNames,
        context.id,
      ),
    );
  });

  return issues;
}

export function collectValidationCommandIssues(
  definition: Pick<
    WorkflowSemanticDefinition,
    "workflowConfig" | "executionContexts"
  >,
  preflight: ValidationCommandPreflight,
): WorkflowGraphValidationError[] {
  const registeredNames = Object.keys(preflight.commandCosts);
  return [
    ...collectUnknownValidationCommandIssues(definition, registeredNames),
    ...authoredSelectedEntries(definition, registeredNames).flatMap((group) =>
      toCostIssues(group.entries, preflight, group.contextId),
    ),
    ...collectAuthoredEnvelopedScriptCoverageIssues(definition, preflight),
  ];
}

/**
 * The live-edit counterpart: validate one RESOLVED context's selections (the
 * shape a live `update-context`/`add-context` op writes). Paths are qualified
 * by the context's stable id — the live tier addresses entities by id, never
 * by array position.
 */
export function collectUnknownCommandIssuesForResolvedContext(
  context: GraphWorkflowResolvedContext,
  registeredNames: readonly string[],
): WorkflowGraphValidationError[] {
  const prefix = `executionContexts.${context.id}`;
  return toIssues(
    [
      ...listEntries(
        context.scriptValidator.commands,
        `${prefix}.scriptValidator.commands`,
      ),
      ...selectorEntries(
        context.agentValidation?.implementer.value,
        `${prefix}.agentValidation.implementer.value`,
      ),
      ...selectorEntries(
        context.agentValidation?.contextValidator.value,
        `${prefix}.agentValidation.contextValidator.value`,
      ),
    ],
    registeredNames,
    context.id,
  );
}

export function collectValidationCommandIssuesForResolvedContext(
  context: GraphWorkflowResolvedContext,
  preflight: ValidationCommandPreflight,
  laneMergeSelector?: GraphWorkflowLaneMergeCommandSelector,
): WorkflowGraphValidationError[] {
  const registeredNames = Object.keys(preflight.commandCosts);
  const prefix = `executionContexts.${context.id}`;
  const costEntries = [
    ...listEntries(
      context.scriptValidator.commands,
      `${prefix}.scriptValidator.commands`,
    ),
    ...selectedSelectorEntries(
      context.agentValidation?.implementer.value,
      `${prefix}.agentValidation.implementer.value`,
      registeredNames,
      context.agentValidation?.implementer.commands,
    ),
    ...selectedSelectorEntries(
      context.agentValidation?.contextValidator.value,
      `${prefix}.agentValidation.contextValidator.value`,
      registeredNames,
      context.agentValidation?.contextValidator.commands,
    ),
  ];
  return [
    ...collectUnknownCommandIssuesForResolvedContext(context, registeredNames),
    ...toCostIssues(costEntries, preflight, context.id),
    ...(laneMergeSelector?.mode === "project"
      ? collectEnvelopedScriptCoverageIssues({
          context,
          commands: context.scriptValidator.commands,
          commandField: `${prefix}.scriptValidator.commands`,
          barrierCommands: laneMergeBarrierCommands(
            laneMergeSelector,
            preflight,
          ),
        })
      : []),
  ];
}

/**
 * Validate the workflow-scope lane-merge selection (the shape both the
 * resolved-definition snapshot and the live `update-lane-merge-validation` op
 * carry). `{mode:"project"}` names nothing and resolves at merge submission,
 * so only `{mode:"only"}` lists are preflighted.
 */
export function collectUnknownLaneMergeCommandIssues(
  selector: GraphWorkflowLaneMergeCommandSelector | undefined,
  registeredNames: readonly string[],
): WorkflowGraphValidationError[] {
  return toIssues(
    selectorEntries(selector, "laneMergeValidation.commands"),
    registeredNames,
  );
}

export function collectLaneMergeValidationCommandIssues(
  selector: GraphWorkflowLaneMergeCommandSelector | undefined,
  preflight: ValidationCommandPreflight,
): WorkflowGraphValidationError[] {
  const registeredNames = Object.keys(preflight.commandCosts);
  return [
    ...collectUnknownLaneMergeCommandIssues(selector, registeredNames),
    ...toCostIssues(
      selectedSelectorEntries(
        selector,
        "laneMergeValidation.commands",
        registeredNames,
      ),
      preflight,
    ),
  ];
}

export interface FreezeResolvedSelectionsResult {
  definition: ResolvedWorkflowSemanticDefinition;
  issues: WorkflowGraphValidationError[];
}

function freezeResolvedContextSelections(
  context: GraphWorkflowResolvedContext,
  registeredNames: readonly string[],
): GraphWorkflowResolvedContext {
  if (!context.agentValidation) return context;
  return {
    ...context,
    agentValidation: {
      implementer: {
        ...context.agentValidation.implementer,
        commands: expandCommandSelector(
          context.agentValidation.implementer.value,
          registeredNames,
        ).commands,
      },
      contextValidator: {
        ...context.agentValidation.contextValidator,
        commands: expandCommandSelector(
          context.agentValidation.contextValidator.value,
          registeredNames,
        ).commands,
      },
    },
  };
}

/**
 * Seed-time freeze (design §6): expand every resolved role selector to an
 * explicit command-name snapshot against the project registry, and validate
 * ALL resolved selections — including ones inherited from global defaults,
 * which the authored-definition preflight structurally cannot see. Start is
 * the last project-bound boundary, so unknown or oversized selections must
 * fail here, never during execution. Pure: returns a new definition, never
 * mutates the input.
 */
export function freezeResolvedDefinitionSelections(
  definition: ResolvedWorkflowSemanticDefinition,
  preflight: ValidationCommandPreflight,
): FreezeResolvedSelectionsResult {
  const registeredNames = Object.keys(preflight.commandCosts);
  const issues: WorkflowGraphValidationError[] = [
    ...collectLaneMergeValidationCommandIssues(
      definition.laneMergeValidation?.commands,
      preflight,
    ),
  ];

  const executionContexts = definition.executionContexts.map((context) => {
    issues.push(
      ...collectValidationCommandIssuesForResolvedContext(
        context,
        preflight,
        definition.laneMergeValidation.commands,
      ),
    );
    return freezeResolvedContextSelections(context, registeredNames);
  });
  const loopGroups = definition.loopGroups?.map((group) => ({
    ...group,
    template: {
      ...group.template,
      contexts: group.template.contexts.map((context) =>
        freezeResolvedContextSelections(context, registeredNames),
      ),
    },
  }));

  return {
    definition: {
      ...definition,
      executionContexts,
      ...(loopGroups === undefined ? {} : { loopGroups }),
    },
    issues,
  };
}
