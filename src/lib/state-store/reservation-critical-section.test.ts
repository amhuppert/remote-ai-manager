/**
 * The lease reservation's critical section must perform no I/O of its own.
 *
 * `serialized-state-and-publication-seams` puts logging outside the write-queue
 * reducer, and the reason is concrete rather than stylistic: `createLogger`
 * appends to its log file SYNCHRONOUSLY, so a line emitted from inside the
 * section holds both the write queue and (once `BEGIN IMMEDIATE` has run)
 * SQLite's write lock across a filesystem write. Every other launch in every
 * other process is blocked behind that lock, and the reservation is the one path
 * the whole workflow serializes on.
 *
 * What this pins is the WHOLE queue callback, not just the transaction: the
 * session lookup that precedes `BEGIN IMMEDIATE` is inside the serialized
 * section too, and its repository timing log is filesystem I/O at a moment when
 * `db.inTransaction` is still false — the exact gap a transaction-only probe
 * reports as clean.
 *
 * The observation is the real logger writing to a real file, with the write
 * queue injected as the collaborator it already is: no internal module is
 * mocked, so what the test measures is what production does.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { _resetLoggerForTesting } from "@/lib/logging/logger";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  createWriteQueue,
  type WriteQueue,
} from "@/lib/state-store/write-queue";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function makeExecution(
  overrides: Record<string, unknown> = {},
): GraphWorkflowExecution {
  return graphWorkflowExecutionSchema.parse({
    id: "wf-critical-1",
    origin: {
      kind: "template",
      definitionId: "seed-1",
      definitionRevision: 1,
      tier: "project",
    },
    seedDefinitionId: "seed-1",
    seedDefinitionRevision: 1,
    workingDefinition: {},
    charter: makeTestCharter(),
    status: "pending",
    startedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

let tmpRoot: string;
let logFile: string;
let fixture: PersistenceFixture;
/** Bytes appended to the log file while a write-queue section was held. */
let bytesLoggedInsideSection = 0;

function logFileSize(): number {
  if (!existsSync(logFile)) return 0;
  return statSync(logFile).size;
}

function loggedMessages(): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const entry: unknown = JSON.parse(line);
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("message" in entry)
      ) {
        return "";
      }
      const message = (entry as { message: unknown }).message;
      return typeof message === "string" ? message : "";
    });
}

/**
 * The real write queue, wrapped so the test can measure the log file across the
 * exact window the callback holds the queue. Injected rather than mocked: the
 * queue is a constructor dependency of the store, and every write still runs
 * through the production implementation.
 */
