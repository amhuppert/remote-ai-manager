import { getStaticBackendModelCatalog } from "../catalog";
import {
  ModelSelectionPolicyError,
  validateModelSelection,
} from "../model-selection";
import {
  claudeEffortLevelSchema,
  claudeModelSchema,
  type BackendModelSelection,
  type ClaudeEffortLevel,
  type ClaudeModel,
} from "../schemas";

export interface ResolvedClaudeModelSelection {
  readonly modelSelection: BackendModelSelection;
  readonly modelId: ClaudeModel;
  readonly effort: ClaudeEffortLevel | undefined;
}

/** Validates a complete neutral selection and projects Claude SDK controls. */
export function resolveClaudeModelSelection(
  selection: BackendModelSelection,
): ResolvedClaudeModelSelection {
  const validation = validateModelSelection(
    getStaticBackendModelCatalog("claude"),
    selection,
  );
  if (!validation.valid) {
    throw new ModelSelectionPolicyError(validation.issues);
  }

  const effort = validation.selection.parameters.effort;
  return {
    modelSelection: validation.selection,
    modelId: claudeModelSchema.parse(validation.selection.modelId),
    effort:
      effort === undefined ? undefined : claudeEffortLevelSchema.parse(effort),
  };
}
