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
    // Retained-historical field: kept parseable on persisted rows but never
    // read by any dispatch path — its presence must not affect evaluation.
    surfaceId: "spec-studio-v2",
  },
  ...overrides,
});

describe("evaluateEvidenceFreshness", () => {
  it("13.11 keeps commit evidence valid only when it is in candidate history", async () => {
    const valid = await evaluateEvidenceFreshness(
      evidence("commit"),
      candidate,
      createProbes({ ancestors: ["evidence-sha->candidate-sha"] }),
    );
    const stale = await evaluateEvidenceFreshness(
      evidence("commit"),
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
      action: "produce evidence that resolves into the delivery candidate",
    });
  });

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
      action: "produce evidence that resolves into the delivery candidate",
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

  it.each(["test_run", "validator_verdict"] as const)(
    "F24 treats ingested %s evidence with a lane commitSha as fresh when it is in candidate history",
    async (kind) => {
      const result = await evaluateEvidenceFreshness(
        evidence(kind, {
          evaluatedState: {
            commitSha: "evidence-sha",
            relevantPaths: [],
          },
        }),
        candidate,
        createProbes({ ancestors: ["evidence-sha->candidate-sha"] }),
      );

      expect(result).toEqual({
        status: "valid",
        basis: "candidate_history",
      });
    },
  );

  it.each(["test_run", "validator_verdict"] as const)(
    "F24 marks ingested %s evidence stale when its lane commit is not in candidate history",
    async (kind) => {
      const result = await evaluateEvidenceFreshness(
        evidence(kind, {
          evaluatedState: {
            commitSha: "evidence-sha",
            relevantPaths: [],
          },
        }),
        candidate,
        createProbes(),
      );

      expect(result).toEqual({
        status: "stale",
        reason: "not_in_candidate_history",
        action: "produce evidence that resolves into the delivery candidate",
      });
    },
  );

  it("marks machine evidence with neither commit nor tree state stale as missing_commit_state", async () => {
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
      reason: "missing_commit_state",
      action: "produce evidence that resolves into the delivery candidate",
    });
  });

  it("still routes machine evidence with tree state through the tree-identity check", async () => {
    const result = await evaluateEvidenceFreshness(
      evidence("validator_verdict", {
        evaluatedState: {
          commitSha: "evidence-sha",
          relevantPaths: ["src/feature.ts"],
          relevantTreeHash: "old-tree",
        },
      }),
      candidate,
      // The evidence sha IS an ancestor: the tree route must still win and
      // report the tree drift rather than fall back to ancestry freshness.
      createProbes({
        ancestors: ["evidence-sha->candidate-sha"],
        treeHashes: { "candidate-sha:src/feature.ts": "changed-tree" },
      }),
    );

    expect(result).toEqual({
      status: "stale",
      reason: "relevant_tree_changed",
      action: "rerun validation against the delivery candidate",
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
