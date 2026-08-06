import {
  globalValidationConfigSchema,
  type GlobalValidationConfig,
  type RepoValidationConfig,
  type ValidationCommandConfig,
} from "./schemas";

export const VALIDATION_COST_EXCEEDS_LIMIT_CODE =
  "validation_cost_exceeds_limit";

export interface ValidationCommandPreflight {
  commandCosts: Readonly<Record<string, ValidationCommandConfig["cost"]>>;
  concurrencyLimit: GlobalValidationConfig["concurrencyLimit"];
}

export interface ValidationCostExceedsLimit {
  code: typeof VALIDATION_COST_EXCEEDS_LIMIT_CODE;
  name: string;
  cost: ValidationCommandConfig["cost"];
  limit: GlobalValidationConfig["concurrencyLimit"];
  message: string;
}

export function createValidationCommandPreflight(
  repoValidation: RepoValidationConfig | undefined,
  globalValidation: GlobalValidationConfig | undefined,
): ValidationCommandPreflight {
  const resolvedGlobal = globalValidationConfigSchema.parse(
    globalValidation ?? {},
  );
  return {
    commandCosts: Object.fromEntries(
      Object.entries(repoValidation?.commands ?? {}).map(([name, command]) => [
        name,
        command.cost,
      ]),
    ),
    concurrencyLimit: resolvedGlobal.concurrencyLimit,
  };
}

export function validationCostExceedsLimit(
  name: string,
  preflight: ValidationCommandPreflight,
): ValidationCostExceedsLimit | null {
  const cost = preflight.commandCosts[name];
  if (cost === undefined || cost <= preflight.concurrencyLimit) return null;

  return {
    code: VALIDATION_COST_EXCEEDS_LIMIT_CODE,
    name,
    cost,
    limit: preflight.concurrencyLimit,
    message: `Validation command "${name}" has configured cost ${cost}, exceeding the global limit ${preflight.concurrencyLimit}. Register a lower-worker command profile, reduce its worker cap and honest cost together, or raise the machine limit.`,
  };
}
