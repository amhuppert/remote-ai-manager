import type {
  ConversationBackendFactory,
  ProjectModelSelectionValidation,
} from "./conversation";
import type { ConversationTurnConfig } from "./conversation-policy";
import {
  ModelSelectionPolicyError,
  type ModelSelectionValidationIssue,
  validateModelSelection,
} from "./model-selection";
import type { BackendModelCatalog, BackendModelSelection } from "./schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import { getConfiguredBackendModelCatalog } from "./catalog";
import { getConversationBackendFactory } from "./registry";
import { readConfig } from "@/lib/config/loader";

export interface ModelSelectionAdmissionDiagnostic {
  code: string;
  message: string;
  modelId: string;
  parameterId?: string;
}

export class ModelSelectionAdmissionError extends Error {
  readonly code: string;
  readonly modelId: string;
  readonly parameterId?: string;

  constructor(diagnostic: ModelSelectionAdmissionDiagnostic) {
    super(diagnostic.message);
    this.name = "ModelSelectionAdmissionError";
    this.code = diagnostic.code;
    this.modelId = diagnostic.modelId;
    this.parameterId = diagnostic.parameterId;
  }
}

function refusalFromIssue(
  issue: ModelSelectionValidationIssue | undefined,
  selection: BackendModelSelection,
  message: string,
): ProjectModelSelectionValidation {
  return {
    ok: false,
    code: issue?.code ?? "selection_invalid",
    message,
    modelId: issue?.modelId ?? selection.modelId,
    ...(issue?.parameterId !== undefined
      ? { parameterId: issue.parameterId }
      : {}),
  };
}

export async function admitConversationModelSelection(
  factory: ConversationBackendFactory,
  input: {
    projectPath: string;
    modelSelection: BackendModelSelection;
  },
): Promise<ProjectModelSelectionValidation> {
  try {
    factory.validateModelSelection?.(input.modelSelection);
  } catch (error) {
    const issue =
      error instanceof ModelSelectionPolicyError ? error.issues[0] : undefined;
    return refusalFromIssue(
      issue,
      input.modelSelection,
      getErrorMessage(error),
    );
  }

  if (factory.validateProjectModelSelection === undefined) {
    return { ok: true, modelSelection: input.modelSelection };
  }

  try {
    return await factory.validateProjectModelSelection(input);
  } catch (error) {
    return {
      ok: false,
      code: "selection_validation_failed",
      message: getErrorMessage(error),
      modelId: input.modelSelection.modelId,
    };
  }
}

export interface ModelSelectionAdmissionDeps {
  readConfig(): Promise<ConversationTurnConfig>;
  getConfiguredBackendModelCatalog(
    backend: AgentBackendId,
    configuredSelection?: BackendModelSelection,
  ): BackendModelCatalog;
  getConversationBackendFactory(
    backend: AgentBackendId,
  ): ConversationBackendFactory;
}

const defaultAdmissionDeps: ModelSelectionAdmissionDeps = {
  readConfig,
  getConfiguredBackendModelCatalog,
  getConversationBackendFactory,
};

/**
 * Resolve one effective selection, validate it against the configured catalog,
 * and then apply the backend's runtime and project policy. Catalog validation
 * happens first so aliases are canonical before a project policy sees them and
 * a configured custom Codex model remains part of the accepted surface.
 */
export async function admitConfiguredModelSelection(
  input: {
    backend: AgentBackendId;
    projectPath: string;
    modelSelection?: BackendModelSelection;
    config?: ConversationTurnConfig;
  },
  deps: ModelSelectionAdmissionDeps = defaultAdmissionDeps,
): Promise<ProjectModelSelectionValidation> {
  let config = input.config;
  if (config === undefined) {
    try {
      config = await deps.readConfig();
    } catch (error) {
      return {
        ok: false,
        code:
          input.modelSelection === undefined
            ? "configured_selection_unavailable"
            : "selection_validation_failed",
        message: getErrorMessage(error),
        modelId: input.modelSelection?.modelId ?? "configured_default",
      };
    }
  }
  const configuredSelection =
    config.agentBackends[input.backend].modelSelection;
  const requestedSelection = input.modelSelection ?? configuredSelection;

  let catalog: BackendModelCatalog;
  try {
    catalog = deps.getConfiguredBackendModelCatalog(
      input.backend,
      configuredSelection,
    );
  } catch (error) {
    const issue =
      error instanceof ModelSelectionPolicyError ? error.issues[0] : undefined;
    return refusalFromIssue(issue, requestedSelection, getErrorMessage(error));
  }

  const catalogValidation = validateModelSelection(catalog, requestedSelection);
  if (!catalogValidation.valid) {
    const issue = catalogValidation.issues[0];
    return refusalFromIssue(
      issue,
      requestedSelection,
      issue?.message ?? "Model selection is invalid.",
    );
  }

  let factory: ConversationBackendFactory;
  try {
    factory = deps.getConversationBackendFactory(input.backend);
  } catch (error) {
    return {
      ok: false,
      code: "selection_validation_failed",
      message: getErrorMessage(error),
      modelId: catalogValidation.selection.modelId,
    };
  }

  return admitConversationModelSelection(factory, {
    projectPath: input.projectPath,
    modelSelection: catalogValidation.selection,
  });
}
