import { describe, expect, it } from "vitest";
import {
  evaluateDeterministicValidatorCredit,
  evaluateEvidenceFreshness,
  type CandidateState,
  type FreshnessEvidence,
  type GitProbes,
} from "./freshness";
import type { EvidenceKind } from "./schemas";

const candidate: CandidateState = {
  commitSha: "candidate-sha",
  surfaceId: "spec-studio-v2",
};

const createProbes = (
  options: {
    ancestors?: string[];
    treeHashes?: Record<string, string>;
  } = {},
): GitProbes => ({
  async isAncestor(ancestorSha, descendantSha) {
    return (options.ancestors ?? []).includes(
      `${ancestorSha}->${descendantSha}`,
    );
  },
  async relevantTreeHash(commitSha, relevantPaths) {
    const key = `${commitSha}:${[...relevantPaths].sort().join(",")}`;
    return options.treeHashes?.[key] ?? "candidate-tree";
  },
});

const evidence = (
  kind: EvidenceKind,
  overrides: Partial<FreshnessEvidence> = {},
): FreshnessEvidence => ({
  id: `${kind}-evidence`,
  kind,
  producingExecutionState: "running",
  evaluatedState: {
    commitSha: "evidence-sha",
    relevantPaths: ["src/feature.ts"],
    relevantTreeHash: "candidate-tree",
    surfaceId: "spec-studio-v2",
  },
  ...overrides,
});

describe("evaluateEvidenceFreshness", () => {
  it.each(["commit", "diff"] as const)(
    "13.11 keeps %s evidence valid only when it is in candidate history",
    async (kind) => {
      const valid = await evaluateEvidenceFreshness(
        evidence(kind),
        candidate,
        createProbes({ ancestors: ["evidence-sha->candidate-sha"] }),
      );
      const stale = await evaluateEvidenceFreshness(
        evidence(kind),
        candidate,
        createProbes(),
      );

      expect(valid).toEqual({
        status: "valid",
        basis: "candidate_history",
      });
      expect(stale).toEqual({
        status: "stale",
        reason: "not_in_candidate_history",
        action: "attach evidence that resolves into the delivery candidate",
      });
    },
  );

  it.each(["test_run", "validator_verdict"] as const)(
    "13.9 keeps %s evidence valid across a pure rebase with an identical relevant tree",
    async (kind) => {
      const result = await evaluateEvidenceFreshness(
        evidence(kind),
        candidate,
        createProbes({
          treeHashes: {
            "candidate-sha:src/feature.ts": "candidate-tree",
          },
        }),
      );

      expect(result).toEqual({
        status: "valid",
        basis: "identical_relevant_tree",
      });
    },
  );

  it.each(["test_run", "validator_verdict"] as const)(
    "marks %s evidence stale when the relevant candidate tree changed",
    async (kind) => {
      const result = await evaluateEvidenceFreshness(
        evidence(kind),
        candidate,
        createProbes({
          treeHashes: {
            "candidate-sha:src/feature.ts": "changed-tree",
          },
        }),
      );

      expect(result).toEqual({
        status: "stale",
        reason: "relevant_tree_changed",
        action: "rerun validation against the delivery candidate",
      });
    },
  );

  it.each(["screenshot", "human_signoff"] as const)(
    "13.12 keeps %s evidence valid while its captured surface is unchanged",
    async (kind) => {
      const result = await evaluateEvidenceFreshness(
        evidence(kind),
        candidate,
        createProbes(),
      );

      expect(result).toEqual({
        status: "valid",
        basis: "unchanged_surface",
      });
    },
  );

  it.each(["screenshot", "human_signoff"] as const)(
    "13.12 marks %s evidence stale when its captured surface changed",
    async (kind) => {
      const result = await evaluateEvidenceFreshness(
        evidence(kind),
        { ...candidate, surfaceId: "spec-studio-v3" },
        createProbes(),
      );

      expect(result).toEqual({
        status: "stale",
        reason: "surface_changed",
        action: "revalidate, recapture, or explicitly waive the criterion",
      });
    },
  );

  it("13.11 does not let identical trees override commit ancestry", async () => {
    const result = await evaluateEvidenceFreshness(
      evidence("commit"),
      candidate,
      createProbes({
        treeHashes: {
          "candidate-sha:src/feature.ts": "candidate-tree",
        },
      }),
    );

    expect(result).toEqual({
      status: "stale",
      reason: "not_in_candidate_history",
      action: "attach evidence that resolves into the delivery candidate",
    });
  });

  it("13.13 never auto-applies evidence from an abandoned run", async () => {
    const result = await evaluateEvidenceFreshness(
      evidence("test_run", { producingExecutionState: "abandoned" }),
      candidate,
      createProbes(),
    );

    expect(result).toEqual({
      status: "stale",
      reason: "abandoned_run_applicability_unestablished",
      action:
        "establish applicability to this candidate in a later proof verdict",
    });
  });

  it("13.13 allows a later verdict to establish abandoned evidence applicability", async () => {
    const result = await evaluateEvidenceFreshness(
      evidence("test_run", {
        producingExecutionState: "abandoned",
        laterVerdictApplicability: {
          verdictId: "verdict-2",
          candidateSha: "candidate-sha",
        },
      }),
      candidate,
      createProbes(),
    );

    expect(result).toEqual({
      status: "valid",
      basis: "identical_relevant_tree",
    });
  });

  it("requires evaluated tree state for code-evaluated evidence", async () => {
    const result = await evaluateEvidenceFreshness(
      evidence("test_run", {
        evaluatedState: {
          relevantPaths: ["src/feature.ts"],
        },
      }),
      candidate,
      createProbes(),
    );

    expect(result).toEqual({
      status: "stale",
      reason: "missing_relevant_tree_state",
      action: "rerun validation against the delivery candidate",
    });
  });

  it("requires captured surface state for non-deterministic evidence", async () => {
    const result = await evaluateEvidenceFreshness(
      evidence("screenshot", {
        evaluatedState: {
          relevantPaths: [],
        },
      }),
      candidate,
      createProbes(),
    );

    expect(result).toEqual({
      status: "stale",
      reason: "missing_surface_state",
      action: "recapture evidence against the current surface",
    });
  });
});

