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
 *  2. Pause-kind invariants hold across all kinds (`ask_user` is always
 *     `mid_turn`, `human_approval` is always `post_turn`).
 *  3. Failure-class details (`validation_failed` vs `infrastructure`) remain
 *     observable on the gates that distinguish them.
 *  4. Pass and fail outcomes are stable on the same input — gates are pure.
 */

import { describe, expect, it } from "vitest";
import type { AgentCallResult } from "./agent-call-vocabulary";
import { askUserGateFromPause, pauseForAskUser } from "./ask-user-gate";
import { runChangeSetGate } from "./change-set-gate";
import { runCircuitBreakerGate } from "./circuit-breaker-gate";
import { runContextLimitGate } from "./context-limit-gate";
import { runConvergenceGate } from "./convergence-gate";
import {
  gateResultSchema,
  isPauseGateResult,
  type GateResult,
} from "./gate-vocabulary";
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

  it("surfaces a backend-native ask-user pause as a mid-turn gate pause", () => {
    const result: AgentCallResult = {
      backend: "claude",
      backendRef: null,
      capabilities: {
        backend: "claude",
        continuationStrength: "precise_session",
        structuredOutputEnforcement: "post_validation",
        mcpApplicationBoundary: "between_turns",
        contextMetricsAvailable: true,
        nativeMidTurnAskUser: true,
      },
      usage: {},
      artifacts: [],
      outcome: {
        kind: "paused",
        pauseKind: "mid_turn",
        resumeToken: "rt-mid-7",
        details: {
          questions: [
            {
              question: "Continue?",
              options: [{ label: "Yes" }, { label: "No" }],
              multiSelect: false,
            },
          ],
        },
      },
    };
    const gate = askUserGateFromPause(result);
    expect(gate).not.toBeNull();
    if (!gate) return;
    expectSharedShape(gate);
    expect(isPauseGateResult(gate)).toBe(true);
    expect(gate.kind).toBe("ask_user");
    expect(gate.pauseKind).toBe("mid_turn");
    expect(gate.resumeToken).toBe("rt-mid-7");
  });

  it("manufactures a mid-turn ask-user pause when the workflow surfaces questions itself", () => {
    const gate = pauseForAskUser({
      resumeToken: "rt-deferred-1",
      questions: [
        {
          question: "Pick a region",
          options: [{ label: "us" }],
          multiSelect: false,
        },
      ],
    });
    expectSharedShape(gate);
    expect(gate.pauseKind).toBe("mid_turn");
    expect(gate.kind).toBe("ask_user");
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

  it("fails the change-set gate when an implementation lane produced no changes", () => {
    const gate = runChangeSetGate({
      hasChanges: false,
      expectation: "required",
    });
    expectSharedShape(gate);
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("change_set");
    expect(gate.details).toMatchObject({
      expectation: "required",
      hasChanges: false,
    });
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

  it("fails the convergence gate when one lane disagrees, surfacing the rejecting voter", () => {
    const gate = runConvergenceGate({
      votes: [
        { voter: "claude", decision: "accept" },
        { voter: "codex", decision: "reject", reason: "schema mismatch" },
      ],
    });
    expectSharedShape(gate);
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("convergence");
    expect(gate.reason).toContain("codex");
    expect(gate.details).toMatchObject({
      voterCount: 2,
      acceptCount: 1,
      rejectCount: 1,
      rejectors: [{ voter: "codex", reason: "schema mismatch" }],
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
    const a = runChangeSetGate({ hasChanges: false, expectation: "required" });
    const b = runChangeSetGate({ hasChanges: false, expectation: "required" });
    expectSharedShape(a);
    expectSharedShape(b);
    expect(a).not.toBe(b);
    expect(a).toStrictEqual(b);
  });
});

function expectSharedShape(gate: GateResult): void {
  expect(() => gateResultSchema.parse(gate)).not.toThrow();
}
