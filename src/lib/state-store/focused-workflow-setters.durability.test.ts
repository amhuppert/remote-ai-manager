/**
 * Durability backstop for the focused single-column workflow setters
 * (`mutateSessionWorkflowLanes` / `mutateSessionWorkflowEnvelopes`). These
 * exist to skip the whole-state read/validate/diff cycle and, crucially, to
 * avoid re-serializing every other session column on a single-key write.
 *
 * Each test runs against `createPersistenceFixture()` — real repos over a fresh
 * `:memory:` DB — so the assertions exercise a genuine repository ↔ SQLite
 * round-trip. The session also has a non-trivial active graph-workflow execution
 * (in the dedicated graph_workflow_executions table) so we can prove that a
 * focused lane/envelope write leaves the execution untouched (i.e. it was never
 * rewritten by the focused path).
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { _createTestDb, _createTestDbAtPath } from "@/lib/state-store/state-db";
import { createStateStore } from "@/lib/state-store/store";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import type { GraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import type { GraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import type { GraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { captureStoreInventory } from "@/lib/shared/testing/store-inventory";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  graphWorkflowBoundaryEventSchema,
  graphWorkflowExecutionEventSchema,
  type GraphWorkflowBoundaryKind,
} from "@/lib/workflow-graph/event-schemas";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function makeExecution(
  overrides: Record<string, unknown> = {},
): GraphWorkflowExecution {
  return graphWorkflowExecutionSchema.parse({
    id: "wf-exec-1",
    origin: {
      kind: "template",
      definitionId: "seed-1",
      definitionRevision: 3,
      tier: "project",
    },
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 3,
    workingDefinition: {},
    charter: makeTestCharter(),
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
});

afterEach(() => {
  fixture.close();
});

async function seedSessionWithExecution(
  overrides: Partial<SessionState> = {},
): Promise<void> {
  fixture.seedSession(PROJECT_PATH, SESSION_NAME, overrides);
  // The active execution lives in the dedicated graph_workflow_executions table
  // (no longer on the session row), seeded via the real setter.
  await fixture.store.mutateActiveGraphWorkflowExecution(
    PROJECT_PATH,
    SESSION_NAME,
    "test.seed-active-execution",
    () => ({ execution: makeExecution(), events: [] }),
  );
}

function boundaryEvent(
  execution: GraphWorkflowExecution,
  boundaryKind: GraphWorkflowBoundaryKind,
) {
  return graphWorkflowExecutionEventSchema.parse({
    occurredAt: "2026-08-14T12:00:00.000Z",
    preReset: false,
    event: graphWorkflowBoundaryEventSchema.parse({
      type: "graph-workflow-boundary",
      projectName: "p1",
      sessionName: SESSION_NAME,
      executionId: execution.id,
      boundaryKind,
      workflowStatus: execution.status,
      contextId:
        boundaryKind === "context_approval" || boundaryKind === "lane_question"
          ? "context-plan"
          : null,
      pendingActions: [{ kind: `act-${boundaryKind}` }],
      outputProjection: { "context-plan": { value: boundaryKind } },
    }),
  });
}

describe("graph-workflow boundary result atomicity", () => {
  const cases: ReadonlyArray<{
    kind: GraphWorkflowBoundaryKind;
    status: GraphWorkflowExecution["status"];
  }> = [
    { kind: "definition_approval", status: "pending" },
    { kind: "context_approval", status: "running" },
    { kind: "lane_question", status: "running" },
    { kind: "pause", status: "paused" },
    { kind: "halt", status: "halted" },
    { kind: "abandon", status: "halted" },
    { kind: "completion", status: "completed" },
    { kind: "abort", status: "aborted" },
  ];

  it.each(cases)(
    "records the $kind boundary event and origin delivery in one mutation",
    async ({ kind, status }) => {
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      const initial = makeExecution({
        id: `wf-${kind}`,
        ownerConversationId: "conv-origin",
      });
      await fixture.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.seed-boundary",
        () => ({ execution: initial, events: [] }),
      );
      const next = makeExecution({
        ...initial,
        status,
        ...(status === "completed" || status === "aborted"
          ? { completedAt: "2026-08-14T12:00:00.000Z" }
          : {}),
        ...(kind === "abandon"
          ? {
              abandonment: {
                abandonedAt: "2026-08-14T12:00:00.000Z",
                actor: { kind: "human" },
                reason: "No longer needed",
              },
            }
          : {}),
      });

      const committed = await fixture.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        `test.boundary-${kind}`,
        () => ({ execution: next, events: [boundaryEvent(next, kind)] }),
      );

      const boundary = fixture.graphWorkflowEvents
        .findRecordsByExecution(PROJECT_PATH, SESSION_NAME, next.id)
        .find((record) => record.event.type === "graph-workflow-boundary");
      expect(boundary).toBeDefined();
      expect(committed.delivery.publications).toEqual([
        {
          type: "graph-workflow-result-recorded",
          projectName: "p1",
          sessionName: SESSION_NAME,
          executionId: next.id,
          originConversationId: "conv-origin",
          boundaryCursor: boundary!.id,
        },
      ]);
      const delivery = createGraphWorkflowResultDeliveriesRepo(
        fixture.db,
      ).findByBoundary(PROJECT_PATH, SESSION_NAME, next.id, boundary!.id);
      expect(delivery).toMatchObject({
        executionId: next.id,
        boundarySeq: boundary!.id,
        originConversationId: "conv-origin",
        state: "pending",
        payload: {
          status,
          boundaryKind: kind,
          pendingActions: [{ kind: `act-${kind}` }],
          outputs: {
            kind: "declared_outputs",
            byContext: { "context-plan": { value: kind } },
          },
        },
      });
    },
  );

  it("records halt and completion around a delivery-free resume in cursor order", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    const running = makeExecution({ ownerConversationId: "conv-origin" });
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seed-boundary-sequence",
      () => ({ execution: running, events: [] }),
    );
    const halted = makeExecution({ ...running, status: "halted" });
    const completed = makeExecution({
      ...running,
      status: "completed",
      completedAt: "2026-08-14T12:00:00.000Z",
    });
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.halt",
      () => ({ execution: halted, events: [boundaryEvent(halted, "halt")] }),
    );
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.resume",
      () => ({ execution: running, events: [] }),
    );
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.complete",
      () => ({
        execution: completed,
        events: [boundaryEvent(completed, "completion")],
      }),
    );

    const deliveries = createGraphWorkflowResultDeliveriesRepo(
      fixture.db,
    ).listByExecution(PROJECT_PATH, SESSION_NAME, running.id);
    expect(deliveries.map((delivery) => delivery.payload.boundaryKind)).toEqual(
      ["halt", "completion"],
    );
    expect(deliveries[0]!.boundarySeq).toBeLessThan(deliveries[1]!.boundarySeq);
  });

  it("rolls back state and event writes when result recording fails", async () => {
    const db = _createTestDb({ inMemory: true });
    const realDeliveries = createGraphWorkflowResultDeliveriesRepo(db);
    const failingDeliveries: GraphWorkflowResultDeliveriesRepo = {
      ...realDeliveries,
      record() {
        throw new Error("injected result-delivery failure");
      },
    };
    const localFixture = createPersistenceFixture({ db });
    const store = createStateStore({
      db,
      writeQueue: createWriteQueue(),
      repos: { graphWorkflowResultDeliveries: failingDeliveries },
    });
    try {
      localFixture.seedProject(PROJECT_PATH);
      localFixture.seedSession(PROJECT_PATH, SESSION_NAME);
      const running = makeExecution({ ownerConversationId: "conv-origin" });
      await store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.seed-failure",
        () => ({ execution: running, events: [] }),
      );
      const paused = makeExecution({ ...running, status: "paused" });

      await expect(
        store.mutateActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
          "test.delivery-failure",
          () => ({
            execution: paused,
            events: [boundaryEvent(paused, "pause")],
          }),
        ),
      ).rejects.toThrow("injected result-delivery failure");

      expect(
        (
          await store.getActiveGraphWorkflowExecution(
            PROJECT_PATH,
            SESSION_NAME,
          )
        )?.status,
      ).toBe("running");
      expect(
        createGraphWorkflowEventsRepo(db).findByExecution(
          PROJECT_PATH,
          SESSION_NAME,
          running.id,
        ),
      ).toEqual([]);
      expect(
        realDeliveries.listByExecution(PROJECT_PATH, SESSION_NAME, running.id),
      ).toEqual([]);
    } finally {
      localFixture.close();
    }
  });

  it("rolls back the execution write when boundary event insertion fails", async () => {
    const db = _createTestDb({ inMemory: true });
    const realEvents = createGraphWorkflowEventsRepo(db);
    const failingEvents: GraphWorkflowEventsRepo = {
      ...realEvents,
      appendMany(projectPath, sessionName, executionId, occurredAt, events) {
        if (
          events.some((event) => event.event.type === "graph-workflow-boundary")
        ) {
          throw new Error("injected boundary-event failure");
        }
        return realEvents.appendMany(
          projectPath,
          sessionName,
          executionId,
          occurredAt,
          events,
        );
      },
    };
    const localFixture = createPersistenceFixture({ db });
    const store = createStateStore({
      db,
      writeQueue: createWriteQueue(),
      repos: { graphWorkflowEvents: failingEvents },
    });
    try {
      localFixture.seedProject(PROJECT_PATH);
      localFixture.seedSession(PROJECT_PATH, SESSION_NAME);
      const running = makeExecution({ ownerConversationId: "conv-origin" });
      await store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.seed-event-failure",
        () => ({ execution: running, events: [] }),
      );
      const paused = makeExecution({ ...running, status: "paused" });

      await expect(
        store.mutateActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
          "test.event-failure",
          () => ({
            execution: paused,
            events: [boundaryEvent(paused, "pause")],
          }),
        ),
      ).rejects.toThrow("injected boundary-event failure");

      expect(
        (
          await store.getActiveGraphWorkflowExecution(
            PROJECT_PATH,
            SESSION_NAME,
          )
        )?.status,
      ).toBe("running");
      expect(
        createGraphWorkflowResultDeliveriesRepo(db).listByExecution(
          PROJECT_PATH,
          SESSION_NAME,
          running.id,
        ),
      ).toEqual([]);
    } finally {
      localFixture.close();
    }
  });

  it("archives an abandonment with its boundary event and delivery atomically", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    const halted = makeExecution({
      ownerConversationId: "conv-origin",
      status: "halted",
    });
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seed-abandon",
      () => ({ execution: halted, events: [] }),
    );

    const outcome = await fixture.store.archiveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      { reason: "abandoned", actor: "human" },
      (execution) => execution.id === halted.id,
      (execution) => ({
        ...execution,
        abandonment: {
          abandonedAt: "2026-08-14T12:00:00.000Z",
          actor: { kind: "human" },
          reason: "No longer needed",
        },
      }),
    );

    expect(outcome.archived).toBe(true);
    const boundary = fixture.graphWorkflowEvents
      .findRecordsByExecution(PROJECT_PATH, SESSION_NAME, halted.id)
      .find((record) => record.event.type === "graph-workflow-boundary");
    expect(boundary?.event).toMatchObject({ boundaryKind: "abandon" });
    expect(
      createGraphWorkflowResultDeliveriesRepo(fixture.db).findByBoundary(
        PROJECT_PATH,
        SESSION_NAME,
        halted.id,
        boundary!.id,
      ),
    ).not.toBeNull();
  });

  it("rolls back abandonment archival when its result delivery cannot be recorded", async () => {
    const db = _createTestDb({ inMemory: true });
    const realDeliveries = createGraphWorkflowResultDeliveriesRepo(db);
    const failingDeliveries: GraphWorkflowResultDeliveriesRepo = {
      ...realDeliveries,
      record() {
        throw new Error("injected archive-delivery failure");
      },
    };
    const localFixture = createPersistenceFixture({ db });
    const store = createStateStore({
      db,
      writeQueue: createWriteQueue(),
      repos: { graphWorkflowResultDeliveries: failingDeliveries },
    });
    try {
      localFixture.seedProject(PROJECT_PATH);
      localFixture.seedSession(PROJECT_PATH, SESSION_NAME);
      const halted = makeExecution({
        ownerConversationId: "conv-origin",
        status: "halted",
      });
      await store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.seed-archive-failure",
        () => ({ execution: halted, events: [] }),
      );

      await expect(
        store.archiveActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
          { reason: "abandoned", actor: "human" },
          (execution) => execution.id === halted.id,
          (execution) => ({
            ...execution,
            abandonment: {
              abandonedAt: "2026-08-14T12:00:00.000Z",
              actor: { kind: "human" },
              reason: "No longer needed",
            },
          }),
        ),
      ).rejects.toThrow("injected archive-delivery failure");

      expect(
        (
          await store.getActiveGraphWorkflowExecution(
            PROJECT_PATH,
            SESSION_NAME,
          )
        )?.abandonment,
      ).toBeNull();
      expect(
        await store.listArchivedGraphWorkflowExecutions(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toEqual([]);
      expect(
        realDeliveries.listByExecution(PROJECT_PATH, SESSION_NAME, halted.id),
      ).toEqual([]);
      expect(
        createGraphWorkflowEventsRepo(db).findByExecution(
          PROJECT_PATH,
          SESSION_NAME,
          halted.id,
        ),
      ).toEqual([]);
    } finally {
      localFixture.close();
    }
  });
});

/**
 * The authoritative lease reservation (D7 R3.1-R3.5, R5.2). These run against
 * real SQLite because the claim is transactional: exactly one of two concurrent
 * launches installs a row, a refusal commits nothing at all, and a lease-free
 * incumbent's normalization is atomic with the winner's installation. A
 * JS-object fake cannot prove any of the three.
 */
