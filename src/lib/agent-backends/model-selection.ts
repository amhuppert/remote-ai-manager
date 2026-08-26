import type {
  BackendModelCatalog,
  BackendModelDefinition,
  BackendModelSelection,
  BackendModelVariant,
} from "./schemas";

export type ModelSelectionValidationCode =
  | "unknown_model"
  | "model_not_allowed"
  | "unknown_parameter"
  | "missing_parameter"
  | "unsupported_value"
  | "unsupported_combination";

export interface ModelSelectionValidationIssue {
  code: ModelSelectionValidationCode;
  message: string;
  modelId: string;
  parameterId?: string;
}

export type ModelSelectionValidationResult =
  | {
      valid: true;
      selection: BackendModelSelection;
      model: BackendModelDefinition;
      variant: BackendModelVariant;
    }
  | {
      valid: false;
      issues: readonly ModelSelectionValidationIssue[];
    };

/** A catalog-policy refusal that preserves stable diagnostic codes for APIs. */
export class ModelSelectionPolicyError extends Error {
  readonly issues: readonly ModelSelectionValidationIssue[];

  constructor(issues: readonly ModelSelectionValidationIssue[]) {
    super(issues.map(({ message }) => message).join(" "));
    this.name = "ModelSelectionPolicyError";
    this.issues = issues;
  }
}

function findModel(
  catalog: BackendModelCatalog,
  modelId: string,
): BackendModelDefinition | undefined {
  return catalog.models.find(
    (model) => model.id === modelId || model.aliases.includes(modelId),
  );
}

function sortedParameters(
  parameters: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parameters).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function cloneSelection(
  selection: BackendModelSelection,
): BackendModelSelection {
  return {
    modelId: selection.modelId,
    parameters: sortedParameters(selection.parameters),
  };
}

function unknownModelIssue(modelId: string): ModelSelectionValidationIssue {
  return {
    code: "unknown_model",
    modelId,
    message: `Model "${modelId}" is not present in this backend catalog.`,
  };
}

/** Converts an accepted alias to its canonical model id without changing values. */
export function canonicalizeModelSelection(
  catalog: BackendModelCatalog,
  selection: BackendModelSelection,
): BackendModelSelection {
  const model = findModel(catalog, selection.modelId);
  if (model === undefined) {
    throw new ModelSelectionPolicyError([unknownModelIssue(selection.modelId)]);
  }

  return {
    modelId: model.id,
    parameters: sortedParameters(selection.parameters),
  };
}

/**
 * Returns a collision-safe, insertion-order-independent identity for a
 * canonical model selection.
 */
