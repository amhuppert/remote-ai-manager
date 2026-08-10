import { describe, expect, it } from "vitest";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import {
  applyLiveExecutionEdits,
  finalizePreparedEdits,
  prepareLiveExecutionEdits,
  type LiveEditDeps,
  type PreparedLiveEdits,
} from "./runtime-edits";
import { nextStructuralRevision } from "./structural-revision";
import { createWorkflowExecution } from "./test-fixtures";

function makeDeps(overrides: Partial<LiveEditDeps> = {}): LiveEditDeps {
  let counter = 0;
  return {
    createTaskId: () => `task-minted-${(counter += 1)}`,
    resolvedGlobalDefaults() {
      throw new Error("task-only staging does not resolve context defaults");
    },
    validationCommandPreflight() {
      throw new Error("task-only staging does not edit validation selections");
    },
    snapshotFor() {
      throw new Error("task-only staging does not introduce assignments");
    },
    now: () => "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

const ADD_VERIFY_TASK: WorkflowLiveEditOperation[] = [
  {
    type: "add-task",
    contextId: "context-verify",
    title: "Cover the regression",
    instructions: "Add a case for the newly discovered edge condition.",
  },
];

function pausedExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "paused",
    executionStateRevision: 12,
    ...overrides,
  });
}

function prepare(
  execution: GraphWorkflowExecution,
  operations: WorkflowLiveEditOperation[] = ADD_VERIFY_TASK,
  deps: LiveEditDeps = makeDeps(),
): PreparedLiveEdits {
  const result = prepareLiveExecutionEdits(execution, { operations }, deps);
  if (!result.ok) {
    throw new Error(`prepare rejected: ${JSON.stringify(result.issues)}`);
  }
  return result.prepared;
}

/**
 * Mirrors what the repository does on a committed mutation: the reducer runs on
 * a clone and the repository — not the reducer — stamps both fences. It calls
 * the production derivation rather than restating it, so a test can never hand
 * the seam a `structuralRevision` the real repository would not have produced.
 * The stamping itself is proven in `execution-repository.test.ts`.
 */
function commit(
  execution: GraphWorkflowExecution,
  mutate: (draft: GraphWorkflowExecution) => GraphWorkflowExecution,
): GraphWorkflowExecution {
  const next = mutate(structuredClone(execution));
  return {
    ...next,
    executionStateRevision: execution.executionStateRevision + 1,
    structuralRevision: nextStructuralRevision(execution, next),
  };
}

/**
 * The shape of `iteration-orchestrator.appendScriptValidatorRemediationTask`: a
 * RUNTIME writer that appends to the working definition inside `mutateActive`
 * and moves no live-edit field, because failing a pre-merge script is not a live
 * edit. Any definition fence a writer has to remember to bump misses this.
 */
function appendRemediationTask(
  draft: GraphWorkflowExecution,
): GraphWorkflowExecution {
  draft.workingDefinition.tasks.push({
    id: "task-remediation-1",
    contextId: "context-implement",
    order: 2,
    title: "Fix pre-merge validation errors (.cc/logs/pre-merge.log)",
    instructions: "Re-run the pre-merge script and fix what it reports.",
    source: "user",
    metadata: { origin: "script_validator" },
  });
  draft.taskStates["task-remediation-1"] = {
    taskId: "task-remediation-1",
    contextId: "context-implement",
    order: 2,
    status: "pending",
    summary: null,
    startedAt: null,
    completedAt: null,
    lastConversationId: null,
    failureMessage: "pre-merge script failed",
    failureHistory: [],
  };
  return draft;
}

/** A scheduler tick that starts context-plan — untouched by the staged batch. */
function startPlanContext(
  draft: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return {
    ...draft,
    activeContextIds: ["context-plan"],
    contextStates: {
      ...draft.contextStates,
      "context-plan": {
        ...draft.contextStates["context-plan"]!,
        status: "running",
        iterationCount: 1,
        worktreePath: "/repo/.worktrees/lane-plan",
      },
    },
  };
}

