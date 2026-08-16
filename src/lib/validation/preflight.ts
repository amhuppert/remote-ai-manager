import { maxDeclaredCost } from "./cost-resolution";
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
  /**
   * The project's effective lane-merge command set. Optional only for pure
   * unit fixtures and project-unbound callers; every production project-bound
   * boundary supplies it through {@link createValidationCommandPreflight}.
   */
  laneMergeCommands?: readonly string[];
}

export interface ValidationCostExceedsLimit {
  code: typeof VALIDATION_COST_EXCEEDS_LIMIT_CODE;
  name: string;
  cost: number;
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
    laneMergeCommands: [
      ...(repoValidation?.laneMerge ?? repoValidation?.preMerge ?? []),
    ],
  };
}

export function validationCostExceedsLimit(
  name: string,
  preflight: ValidationCommandPreflight,
): ValidationCostExceedsLimit | null {
  const declared = preflight.commandCosts[name];
  if (declared === undefined) return null;

  // Admissibility must hold for every scope the caller could ask for, so a
  // table is judged by its heaviest reading rather than by a narrowing it may
  // never get.
  const cost = maxDeclaredCost(declared);
  if (cost <= preflight.concurrencyLimit) return null;

  const costPhrase =
    typeof declared === "number"
      ? `configured cost ${cost}`
      : `maximum configured cost ${cost} (cost.full)`;

  return {
    code: VALIDATION_COST_EXCEEDS_LIMIT_CODE,
    name,
    cost,
    limit: preflight.concurrencyLimit,
    message: `Validation command "${name}" has ${costPhrase}, exceeding the global limit ${preflight.concurrencyLimit}. Register a lower-worker command profile, reduce its worker cap and honest cost together, or raise the machine limit.`,
  };
}
