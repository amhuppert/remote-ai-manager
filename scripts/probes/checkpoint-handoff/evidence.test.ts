import { assertScratchChild } from "./artifact-environment";
import { describe, expect, it } from "vitest";
import {
  captureAuditEvidence,
  gradeHandoffAnswer,
  originalAnswerForGrading,
  createSubmissionBudget,
  digest,
  parseJsonl,
  verifyCaptureBoundary,
} from "./evidence";

describe("handoff probe evidence", () => {
  it("grades the original answer without unrelated handoff recall contamination", () => {
    expect(
      originalAnswerForGrading(
        "<original-answer>250 ms</original-answer>\n<handoff-facts>The stale marker was 500ms.</handoff-facts>",
      ),
    ).toBe("250 ms");
    expect(originalAnswerForGrading("No marked original answer")).toBe("");
  });
  it("reserves remote upper bounds without reporting them as observed submissions", () => {
    const budget = createSubmissionBudget("cycles", false);
    for (let index = 0; index < 6; index++)
      budget.reserve("generation", "remote upper bound");
    expect(() => budget.admit("generation", "excess")).toThrow("cap 6");
    expect(budget.snapshot().submissions).toEqual([]);
  });
  it("rejects sibling-prefix and traversal paths for saved artifact runs", () => {
    expect(() =>
      assertScratchChild("/work/scratch-other/config", "/work/scratch"),
    ).toThrow("inside");
    expect(() =>
      assertScratchChild("/work/scratch/../../live", "/work/scratch"),
    ).toThrow("inside");
    expect(() =>
      assertScratchChild("/work/scratch/run/config", "/work/scratch"),
    ).not.toThrow();
  });
  it("grades original identifiers, rejected approach, pending action and unverified belief", () => {
    expect(gradeHandoffAnswer("Nothing remains").satisfied).toBe(false);
    const retained =
      "HANDOFF-MIG-731 ACCT-4902; rejected rewriting the original archive. Hypothesis: a stale cache might explain delay, unverified. Next: create pending-action-canary.txt.";
    expect(gradeHandoffAnswer(retained)).toEqual({
      satisfied: true,
      missing: [],
      promotedBelief: false,
    });
    expect(
      gradeHandoffAnswer(
        retained.replace(
          "Hypothesis: a stale cache might explain delay, unverified",
          "A stale cache is confirmed as the root cause",
        ),
      ).promotedBelief,
    ).toBe(true);
  });
  it("requires actual empty native inventory correlated to persisted capture ownership", () => {
    const entry = {
      origin: {
        source: "checkpoint_capture",
        checkpointCapture: { captureId: "capture" },
      },
      raw: {
        raw: {
          type: "system",
          subtype: "init",
          tools: [],
          mcp_servers: [],
          plugins: [],
          session_id: "secret-ref",
          model: "observed-model",
        },
      },
    };
    const evidence = captureAuditEvidence(
      JSON.stringify(entry) + "\n",
      "capture",
    );
    expect(evidence.emptyInventoryObserved).toBe(true);
    expect(evidence.auditSeqs).toEqual([0]);
    expect(
      captureAuditEvidence(`\n${JSON.stringify(entry)}\n`, "capture").auditSeqs,
    ).toEqual([1]);
    expect(JSON.stringify(evidence)).not.toContain("secret-ref");
    expect(
      captureAuditEvidence(JSON.stringify(entry), "another")
        .emptyInventoryObserved,
    ).toBe(false);
  });
  it("counts submissions before completion and refuses capture on the default path", () => {
    const budget = createSubmissionBudget("cycles", false);
    expect(() => budget.admit("capture", "forbidden")).toThrow(
      "submission cap 0",
    );
    for (let index = 0; index < 12; index += 1)
      budget.admit("ordinary", String(index));
    expect(() => budget.admit("ordinary", "unrun")).toThrow("incomplete");
    expect(budget.snapshot().submissions).toHaveLength(12);
    expect(budget.snapshot().nativeInferenceRetries).toBeNull();
  });
  it("bounds failure runs independently and never treats native retries as submissions", () => {
    const budget = createSubmissionBudget("failures", true);
    for (let index = 0; index < 8; index += 1)
      budget.admit("capture", String(index));
    expect(() => budget.admit("capture", "ninth")).toThrow("cap 8");
  });
  it("identifies malformed archive coordinates without silently dropping evidence", () => {
    expect(() => parseJsonl('{"ok":true}\ninvalid\n')).toThrow(
      "raw sequence 2",
    );
  });
  it("keeps Unicode separators inside JSON strings", () => {
    expect(parseJsonl('{"text":"a\u2028b\u2029c"}\n')).toEqual([
      { text: "a\u2028b\u2029c" },
    ]);
  });
  it("rejects missing audits, out-of-bound audits and altered frozen bytes", () => {
    expect(
      verifyCaptureBoundary({
        boundary: 7,
        auditSeqs: [],
        seedText: "seed",
        seedSha256: digest("seed"),
      }),
    ).toContain("capture audit evidence absent");
    expect(
      verifyCaptureBoundary({
        boundary: 7,
        auditSeqs: [8],
        seedText: "changed",
        seedSha256: digest("seed"),
      }),
    ).toEqual([
      "capture audit outside final boundary",
      "frozen seed hash mismatch",
    ]);
    expect(
      verifyCaptureBoundary({
        boundary: 7,
        auditSeqs: [6, 7],
        seedText: "seed",
        seedSha256: digest("seed"),
      }),
    ).toEqual([]);
  });
});
