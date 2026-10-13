/**
 * A seat as the template editor edits it: a backend and a model selection,
 * each absent when it is left to its default. No backend is the Command
 * Center default (the configured default backend and its default model, at
 * launch); a backend without a model is that backend's default model. A
 * chosen model is always a complete selection from the backend's catalog, so
 * its effort is the selection's primary parameter (`effort` or `reasoning`).
 */
import type { ProjectBackendModelOptions } from "@/lib/agent-backends/project-model-options-schema";
import {
  defaultSelectionForModel,
  validateModelSelection,
} from "@/lib/agent-backends/model-selection";
import type {
  BackendModelCatalog,
  BackendModelDefinition,
  BackendModelParameterDefinition,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import {
  agentProfileRefSchema,
  type AgentProfileRef,
} from "@/lib/agent-profiles/schemas";
import type { ImplementerSetting, ReviewerSetting } from "@/lib/runs/settings";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface Seat {
  backend?: AgentBackendId;
  modelSelection?: BackendModelSelection;
}

/** A seat setting's backend and model, without its profile or reviewer fields. */
export function seatOf(setting: ImplementerSetting | ReviewerSetting): Seat {
  return {
    ...(setting.backend === undefined ? {} : { backend: setting.backend }),
    ...(setting.modelSelection === undefined
      ? {}
      : { modelSelection: setting.modelSelection }),
  };
}

/** The complete catalog the project offers for a backend; null without a backend or a complete catalog. */
export function catalogFor(
  options: readonly ProjectBackendModelOptions[],
  backend: AgentBackendId | undefined,
): BackendModelCatalog | null {
  if (backend === undefined) return null;
  return (
    options.find((entry) => entry.backend === backend)?.modelCatalog ?? null
  );
}

export function modelOf(
  catalog: BackendModelCatalog,
  modelId: string,
): BackendModelDefinition | null {
  return (
    catalog.models.find(
      (model) => model.id === modelId || model.aliases.includes(modelId),
    ) ?? null
  );
}

/** The parameter the effort control sets: the model's primary choice, when it has one. */
export function effortParameterOf(
  catalog: BackendModelCatalog,
  modelId: string,
): BackendModelParameterDefinition | null {
  return (
    modelOf(catalog, modelId)?.parameters.find(
      (parameter) =>
        parameter.prominence === "primary" && parameter.values.length > 1,
    ) ?? null
  );
}

/** Null leaves the backend, and with it the model, to the Command Center default. */
export function withBackend(seat: Seat, backend: AgentBackendId | null): Seat {
  if (backend === null) return {};
  if (backend === seat.backend) return seat;
  return { backend };
}

/**
 * Null leaves the model to the backend's default. A chosen model starts from
 * its default selection and keeps the seat's current effort when the model
 * offers that value.
 */
export function withModel(
  seat: Seat,
  catalog: BackendModelCatalog,
  modelId: string | null,
): Seat {
  const backend = seat.backend === undefined ? {} : { backend: seat.backend };
  if (modelId === null) return backend;
  const selection = defaultSelectionForModel(catalog, modelId);
  const previous = seat.modelSelection;
  const parameter = effortParameterOf(catalog, modelId);
  const effort =
    previous === undefined || parameter === null
      ? undefined
      : previous.parameters[parameter.id];
  const kept =
    parameter === null || effort === undefined
      ? selection
      : withParameter(catalog, selection, parameter.id, effort);
  return { ...backend, modelSelection: kept ?? selection };
}

function withParameter(
  catalog: BackendModelCatalog,
  selection: BackendModelSelection,
  parameterId: string,
  value: string,
): BackendModelSelection | null {
  const draft = {
    modelId: selection.modelId,
    parameters: { ...selection.parameters, [parameterId]: value },
  };
  const validated = validateModelSelection(catalog, draft);
  if (validated.valid) return validated.selection;
  // Another parameter's value may not combine with this one: take the model's
  // first selection that has it.
  return (
    modelOf(catalog, selection.modelId)?.variants.find(
      (variant) => variant.selection.parameters[parameterId] === value,
    )?.selection ?? null
  );
}

/** The seat with its model's effort set; unchanged when the model cannot take that value. */
export function withEffort(
  seat: Seat,
  catalog: BackendModelCatalog,
  value: string,
): Seat {
  const selection = seat.modelSelection;
  if (selection === undefined) return seat;
  const parameter = effortParameterOf(catalog, selection.modelId);
  if (parameter === null) return seat;
  const next = withParameter(catalog, selection, parameter.id, value);
  return next === null ? seat : { ...seat, modelSelection: next };
}

/** A profile reference as one select value: `tier:id`. */
export function profileKey(ref: AgentProfileRef): string {
  return `${ref.tier}:${ref.id}`;
}

export function profileRefOf(key: string): AgentProfileRef | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;
  const parsed = agentProfileRefSchema.safeParse({
    tier: key.slice(0, separator),
    id: key.slice(separator + 1),
  });
  return parsed.success ? parsed.data : null;
}
