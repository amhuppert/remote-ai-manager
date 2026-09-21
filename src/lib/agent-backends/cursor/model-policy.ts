/**
 * Cursor model policy (spec D10): the adapter is the validation authority for
 * which model a run may use. Every model in the generated catalog is available
 * to every project; a project opts a model OUT through
 * `agentBackends.cursor.disabledModels` in its `CommandCenter.json`. A resolved
 * model that the project has disabled is always a bounded client error, never a
 * substitution: silently running a different model than the operator configured
 * is worse than refusing.
 *
 * No production path here calls live model-catalog discovery. The catalog is
 * the checked-in artifact the build refreshes, and the denylist is static
 * project configuration.
 */

import type { PerRepoConfig } from "@/lib/config/schemas";
import type { BackendModelCatalogFacet } from "../descriptor";
import type { BackendModelSelection } from "../schemas";
import {
  ModelSelectionPolicyError,
  validateModelSelection,
} from "../model-selection";

export const CURSOR_DEFAULT_MODEL = "composer-2.5";

/**
 * Bind the catalog's denylist read to the project's `CommandCenter.json`
 * through the repo-config reader, which parses it with the canonical per-repo
 * schema. Null means the project declares no Cursor block at all, which is the
 * same effective answer as an empty denylist: nothing is disabled.
 */
export function createCursorDisabledModelsReader(
  readRepoConfig: (projectPath: string) => Promise<PerRepoConfig | null>,
): (projectPath: string) => Promise<readonly string[] | null> {
  return async (projectPath: string) => {
    const config = await readRepoConfig(projectPath);
    return config?.agentBackends?.cursor?.disabledModels ?? null;
  };
}

export interface CursorModelSelectionPolicyDeps {
  modelCatalog: BackendModelCatalogFacet;
}

export type CursorModelSelectionResolution =
  | { ok: true; selection: BackendModelSelection }
  | {
      ok: false;
      code: string;
      message: string;
      modelId: string;
      parameterId?: string;
    };

function catalogFailure(
  error: unknown,
  requestedModelId: string,
): CursorModelSelectionResolution {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const modelId =
      "modelId" in error && typeof error.modelId === "string"
        ? error.modelId
        : requestedModelId;
    return { ok: false, code: error.code, message: error.message, modelId };
  }
  if (error instanceof ModelSelectionPolicyError) {
    const issue = error.issues[0];
    return {
      ok: false,
      code: issue?.code ?? "selection_invalid",
      message: error.message,
      modelId: issue?.modelId ?? requestedModelId,
      ...(issue?.parameterId !== undefined
        ? { parameterId: issue.parameterId }
        : {}),
    };
  }
  const detail =
    error instanceof Error ? error.message.slice(0, 200) : "unknown error";
  return {
    ok: false,
    code: "catalog_unavailable",
    message: `Could not load the effective Cursor model catalog: ${detail}`,
    modelId: requestedModelId,
  };
}

export async function validateCursorModelSelectionForProject(
  input: {
    projectPath: string;
    selection: BackendModelSelection;
    configuredSelection: BackendModelSelection;
  },
  deps: CursorModelSelectionPolicyDeps,
): Promise<CursorModelSelectionResolution> {
  let catalog;
  try {
    catalog = await deps.modelCatalog.getCatalog({
      projectPath: input.projectPath,
      configuredSelection: input.configuredSelection,
    });
  } catch (error) {
    return catalogFailure(error, input.selection.modelId);
  }

  const validation = validateModelSelection(catalog, input.selection);
  if (validation.valid) {
    return { ok: true, selection: validation.selection };
  }

  const issue = validation.issues[0];
  return {
    ok: false,
    code: issue?.code ?? "selection_invalid",
    message: validation.issues.map(({ message }) => message).join(" "),
    modelId: issue?.modelId ?? input.selection.modelId,
    ...(issue?.parameterId !== undefined
      ? { parameterId: issue.parameterId }
      : {}),
  };
}