function verifyTaskTitles(execution: GraphWorkflowExecution): string[] {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === "context-verify")
    .map((task) => task.title);
}

describe("prepareLiveExecutionEdits", () => {
  it("produces the same accepted result applyLiveExecutionEdits does", () => {
    const execution = pausedExecution();

    const staged = prepareLiveExecutionEdits(
      execution,
      { operations: ADD_VERIFY_TASK },
      makeDeps(),
    );
    const direct = applyLiveExecutionEdits(
      execution,
      { operations: ADD_VERIFY_TASK },
      makeDeps(),
    );

    expect(staged.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (!staged.ok || !direct.ok) return;
    expect(staged.prepared.execution).toEqual(direct.execution);
    expect(staged.prepared.affectedContextIds).toEqual(
      direct.affectedContextIds,
    );
    expect(staged.prepared.baseStateRevision).toBe(12);
    expect(staged.prepared.executionId).toBe(execution.id);
  });

  it("rejects with the same code applyLiveExecutionEdits rejects with", () => {
    const execution = pausedExecution();

    const staged = prepareLiveExecutionEdits(
      execution,
      {
        operations: [
          {
            type: "add-task",
            contextId: "context-missing",
            title: "Orphan",
            instructions: "No such context.",
          },
        ],
      },
      makeDeps(),
    );

    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.code).toBe("invalid_edit");
    expect(staged.issues[0]).toMatchObject({ code: "unknown-context" });
  });

  it("leaves the snapshot it validated against unmutated", () => {
    const execution = pausedExecution();
    const before = structuredClone(execution);

    prepare(execution);

    expect(execution).toEqual(before);
  });
});

describe("finalizePreparedEdits — unchanged fence", () => {
  it("splices the prepared whole state when nothing committed in between", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    const result = finalizePreparedEdits(execution, prepared);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.install).toBe("spliced");
    expect(result.execution).toBe(prepared.execution);
    expect(result.affectedContextIds).toEqual(["context-verify"]);
    expect(verifyTaskTitles(result.execution)).toEqual([
      "Run checks",
      "Cover the regression",
    ]);
  });

  it("cannot be handed a graph the frontier validation never saw", () => {
    // The splice path installs the prepared state verbatim, so that state must
    // not be editable after validation — otherwise a cycle (or anything else
    // Kahn acyclicity refuses) could be smuggled past the fence.
    const execution = pausedExecution();
    const prepared = prepare(execution);

    expect(() =>
      prepared.execution.workingDefinition.edges.push({
        id: "edge-verify-plan",
        sourceContextId: "context-verify",
        targetContextId: "context-plan",
      }),
    ).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error deliberately assigning through the readonly token
      prepared.execution = { ...prepared.execution, liveRevision: 99 };
    }).toThrow(TypeError);

    const result = finalizePreparedEdits(execution, prepared);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.execution.workingDefinition.edges.map((edge) => edge.id),
    ).toEqual(["edge-plan-implement", "edge-implement-verify"]);
  });
});

