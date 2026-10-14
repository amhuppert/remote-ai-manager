import { expect, it } from "vitest";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
import { toPromptActorResult, toTaskRunResult } from "./turn-result";

it("preserves structured-output rejection evidence and partial accounting", () => {
  const result: AgentCallResult = {
    backend: "claude",
    backendRef: { backend: "claude", ref: "partial-ref" },
    capabilities: capabilityViewForBackend("claude"),
    usage: { costUsd: 0.7, durationMs: 45, inputTokens: 21, outputTokens: 9 },
    artifacts: [],
    continuationDisposition: "clear",
    outcome: {
      kind: "failed",
      numTurns: 2,
      contentBlocks: [{ type: "text", text: "rejected partial answer" }],
      error: {
        backend: "claude",
        failureKind: "schema_validation",
        message: "The answer was rejected",
        retryable: false,
        backendDetails: {
          errors: ["/answer: expected string"],
          repairAttempts: 1,
          repairMaxAttempts: 1,
        },
      },
    },
  };
  expect(toPromptActorResult({ kind: "call_result", result })).toMatchObject({
    contentBlocks: [{ type: "text", text: "rejected partial answer" }],
    structuredOutputIssues: ["/answer: expected string"],
    structuredOutputRepair: { attempts: 1, maxAttempts: 1 },
    costUsd: 0.7,
    inputTokens: 21,
    outputTokens: 9,
    numTurns: 2,
    continuationDisposition: "clear",
  });
});

it("does not present an unexpected paused task outcome as a successful empty turn", () => {
  const result: AgentCallResult = {
    backend: "claude",
    backendRef: null,
    capabilities: capabilityViewForBackend("claude"),
    usage: {},
    artifacts: [],
    outcome: { kind: "paused", pauseKind: "post_turn", resumeToken: "pending" },
  };
  expect(
    toPromptActorResult({ kind: "call_result", result }).error,
  ).not.toBeNull();
});

// Retryability of a session death is decided by the error OBJECT (an
// undelivered prompt is safe to re-dispatch, a mid-turn death is not), and
// that fact is gone by the time the failure is prose. When the turn already
// carries the classification, re-reading the string would downgrade a
// retryable transient into a halt.
it("keeps the recorded failure classification when display wording suggests a different policy", () => {
  const result: AgentCallResult = {
    backend: "claude",
    backendRef: null,
    capabilities: capabilityViewForBackend("claude"),
    usage: { costUsd: 0.2 },
    artifacts: [],
    outcome: {
      kind: "failed",
      error: {
        backend: "claude",
        failureKind: "session_died",
        message: "Permanent failure according to prose",
        retryable: true,
      },
    },
  };
  const mapped = toTaskRunResult({ kind: "call_result", result });
  expect(mapped).toMatchObject({
    kind: "error",
    failure: { kind: "session_died", retryable: true },
    usage: { costUsd: 0.2 },
  });
});

it("keeps admission pressure distinct from a failed backend turn without fabricating spend", () => {
  const mapped = toTaskRunResult({
    kind: "not_started",
    reason: "query_slot_timeout",
    message: "Capacity was unavailable",
  });
  expect(mapped).toMatchObject({
    kind: "error",
    notStarted: { reason: "query_slot_timeout" },
    usage: { costUsd: null, inputTokens: null },
  });
  if (mapped.kind !== "error") throw new Error("Expected admission refusal");
  expect(mapped.failure).toBeUndefined();
});

it("retains refused text when a structured presentation field was requested", () => {
  const result: AgentCallResult = {
    backend: "claude",
    backendRef: null,
    capabilities: capabilityViewForBackend("claude"),
    usage: { costUsd: 0.2 },
    artifacts: [],
    outcome: {
      kind: "failed",
      contentBlocks: [{ type: "text", text: "Incomplete response" }],
      error: {
        backend: "claude",
        failureKind: "schema_validation",
        message: "Rejected",
        retryable: false,
      },
    },
  };
  expect(
    toTaskRunResult({ kind: "call_result", result }, undefined, {
      structuredOutputTextField: "response",
    }),
  ).toMatchObject({ kind: "error", text: "Incomplete response" });
});
