import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * The ambient "this session has live workflow work" signal is lease tenure, not
 * physical position (R12.4).
 *
 * A lease-free run is allowed to keep sitting in the session's active row until
 * the next launch normalizes it away (R3.3), so a session whose runs are all
 * historical still has a physically-active row. It must nonetheless report no
 * ambient indicator — while every historical run stays fully browsable, which is
 * the half a "just hide terminal executions" fix would break.
 */

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

const RESUMABLE_HALT = {
  type: "circuit_breaker",
  contextId: "context-implement",
  condition: "retry_exhaustion",
  summary: null,
} as const;

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

async function installActive(execution: GraphWorkflowExecution): Promise<void> {
  await fixture.store.mutateActiveGraphWorkflowExecution(
    PROJECT_PATH,
    SESSION_NAME,
    "test.install-active-execution",
    () => ({ execution, events: [] }),
  );
}

async function ambientFlag(): Promise<boolean | undefined> {
  const items = await fixture.store.getProjectSessionListItems(PROJECT_PATH);
  return items.find((item) => item.sessionName === SESSION_NAME)
    ?.hasActiveGraphWorkflow;
}

describe("ambient session projection over a historical-only session", () => {
  it("reports no active workflow while every run is historical, and keeps History readable", async () => {
    // History: a completed run relocated into the archive.
    const archived = createWorkflowExecution({
      id: "execution-history",
      status: "completed",
    });
    await installActive(archived);
    const outcome = await fixture.store.archiveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(outcome.archived).toBe(true);

    // Current: nothing. The physically-active row is an aborted run that no
    // launch has normalized away yet.
    const stale = createWorkflowExecution({
      id: "execution-stale-active",
      status: "aborted",
    });
    await installActive(stale);

    expect(await ambientFlag()).toBe(false);

    // Both runs stay reviewable: History by its archive listing, the
    // lease-free incumbent by its still-present record.
    const history = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(history.map((execution) => execution.id)).toEqual([
      "execution-history",
    ]);
    const stillAddressable =
      await fixture.store.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
    expect(stillAddressable?.id).toBe("execution-stale-active");
  });

  it("reports an active workflow while a resumably halted run still holds the lease", async () => {
    await installActive(
      createWorkflowExecution({
        id: "execution-current",
        status: "halted",
        haltReason: RESUMABLE_HALT,
      }),
    );

    expect(await ambientFlag()).toBe(true);
  });

  it("drops the ambient indicator the moment that halted run is abandoned", async () => {
    await installActive(
      createWorkflowExecution({
        id: "execution-current",
        status: "halted",
        haltReason: RESUMABLE_HALT,
      }),
    );
    await installActive(
      createWorkflowExecution({
        id: "execution-current",
        status: "halted",
        haltReason: RESUMABLE_HALT,
        abandonment: {
          abandonedAt: "2026-06-10T11:00:00.000Z",
          actor: { kind: "human" },
          reason: "superseded",
        },
      }),
    );

    expect(await ambientFlag()).toBe(false);
  });
});