describe("finalizePreparedEdits — interleaved mutation", () => {
  it("never erases a scheduler mutation committed between prepare and finalize", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    const current = commit(execution, startPlanContext);

    // The prepared whole state was computed before the tick, so splicing it
    // would silently roll context-plan back. That is exactly what the fence
    // exists to prevent.
    expect(prepared.execution.contextStates["context-plan"]?.status).toBe(
      "pending",
    );

    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.install).toBe("merged");
    // The scheduler's write survives...
    expect(result.execution.contextStates["context-plan"]).toMatchObject({
      status: "running",
      iterationCount: 1,
      worktreePath: "/repo/.worktrees/lane-plan",
    });
    expect(result.execution.activeContextIds).toEqual(["context-plan"]);
    // ...and so does the staged edit.
    expect(verifyTaskTitles(result.execution)).toEqual([
      "Run checks",
      "Cover the regression",
    ]);
    expect(
      result.execution.contextStates["context-verify"]?.totalTaskCount,
    ).toBe(2);
  });

  it("installs the identifiers prepare minted rather than drawing fresh ones", () => {
    const execution = pausedExecution();
    // A caller that inspects the prepared state must get the same ids back from
    // the install, so the merge may not re-draw from the id source.
    const prepared = prepare(execution, ADD_VERIFY_TASK, makeDeps());
    const preparedTaskId = prepared.execution.workingDefinition.tasks.find(
      (task) => task.title === "Cover the regression",
    )?.id;
    expect(preparedTaskId).toBe("task-minted-1");

    const current = commit(execution, startPlanContext);
    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.install).toBe("merged");
    expect(
      result.execution.workingDefinition.tasks.find(
        (task) => task.title === "Cover the regression",
      )?.id,
    ).toBe("task-minted-1");
    expect(result.execution.taskStates["task-minted-1"]).toMatchObject({
      contextId: "context-verify",
      status: "pending",
    });
  });

  it("installs the same batch when the same token is finalized twice", () => {
    // The write queue may retry a reducer, so a token has to survive being
    // finalized more than once rather than being consumed by the first attempt.
    // Each attempt gets its own draft, exactly as `mutateActive` re-clones for
    // every reducer run.
    const execution = pausedExecution();
    const prepared = prepare(execution);
    const current = commit(execution, startPlanContext);

    const first = finalizePreparedEdits(structuredClone(current), prepared);
    const second = finalizePreparedEdits(structuredClone(current), prepared);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.install).toBe("merged");
    expect(second.execution).toEqual(first.execution);
  });

  it("writes into the draft it is given rather than rebuilding the state maps", () => {
    // The ownership contract, pinned: finalize installs into the reducer's own
    // execution. Rebuilding those maps instead would mean copying every context
    // and task in the execution while holding the global write lock.
    const execution = pausedExecution();
    const prepared = prepare(execution);
    const draft = commit(execution, startPlanContext);
    const contextStatesBefore = draft.contextStates;
    const taskStatesBefore = draft.taskStates;

    const result = finalizePreparedEdits(draft, prepared);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.execution).toBe(draft);
    expect(result.execution.contextStates).toBe(contextStatesBefore);
    expect(result.execution.taskStates).toBe(taskStatesBefore);
    expect(draft.taskStates["task-minted-1"]).toBeDefined();
  });

  it("leaves the draft untouched when it signals reprepare", () => {
    // Preconditions are checked before the first write, so a caller can retry
    // on the draft it already has.
    const execution = pausedExecution();
    const prepared = prepare(execution);
    const draft = commit(execution, appendRemediationTask);
    const before = structuredClone(draft);

    const result = finalizePreparedEdits(draft, prepared);

    expect(result.ok).toBe(false);
    expect(draft).toEqual(before);
  });

  it("re-applies onto the newest state across several interleaved commits", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    let current = commit(execution, startPlanContext);
    current = commit(current, (draft) => ({
      ...draft,
      taskStates: {
        ...draft.taskStates,
        "task-plan-1": {
          ...draft.taskStates["task-plan-1"]!,
          status: "completed",
          summary: "Planned",
        },
      },
      contextStates: {
        ...draft.contextStates,
        "context-plan": {
          ...draft.contextStates["context-plan"]!,
          completedTaskCount: 1,
          status: "completed",
        },
      },
      activeContextIds: [],
    }));

    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.install).toBe("merged");
    expect(result.execution.contextStates["context-plan"]).toMatchObject({
      status: "completed",
      completedTaskCount: 1,
    });
    expect(verifyTaskTitles(result.execution)).toEqual([
      "Run checks",
      "Cover the regression",
    ]);
  });

  it("never erases a definition write from a runtime writer that moves no live-edit field", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    const current = commit(execution, appendRemediationTask);
    // The interleaving is invisible to `liveRevision` — that is the whole point.
    expect(current.liveRevision).toBe(execution.liveRevision);
    expect(
      prepared.execution.workingDefinition.tasks.some(
        (task) => task.id === "task-remediation-1",
      ),
    ).toBe(false);

    const result = finalizePreparedEdits(current, prepared);

    // Installing the prepared definition over this would delete the remediation
    // task while keeping its task state — a runtime map that names a task the
    // definition no longer has. The seam must refuse to guess.
    if (result.ok) {
      expect(
        result.execution.workingDefinition.tasks.map((task) => task.id),
      ).toContain("task-remediation-1");
    } else {
      expect(result.outcome).toBe("reprepare");
      if (result.outcome !== "reprepare") return;
      expect(result.reason).toEqual({ kind: "structural_changed" });
    }
  });

  it("installs without reading the definition or the runtime blobs", () => {
    // finalize runs inside the write queue, so the staging seam is only worth
    // having if the fenced half stays payload-local. Booby-trap the structures a
    // whole-state pass would have to touch and prove the merge never reaches
    // them. A deep clone, a definition walk, or a full re-validation all trip
    // this.
    const execution = pausedExecution();
    const prepared = prepare(execution);
    const committed = commit(execution, startPlanContext);

    /** Any read at all is a whole-structure read for these. */
    function noReads<T extends object>(label: string): ProxyHandler<T> {
      return {
        get(_target, property) {
          throw new Error(
            `finalize traversed ${label}.${String(property)} under the fence`,
          );
        },
      };
    }
    /**
     * Reading or writing ONE entry is O(payload) and allowed; listing the keys
     * is the O(every context in the execution) traversal. `ownKeys` is exactly
     * that line — a `{...map}` spread, `Object.keys`/`entries`/`values`, and a
     * deep-compare of the whole map all go through it, while indexing a single
     * id does not.
     */
    function noEnumeration<T extends object>(label: string): ProxyHandler<T> {
      return {
        ownKeys: () => {
          throw new Error(
            `finalize enumerated all of ${label} under the fence`,
          );
        },
      };
    }

    const current: GraphWorkflowExecution = {
      ...committed,
      workingDefinition: new Proxy(
        committed.workingDefinition,
        noReads("workingDefinition"),
      ),
      laneStates: new Proxy(committed.laneStates, noReads("laneStates")),
      lanePlan: new Proxy(committed.lanePlan, noReads("lanePlan")),
      contextStates: new Proxy(
        committed.contextStates,
        noEnumeration("contextStates"),
      ),
      taskStates: new Proxy(committed.taskStates, noEnumeration("taskStates")),
    };

    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.install).toBe("merged");
    expect(verifyTaskTitles(result.execution)).toEqual([
      "Run checks",
      "Cover the regression",
    ]);
    // The staged edit landed in the map without the map being rebuilt...
    expect(result.execution.taskStates["task-minted-1"]).toMatchObject({
      contextId: "context-verify",
      status: "pending",
    });
    expect(result.execution.contextStates["context-verify"]).toMatchObject({
      totalTaskCount: 2,
    });
    // ...and the interleaved commit's entry is still there.
    expect(result.execution.contextStates["context-plan"]).toMatchObject({
      status: "running",
    });
    // The untouched blob is carried across by reference, never rebuilt.
    expect(result.execution.laneStates).toBe(current.laneStates);
  });
});

