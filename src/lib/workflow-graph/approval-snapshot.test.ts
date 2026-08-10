import { describe, expect, it } from "vitest";
import type { SessionDiff } from "@/lib/git/schemas";
import { resolveApprovalSnapshot } from "./approval-snapshot";
import { createWorkflowExecution } from "./test-fixtures";
import type { ValidationDiffScope } from "./validation-diff-scope";
import type { GraphWorkflowExecution } from "./schemas";

const CONTEXT_ID = "context-implement";
const LANE_WORKTREE = "/wt/lane-impl";
const FROZEN_TREE_HASH = "owned-digest-frozen";

const OWNED_DIFF: SessionDiff = {
  files: [
    {
      filePath: "src/api/handler.ts",
      additions: 2,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,3 +1,4 @@",
          lines: [
            { type: "hunk-header", content: "@@ -1,3 +1,4 @@" },
            { type: "add", content: "export const handler = 2;" },
          ],
        },
      ],
    },
  ],
  totalAdditions: 2,
  totalDeletions: 1,
};

function parkedExecution(
  opts: {
    ownedPaths?: string[] | null;
    status?: "awaiting_approval" | "running";
    decided?: boolean;
    worktreePath?: string | null;
  } = {},
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({ status: "running" });
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === CONTEXT_ID,
  );
  if (!context) throw new Error("fixture context missing");
  const ownedPaths = opts.ownedPaths;
  context.placement =
    ownedPaths === null || ownedPaths === undefined
      ? { lane: "solo", mode: "full" }
      : { lane: "impl", mode: "owned", ownedPaths };
  context.humanApprovalGate = { enabled: true };

  const contextState = execution.contextStates[CONTEXT_ID];
  if (!contextState) throw new Error("fixture context state missing");
  contextState.status = opts.status ?? "awaiting_approval";
  contextState.worktreePath =
    opts.worktreePath === undefined ? LANE_WORKTREE : opts.worktreePath;
  contextState.pendingApproval = {
    conversationId: "conv-1",
    requestedAt: "2026-08-08T09:00:00.000Z",
    decision: opts.decided
      ? { type: "approved", decidedAt: "2026-08-08T09:05:00.000Z" }
      : null,
    approvalScope:
      ownedPaths === null || ownedPaths === undefined
        ? { kind: "whole_tree" }
        : {
            kind: "scoped",
            ownedPaths,
            treeHash: FROZEN_TREE_HASH,
            headSha: "base-sha",
          },
  };
  return execution;
}

function scopeReader(scope: ValidationDiffScope) {
  const seen: { worktreePath: string; scope: unknown }[] = [];
  return {
    seen,
    deps: {
      async computeDiffScope(worktreePath: string, candidateScope: unknown) {
        seen.push({ worktreePath, scope: candidateScope });
        return scope;
      },
    },
  };
}

