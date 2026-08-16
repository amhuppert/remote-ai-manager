import { collectStableAccountabilityContextIds } from "./authored-accountability";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "./definition-schemas";
import { projectResolvedDefinitionLoops } from "./execution-routes";
import { projectMustRunContextIds } from "./route-projection";

export interface AuthoredAccountabilityCoverageGroup {
  readonly bindingKey: string;
  readonly claimantContextIds: readonly string[];
}

export type AuthoredAccountabilityCoverageSource =
  | {
      readonly kind: "authored";
      readonly definition: WorkflowSemanticDefinition;
    }
  | {
      readonly kind: "working";
      readonly definition: ResolvedWorkflowSemanticDefinition;
      readonly admittedStableSourceIds: readonly string[];
    };

export interface AuthoredAccountabilityCoverageInput {
  readonly source: AuthoredAccountabilityCoverageSource;
  readonly groups: readonly AuthoredAccountabilityCoverageGroup[];
}

export interface LocatedAuthoredAccountabilityCoverage {
  readonly bindingKey: string;
  readonly claimantContextIds: readonly string[];
  readonly stableExistingClaimantContextIds: readonly string[];
  readonly mustRunClaimantContextIds: readonly string[];
  readonly covered: boolean;
}

export function locateAuthoredAccountabilityCoverageCore(
  input: AuthoredAccountabilityCoverageInput,
): LocatedAuthoredAccountabilityCoverage[] {
  const stableSourceIds = new Set(
    input.source.kind === "authored"
      ? collectStableAccountabilityContextIds(input.source.definition)
      : input.source.admittedStableSourceIds,
  );
  const existingContextIds = new Set(
    input.source.definition.executionContexts.map((context) => context.id),
  );
  const mustRunContextIds = projectMustRunContextIds({
    ...input.source.definition,
    ...(input.source.kind === "working"
      ? { loops: projectResolvedDefinitionLoops(input.source.definition) }
      : {}),
  });

  return input.groups.map((group) => {
    const stableExistingClaimantContextIds = group.claimantContextIds.filter(
      (contextId) =>
        stableSourceIds.has(contextId) && existingContextIds.has(contextId),
    );
    const mustRunClaimantContextIds = stableExistingClaimantContextIds.filter(
      (contextId) => mustRunContextIds.has(contextId),
    );
    return {
      bindingKey: group.bindingKey,
      claimantContextIds: [...group.claimantContextIds],
      stableExistingClaimantContextIds,
      mustRunClaimantContextIds,
      covered: mustRunClaimantContextIds.length > 0,
    };
  });
}