describe("finalizePreparedEdits — reprepare signals", () => {
  it("signals reprepare rather than overwriting a field the batch also rewrites", () => {
    // A merge installs only the fields the batch rewrote. If an interleaved
    // commit rewrote one of those SAME fields, merging would erase it, so the
    // collision has to surface instead.
    // context-verify is already `started`, so its lifecycle does not move and
    // the field collision itself is what has to be caught.
    const base = pausedExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-verify": {
          ...base.contextStates["context-verify"]!,
          status: "running",
          iterationCount: 1,
        },
      },
    };
    const prepared = prepare(execution);
    expect(
      prepared.delta.contextStates.changed["context-verify"]?.set,
    ).toMatchObject({ totalTaskCount: 2 });

    const current = commit(execution, (draft) => ({
      ...draft,
      contextStates: {
        ...draft.contextStates,
        "context-verify": {
          ...draft.contextStates["context-verify"]!,
          totalTaskCount: 5,
        },
      },
    }));

    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("reprepare");
    if (result.outcome !== "reprepare") return;
    expect(result.reason).toEqual({
      kind: "concurrent_write",
      field: "contextStates.context-verify.totalTaskCount",
    });
  });

  it("signals reprepare when a context the batch depends on changed lifecycle", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    const current = commit(execution, (draft) => ({
      ...draft,
      activeContextIds: ["context-verify"],
      contextStates: {
        ...draft.contextStates,
        "context-verify": {
          ...draft.contextStates["context-verify"]!,
          status: "running",
          iterationCount: 1,
        },
      },
    }));

    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("reprepare");
    if (result.outcome !== "reprepare") return;
    expect(result.reason).toEqual({
      kind: "context_lifecycle_changed",
      contextId: "context-verify",
    });
  });

  it("signals reprepare when the working definition moved under the batch", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    // Another accepted live edit landed first — its own liveRevision bump plus
    // the changed definition invalidate this batch's structural evidence.
    const interleaved = applyLiveExecutionEdits(
      execution,
      {
        operations: [
          {
            type: "add-task",
            contextId: "context-implement",
            title: "Concurrent addition",
            instructions: "Landed while the other batch was staged.",
          },
        ],
      },
      makeDeps(),
    );
    expect(interleaved.ok).toBe(true);
    if (!interleaved.ok) return;
    const current = commit(execution, () => ({
      ...interleaved.execution,
      liveRevision: interleaved.execution.liveRevision + 1,
    }));

    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("reprepare");
    if (result.outcome !== "reprepare") return;
    expect(result.reason).toEqual({ kind: "structural_changed" });
  });

  it("signals reprepare when the execution stopped being quiescent", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    const current = commit(execution, (draft) => ({
      ...draft,
      status: "running",
    }));

    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("reprepare");
    if (result.outcome !== "reprepare") return;
    expect(result.reason).toEqual({ kind: "editability_changed" });
  });

  it("signals reprepare when a task the batch renumbers was locked in between", () => {
    // context-implement is already `started`, so the task's own lock — not its
    // context's lifecycle — is the signal that moves.
    const base = pausedExecution();
    const execution: GraphWorkflowExecution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-implement": {
          ...base.contextStates["context-implement"]!,
          status: "running",
          iterationCount: 1,
        },
      },
    };
    // Inserting at the head renumbers the existing sibling, so that sibling is
    // part of the batch's footprint even though no op names it.
    const prepared = prepare(execution, [
      {
        type: "add-task",
        contextId: "context-implement",
        title: "Land this first",
        instructions: "Runs ahead of the existing work.",
        position: { at: "start" },
      },
    ]);
    expect(
      prepared.delta.taskStates.changed["task-implement-1"]?.set,
    ).toMatchObject({ order: 2 });

    const current = commit(execution, (draft) => ({
      ...draft,
      taskStates: {
        ...draft.taskStates,
        "task-implement-1": {
          ...draft.taskStates["task-implement-1"]!,
          status: "running",
        },
      },
    }));

    const result = finalizePreparedEdits(current, prepared);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("reprepare");
    if (result.outcome !== "reprepare") return;
    expect(result.reason).toEqual({
      kind: "task_lock_changed",
      taskId: "task-implement-1",
    });
  });
});

