import {
  validateModelSelection,
  type ModelSelectionValidationIssue,
} from "../../model-selection";
import type { BackendModelSelection } from "../../schemas";
import { readGeneratedCursorModelCatalog } from "../generated-model-catalog-artifact";
import type { CursorSdkErrorFrameDetail } from "./ipc";

const GENERATED_CURSOR_MODEL_CATALOG = readGeneratedCursorModelCatalog();

export type CursorWorkerModelSelectionValidation =
  | { valid: true; selection: BackendModelSelection }
  | { valid: false; error: CursorSdkErrorFrameDetail };

function selectionError(
  issue: ModelSelectionValidationIssue | undefined,
): CursorSdkErrorFrameDetail {
  return {
    name: "CursorModelSelectionError",
    code: issue?.code ?? "model_selection_invalid",
    status: null,
    message:
      issue?.message ??
      "The Cursor model selection is not an exact generated-catalog variant.",
  };
}

/**
 * Revalidates worker input against the generated provider catalog. Project
 * allowlists live only in the parent process and are intentionally not applied
 * at this trust boundary.
 */
export function validateCursorWorkerModelSelection(
  selection: BackendModelSelection,
): CursorWorkerModelSelectionValidation {
  const validation = validateModelSelection(
    GENERATED_CURSOR_MODEL_CATALOG,
    selection,
  );
  if (!validation.valid) {
    return { valid: false, error: selectionError(validation.issues[0]) };
  }
  return { valid: true, selection: validation.selection };
}