describe("reserveActiveGraphWorkflowExecution — authoritative lease CAS", () => {
  it("installs the reservation when the session has no incumbent", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    const execution = makeExecution({ id: "wf-winner", status: "pending" });

    const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.reserve",
      { execution, events: [] },
    );

    expect(outcome).toMatchObject({ reserved: true, normalized: null });
    const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(reloaded?.id).toBe("wf-winner");
  });

  it("admits exactly one of two concurrent reservations and refuses the loser with the winner", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);

    const [first, second] = await Promise.all([
      fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.reserve-a",
        {
          execution: makeExecution({ id: "wf-a", status: "pending" }),
          events: [],
        },
      ),
      fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.reserve-b",
        {
          execution: makeExecution({ id: "wf-b", status: "pending" }),
          events: [],
        },
      ),
    ]);

    const outcomes = [first, second];
    const reserved = outcomes.filter((outcome) => outcome.reserved === true);
    const refused = outcomes.filter((outcome) => outcome.reserved === false);
    expect(reserved).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const winnerId =
      reserved[0]!.reserved === true ? reserved[0]!.execution.id : "";
    expect(refused[0]).toMatchObject({
      reserved: false,
      refusal: {
        kind: "refuse",
        incumbent: { executionId: winnerId },
      },
    });

    // The loser persisted nothing: one active row, no archived row, and no
    // event carrying its id.
    const reloaded = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(reloaded?.id).toBe(winnerId);
    const loserId = winnerId === "wf-a" ? "wf-b" : "wf-a";
    expect(
      fixture.graphWorkflowEvents.findByExecution(
        PROJECT_PATH,
        SESSION_NAME,
        loserId,
      ),
    ).toEqual([]);
    expect(
      fixture.graphWorkflowArchivedExecutions.listBySession(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).toEqual([]);
  });

  /**
   * Seed a physical incumbent into the active row without events, so a later
   * reservation's audit trail is provably the reservation's own.
   */
  async function seedIncumbent(
    overrides: Record<string, unknown>,
  ): Promise<void> {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seed-incumbent",
      () => ({
        execution: makeExecution({ id: "wf-incumbent", ...overrides }),
        events: [],
      }),
    );
  }

  const RESUMABLE_HALT = {
    type: "execution_loop_failed",
    contextId: null,
    cause: "unknown",
    message: "halted",
  };

  /**
   * Every physical shape the active row can hold, split by the ONE predicate
   * that decides tenure. Enumerating both `halted` rows is the point: they are
   * identical in status and opposite in tenure, which is precisely what the
   * superseded status-only slot rule could not see — it reported every halted
   * run as slot-owning. Abandonment is the same trap from the other side: a
   * status-only reader calls the abandoned row a lease holder forever.
   */
  const LEASE_FREE_INCUMBENTS: ReadonlyArray<{
    label: string;
    overrides: Record<string, unknown>;
    status: string;
  }> = [
    {
      label: "completed",
      overrides: { status: "completed" },
      status: "completed",
    },
    { label: "aborted", overrides: { status: "aborted" }, status: "aborted" },
    {
      label: "non-resumably halted",
      overrides: {
        status: "halted",
        haltReason: { type: "recovery_error", message: "unrecoverable" },
      },
      status: "halted",
    },
    {
      label: "abandoned resumable halt",
      overrides: {
        status: "halted",
        haltReason: RESUMABLE_HALT,
        abandonment: {
          abandonedAt: "2026-01-02T00:00:00Z",
          actor: { kind: "human" },
          reason: "superseded by a newer plan",
        },
      },
      status: "halted",
    },
  ];

  const LEASE_HELD_INCUMBENTS: ReadonlyArray<{
    label: string;
    overrides: Record<string, unknown>;
    status: string;
    remedy: string;
  }> = [
    {
      label: "pending",
      overrides: { status: "pending" },
      status: "pending",
      remedy: "inspect_or_pause",
    },
    {
      label: "running",
      overrides: { status: "running" },
      status: "running",
      remedy: "inspect_or_pause",
    },
    {
      label: "paused",
      overrides: { status: "paused" },
      status: "paused",
      remedy: "inspect_or_pause",
    },
    {
      label: "pending awaiting definition approval",
      overrides: {
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-01-01T00:00:00Z",
          approvedAt: null,
        },
      },
      status: "pending",
      remedy: "approve_or_abort",
    },
    {
      label: "resumably halted",
      overrides: { status: "halted", haltReason: RESUMABLE_HALT },
      status: "halted",
      remedy: "resume_or_abandon",
    },
  ];

  it.each(LEASE_FREE_INCUMBENTS)(
    "normalizes a lease-free $label incumbent into readable History in the reserving transaction",
    async ({ overrides, status }) => {
      await seedIncumbent(overrides);

      const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.reserve-over-lease-free",
        {
          execution: makeExecution({ id: "wf-next", status: "pending" }),
          events: [],
        },
      );

      expect(outcome).toMatchObject({
        reserved: true,
        normalized: { executionId: "wf-incumbent", status },
      });
      expect(
        (
          await fixture.store.getActiveGraphWorkflowExecution(
            PROJECT_PATH,
            SESSION_NAME,
          )
        )?.id,
      ).toBe("wf-next");

      // "Readable History" is a round-trip claim, not a row-exists claim: the
      // relocated record must still parse as a whole execution, because History
      // renders it by id long after the template it came from is gone.
      const archived = fixture.graphWorkflowArchivedExecutions.findByExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "wf-incumbent",
      );
      expect(archived?.status).toBe(status);
      expect(archived?.id).toBe("wf-incumbent");
      expect(() => graphWorkflowExecutionSchema.parse(archived)).not.toThrow();
      // The list projection History actually renders must contain it too — a
      // record only `findByExecution` can reach is not in History.
      expect(
        fixture.graphWorkflowArchivedExecutions
          .listBySession(PROJECT_PATH, SESSION_NAME)
          .map((record) => record.id),
      ).toEqual(["wf-incumbent"]);

      // Exactly ONE durable audit row, and it is a release — never a rewrite of
      // the record itself (R3.4).
      const releases = fixture.graphWorkflowEvents
        .findByExecution(PROJECT_PATH, SESSION_NAME, "wf-incumbent")
        .filter(
          (record) => record.event.type === "graph-workflow-execution-released",
        );
      expect(releases).toHaveLength(1);
      expect(releases[0]?.event).toMatchObject({
        reason: "normalized_on_admission",
        executionId: "wf-incumbent",
        status,
      });
    },
  );

  it.each(LEASE_HELD_INCUMBENTS)(
    "refuses over a lease-holding $label incumbent, leaving it byte-identical and committing nothing",
    async ({ overrides, status, remedy }) => {
      await seedIncumbent(overrides);
      const before = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      const eventsBefore = fixture.graphWorkflowEvents.findByExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "wf-incumbent",
      ).length;

      const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.reserve-blocked",
        {
          execution: makeExecution({ id: "wf-blocked", status: "pending" }),
          events: [],
        },
      );

      expect(outcome).toMatchObject({
        reserved: false,
        refusal: {
          kind: "refuse",
          incumbent: { executionId: "wf-incumbent", status },
          remedy,
        },
      });

      // Byte-identical: a refusal must not end, hide, or rewrite live work, so
      // the reloaded row is compared whole rather than field-by-field.
      const after = await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(after).toEqual(before);
      expect(
        fixture.graphWorkflowEvents.findByExecution(
          PROJECT_PATH,
          SESSION_NAME,
          "wf-incumbent",
        ),
      ).toHaveLength(eventsBefore);
      expect(
        fixture.graphWorkflowEvents.findByExecution(
          PROJECT_PATH,
          SESSION_NAME,
          "wf-blocked",
        ),
      ).toEqual([]);
      expect(
        fixture.graphWorkflowArchivedExecutions.listBySession(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toEqual([]);
    },
  );

  /**
   * Guard the guard. Every zero-write assertion below is an EQUALITY against a
   * snapshot, so an inventory that covered no tables — or one blind to the
   * tables a launch writes — would make them all vacuously true. These two
   * prove the instrument has scope and sensitivity before it is trusted.
   */
  it("inventories the graph-workflow stores a launch could write to", async () => {
    await seedIncumbent({ status: "running" });

    const inventory = captureStoreInventory(fixture.db);

    expect(Object.keys(inventory)).toEqual(
      expect.arrayContaining([
        "graph_workflow_executions",
        "graph_workflow_events",
        "graph_workflow_archived_executions",
        "graph_workflow_result_deliveries",
      ]),
    );
    expect(inventory["graph_workflow_executions"]).toHaveLength(1);
  });

  it("registers a real write, so an unchanged inventory is evidence rather than blindness", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    const before = captureStoreInventory(fixture.db);

    const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.reserve-admitted",
      {
        execution: makeExecution({ id: "wf-admitted", status: "pending" }),
        events: [],
      },
    );

    expect(outcome.reserved).toBe(true);
    expect(captureStoreInventory(fixture.db)).not.toEqual(before);
  });

  /**
   * R5.2 as a whole-database claim rather than a per-table one. The assertions
   * above name the stores they know about; this one names none, so a refusal
   * that wrote a queued-launch row, a definition, a result-delivery, or a
   * bookkeeping row in some table these tests never heard of still fails here.
   */
  it.each(LEASE_HELD_INCUMBENTS)(
    "leaves the ENTIRE store byte-identical when a launch is refused over a $label incumbent",
    async ({ overrides }) => {
      await seedIncumbent(overrides);
      const before = captureStoreInventory(fixture.db);

      const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.reserve-blocked-inventory",
        {
          execution: makeExecution({ id: "wf-blocked", status: "pending" }),
          events: [],
        },
      );

      expect(outcome.reserved).toBe(false);
      expect(captureStoreInventory(fixture.db)).toEqual(before);
    },
  );

  /**
   * The refusal shape the other inventory cases cannot reach: an incumbent
   * whose stored record is LEGACY-shaped.
   *
   * Every case above seeds through the store, so every row is already current.
   * A real database holds rows written before the current schema, and the
   * ordinary read path upgrades those in place — a read-repair WRITE. On the
   * admission read that is a refused launch mutating the very incumbent it was
   * refused for, which R5.2 forbids outright; worse, the upgrade forced any
   * non-paused record to `paused`, so it could hand admission a fabricated
   * lease holder.
   *
   * Seeded by raw insert because that is the only way to produce the shape:
   * anything written through the store is current by construction.
   */
  /**
   * Raw-insert a legacy-shaped incumbent. `lease_held` is deliberately left at
   * 1 for every status: it is a derived projection, and a stale terminal row
   * left in the active position is exactly the case where the physical column
   * disagrees with the canonical predicate. Admission must believe the
   * predicate.
   */
  function seedLegacyIncumbent(status: string, completedAt: string | null) {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    // `activeContextId` (singular) is the legacy marker the decoder trips on.
    const legacyRecord = {
      ...JSON.parse(
        JSON.stringify(
          makeExecution({ id: "wf-legacy-incumbent", status, completedAt }),
        ),
      ),
      activeContextId: "ctx-a",
    };
    delete legacyRecord.activeContextIds;
    fixture.db
      .prepare(
        `INSERT INTO graph_workflow_executions (
           project_path, session_name, execution_id, seed_definition_id,
           seed_definition_revision, started_at, status, completed_at,
           definition_json, runtime_json, updated_at, lease_held
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        PROJECT_PATH,
        SESSION_NAME,
        "wf-legacy-incumbent",
        "seed-1",
        3,
        "2026-01-01T00:00:00Z",
        status,
        completedAt,
        "{}",
        JSON.stringify(legacyRecord),
        "2026-01-01T00:00:00Z",
        1,
      );
  }

  it("leaves the ENTIRE store byte-identical when a launch is refused over a legacy-shaped incumbent", async () => {
    seedLegacyIncumbent("running", null);
    const before = captureStoreInventory(fixture.db);

    const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.reserve-blocked-legacy",
      {
        execution: makeExecution({ id: "wf-blocked", status: "pending" }),
        events: [],
      },
    );

    expect(outcome.reserved).toBe(false);
    expect(
      outcome.reserved === false && outcome.refusal.incumbent.executionId,
    ).toBe("wf-legacy-incumbent");
    expect(captureStoreInventory(fixture.db)).toEqual(before);
  });

  /**
   * The lease-free half of the same shape, composed end to end. The cases above
   * each cover one link — the admission read reports a legacy row's true
   * status, and a lease-free incumbent normalizes into History — but the defect
   * these replaced lived in their JOIN: the read's repair rewrote a settled
   * legacy row to `paused`, so admission classified it as a lease holder and
   * refused. Only a settled LEGACY incumbent driven through a real reservation
   * shows that, which is why it is asserted here rather than left to compose.
   */
  it.each(["completed", "aborted"] as const)(
    "normalizes a legacy-shaped %s incumbent into History instead of refusing the launch",
    async (status) => {
      seedLegacyIncumbent(status, "2026-01-03T00:00:00Z");

      const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.reserve-over-legacy-settled",
        {
          execution: makeExecution({ id: "wf-next", status: "pending" }),
          events: [],
        },
      );

      expect(outcome).toMatchObject({
        reserved: true,
        normalized: { executionId: "wf-legacy-incumbent", status },
      });
      expect(
        (
          await fixture.store.getActiveGraphWorkflowExecution(
            PROJECT_PATH,
            SESSION_NAME,
          )
        )?.id,
      ).toBe("wf-next");

      // Relocated intact and readable: History renders the record by id, so it
      // must still parse whole — and carry its own settled status, not the
      // `paused` the superseded read-repair would have stamped on it.
      const archived = fixture.graphWorkflowArchivedExecutions.findByExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "wf-legacy-incumbent",
      );
      expect(archived?.status).toBe(status);
      expect(() => graphWorkflowExecutionSchema.parse(archived)).not.toThrow();

      const releases = fixture.graphWorkflowEvents
        .findByExecution(PROJECT_PATH, SESSION_NAME, "wf-legacy-incumbent")
        .filter(
          (record) => record.event.type === "graph-workflow-execution-released",
        );
      expect(releases).toHaveLength(1);
      expect(releases[0]?.event).toMatchObject({
        reason: "normalized_on_admission",
        status,
      });
    },
  );

  /**
   * THE structural guarantee behind R3.5: the incumbent read that decides
   * admission happens INSIDE the immediate transaction that installs the winner.
   *
   * This is asserted directly rather than by racing two callers, and
   * deliberately so. better-sqlite3 is synchronous, so two reservations started
   * together in one process still run end-to-end in sequence — a wall-clock race
   * cannot interleave them, and a "concurrent" test therefore passes just as
   * happily when the read sits outside the transaction (verified: restoring that
   * defect leaves every such test green). What actually distinguishes the two is
   * WHERE the read happens, so that is what this measures: with the read outside,
   * `db.inTransaction` is false at read time and a second connection can slip a
   * winner in between the read and the write.
   */
  it("performs the admission read inside the immediate transaction", async () => {
    const db = _createTestDb({ inMemory: true });
    const realExecutions = createGraphWorkflowExecutionsRepo(db);
    let inTransactionAtReadTime: boolean | null = null;
    let cachedReadsInsideTransaction = 0;
    const observingExecutions: GraphWorkflowExecutionsRepo = {
      ...realExecutions,
      getActive(projectPath, sessionName) {
        // The CAS must not decide from the cached reader; counting its use
        // inside the lock is what keeps this test honest if the call reverts.
        if (db.inTransaction) cachedReadsInsideTransaction += 1;
        return realExecutions.getActive(projectPath, sessionName);
      },
      getActiveAuthoritative(projectPath, sessionName) {
        inTransactionAtReadTime = db.inTransaction;
        return realExecutions.getActiveAuthoritative(projectPath, sessionName);
      },
    };
    const fixtureWithProbe = createPersistenceFixture({ db });
    const store = createStateStore({
      db,
      writeQueue: createWriteQueue(),
      repos: { graphWorkflowExecutions: observingExecutions },
    });
    try {
      fixtureWithProbe.seedProject(PROJECT_PATH);
      fixtureWithProbe.seedSession(PROJECT_PATH, SESSION_NAME);

      const outcome = await store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.read-inside-transaction",
        {
          execution: makeExecution({ id: "wf-inside", status: "pending" }),
          events: [],
        },
      );

      expect(outcome.reserved).toBe(true);
      expect(inTransactionAtReadTime).toBe(true);
      expect(cachedReadsInsideTransaction).toBe(0);
    } finally {
      fixtureWithProbe.close();
    }
  });

  it("admits exactly one winner across two independent SQLite connections", async () => {
    const dbPath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cc-lease-race-")),
      "state.db",
    );
    const clientA = createPersistenceFixture({
      db: _createTestDbAtPath(dbPath),
    });
    const clientB = createPersistenceFixture({
      db: _createTestDbAtPath(dbPath),
    });
    try {
      clientA.seedProject(PROJECT_PATH);
      clientA.seedSession(PROJECT_PATH, SESSION_NAME);

      const [first, second] = await Promise.all([
        clientA.store.reserveActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
          "test.cross-connection-a",
          {
            execution: makeExecution({ id: "wf-conn-a", status: "pending" }),
            events: [],
          },
        ),
        clientB.store.reserveActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
          "test.cross-connection-b",
          {
            execution: makeExecution({ id: "wf-conn-b", status: "pending" }),
            events: [],
          },
        ),
      ]);

      const outcomes = [first, second];
      const winners = outcomes.filter((outcome) => outcome.reserved);
      const losers = outcomes.filter((outcome) => !outcome.reserved);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      const winnerId = winners[0]?.reserved ? winners[0].execution.id : "";
      const loserId = winnerId === "wf-conn-a" ? "wf-conn-b" : "wf-conn-a";
      // The loser's blocker names the run that actually committed, not merely
      // "something else won".
      expect(
        losers[0]?.reserved === false &&
          losers[0].refusal.incumbent.executionId,
      ).toBe(winnerId);

      // Read the committed truth through a THIRD connection, so the assertion
      // cannot be satisfied by either client's in-memory row cache.
      const reader = createPersistenceFixture({
        db: _createTestDbAtPath(dbPath),
      });
      try {
        expect(
          (
            await reader.store.getActiveGraphWorkflowExecution(
              PROJECT_PATH,
              SESSION_NAME,
            )
          )?.id,
        ).toBe(winnerId);
        const inventory = captureStoreInventory(reader.db);
        const loserTraces = Object.entries(inventory).flatMap(([table, rows]) =>
          rows
            .filter((row) => row.includes(loserId))
            .map((row) => `${table}: ${row}`),
        );
        expect(loserTraces).toEqual([]);
      } finally {
        reader.close();
      }
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  /**
   * The production race, which the cold-cache version above cannot reach.
   *
   * Every launch is preceded by an advisory `getActive` read — the manager asks
   * whether a lease is free before it tries to take it. That read populates the
   * repository's per-connection parsed-row cache, and the cache is invalidated
   * only by writes made through the SAME connection. So both processes can cache
   * "no incumbent", and the second reservation's `BEGIN IMMEDIATE` then serves
   * its admission decision out of that stale cache instead of querying SQLite:
   * it takes the write lock, never looks, and overwrites the committed winner.
   *
   * The transaction is only an authoritative recheck if the read inside it goes
   * to the database. Warming both caches first is what proves it does.
   */
  it("admits one winner when both connections cached an empty lease", async () => {
    const dbPath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cc-lease-warm-race-")),
      "state.db",
    );
    const clientA = createPersistenceFixture({
      db: _createTestDbAtPath(dbPath),
    });
    const clientB = createPersistenceFixture({
      db: _createTestDbAtPath(dbPath),
    });
    try {
      clientA.seedProject(PROJECT_PATH);
      clientA.seedSession(PROJECT_PATH, SESSION_NAME);

      // The advisory pre-launch read, on both connections, before either
      // reserves: this is what caches the emptiness that the CAS must not trust.
      expect(
        await clientA.store.getActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toBeNull();
      expect(
        await clientB.store.getActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toBeNull();

      // Sequential, not raced: better-sqlite3 is synchronous, so awaiting the
      // first reservation to completion is the STRONGEST version of this test.
      // The winner is fully committed and visible in SQLite before the second
      // caller starts, so nothing but a stale cache can make it admit.
      const first = await clientA.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.warm-cache-a",
        {
          execution: makeExecution({ id: "wf-warm-a", status: "pending" }),
          events: [],
        },
      );
      const second = await clientB.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.warm-cache-b",
        {
          execution: makeExecution({ id: "wf-warm-b", status: "pending" }),
          events: [],
        },
      );

      expect(first.reserved).toBe(true);
      expect(second.reserved).toBe(false);
      expect(
        second.reserved === false && second.refusal.incumbent.executionId,
      ).toBe("wf-warm-a");

      const reader = createPersistenceFixture({
        db: _createTestDbAtPath(dbPath),
      });
      try {
        // The live incumbent was neither replaced nor rewritten (R3.4).
        expect(
          (
            await reader.store.getActiveGraphWorkflowExecution(
              PROJECT_PATH,
              SESSION_NAME,
            )
          )?.id,
        ).toBe("wf-warm-a");
        const inventory = captureStoreInventory(reader.db);
        const loserTraces = Object.entries(inventory).flatMap(([table, rows]) =>
          rows
            .filter((row) => row.includes("wf-warm-b"))
            .map((row) => `${table}: ${row}`),
        );
        expect(loserTraces).toEqual([]);
      } finally {
        reader.close();
      }
    } finally {
      clientA.close();
      clientB.close();
    }
  });

  it("leaves the race loser with no persisted trace of any kind", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);

    const [first, second] = await Promise.all([
      fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.race-a",
        {
          execution: makeExecution({ id: "wf-a", status: "pending" }),
          events: [],
        },
      ),
      fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.race-b",
        {
          execution: makeExecution({ id: "wf-b", status: "pending" }),
          events: [],
        },
      ),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((outcome) => outcome.reserved);
    const losers = outcomes.filter((outcome) => !outcome.reserved);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winnerId = winners[0]?.reserved ? winners[0].execution.id : "";
    const loserId = winnerId === "wf-a" ? "wf-b" : "wf-a";
    // The loser's refusal names the winner, so the operator is told who holds
    // the lease rather than merely that they lost.
    expect(
      losers[0]?.reserved === false && losers[0].refusal.incumbent,
    ).toMatchObject({ executionId: winnerId });

    // Nowhere in the database does the loser's id appear: not as an execution,
    // an archive, an event, a delivery, or a queued launch. Scanning the whole
    // serialized store is what makes "no partial record" checkable rather than
    // merely asserted table by table.
    const inventory = captureStoreInventory(fixture.db);
    const loserTraces = Object.entries(inventory).flatMap(([table, rows]) =>
      rows
        .filter((row) => row.includes(loserId))
        .map((row) => `${table}: ${row}`),
    );
    expect(loserTraces).toEqual([]);
    expect(
      (
        await fixture.store.getActiveGraphWorkflowExecution(
          PROJECT_PATH,
          SESSION_NAME,
        )
      )?.id,
    ).toBe(winnerId);
  });
});

/**
 * The archive seam carries the audited abandon act (D7 R4.1), so its
 * eligibility decision is a lease claim about the DATABASE, not about what this
 * connection last parsed. Same structural guarantee the reservation CAS has,
 * asserted the same two ways: where the deciding read happens, and what a
 * second connection's write does to it.
 */
describe("archiveActiveGraphWorkflowExecution — authoritative eligibility", () => {
  it("performs the eligibility read inside the immediate transaction", async () => {
    const db = _createTestDb({ inMemory: true });
    const realExecutions = createGraphWorkflowExecutionsRepo(db);
    let inTransactionAtReadTime: boolean | null = null;
    let cachedReadsInsideTransaction = 0;
    const observingExecutions: GraphWorkflowExecutionsRepo = {
      ...realExecutions,
      getActive(projectPath, sessionName) {
        if (db.inTransaction) cachedReadsInsideTransaction += 1;
        return realExecutions.getActive(projectPath, sessionName);
      },
      getActiveAuthoritative(projectPath, sessionName) {
        inTransactionAtReadTime = db.inTransaction;
        return realExecutions.getActiveAuthoritative(projectPath, sessionName);
      },
    };
    const fixtureWithProbe = createPersistenceFixture({ db });
    const store = createStateStore({
      db,
      writeQueue: createWriteQueue(),
      repos: { graphWorkflowExecutions: observingExecutions },
    });
    try {
      fixtureWithProbe.seedProject(PROJECT_PATH);
      fixtureWithProbe.seedSession(PROJECT_PATH, SESSION_NAME);
      await store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.seed",
        () => ({
          execution: makeExecution({ id: "wf-archive", status: "halted" }),
          events: [],
        }),
      );

      const outcome = await store.archiveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        { reason: "abandoned", actor: "human" },
        (execution) => execution.status === "halted",
        (execution) => ({ ...execution, completedAt: null }),
      );

      expect(outcome.archived).toBe(true);
      expect(inTransactionAtReadTime).toBe(true);
      expect(cachedReadsInsideTransaction).toBe(0);
    } finally {
      fixtureWithProbe.close();
    }
  });

  it("refuses to archive a snapshot another connection has already moved on from", async () => {
    const dbPath = path.join(
      mkdtempSync(path.join(os.tmpdir(), "cc-archive-race-")),
      "state.db",
    );
    const clientA = createPersistenceFixture({
      db: _createTestDbAtPath(dbPath),
    });
    const clientB = createPersistenceFixture({
      db: _createTestDbAtPath(dbPath),
    });
    try {
      clientA.seedProject(PROJECT_PATH);
      clientA.seedSession(PROJECT_PATH, SESSION_NAME);
      await clientA.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.seed-halted",
        () => ({
          execution: makeExecution({ id: "wf-raced", status: "halted" }),
          events: [],
        }),
      );
      // A's ordinary advisory read — this is what caches "halted" on A.
      expect(
        (
          await clientA.store.getActiveGraphWorkflowExecution(
            PROJECT_PATH,
            SESSION_NAME,
          )
        )?.status,
      ).toBe("halted");

      // B resumes the run. A's cache still says halted, so an abandon that
      // decides from it would archive a snapshot that no longer exists and
      // delete B's running row.
      await clientB.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.resume",
        (current) => {
          if (current === null) throw new Error("B saw no active execution");
          return {
            execution: { ...current, status: "running" },
            events: [],
          };
        },
      );

      const outcome = await clientA.store.archiveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        { reason: "abandoned", actor: "human" },
        (execution) =>
          execution.id === "wf-raced" && execution.status === "halted",
      );

      expect(outcome).toMatchObject({
        archived: false,
        reason: "guard_rejected",
      });
      expect(
        (
          await clientB.store.getActiveGraphWorkflowExecution(
            PROJECT_PATH,
            SESSION_NAME,
          )
        )?.status,
      ).toBe("running");
      expect(
        await clientB.store.listArchivedGraphWorkflowExecutions(
          PROJECT_PATH,
          SESSION_NAME,
        ),
      ).toEqual([]);
    } finally {
      clientA.close();
      clientB.close();
    }
  });
});

describe("mutateSessionWorkflowLanes — focused durable write", () => {
  it("persists a lane write across a reload and leaves graphWorkflowExecution byte-identical", async () => {
    await seedSessionWithExecution();
    const executionBefore = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(executionBefore).not.toBeNull();

    await fixture.store.mutateSessionWorkflowLanes(
      PROJECT_PATH,
      SESSION_NAME,
      "workflow-lane.write[wf-A/primary]",
      (lanes) => {
        lanes["wf-A::primary"] = { engine: "noop", seq: 7 };
      },
    );

    const reloaded = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
    expect(reloaded?.workflowLanes).toEqual({
      "wf-A::primary": { engine: "noop", seq: 7 },
    });
    // The active execution must survive untouched — the focused lane write must
    // not have disturbed the dedicated executions table.
    const executionAfter = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(executionAfter).toEqual(executionBefore);
  });

  it("returns the mutator's value and stamps lastActivityAt", async () => {
    await seedSessionWithExecution();
    const result = await fixture.store.mutateSessionWorkflowLanes(
      PROJECT_PATH,
      SESSION_NAME,
      "workflow-lane.write[wf-A/primary]",
      (lanes) => {
        lanes["wf-A::primary"] = { engine: "noop" };
        return "ok" as const;
      },
    );
    expect(result).toBe("ok");

    const reloaded = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
    expect(reloaded?.lastActivityAt).not.toBe("2026-01-01T00:00:00Z");
  });

  it("serializes concurrent same-session lane writes (neither is lost)", async () => {
    await seedSessionWithExecution();
    await Promise.all([
      fixture.store.mutateSessionWorkflowLanes(
        PROJECT_PATH,
        SESSION_NAME,
        "workflow-lane.write[wf-A/a]",
        (lanes) => {
          lanes["wf-A::a"] = { engine: "noop" };
        },
      ),
      fixture.store.mutateSessionWorkflowLanes(
        PROJECT_PATH,
        SESSION_NAME,
        "workflow-lane.write[wf-A/b]",
        (lanes) => {
          lanes["wf-A::b"] = { engine: "noop" };
        },
      ),
    ]);

    const reloaded = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
    expect(Object.keys(reloaded?.workflowLanes ?? {}).sort()).toEqual([
      "wf-A::a",
      "wf-A::b",
    ]);
  });

  it("throws when the session does not exist", async () => {
    await expect(
      fixture.store.mutateSessionWorkflowLanes(
        PROJECT_PATH,
        "missing",
        "workflow-lane.write[wf-A/x]",
        (lanes) => {
          lanes["wf-A::x"] = {};
        },
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe("mutateSessionWorkflowEnvelopes — focused durable write", () => {
  it("persists an envelope write across a reload and leaves graphWorkflowExecution byte-identical", async () => {
    await seedSessionWithExecution();
    const executionBefore = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(executionBefore).not.toBeNull();

    await fixture.store.mutateSessionWorkflowEnvelopes(
      PROJECT_PATH,
      SESSION_NAME,
      "workflow-envelope.upsert[wf-1]",
      (envelopes) => {
        envelopes["wf-1"] = {
          workflowId: "wf-1",
          workflowType: "collaboration",
          status: "running",
        };
      },
    );

    const reloaded = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
    expect(reloaded?.workflowEnvelopes).toEqual({
      "wf-1": {
        workflowId: "wf-1",
        workflowType: "collaboration",
        status: "running",
      },
    });
    const executionAfter = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(executionAfter).toEqual(executionBefore);
  });

  it("returns the mutator's value and stamps lastActivityAt", async () => {
    await seedSessionWithExecution();
    const result = await fixture.store.mutateSessionWorkflowEnvelopes(
      PROJECT_PATH,
      SESSION_NAME,
      "workflow-envelope.upsert[wf-1]",
      (envelopes) => {
        envelopes["wf-1"] = { workflowId: "wf-1" };
        return 42;
      },
    );
    expect(result).toBe(42);

    const reloaded = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
    expect(reloaded?.lastActivityAt).not.toBe("2026-01-01T00:00:00Z");
  });

  it("serializes concurrent same-session envelope writes (neither is lost)", async () => {
    await seedSessionWithExecution();
    await Promise.all([
      fixture.store.mutateSessionWorkflowEnvelopes(
        PROJECT_PATH,
        SESSION_NAME,
        "workflow-envelope.upsert[wf-a]",
        (envelopes) => {
          envelopes["wf-a"] = { workflowId: "wf-a" };
        },
      ),
      fixture.store.mutateSessionWorkflowEnvelopes(
        PROJECT_PATH,
        SESSION_NAME,
        "workflow-envelope.upsert[wf-b]",
        (envelopes) => {
          envelopes["wf-b"] = { workflowId: "wf-b" };
        },
      ),
    ]);

    const reloaded = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
    expect(Object.keys(reloaded?.workflowEnvelopes ?? {}).sort()).toEqual([
      "wf-a",
      "wf-b",
    ]);
  });

  it("throws when the session does not exist", async () => {
    await expect(
      fixture.store.mutateSessionWorkflowEnvelopes(
        PROJECT_PATH,
        "missing",
        "workflow-envelope.upsert[wf-1]",
        (envelopes) => {
          envelopes["wf-1"] = { workflowId: "wf-1" };
        },
      ),
    ).rejects.toThrow(/not found/i);
  });
});

/**
 * The reconstruction data a post-commit materialization retry needs (D7 R3.4).
 * Real SQLite, because the claim is transactional: the winner's pending-artifact
 * record is committed by the SAME transaction that installs its row, so no crash
 * can land one without the other, and a refused launch commits neither.
 */
describe("reserveActiveGraphWorkflowExecution — pending artifact reconstruction data", () => {
  const SEEDED = [
    {
      relativePath: ".cc/graph-workflow-docs/spec.md",
      contents: "# the spec",
      description: "the spec",
      readWhen: "before implementing",
    },
  ];

  it("commits the winner's seeded-document contents with its row", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);

    await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.reserve",
      {
        execution: makeExecution({ id: "wf-winner", status: "pending" }),
        events: [],
        seededDocuments: SEEDED,
      },
    );

    // Reloaded through the repository, not the object handed in: the contents
    // have to survive SQLite for a retry after a restart to reconstruct them.
    const pending = await fixture.store.getGraphWorkflowPendingArtifacts(
      PROJECT_PATH,
      SESSION_NAME,
      "wf-winner",
    );
    expect(pending?.documents).toEqual(SEEDED);
  });

  it("records nothing for a launch the lease refuses", async () => {
    await seedSessionWithExecution();

    const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.reserve",
      {
        execution: makeExecution({ id: "wf-loser", status: "pending" }),
        events: [],
        seededDocuments: SEEDED,
      },
    );

    expect(outcome.reserved).toBe(false);
    expect(
      await fixture.store.getGraphWorkflowPendingArtifacts(
        PROJECT_PATH,
        SESSION_NAME,
        "wf-loser",
      ),
    ).toBeNull();
  });

  it("drops the record once materialization is reported complete", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.reserve",
      {
        execution: makeExecution({ id: "wf-winner", status: "pending" }),
        events: [],
        seededDocuments: SEEDED,
      },
    );

    await fixture.store.clearGraphWorkflowPendingArtifacts("wf-winner");

    expect(
      await fixture.store.getGraphWorkflowPendingArtifacts(
        PROJECT_PATH,
        SESSION_NAME,
        "wf-winner",
      ),
    ).toBeNull();
  });

  it("scopes the read to the owning session", async () => {
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    fixture.seedSession(PROJECT_PATH, "other-session");
    await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.reserve",
      {
        execution: makeExecution({ id: "wf-winner", status: "pending" }),
        events: [],
        seededDocuments: SEEDED,
      },
    );

    expect(
      await fixture.store.getGraphWorkflowPendingArtifacts(
        PROJECT_PATH,
        "other-session",
        "wf-winner",
      ),
    ).toBeNull();
  });
});