describe("finalizePreparedEdits — refusals", () => {
  it("refuses under a pending halt reason even when the fence is unchanged", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    const halting: GraphWorkflowExecution = {
      ...execution,
      pendingHaltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: "3 consecutive failures",
      },
    };

    const result = finalizePreparedEdits(halting, prepared);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.code).toBe("pending_halt");
  });

  it("refuses when the active execution was replaced under the batch", () => {
    const execution = pausedExecution();
    const prepared = prepare(execution);

    const successor = commit(execution, (draft) => ({
      ...draft,
      id: "execution-2",
    }));

    const result = finalizePreparedEdits(successor, prepared);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.code).toBe("execution_mismatch");
  });
});

describe("the staging seam over the real repository fence", () => {
  function makeRepo() {
    const sessions = new Map<string, SessionState>();
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast() {},
    });

    function session(projectPath: string, sessionName: string): SessionState {
      const key = `${projectPath}:${sessionName}`;
      let entry = sessions.get(key);
      if (!entry) {
        entry = {
          worktreePath: "/repo/.worktrees/session-1",
          graphWorkflowExecution: null,
        } as unknown as SessionState;
        sessions.set(key, entry);
      }
      return entry;
    }

    const repo = createGraphWorkflowExecutionRepository({
      async getSession(projectPath, sessionName) {
        return session(projectPath, sessionName);
      },
      async getActiveGraphWorkflowExecution(projectPath, sessionName) {
        return session(projectPath, sessionName).graphWorkflowExecution;
      },
      async mutateActiveGraphWorkflowExecution(
        projectPath,
        sessionName,
        _label,
        mutate,
      ) {
        const entry = session(projectPath, sessionName);
        const { execution, events, pushes } = mutate(
          entry.graphWorkflowExecution,
        );
        entry.graphWorkflowExecution = execution;
        return { execution, delivery: { events, pushes: pushes ?? [] } };
      },
      async archiveActiveGraphWorkflowExecution() {
        return { archived: false as const, reason: "no_active" as const };
      },
      async markGraphWorkflowContextEventsPreReset() {
        return 0;
      },
      eventPublisher,
    });

    return { repo, session };
  }

  it("keeps an interleaved repository commit when the staged batch installs", async () => {
    const { repo, session } = makeRepo();
    session("/repo", "session-1").graphWorkflowExecution = pausedExecution();

    // Prepare outside the lock, against the snapshot the read accessor returns.
    const snapshot = await repo.getActive("/repo", "session-1");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const prepared = prepare(snapshot);

    // A real scheduler commit lands in between and moves the repository fence.
    const ticked = await repo.mutateActive("/repo", "session-1", (execution) =>
      startPlanContext(execution),
    );
    expect(ticked.executionStateRevision).toBe(prepared.baseStateRevision + 1);

    // Finalize inside a reducer, exactly where a staged caller would.
    let install: string | undefined;
    const committed = await repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => {
        const result = finalizePreparedEdits(execution, prepared);
        if (!result.ok) {
          throw new Error(`finalize did not install: ${result.outcome}`);
        }
        install = result.install;
        return result.execution;
      },
    );

    expect(install).toBe("merged");
    expect(committed.contextStates["context-plan"]).toMatchObject({
      status: "running",
      iterationCount: 1,
    });
    expect(verifyTaskTitles(committed)).toEqual([
      "Run checks",
      "Cover the regression",
    ]);
    expect(committed.executionStateRevision).toBe(
      prepared.baseStateRevision + 2,
    );
  });

  it("commits a spliced install through the repository unchanged", async () => {
    // The splice path hands the reducer the frozen prepared state, so the
    // repository's own parse + event derivation has to accept it as-is.
    const { repo, session } = makeRepo();
    session("/repo", "session-1").graphWorkflowExecution = pausedExecution();

    const snapshot = await repo.getActive("/repo", "session-1");
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const prepared = prepare(snapshot);

    let install: string | undefined;
    const committed = await repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => {
        const result = finalizePreparedEdits(execution, prepared);
        if (!result.ok) {
          throw new Error(`finalize did not install: ${result.outcome}`);
        }
        install = result.install;
        return result.execution;
      },
    );

    expect(install).toBe("spliced");
    expect(verifyTaskTitles(committed)).toEqual([
      "Run checks",
      "Cover the regression",
    ]);
    expect(committed.executionStateRevision).toBe(
      prepared.baseStateRevision + 1,
    );
  });
});
