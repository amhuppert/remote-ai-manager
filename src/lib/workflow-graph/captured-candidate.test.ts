import { changed } from "@/lib/workflow-graph/execution-mutation";
import { describe, expect, it } from "vitest";
import {
  createCohortExecution,
  createHarness,
  failResult,
  INFRA_RESULT,
  metadata,
  passResult,
  TREE_A,
} from "./testing/cohort-engine-harness";

function executionWithHandoff() {
  const execution = createCohortExecution({
    assignmentIds: ["reviewer"],
    consecutiveFailureCount: 0,
  });
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === "context-plan",
  )!;
  context.outputSchema = {
    type: "object",
    properties: { instructions: { type: "string" } },
    required: ["instructions"],
  };
  return execution;
}

describe("captured candidate lifecycle", () => {
  it("charges one rejected capture once at the semantic breaker and closes its round", async () => {
    const execution = executionWithHandoff();
    execution.contextStates["context-plan"]!.consecutiveFailureCount = 2;
    const harness = createHarness({
      execution,
      productionSignalHalt: true,
      outputCaptureService: {
        captureContextOutput: async () => ({
          kind: "captured",
          value: { instructions: "Incomplete remediation" },
          parse: { source: "native" },
        }),
      },
      runContextValidator: async (input) => ({
        result: failResult(input.validator.id, ["task-plan-1"]),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });
    await harness.run();
    expect(harness.repository.read().pendingHaltReason).toMatchObject({
      type: "circuit_breaker",
      failureCount: 3,
    });
    expect(harness.contextState()?.consecutiveFailureCount).toBe(3);
    expect(harness.contextState()?.validationRound?.outcome).toBe("failed");
    expect(
      harness.repository.read().contextOutputs["context-plan"],
    ).toBeUndefined();
  });

  it("does not charge provider infrastructure exhaustion to semantic failures while draining", async () => {
    const harness = createHarness({
      execution: executionWithHandoff(),
      productionSignalHalt: true,
      outputCaptureService: {
        captureContextOutput: async () => ({
          kind: "captured",
          value: { instructions: "Candidate awaiting independent review" },
          parse: { source: "native" },
        }),
      },
      runContextValidator: async (input) => ({
        result: INFRA_RESULT,
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });
    await harness.run();
    expect(harness.repository.read().pendingHaltReason?.type).toBe(
      "validator_infra_error",
    );
    expect(harness.contextState()?.consecutiveFailureCount).toBe(0);
    expect(harness.repository.read().taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(
      harness.repository.read().contextOutputs["context-plan"],
    ).toBeUndefined();
  });

  it("rejects findings when the staged handoff changes during review", async () => {
    const harness = createHarness({
      execution: executionWithHandoff(),
      outputCaptureService: {
        captureContextOutput: async () => ({
          kind: "captured",
          value: { instructions: "Reviewed text" },
          parse: { source: "native" },
        }),
      },
      runContextValidator: async (input) => {
        await harness.repository
          .mutateActive("/repo", "session-1", (execution) => {
            execution.contextStates[
              "context-plan"
            ]!.validationRound!.outputCandidate!.value = {
              instructions: "Different text",
            };
            return changed(execution);
          })
          .then((mutation) => mutation.execution);
        return {
          result: failResult(input.validator.id, ["task-plan-1"]),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });
    await harness.run();
    expect(harness.repository.read().taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(
      harness.repository.read().contextOutputs["context-plan"],
    ).toBeUndefined();
    expect(harness.contextState()?.validationRound?.outcome).toBe(
      "candidate_mismatch",
    );
    expect(harness.contextState()?.consecutiveFailureCount).toBe(0);
  });

  it("resumes infrastructure review on the same captured candidate", async () => {
    let captures = 0;
    let ready = false;
    const reviewed: unknown[] = [];
    const harness = createHarness({
      execution: executionWithHandoff(),
      outputCaptureService: {
        captureContextOutput: async () => ({
          kind: "captured",
          value: { instructions: `Candidate ${++captures}` },
          parse: { source: "native" },
        }),
      },
      runContextValidator: async (input) => {
        reviewed.push(
          input.execution.contextStates["context-plan"]?.validationRound
            ?.outputCandidate?.value,
        );
        return {
          result: ready ? passResult(input.validator.id) : INFRA_RESULT,
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });
    await harness.run();
    expect(harness.repository.read().haltReason?.type).toBe(
      "validator_infra_error",
    );
    ready = true;
    await harness.resumeHalt();
    await harness.scheduleNextContext();
    await harness.run();
    expect(captures).toBe(1);
    expect(reviewed).toEqual(
      Array.from({ length: 4 }, () => ({ instructions: "Candidate 1" })),
    );
    expect(
      harness.repository.read().contextOutputs["context-plan"]?.value,
    ).toEqual({ instructions: "Candidate 1" });
  });

  it("binds a read-only handoff to the entire input tree and retires stale file findings", async () => {
    const execution = executionWithHandoff();
    execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    )!.placement = { lane: "session", mode: "readOnly" };
    let changed = false;
    const scopes: unknown[] = [];
    const harness = createHarness({
      execution,
      resolveCandidateTree: (input) => {
        scopes.push(input.candidateScope);
        return {
          ...TREE_A,
          candidateTreeHash: changed
            ? "restored-producer-input"
            : "truncated-producer-input",
        };
      },
      outputCaptureService: {
        captureContextOutput: async () => ({
          kind: "captured",
          value: { instructions: "Repair missing inventory" },
          parse: { source: "native" },
        }),
      },
      runContextValidator: async (input) => {
        changed = true;
        return {
          result: failResult(input.validator.id, ["task-plan-1"]),
          metadata: metadata(),
          roundToken: input.roundToken ?? null,
        };
      },
    });
    await harness.run();
    expect(scopes.length).toBeGreaterThan(1);
    expect(
      scopes.every(
        (scope) =>
          JSON.stringify(scope) === JSON.stringify({ mode: "wholeTree" }),
      ),
    ).toBe(true);
    expect(harness.repository.read().taskStates["task-plan-1"]?.status).toBe(
      "completed",
    );
    expect(harness.contextState()?.validationRound?.outcome).toBe(
      "candidate_mismatch",
    );
    expect(
      harness.repository.read().contextOutputs["context-plan"],
    ).toBeUndefined();
  });
});
