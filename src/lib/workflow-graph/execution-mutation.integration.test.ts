import { runWithLoopFence, StaleLoopFenceError } from "./loop-fence";
import {
  runWithExecutionPrincipalFence,
  ExecutionTurnoverError,
} from "./principal-fence";
import {
  changed,
  eventsOnly,
  refused,
  unchanged,
  type ExecutionMutationDecision,
} from "./execution-mutation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createWorkflowExecution } from "./test-fixtures";
import type { GraphWorkflowSSEEvent } from "./event-schemas";
import {
  prepareLiveExecutionEdits,
  finalizePreparedEdits,
  type LiveEditDeps,
} from "./runtime-edits";

describe("durable graph mutation decisions", () => {
  let fixture: PersistenceFixture;
  const broadcasts: GraphWorkflowSSEEvent[] = [];
  beforeEach(async () => {
    fixture = createPersistenceFixture();
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session-1");
    broadcasts.length = 0;
    await fixture.store.mutateActiveGraphWorkflowExecution(
      "/repo",
      "session-1",
      "fixture.seed",
      () => ({
        kind: "commit",
        value: undefined,
        execution: createWorkflowExecution({
          status: "running",
          executionStateRevision: 7,
        }),
        events: [],
      }),
    );
  });
  afterEach(() => fixture.close());

  function repository() {
    return createGraphWorkflowExecutionRepository({
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      reserveActiveGraphWorkflowExecution:
        fixture.store.reserveActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,

      getGraphWorkflowPendingArtifacts:
        fixture.store.getGraphWorkflowPendingArtifacts,
      clearGraphWorkflowPendingArtifacts:
        fixture.store.clearGraphWorkflowPendingArtifacts,
      eventPublisher: createGraphWorkflowExecutionEventPublisher({
        broadcast: (event) => {
          broadcasts.push(event);
        },
        dispatchPush: () => {},
      }),
    });
  }

  function rows() {
    return {
      execution: fixture.db
        .prepare("SELECT * FROM graph_workflow_executions")
        .all(),
      events: fixture.db.prepare("SELECT * FROM graph_workflow_events").all(),
      deliveries: fixture.db
        .prepare("SELECT * FROM graph_workflow_result_deliveries")
        .all(),
    };
  }

  it("leaves durable state and delivery untouched when an operation has no effect", async () => {
    const before = rows();
    await repository().mutateActive("/repo", "session-1", () => unchanged());
    expect(rows()).toEqual(before);
    expect(broadcasts).toEqual([]);
  });
  async function readExecution() {
    const execution = await fixture.store.getActiveGraphWorkflowExecution(
      "/repo",
      "session-1",
    );
    if (!execution) throw new Error("Fixture execution missing");
    return execution;
  }

  async function delivery() {
    const execution = await readExecution();
    return createGraphWorkflowExecutionEventPublisher().publishCharterUpdated({
      projectPath: "/repo",
      sessionName: "session-1",
      execution,
      definitionId: "workflow-1",
      definitionRevision: 1,
      charterHash: "a".repeat(64),
    });
  }

  it.each(["unchanged", "refused"] as const)(
    "discards a private draft and preserves %s operation data",
    async (kind) => {
      const before = rows();
      const outcome = await repository().mutateActive<
        { reason: string },
        { code: "already_done" }
      >("/repo", "session-1", (draft) => {
        draft.pendingMergeRetry.push("context-plan");
        return kind === "unchanged"
          ? unchanged({ reason: "already done" })
          : refused({ code: "already_done" });
      });
      expect(rows()).toEqual(before);
      expect(outcome.execution.pendingMergeRetry).toEqual([]);
      expect(outcome).toMatchObject(
        kind === "unchanged"
          ? { kind, value: { reason: "already done" } }
          : { kind, refusal: { code: "already_done" } },
      );
      expect(broadcasts).toEqual([]);
    },
  );

  it("commits a change once and returns its operation value", async () => {
    const outcome = await repository().mutateActive(
      "/repo",
      "session-1",
      (draft) => {
        draft.pendingMergeRetry.push("context-plan");
        return changed(draft, { recorded: true });
      },
    );
    expect(outcome).toMatchObject({
      kind: "changed",
      value: { recorded: true },
      execution: {
        executionStateRevision: 8,
        pendingMergeRetry: ["context-plan"],
      },
    });
    expect(await readExecution()).toEqual(outcome.execution);
  });

  it("commits event-only delivery without changing graph content or its structural revision", async () => {
    const before = await readExecution();
    const descriptor = await delivery();
    const outcome = await repository().mutateActive("/repo", "session-1", () =>
      eventsOnly({ notified: true }, descriptor),
    );
    expect(outcome).toMatchObject({
      kind: "events_only",
      value: { notified: true },
    });
    expect(await readExecution()).toEqual({
      ...before,
      executionStateRevision: 8,
    });
    expect(rows().events).toHaveLength(1);
    expect(broadcasts).toEqual(descriptor.events.map((row) => row.event));
  });

  it("refuses empty event-only commits", async () => {
    const before = rows();
    await expect(
      repository().mutateActive("/repo", "session-1", () => ({
        kind: "events_only",
        value: undefined,
        delivery: { events: [], pushes: [] },
      })),
    ).rejects.toThrow("nonempty delivery");
    expect(rows()).toEqual(before);
    expect(broadcasts).toEqual([]);
  });

  it.each(["changed", "events_only", "unchanged", "refused"] as const)(
    "checks both authority fences before a %s reducer",
    async (kind) => {
      const execution = await readExecution();
      const decisions: Record<
        typeof kind,
        ExecutionMutationDecision<void, { code: string }>
      > = {
        changed: changed(execution),
        events_only: eventsOnly(undefined, await delivery()),
        unchanged: unchanged(),
        refused: refused({ code: "declined" }),
      };
      const before = rows();
      let invoked = 0;
      const run = () =>
        repository().mutateActive("/repo", "session-1", () => {
          invoked++;
          return decisions[kind];
        });
      await expect(
        runWithLoopFence(
          {
            projectPath: "/repo",
            sessionName: "session-1",
            executionId: execution.id,
            loopEpoch: execution.loopEpoch + 1,
          },
          run,
        ),
      ).rejects.toBeInstanceOf(StaleLoopFenceError);
      await expect(
        runWithExecutionPrincipalFence(
          {
            projectPath: "/repo",
            sessionName: "session-1",
            executionId: "retired",
            originConversationId: "origin",
            principal: { kind: "conversation", conversationId: "origin" },
          },
          run,
        ),
      ).rejects.toBeInstanceOf(ExecutionTurnoverError);
      expect(invoked).toBe(0);
      expect(rows()).toEqual(before);
      expect(broadcasts).toEqual([]);
    },
  );

  it("delivers nothing when an event-only commit fails", async () => {
    const before = rows();
    const descriptor = await delivery();
    fixture.db.exec(
      "CREATE TRIGGER fail_graph_mutation BEFORE UPDATE ON graph_workflow_executions BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END",
    );
    await expect(
      repository().mutateActive("/repo", "session-1", () =>
        eventsOnly(undefined, descriptor),
      ),
    ).rejects.toThrow("fixture commit failure");
    expect(rows()).toEqual(before);
    expect(broadcasts).toEqual([]);
  });

  async function prepareTaskEdit() {
    await repository().mutateActive("/repo", "session-1", (draft) =>
      changed({ ...draft, status: "paused" }),
    );
    const deps: LiveEditDeps = {
      createTaskId: () => "task-staged",
      now: () => "2026-09-07T12:00:00.000Z",
      resolvedGlobalDefaults() {
        throw new Error("Task edit does not resolve context defaults");
      },
      validationCommandPreflight() {
        throw new Error("Task edit does not select validation commands");
      },
      snapshotFor() {
        throw new Error("Task edit does not introduce assignments");
      },
    };
    const result = prepareLiveExecutionEdits(
      await readExecution(),
      {
        operations: [
          {
            type: "add-task",
            contextId: "context-verify",
            title: "Staged task",
            instructions: "Verify the prepared edit.",
          },
        ],
      },
      deps,
    );
    if (!result.ok)
      throw new Error(
        `Fixture preparation failed: ${JSON.stringify(result.issues)}`,
      );
    return result.prepared;
  }

  it.each(["unchanged", "refused", "events_only", "unrelated_write"] as const)(
    "preserves a prepared edit across %s with the correct commit fence",
    async (kind) => {
      const prepared = await prepareTaskEdit();
      const before = await readExecution();
      const descriptor = await delivery();
      await repository().mutateActive<void, "declined">(
        "/repo",
        "session-1",
        (draft) => {
          switch (kind) {
            case "unchanged":
              return unchanged();
            case "refused":
              return refused("declined");
            case "events_only":
              return eventsOnly(undefined, descriptor);
            case "unrelated_write":
              return changed({ ...draft, pendingMergeRetry: ["context-plan"] });
          }
        },
      );
      const committed = kind === "events_only" || kind === "unrelated_write";
      expect((await readExecution()).executionStateRevision).toBe(
        before.executionStateRevision + (committed ? 1 : 0),
      );
      const outcome = await repository().mutateActive(
        "/repo",
        "session-1",
        (draft) => {
          const finalized = finalizePreparedEdits(draft, prepared);
          if (!finalized.ok)
            throw new Error(
              `Unexpected finalize refusal: ${finalized.outcome}`,
            );
          return changed(finalized.execution, finalized.install);
        },
      );
      expect(outcome).toMatchObject({
        kind: "changed",
        value: committed ? "merged" : "spliced",
      });
      const durable = await readExecution();
      expect(
        durable.workingDefinition.tasks.some(
          (task) => task.id === "task-staged",
        ),
      ).toBe(true);
      expect(durable.pendingMergeRetry).toEqual(
        kind === "unrelated_write" ? ["context-plan"] : [],
      );
      expect(durable.executionStateRevision).toBe(
        before.executionStateRevision + (committed ? 2 : 1),
      );
    },
  );

  it.each(["lifecycle", "structure", "turnover"] as const)(
    "refuses a prepared splice after relevant %s changes",
    async (kind) => {
      const prepared = await prepareTaskEdit();
      if (kind === "turnover") {
        await fixture.store.mutateActiveGraphWorkflowExecution(
          "/repo",
          "session-1",
          "fixture.turnover",
          () => ({
            kind: "commit",
            value: undefined,
            execution: createWorkflowExecution({
              id: "successor",
              status: "paused",
            }),
            events: [],
          }),
        );
      } else {
        await repository().mutateActive("/repo", "session-1", (draft) => {
          if (kind === "lifecycle")
            return changed({ ...draft, status: "running" });
          const task = draft.workingDefinition.tasks.find(
            (task) => task.contextId === "context-verify",
          );
          if (!task) throw new Error("Fixture verify task missing");
          task.title = "Concurrent definition edit";
          return changed(draft);
        });
      }
      const before = rows();
      const outcome = await repository().mutateActive(
        "/repo",
        "session-1",
        (draft) => {
          const finalized = finalizePreparedEdits(draft, prepared);
          if (finalized.ok)
            return changed(finalized.execution, finalized.install);
          return refused(finalized);
        },
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused")
        throw new Error("Prepared splice bypassed a changed witness");
      expect(outcome.refusal).toMatchObject(
        kind === "turnover"
          ? {
              outcome: "refused",
              issues: expect.arrayContaining([
                expect.objectContaining({ code: "execution-mismatch" }),
              ]),
            }
          : {
              outcome: "reprepare",
              reason: {
                kind:
                  kind === "lifecycle"
                    ? "editability_changed"
                    : "structural_changed",
              },
            },
      );
      expect(rows()).toEqual(before);
    },
  );
});
