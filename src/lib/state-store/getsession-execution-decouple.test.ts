import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { buildMaximalGraphWorkflowExecution } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

describe("getSession is decoupled from the active graph-workflow execution", () => {
  it("returns graphWorkflowExecution: null even when an active execution exists in the new table", async () => {
    const execution = graphWorkflowExecutionSchema.parse(
      buildMaximalGraphWorkflowExecution(),
    );

    // Write the active execution through the real setter, which persists it to
    // the dedicated graph_workflow_executions table (never the sessions row).
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seed-active-execution",
      () => ({ execution, events: [] }),
    );

    // The focused execution accessor sees it...
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.id).toBe(execution.id);

    // ...but the session payload no longer carries it.
    const session = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
    expect(session).not.toBeNull();
    expect(session?.graphWorkflowExecution).toBeNull();
  });
});
