import { type ContextIterationFixtureDeps } from "@/lib/workflow-graph/testing/iteration-fixture";

/** Capabilities for fixtures that exercise no external validation or capture turns. */
export function createContextTestCapabilities(): Pick<
  ContextIterationFixtureDeps,
  | "materializeWorkflowDocuments"
  | "scriptValidatorService"
  | "validationRoundService"
  | "outputCaptureService"
  | "advisoryResponseService"
> {
  return {
    materializeWorkflowDocuments: async () => {},
    scriptValidatorService: {
      runScriptValidator: async () => {
        throw new Error("Script validation is outside this fixture");
      },
    },
    validationRoundService: {
      resolveCandidateTree: async () => ({
        kind: "unavailable",
        reason: "This fixture has no candidate worktree",
      }),
    },
    outputCaptureService: {
      captureContextOutput: async () => {
        throw new Error("Output capture is outside this fixture");
      },
    },
    advisoryResponseService: {
      runAdvisoryResponse: async () => {
        throw new Error("Advisory response is outside this fixture");
      },
    },
  };
}