describe("evaluateDeterministicValidatorCredit", () => {
  it("13.10 credits a passing validation against the exact pre-merge candidate", async () => {
    const result = await evaluateDeterministicValidatorCredit(
      {
        validationRef: "merge-validation-1",
        validatedSha: "candidate-sha",
        validatedTreeHash: "candidate-tree",
        commandIdentity: "bun run test",
        outcome: "pass",
      },
      candidate,
      createProbes(),
    );

    expect(result).toEqual({
      status: "valid",
      basis: "pre_merge_candidate_validation",
    });
  });

  it("13.9 credits validation from an earlier commit when the relevant tree is identical", async () => {
    const result = await evaluateDeterministicValidatorCredit(
      {
        validationRef: "merge-validation-1",
        validatedSha: "candidate-a",
        validatedTreeHash: "candidate-tree",
        commandIdentity: "bun run test",
        outcome: "pass",
      },
      candidate,
      createProbes(),
    );

    expect(result).toEqual({
      status: "valid",
      basis: "pre_merge_candidate_validation",
    });
  });

  it("13.10 refuses credit when the validated candidate tree no longer matches", async () => {
    const result = await evaluateDeterministicValidatorCredit(
      {
        validationRef: "merge-validation-1",
        validatedSha: "candidate-sha",
        validatedTreeHash: "old-tree",
        commandIdentity: "bun run test",
        outcome: "pass",
      },
      candidate,
      createProbes(),
    );

    expect(result).toEqual({
      status: "stale",
      reason: "candidate_validation_tree_changed",
      action: "rerun deterministic validation against the delivery candidate",
    });
  });

  it("13.10 refuses credit for a failed candidate validation", async () => {
    const result = await evaluateDeterministicValidatorCredit(
      {
        validationRef: "merge-validation-1",
        validatedSha: "candidate-sha",
        validatedTreeHash: "candidate-tree",
        commandIdentity: "bun run test",
        outcome: "fail",
      },
      candidate,
      createProbes(),
    );

    expect(result).toEqual({
      status: "stale",
      reason: "candidate_validation_failed",
      action: "rerun deterministic validation against the delivery candidate",
    });
  });
});