export function modelSelectionKey(selection: BackendModelSelection): string {
  return JSON.stringify([
    selection.modelId,
    Object.entries(selection.parameters).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);
}

function validationIssuesForParameters(
  model: BackendModelDefinition,
  selection: BackendModelSelection,
): ModelSelectionValidationIssue[] {
  const issues: ModelSelectionValidationIssue[] = [];
  const definitionsById = new Map(
    model.parameters.map((parameter) => [parameter.id, parameter] as const),
  );

  for (const parameterId of Object.keys(selection.parameters)) {
    if (definitionsById.has(parameterId)) continue;
    issues.push({
      code: "unknown_parameter",
      modelId: model.id,
      parameterId,
      message: `Parameter "${parameterId}" is not defined for model "${model.id}".`,
    });
  }

  for (const parameter of model.parameters) {
    const suppliedValue = selection.parameters[parameter.id];
    if (suppliedValue === undefined) {
      issues.push({
        code: "missing_parameter",
        modelId: model.id,
        parameterId: parameter.id,
        message: `Parameter "${parameter.id}" is required for model "${model.id}".`,
      });
      continue;
    }

    if (!parameter.values.some(({ value }) => value === suppliedValue)) {
      issues.push({
        code: "unsupported_value",
        modelId: model.id,
        parameterId: parameter.id,
        message: `Value "${suppliedValue}" is not supported for parameter "${parameter.id}" on model "${model.id}".`,
      });
    }
  }

  return issues;
}

/** Validates one complete selection against exactly one advertised variant. */
export function validateModelSelection(
  catalog: BackendModelCatalog,
  selection: BackendModelSelection,
): ModelSelectionValidationResult {
  const model = findModel(catalog, selection.modelId);
  if (model === undefined) {
    return { valid: false, issues: [unknownModelIssue(selection.modelId)] };
  }

  const canonicalSelection: BackendModelSelection = {
    modelId: model.id,
    parameters: sortedParameters(selection.parameters),
  };
  const parameterIssues = validationIssuesForParameters(
    model,
    canonicalSelection,
  );
  if (parameterIssues.length > 0) {
    return { valid: false, issues: parameterIssues };
  }

  const selectionKey = modelSelectionKey(canonicalSelection);
  const variant = model.variants.find(
    (candidate) => modelSelectionKey(candidate.selection) === selectionKey,
  );
  if (variant === undefined) {
    return {
      valid: false,
      issues: [
        {
          code: "unsupported_combination",
          modelId: model.id,
          message: `The selected parameter combination is not supported for model "${model.id}".`,
        },
      ],
    };
  }

  return {
    valid: true,
    selection: canonicalSelection,
    model,
    variant,
  };
}

function requireValidSelection(
  catalog: BackendModelCatalog,
  selection: BackendModelSelection,
): BackendModelSelection {
  const result = validateModelSelection(catalog, selection);
  if (!result.valid) throw new ModelSelectionPolicyError(result.issues);
  return result.selection;
}

/** Returns a model's declared default complete variant, accepting aliases. */
export function defaultSelectionForModel(
  catalog: BackendModelCatalog,
  modelId: string,
): BackendModelSelection {
  const model = findModel(catalog, modelId);
  if (model === undefined) {
    throw new ModelSelectionPolicyError([unknownModelIssue(modelId)]);
  }

  const defaultVariant = model.variants.find(({ isDefault }) => isDefault);
  if (defaultVariant === undefined) {
    throw new Error(`Model "${model.id}" has no default variant.`);
  }

  return cloneSelection(defaultVariant.selection);
}

/**
 * Resolves candidates as indivisible values. The first present candidate is
 * authoritative, including when invalid; lower-precedence candidates never
 * repair or replace it.
 */
export function resolveModelSelection(input: {
  catalog: BackendModelCatalog;
  candidates: readonly (BackendModelSelection | null | undefined)[];
}): BackendModelSelection {
  const candidate = input.candidates.find(
    (value): value is BackendModelSelection => value != null,
  );
  if (candidate !== undefined) {
    return requireValidSelection(input.catalog, candidate);
  }

  return defaultSelectionForModel(input.catalog, input.catalog.defaultModelId);
}

/**
 * Lists target-parameter values that occur in a valid variant while every
 * other supplied draft value remains unchanged.
 */
export function availableParameterValues(input: {
  model: BackendModelDefinition;
  draft: BackendModelSelection;
  parameterId: string;
}): readonly string[] {
  const { model, draft, parameterId } = input;
  const parameter = model.parameters.find(({ id }) => id === parameterId);
  if (parameter === undefined) {
    throw new ModelSelectionPolicyError([
      {
        code: "unknown_parameter",
        modelId: model.id,
        parameterId,
        message: `Parameter "${parameterId}" is not defined for model "${model.id}".`,
      },
    ]);
  }

  if (draft.modelId !== model.id && !model.aliases.includes(draft.modelId)) {
    throw new ModelSelectionPolicyError([unknownModelIssue(draft.modelId)]);
  }

  const declaredParameterIds = new Set(model.parameters.map(({ id }) => id));
  const suppliedOtherEntries = Object.entries(draft.parameters).filter(
    ([id]) => id !== parameterId,
  );
  if (suppliedOtherEntries.some(([id]) => !declaredParameterIds.has(id))) {
    return [];
  }

  const available = new Set(
    model.variants
      .filter((variant) =>
        suppliedOtherEntries.every(
          ([id, value]) => variant.selection.parameters[id] === value,
        ),
      )
      .map((variant) => variant.selection.parameters[parameterId])
      .filter((value): value is string => value !== undefined),
  );

  return parameter.values
    .map(({ value }) => value)
    .filter((value) => available.has(value));
}
