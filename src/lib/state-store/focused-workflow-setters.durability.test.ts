/**
 * Durability backstop for the focused single-column workflow setters
 * (`mutateSessionWorkflowLanes` / `mutateSessionWorkflowEnvelopes`). These
 * exist to skip the whole-state read/validate/diff cycle and, crucially, to
 * avoid re-serializing every other session column on a single-key write.
 *
 * Each test runs against `createPersistenceFixture()` — real repos over a fresh
 * `:memory:` DB — so the assertions exercise a genuine repository ↔ SQLite
 * round-trip. The session is seeded with a non-trivial `graphWorkflowExecution`
 * so we can prove that a focused lane/envelope write leaves the large execution
 * blob byte-identical (i.e. it was never rewritten by the focused path).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { graphWorkflowExecutionSchema } from "@/lib/workflows/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function makeExecution(): GraphWorkflowExecution {
  return graphWorkflowExecutionSchema.parse({
    id: "wf-exec-1",
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 3,
    workingDefinition: {},
    charter: makeTestCharter(),
    status: "running",
    startedAt: "2026-01-01T00:00:00Z",
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

function seedSessionWithExecution(overrides: Partial<SessionState> = {}): void {
  fixture.seedSession(PROJECT_PATH, SESSION_NAME, {
    graphWorkflowExecution: makeExecution(),
    ...overrides,
  });
}

describe("mutateSessionWorkflowLanes — focused durable write", () => {
  it("persists a lane write across a reload and leaves graphWorkflowExecution byte-identical", async () => {
    seedSessionWithExecution();
    const executionBefore = (
      await fixture.store.getSession(PROJECT_PATH, SESSION_NAME)
    )?.graphWorkflowExecution;
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
    // The large execution blob must survive untouched — the focused write must
    // not have re-serialized the whole row.
    expect(reloaded?.graphWorkflowExecution).toEqual(executionBefore);
  });

  it("returns the mutator's value and stamps lastActivityAt", async () => {
    seedSessionWithExecution();
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
    seedSessionWithExecution();
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
    seedSessionWithExecution();
    const executionBefore = (
      await fixture.store.getSession(PROJECT_PATH, SESSION_NAME)
    )?.graphWorkflowExecution;
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
    expect(reloaded?.graphWorkflowExecution).toEqual(executionBefore);
  });

  it("returns the mutator's value and stamps lastActivityAt", async () => {
    seedSessionWithExecution();
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
    seedSessionWithExecution();
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
