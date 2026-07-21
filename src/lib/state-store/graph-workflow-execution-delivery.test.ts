/**
 * Post-commit event delivery on the graph-workflow execution mutation seam
 * (Design 3.2, `post-commit-delivery`). Event ROWS persist atomically with the
 * execution state inside `mutateActiveGraphWorkflowExecution`'s transaction;
 * SSE/push delivery must happen ONLY after that transaction commits.
 *
 * The seam no longer accepts or exposes any delivery callable — the reducer
 * returns inert data, the seam commits the rows and hands the committed delivery
 * back, and the graph-workflow repository (which owns the broadcaster) performs
 * delivery afterward. So these tests drive the REAL repository over a REAL
 * `:memory:` DB with a production spy broadcaster injected into the event
 * publisher, and prove the spy is UNREACHABLE when the transaction rolls back —
 * not by counting a hand-injected thunk, but by watching the actual broadcaster
 * the repository would use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function runningExecution(): GraphWorkflowExecution {
  return createWorkflowExecution({ status: "running" });
}

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

/**
 * A repository wired to the real `:memory:` store, with a spy broadcaster in the
 * event publisher. `mutateSeam` lets a test wrap the real store seam to force a
 * genuine SQLite rollback (poisoned event rows) between the reducer and the
 * commit — the repository still uses the same real seam and same spy.
 */
function makeRepository(options?: {
  mutateSeam?: PersistenceFixture["store"]["mutateActiveGraphWorkflowExecution"];
}) {
  const broadcast = vi.fn<(event: GraphWorkflowSSEEvent) => void>();
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast,
  });
  const repo = createGraphWorkflowExecutionRepository({
    async getSession() {
      return { worktreePath: "/repo/wt" } as unknown as SessionState;
    },
    getActiveGraphWorkflowExecution:
      fixture.store.getActiveGraphWorkflowExecution,
    mutateActiveGraphWorkflowExecution:
      options?.mutateSeam ?? fixture.store.mutateActiveGraphWorkflowExecution,
    archiveActiveGraphWorkflowExecution:
      fixture.store.archiveActiveGraphWorkflowExecution,
    async markGraphWorkflowContextEventsPreReset() {
      return 0;
    },
    eventPublisher,
  });
  return { repo, broadcast };
}

async function seedActiveExecution(
  execution: GraphWorkflowExecution,
): Promise<void> {
  // Seed the active row directly through the store seam (no events, no
  // delivery) so the subsequent `repo.update` produces a real prev→next diff.
  await fixture.store.mutateActiveGraphWorkflowExecution(
    PROJECT_PATH,
    SESSION_NAME,
    "seed",
    () => ({ execution, events: [] }),
  );
}

describe("graph-workflow execution mutation seam — post-commit delivery", () => {
  it("broadcasts the derived events exactly once, only after the row commits", async () => {
    await seedActiveExecution(runningExecution());
    const { repo, broadcast } = makeRepository();

    let rowsVisibleWhenBroadcast = -1;
    broadcast.mockImplementation(() => {
      // The broadcaster runs post-commit, so the appended row is already
      // durable and visible when the first wire event fires.
      rowsVisibleWhenBroadcast =
        fixture.graphWorkflowEvents.findByExecution("execution-1").length;
    });

    // A status change is a real prev→next diff: running -> paused emits exactly
    // one graph-workflow-status event.
    await repo.update(PROJECT_PATH, SESSION_NAME, {
      ...runningExecution(),
      status: "paused",
    });

    const statusBroadcasts = broadcast.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "graph-workflow-status");
    expect(statusBroadcasts).toHaveLength(1);
    expect(statusBroadcasts[0]).toMatchObject({ workflowStatus: "paused" });
    expect(rowsVisibleWhenBroadcast).toBeGreaterThanOrEqual(1);

    // The committed row is durable and reloads.
    expect(
      fixture.graphWorkflowEvents.findByExecution("execution-1").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("never reaches the broadcaster when the commit throws (nothing persists)", async () => {
    await seedActiveExecution(runningExecution());

    // Wrap the REAL store seam so the reducer's derived rows are replaced with a
    // malformed row (null `event`) that makes the real `appendMany` throw inside
    // the transaction — a genuine SQLite rollback, not a simulated one.
    const poisoned = {
      occurredAt: "",
      event: null,
      preReset: false,
    } as unknown as GraphWorkflowExecutionEvent;
    const poisoningSeam: PersistenceFixture["store"]["mutateActiveGraphWorkflowExecution"] =
      (projectPath, sessionName, label, mutate) =>
        fixture.store.mutateActiveGraphWorkflowExecution(
          projectPath,
          sessionName,
          label,
          (current) => {
            const result = mutate(current);
            return { ...result, events: [poisoned] };
          },
        );

    const { repo, broadcast } = makeRepository({ mutateSeam: poisoningSeam });

    await expect(
      repo.update(PROJECT_PATH, SESSION_NAME, {
        ...runningExecution(),
        status: "paused",
      }),
    ).rejects.toThrow();

    // The production spy broadcaster was never invoked — a mutation that did not
    // persist can never have told a client it did.
    expect(broadcast).not.toHaveBeenCalled();

    // The rollback left the seeded execution untouched and appended no rows.
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("running");
    expect(fixture.graphWorkflowEvents.findByExecution("execution-1")).toEqual(
      [],
    );
  });
});
