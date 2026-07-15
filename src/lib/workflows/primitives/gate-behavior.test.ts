/**
 * Cross-gate behavior tests for the workflow primitive layer.
 *
 * These tests do not duplicate the per-gate matrices. They exercise the
 * canonical workflow scenarios called out by the task spec — one scenario
 * per gate kind — and confirm that:
 *
 *  1. Every gate's output round-trips through the shared `gateResultSchema`,
 *     so a feature adapter can persist or transport any gate outcome with a
 *     single envelope.
 *  2. Pause-kind invariants hold (`human_approval` is always `post_turn`).
 *  3. Failure-class details (`validation_failed` vs `infrastructure`) remain
 *     observable on the gates that distinguish them.
 *  4. Pass and fail outcomes are stable on the same input — gates are pure.
 */

import { describe, expect, it } from "vitest";
import { runCircuitBreakerGate } from "./circuit-breaker-gate";
import { runContextLimitGate } from "./context-limit-gate";
import { gateResultSchema, type GateResult } from "./gate-vocabulary";
import {
  approveHumanApprovalGate,
  pauseForHumanApproval,
  rejectHumanApprovalGate,
} from "./human-approval-gate";
import { scriptValidationGateFromOutcome } from "./script-validation-gate";
import { runStructuredOutputGate } from "./structured-output-gate";

describe("shared gate behavior", () => {
  it("wraps a structured-output validation failure with the validator's errors", () => {
    const gate = runStructuredOutputGate({}, {}, () => ({
      valid: false,
      errors: ["root: missing required key 'summary'"],
    }));
    expectSharedShape(gate);
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("structured_output");
    expect(gate.reason).toContain("missing required key");
    expect(gate.details).toMatchObject({
      errors: ["root: missing required key 'summary'"],
    });
  });

  it("models a human-approval lifecycle as post-turn pause then pass on approval", () => {
    const paused = pauseForHumanApproval({ resumeToken: "rt-hap-3" });
    expectSharedShape(paused);
    expect(paused.kind).toBe("human_approval");
    expect(paused.pauseKind).toBe("post_turn");

    const approved = approveHumanApprovalGate({ approver: "alex" });
    expectSharedShape(approved);
    expect(approved.status).toBe("pass");
    expect(approved.details).toMatchObject({ approver: "alex" });
  });

  it("models a human-approval rejection as a fail with the rejection reason verbatim", () => {
    const rejected = rejectHumanApprovalGate(
      "scope creep — defer to next sprint",
    );
    expectSharedShape(rejected);
    expect(rejected.status).toBe("fail");
    if (rejected.status !== "fail") return;
    expect(rejected.reason).toBe("scope creep — defer to next sprint");
  });

  it("classifies a script-validator timeout as a validation failure (not infrastructure)", () => {
    const gate = scriptValidationGateFromOutcome({
      kind: "fail",
      summary: "tests timed out after 600s",
      logFilePath: "/abs/log",
      logRelativePath: ".cc/workflow/exec-9/pre-merge-T.log",
      timedOut: true,
    });
    expectSharedShape(gate);
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.details).toMatchObject({
      failureClass: "validation_failed",
      timedOut: true,
    });
  });

  it("classifies a script-validator infrastructure error distinctly so workflows can halt rather than retry", () => {
    const gate = scriptValidationGateFromOutcome({
      kind: "infra_error",
      reason: "missing_pre_merge_command",
      message: "Script validator enabled but no preMergeCommand configured",
    });
    expectSharedShape(gate);
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.details).toMatchObject({
      failureClass: "infrastructure",
      infraReason: "missing_pre_merge_command",
    });
  });

  it("trips the circuit-breaker when the consecutive-failure count hits the configured threshold", () => {
    const gate = runCircuitBreakerGate({ failureCount: 3, threshold: 3 });
    expectSharedShape(gate);
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("circuit_breaker");
    expect(gate.details).toMatchObject({
      tripped: true,
      failureCount: 3,
      threshold: 3,
    });
  });

  it("flags context-limit rotation as a fail (workflow action) rather than a pause (waiting state)", () => {
    const gate = runContextLimitGate({
      metrics: {
        backend: "claude",
        contextTokens: 95_000,
        rotateBeforeNextTurn: false,
      },
      policy: { contextLimitTokens: 90_000 },
    });
    expectSharedShape(gate);
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("context_limit");
    expect(gate.details).toMatchObject({
      evaluation: "rotation_required",
      contextTokens: 95_000,
      limit: 90_000,
    });
  });

  it("treats Codex as unsupported for context-limit evaluation rather than emulating the metric", () => {
    const gate = runContextLimitGate({
      metrics: {
        backend: "codex",
        rotateBeforeNextTurn: false,
      },
      policy: { contextLimitTokens: 90_000 },
    });
    expectSharedShape(gate);
    expect(gate.status).toBe("pass");
    expect(gate.details).toMatchObject({ evaluation: "unsupported" });
  });
});

describe("shared gate purity", () => {
  it("returns a fresh, equivalent envelope on repeated invocations of the same input", () => {
    const a = runCircuitBreakerGate({ failureCount: 3, threshold: 3 });
    const b = runCircuitBreakerGate({ failureCount: 3, threshold: 3 });
    expectSharedShape(a);
    expectSharedShape(b);
    expect(a).not.toBe(b);
    expect(a).toStrictEqual(b);
  });
});

function expectSharedShape(gate: GateResult): void {
  expect(() => gateResultSchema.parse(gate)).not.toThrow();
}
