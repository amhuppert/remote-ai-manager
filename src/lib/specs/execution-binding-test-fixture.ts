import type { GraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { SpecExecutionBindingMismatchError } from "./execution-binding";
import {
  createSpecExecutionBindingGraphContract,
  type SpecExecutionBindingPort,
} from "./execution-binding-service";

export function createCrossCandidateSpecExecutionBindingContract(): GraphExecutionContract {
  const linked = {
    specExecutionId: "spec-execution-1",
    workflowExecutionId: "execution-1",
    binding: {
      schemaVersion: 2 as const,
      candidateId: "candidate-approved",
      candidateHash: `sha256:${"a".repeat(64)}`,
      pinnedRevisionId: "revision-1",
      dispositions: [],
      claims: [],
    },
    createdAt: "2026-08-15T12:00:00.000Z",
  };
  const port: SpecExecutionBindingPort = {
    resolveByWorkflowExecutionId(_workflowExecutionId, expected) {
      if (
        expected?.candidateId !== undefined &&
        expected.candidateId !== linked.binding.candidateId
      ) {
        throw new SpecExecutionBindingMismatchError(
          linked.workflowExecutionId,
          "candidateId",
        );
      }
      return linked;
    },
  };
  return createSpecExecutionBindingGraphContract({
    executionContract: port,
    prompts: port,
    liveEdits: port,
  });
}
