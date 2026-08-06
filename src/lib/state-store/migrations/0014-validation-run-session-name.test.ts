import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { validationRunRecordSchema } from "@/lib/validation/schemas";
import { createValidationRunsRepo } from "../validation-runs-repo";
import { migrations } from "./index";

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
});

afterEach(() => {
  fixture.close();
});

function columnNames(): string[] {
  return (
    fixture.db.pragma("table_info(validation_runs)") as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

describe("0014-validation-run-session-name", () => {
  it("adds nullable session attribution without disturbing existing rows", async () => {
    createValidationRunsRepo(fixture.db).submit(
      validationRunRecordSchema.parse({
        runId: "vr-existing",
        source: "agent_cli",
        commandName: "test",
        cost: 2,
        queueOrder: 0,
        status: "queued",
        nonce: "nonce-existing",
        leaseToken: "lease-existing",
        leaseExpiresAt: "2026-08-05T10:01:00.000Z",
        processGroupPid: null,
        projectPath: "/projects/app",
        worktreePath: "/projects/app/.worktrees/s1",
        sessionName: null,
        conversationId: "conv-existing",
        workflowExecutionId: null,
        workflowContextId: null,
        workflowRole: null,
        submittedAt: "2026-08-05T10:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        queueMs: null,
        execMs: null,
        scoped: false,
        scopedPathCount: 0,
        exitCode: null,
        timedOut: false,
      }),
    );
    if (columnNames().includes("session_name")) {
      fixture.db.exec("ALTER TABLE validation_runs DROP COLUMN session_name");
    }

    const migration = migrations.find(
      (candidate) => candidate.name === "0014-validation-run-session-name",
    );
    expect(migration?.name).toBe("0014-validation-run-session-name");
    if (!migration) return;
    await migration.up({
      name: migration.name,
      context: { db: fixture.db, configDir: null },
    });

    expect(columnNames()).toContain("session_name");
    const migrated = createValidationRunsRepo(fixture.db).findById(
      "vr-existing",
    );
    expect(migrated?.sessionName).toBeNull();
    expect(migrated?.conversationId).toBe("conv-existing");

    fixture.db
      .prepare("UPDATE validation_runs SET session_name = ? WHERE run_id = ?")
      .run("s-preserved", "vr-existing");
    await migration.up({
      name: migration.name,
      context: { db: fixture.db, configDir: null },
    });
    expect(
      createValidationRunsRepo(fixture.db).findById("vr-existing")?.sessionName,
    ).toBe("s-preserved");
  });
});