function instrumentedWriteQueue(): WriteQueue {
  const inner = createWriteQueue();
  return {
    withWriteQueue: (label, fn) => inner.withWriteQueue(label, fn),
    withWriteQueueSync: (label, fn, ...reject) =>
      inner.withWriteQueueSync(
        label,
        () => {
          const before = logFileSize();
          try {
            return fn();
          } finally {
            bytesLoggedInsideSection += logFileSize() - before;
          }
        },
        ...reject,
      ),
    tryWithWriteQueue: (label, fn) => inner.tryWithWriteQueue(label, fn),
    _resetForTesting: () => inner._resetForTesting(),
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cc-reservation-section-"));
  logFile = path.join(tmpRoot, "reservation.log");
  _resetLoggerForTesting();
  delete process.env["CC_LOG_SILENT"];
  process.env["CC_LOG_FILE"] = logFile;
  process.env["CC_LOG_LEVEL"] = "debug";

  bytesLoggedInsideSection = 0;
  fixture = createPersistenceFixture({ writeQueue: instrumentedWriteQueue() });
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
  _resetLoggerForTesting();
  process.env["CC_LOG_SILENT"] = "1";
  delete process.env["CC_LOG_FILE"];
  delete process.env["CC_LOG_LEVEL"];
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("reserveActiveGraphWorkflowExecution critical section", () => {
  it("writes no log byte while the write queue is held, on the admitting path", async () => {
    const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.critical-section-admit",
      { execution: makeExecution(), events: [] },
    );

    expect(outcome.reserved).toBe(true);
    expect(bytesLoggedInsideSection).toBe(0);
  });

  it("writes no log byte while the write queue is held, on the refusing path", async () => {
    await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.critical-section-seed",
      { execution: makeExecution({ id: "wf-incumbent" }), events: [] },
    );
    bytesLoggedInsideSection = 0;

    const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.critical-section-refuse",
      { execution: makeExecution({ id: "wf-blocked" }), events: [] },
    );

    expect(outcome.reserved).toBe(false);
    expect(bytesLoggedInsideSection).toBe(0);
  });

  /**
   * The error branches, which the admit/refuse paths above cannot reach.
   *
   * A row can go malformed BETWEEN the manager's advisory read and the
   * authoritative reservation read — another process on a newer schema wrote it,
   * or a blob was truncated — so a repository's validation/quarantine logging is
   * reachable from inside the section, not merely theoretical. Those calls went
   * to `logger` directly rather than through `emitOrDeferRepositoryLog`, so the
   * deferral could not see them: exactly the shape the timing logs had.
   *
   * Worth more than the happy path, because this is the branch where holding the
   * lock hurts most — a corrupt row makes EVERY launch take the slow path, so the
   * filesystem write lands under contention rather than in an idle moment.
   */
  it("writes no log byte while the queue is held when the active execution row is malformed, and still reports the failure after", async () => {
    await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.critical-section-corrupt-seed",
      { execution: makeExecution({ id: "wf-incumbent" }), events: [] },
    );
    // Truncated mid-blob, the way a partial write or a foreign schema leaves it.
    fixture.db
      .prepare(
        `UPDATE graph_workflow_executions SET runtime_json = ?
           WHERE project_path = ? AND session_name = ?`,
      )
      .run('{"status":', PROJECT_PATH, SESSION_NAME);
    bytesLoggedInsideSection = 0;

    await expect(
      fixture.store.reserveActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "test.critical-section-corrupt-read",
        { execution: makeExecution({ id: "wf-blocked" }), events: [] },
      ),
    ).rejects.toThrow();

    expect(bytesLoggedInsideSection).toBe(0);
    // Deferred, not dropped: a section that throws never gets its `flush`, so
    // the diagnostic rides out on the orphan release instead.
    expect(loggedMessages()).toContain(
      "state-store.graph-workflow-executions.schema_validation_failure",
    );
  });

  it("writes no log byte while the queue is held when a session column is quarantined", async () => {
    // Unparseable but nullable: the session read degrades the column and
    // succeeds, so the reservation proceeds normally and the ONLY difference
    // from the admitting case is the quarantine log inside the section.
    fixture.db
      .prepare(
        `UPDATE sessions SET workflow_lanes = ?
           WHERE project_path = ? AND session_name = ?`,
      )
      .run("{not-json", PROJECT_PATH, SESSION_NAME);
    bytesLoggedInsideSection = 0;

    const outcome = await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.critical-section-quarantine",
      { execution: makeExecution(), events: [] },
    );

    expect(outcome.reserved).toBe(true);
    expect(bytesLoggedInsideSection).toBe(0);
    expect(loggedMessages()).toContain(
      "state-store.sessions.column_quarantined",
    );
  });

  it("still emits the repository timing it deferred, once the queue is released", async () => {
    // Deferral, not suppression: the observability these timing logs exist for
    // has to survive the move, or this trades one defect for another. It is also
    // what makes the zero-byte assertions above non-vacuous — the same lines are
    // provably written, just later.
    await fixture.store.reserveActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.critical-section-timing",
      { execution: makeExecution(), events: [] },
    );

    const messages = loggedMessages();
    expect(messages).toContain(
      "state-store.graph-workflow-executions.setActive.timing",
    );
    // The pre-transaction session lookup: inside the serialized section, and
    // therefore deferred with everything else.
    expect(messages).toContain("state-store.sessions.findByKey.timing");
    expect(messages).toContain("graph-workflow.execution.lease_reserved");
  });
});
