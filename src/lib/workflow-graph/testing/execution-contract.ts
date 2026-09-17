import type { GraphExecutionContract } from "../execution-contract-port";

export function createTestGraphExecutionContract(): GraphExecutionContract {
  return {
    validateDefinition: () => ({ ok: true }),
    loadLiveEdit: () => ({
      validateOperation: () => ({ ok: true }),
      accountabilityCoverageGroups: [],
    }),
    validateTaskCompletion: () => ({ ok: true }),
    deriveContextAcceptanceCriteria: () => ({
      ok: true,
      acceptanceCriteriaByContextId: {},
    }),
    loadPromptProjection: async () => null,
  };
}