describe("resolveApprovalSnapshot", () => {
  it("feeds the approval payload the owned-path-scoped diff read under the frozen scope", async () => {
    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      treeHash: FROZEN_TREE_HASH,
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: ["src/api"] }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution).toEqual({
      kind: "scoped",
      snapshot: {
        contextId: CONTEXT_ID,
        ownedPaths: ["src/api"],
        treeHash: FROZEN_TREE_HASH,
        diff: OWNED_DIFF,
      },
    });
    // Read from the context's own lane worktree, under exactly the frozen
    // ownership — not the session worktree and not the whole tree.
    expect(reader.seen).toEqual([
      {
        worktreePath: LANE_WORKTREE,
        scope: { mode: "owned", ownedPaths: ["src/api"] },
      },
    ]);
  });

  it("carries an empty scoped read as an empty diff rather than an unavailable payload", async () => {
    const reader = scopeReader({
      kind: "empty",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      treeHash: FROZEN_TREE_HASH,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: ["src/api"] }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution).toEqual({
      kind: "scoped",
      snapshot: {
        contextId: CONTEXT_ID,
        ownedPaths: ["src/api"],
        treeHash: FROZEN_TREE_HASH,
        diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
      },
    });
  });

  it("refuses to render bytes that are not the frozen candidate", async () => {
    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      treeHash: "owned-digest-moved",
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: ["src/api"] }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution).toEqual({
      kind: "drifted",
      contextId: CONTEXT_ID,
      frozenTreeHash: FROZEN_TREE_HASH,
      observedTreeHash: "owned-digest-moved",
    });
  });

  it("keeps the frozen scoped view after the placement is live-edited to full access", async () => {
    // A parked gate froze a candidate under an envelope. Pausing the execution
    // and live-editing the context to full access must not re-scope the bytes
    // the human is deciding on: the decision belongs to the candidate that was
    // frozen, so the answer comes from the PARKED record, not from a placement
    // that moved underneath it.
    const execution = parkedExecution({ ownedPaths: ["src/api"] });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === CONTEXT_ID,
    );
    if (!context) throw new Error("fixture context missing");
    context.placement = { lane: "solo", mode: "full" };

    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      treeHash: FROZEN_TREE_HASH,
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution,
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution).toEqual({
      kind: "scoped",
      snapshot: {
        contextId: CONTEXT_ID,
        ownedPaths: ["src/api"],
        treeHash: FROZEN_TREE_HASH,
        diff: OWNED_DIFF,
      },
    });
  });

  it("leaves a full-access member on the whole-tree approval view", async () => {
    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "wholeTree" },
      treeHash: "tree",
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: null }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution).toEqual({ kind: "whole_tree", contextId: CONTEXT_ID });
    // Nothing is read: the whole-tree view is the one the session already has.
    expect(reader.seen).toEqual([]);
  });

  it("falls back to the session worktree for an enveloped context with no lane worktree recorded", async () => {
    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      treeHash: FROZEN_TREE_HASH,
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    await resolveApprovalSnapshot(
      {
        execution: parkedExecution({
          ownedPaths: ["src/api"],
          worktreePath: null,
        }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(reader.seen[0]?.worktreePath).toBe("/wt/session");
  });

  it("never falls back to the whole tree for an enveloped member whose freeze failed", async () => {
    const execution = parkedExecution({ ownedPaths: ["src/api"] });
    const pending = execution.contextStates[CONTEXT_ID]?.pendingApproval;
    if (!pending) throw new Error("fixture missing pending approval");
    pending.approvalScope = {
      kind: "unreadable",
      reason: "the candidate tree could not be read at freeze time",
    };
    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "wholeTree" },
      treeHash: "tree",
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution,
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution.kind).toBe("unavailable");
    expect(reader.seen).toEqual([]);
  });

  it("scopes a read-only member to its empty change set rather than the shared worktree", async () => {
    const execution = parkedExecution({ ownedPaths: ["src/api"] });
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === CONTEXT_ID,
    );
    if (!context) throw new Error("fixture context missing");
    context.placement = { lane: "session", mode: "readOnly" };
    const pending = execution.contextStates[CONTEXT_ID]?.pendingApproval;
    if (!pending) throw new Error("fixture missing pending approval");
    pending.approvalScope = {
      kind: "scoped",
      ownedPaths: [],
      treeHash: FROZEN_TREE_HASH,
      headSha: "base-sha",
    };
    const reader = scopeReader({
      kind: "empty",
      candidateScope: { mode: "owned", ownedPaths: [] },
      treeHash: FROZEN_TREE_HASH,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution,
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution).toEqual({
      kind: "scoped",
      snapshot: {
        contextId: CONTEXT_ID,
        ownedPaths: [],
        treeHash: FROZEN_TREE_HASH,
        diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
      },
    });
    expect(reader.seen[0]?.scope).toEqual({ mode: "owned", ownedPaths: [] });
  });

  it("reports an unreadable candidate instead of an empty change set", async () => {
    const reader = scopeReader({
      kind: "unavailable",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      reason: "the candidate tree could not be read",
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: ["src/api"] }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution).toEqual({
      kind: "unavailable",
      reason: "the candidate tree could not be read",
    });
  });

  it.each([
    ["a context that is not parked", { status: "running" as const }],
    ["a context whose decision is already recorded", { decided: true }],
  ])("refuses %s", async (_label, opts) => {
    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      treeHash: FROZEN_TREE_HASH,
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: ["src/api"], ...opts }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution.kind).toBe("not_awaiting_approval");
    expect(reader.seen).toEqual([]);
  });

  it("refuses to answer for a gate other than the one parked", async () => {
    // The caller is rendering an earlier gate. Answering with the CURRENT
    // gate's bytes under that identity would show one candidate while the
    // approve control acts on another.
    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      treeHash: FROZEN_TREE_HASH,
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: ["src/api"] }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
        requestedAt: "2026-08-08T11:00:00.000Z",
      },
      reader.deps,
    );

    expect(resolution.kind).toBe("gate_superseded");
    expect(reader.seen).toEqual([]);
  });

  it("answers when the caller names the gate that is parked", async () => {
    const reader = scopeReader({
      kind: "available",
      candidateScope: { mode: "owned", ownedPaths: ["src/api"] },
      treeHash: FROZEN_TREE_HASH,
      diff: OWNED_DIFF,
      fileCount: 1,
      totalAdditions: 2,
      totalDeletions: 1,
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: ["src/api"] }),
        contextId: CONTEXT_ID,
        sessionWorktreePath: "/wt/session",
        requestedAt: "2026-08-08T09:00:00.000Z",
      },
      reader.deps,
    );

    expect(resolution.kind).toBe("scoped");
  });

  it("refuses an unknown context", async () => {
    const reader = scopeReader({
      kind: "empty",
      candidateScope: { mode: "wholeTree" },
      treeHash: "tree",
    });

    const resolution = await resolveApprovalSnapshot(
      {
        execution: parkedExecution({ ownedPaths: ["src/api"] }),
        contextId: "context-missing",
        sessionWorktreePath: "/wt/session",
      },
      reader.deps,
    );

    expect(resolution.kind).toBe("unknown_context");
  });
});
