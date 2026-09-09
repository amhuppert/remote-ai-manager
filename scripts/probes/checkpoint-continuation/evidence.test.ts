import { describe, expect, it } from "vitest";

import {
  PUBLIC_ANSWER_EXCERPT_BYTES,
  assertNoProtectedLeak,
  protectedValues,
  refDigest,
  toPublicRunReport,
  type ProbeRunEvidence,
} from "./evidence";

const RETIRED = "01J8ZK4E-retired-provider-session";
const FRESH = "01J8ZK4E-fresh-provider-session";

function evidence(overrides: Partial<ProbeRunEvidence> = {}): ProbeRunEvidence {
  return {
    runId: "run-1",
    backend: "claude",
    scope: "session",
    startedAt: "2026-03-04T09:00:00.000Z",
    finishedAt: "2026-03-04T09:20:00.000Z",
    configDir: "/scratch/config",
    conversationId: "conv-1",
    worktreePath: "/scratch/project",
    transcriptPath: "/scratch/config/transcripts/conv-1.jsonl",
    descriptorCheckpointCapability: { shipped: false, overridden: true },
    modelSelection: null,
    callTotals: {
      ordinary: 9,
      compaction: 6,
      providerReportedCostUsd: 1.5,
      callsWithProviderReportedCost: 14,
      estimatedCostUsd: 0,
      callsWithEstimatedCost: 0,
      costEstimators: [],
      callsWithUnavailableCost: 1,
    },
    calls: [],
    outcome: "passed",
    failures: [],
    cycles: [
      {
        cycle: 1,
        operationId: "op-1",
        ordinal: 1,
        phase: "applied",
        seedSha256: "abc123",
        seedBytes: 4096,
        generationPassCount: 2,
        compactionCostUsd: null,
        priorBackendRef: RETIRED,
        acceptedBackendRef: FRESH,
        queuedMessageIds: [],
        queuedAttemptId: null,
        freshRuntimeEvents: 1,
        freshRuntimeResumeRefs: [false],
        acceptedEvents: 1,
        resumeRefMissingEvents: 0,
        seedReinjectedAfterDelivery: false,
        answers: [
          {
            expectationId: "constraint-excluded-column",
            kind: "constraint",
            question: "Which column?",
            answer: "payer_tax_id",
            satisfied: true,
            missing: [],
            forbidden: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("reference digests", () => {
  it("is stable, distinguishes references, and never contains the reference", () => {
    expect(refDigest(RETIRED)).toBe(refDigest(RETIRED));
    expect(refDigest(RETIRED)).not.toBe(refDigest(FRESH));
    expect(refDigest(RETIRED)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(refDigest(RETIRED)).not.toContain(RETIRED);
  });
});

describe("the public run report", () => {
  it("digests both references and states whether continuity actually moved", () => {
    const report = toPublicRunReport(evidence());
    const cycle = report.cycles[0];
    expect(cycle?.priorBackendRefDigest).toBe(refDigest(RETIRED));
    expect(cycle?.acceptedBackendRefDigest).toBe(refDigest(FRESH));
    expect(cycle?.backendRefUnchanged).toBe(false);
    expect(JSON.stringify(report)).not.toContain(RETIRED);
    expect(JSON.stringify(report)).not.toContain(FRESH);
  });

  it("flags a cycle whose fresh runtime reported the retired reference", () => {
    const same = evidence();
    const report = toPublicRunReport({
      ...same,
      cycles: [{ ...same.cycles[0]!, acceptedBackendRef: RETIRED }],
    });
    expect(report.cycles[0]?.backendRefUnchanged).toBe(true);
  });

  it("keeps the scratch config path out of the published report", () => {
    const report = toPublicRunReport(evidence());
    expect("configDir" in report).toBe(false);
  });

  it("bounds every reproduced answer and keeps its grade intact", () => {
    const base = evidence();
    const long = "x".repeat(PUBLIC_ANSWER_EXCERPT_BYTES + 500);
    const report = toPublicRunReport({
      ...base,
      cycles: [
        {
          ...base.cycles[0]!,
          answers: [
            {
              ...base.cycles[0]!.answers[0]!,
              answer: long,
              satisfied: false,
              missing: ["payer_tax_id"],
            },
          ],
        },
      ],
    });
    const answer = report.cycles[0]?.answers[0];
    expect(answer?.answerExcerpt.length).toBeLessThanOrEqual(
      PUBLIC_ANSWER_EXCERPT_BYTES,
    );
    expect(answer?.satisfied).toBe(false);
    expect(answer?.missing).toEqual(["payer_tax_id"]);
    expect("answer" in (answer ?? {})).toBe(false);
  });

  it("carries unavailable cost through as null, never as zero", () => {
    const report = toPublicRunReport(evidence());
    expect(report.cycles[0]?.compactionCostUsd).toBeNull();
    expect(report.callTotals.callsWithUnavailableCost).toBe(1);
  });
});

describe("leak protection", () => {
  it("lists every raw reference the report must not contain", () => {
    expect([...protectedValues(evidence())].sort()).toEqual(
      [FRESH, RETIRED].sort(),
    );
  });

  it("ignores absent references rather than listing empty secrets", () => {
    const base = evidence();
    const values = protectedValues({
      ...base,
      cycles: [
        { ...base.cycles[0]!, priorBackendRef: null, acceptedBackendRef: null },
      ],
    });
    expect(values).toEqual([]);
  });

  it("throws when a protected value survives into the published text", () => {
    expect(() =>
      assertNoProtectedLeak(`{"ref":"${RETIRED}"}`, [RETIRED]),
    ).toThrow(/protected/i);
    expect(() =>
      assertNoProtectedLeak('{"ref":"sha256:beef"}', [RETIRED]),
    ).not.toThrow();
  });
});
