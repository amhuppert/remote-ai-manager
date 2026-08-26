import { z } from "zod";
import { getStaticBackendModelCatalog } from "../catalog";
import {
  ModelSelectionPolicyError,
  type ModelSelectionValidationIssue,
  validateModelSelection,
} from "../model-selection";
import {
  backendModelSelectionSchema,
  codexReasoningEffortSchema,
  type BackendModelSelection,
  type CodexReasoningEffort,
} from "../schemas";

const codexFastModeParameterSchema = z.enum(["false", "true"]);

export interface ResolvedCodexModelSelection {
  readonly modelSelection: BackendModelSelection;
  readonly modelId: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly fastMode: boolean;
}

function genericCustomSelectionIssues(
  selection: BackendModelSelection,
): ConstructorParameters<typeof ModelSelectionPolicyError>[0] {
  const issues: ModelSelectionValidationIssue[] = [];
  const parameterIds = new Set(Object.keys(selection.parameters));

  for (const parameterId of parameterIds) {
    if (parameterId === "reasoning" || parameterId === "fast") continue;
    issues.push({
      code: "unknown_parameter",
      modelId: selection.modelId,
      parameterId,
      message: `Parameter "${parameterId}" is not defined for model "${selection.modelId}".`,
    });
  }

  for (const parameterId of ["reasoning", "fast"] as const) {
    if (parameterIds.has(parameterId)) continue;
    issues.push({
      code: "missing_parameter",
      modelId: selection.modelId,
      parameterId,
      message: `Parameter "${parameterId}" is required for model "${selection.modelId}".`,
    });
  }

  const reasoning = selection.parameters.reasoning;
  if (
    reasoning !== undefined &&
    !codexReasoningEffortSchema.safeParse(reasoning).success
  ) {
    issues.push({
      code: "unsupported_value",
      modelId: selection.modelId,
      parameterId: "reasoning",
      message: `Value "${reasoning}" is not supported for parameter "reasoning" on model "${selection.modelId}".`,
    });
  }

  const fast = selection.parameters.fast;
  if (
    fast !== undefined &&
    !codexFastModeParameterSchema.safeParse(fast).success
  ) {
    issues.push({
      code: "unsupported_value",
      modelId: selection.modelId,
      parameterId: "fast",
      message: `Value "${fast}" is not supported for parameter "fast" on model "${selection.modelId}".`,
    });
  }

  return issues;
}

/** Validates a complete neutral selection and projects Codex SDK controls. */
export function resolveCodexModelSelection(
  selection: BackendModelSelection,
  configuredSelection?: BackendModelSelection,
): ResolvedCodexModelSelection {
  const catalog = getStaticBackendModelCatalog("codex", configuredSelection);
  const validation = validateModelSelection(catalog, selection);
  if (!validation.valid) {
    throw new ModelSelectionPolicyError(validation.issues);
  }

  return {
    modelSelection: validation.selection,
    modelId: validation.selection.modelId,
    reasoningEffort: codexReasoningEffortSchema.parse(
      validation.selection.parameters.reasoning,
    ),
    fastMode:
      codexFastModeParameterSchema.parse(
        validation.selection.parameters.fast,
      ) === "true",
  };
}

/** Projects an already-admitted selection into Codex SDK controls. */
export function projectAdmittedCodexModelSelection(
  selection: BackendModelSelection,
): ResolvedCodexModelSelection {
  const parsed = backendModelSelectionSchema.parse(selection);
  const staticCatalog = getStaticBackendModelCatalog("codex");
  const isKnownModel = staticCatalog.models.some(
    (model) =>
      model.id === parsed.modelId || model.aliases.includes(parsed.modelId),
  );
  if (isKnownModel) return resolveCodexModelSelection(parsed);

  const issues = genericCustomSelectionIssues(parsed);
  if (issues.length > 0) throw new ModelSelectionPolicyError(issues);

  const reasoningEffort = codexReasoningEffortSchema.parse(
    parsed.parameters.reasoning,
  );
  const fastMode =
    codexFastModeParameterSchema.parse(parsed.parameters.fast) === "true";
  return {
    modelSelection: {
      modelId: parsed.modelId,
      parameters: {
        fast: fastMode ? "true" : "false",
        reasoning: reasoningEffort,
      },
    },
    modelId: parsed.modelId,
    reasoningEffort,
    fastMode,
  };
}
