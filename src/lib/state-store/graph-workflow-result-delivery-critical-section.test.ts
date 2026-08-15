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
import { buildMaximalResultDelivery } from "@/lib/shared/testing/graph-workflow-execution-fixture";
import { createGraphWorkflowResultDeliveriesRepo } from "./graph-workflow-result-deliveries-repo";
import { createWriteQueue, type WriteQueue } from "./write-queue";
import { createNotificationsRepo } from "@/lib/notifications/repo";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";
const CONVERSATION_ID = "conversation-origin";
const EXECUTION_ID = "exec-critical-section";
const BOUNDARY_SEQ = 11;

let tmpRoot: string;
let logFile: string;
let fixture: PersistenceFixture;
let bytesLoggedInsideSection = 0;

function logFileSize(): number {
  return existsSync(logFile) ? statSync(logFile).size : 0;
}

function loggedMessages(): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const entry = JSON.parse(line) as { message?: unknown };
      return typeof entry.message === "string" ? entry.message : "";
    });
}

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

function seedDelivery(attemptId?: string): void {
  const repo = createGraphWorkflowResultDeliveriesRepo(fixture.db);
  repo.record({
    ...buildMaximalResultDelivery(),
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    executionId: EXECUTION_ID,
    boundarySeq: BOUNDARY_SEQ,
    originConversationId: CONVERSATION_ID,
    payload: { boundaryKind: "completion", status: "completed" },
    recordedAt: "2026-08-14T12:00:00.000Z",
    state: "pending",
    attemptId: null,
    attemptCount: 0,
    deliveredAt: null,
    effectsDeliveredAt: null,
  });
  if (attemptId !== undefined) {
    repo.markDelivering(
      PROJECT_PATH,
      SESSION_NAME,
      EXECUTION_ID,
      BOUNDARY_SEQ,
      attemptId,
    );
  }
}

function corruptDelivery(): void {
  fixture.db
    .prepare(
      `UPDATE graph_workflow_result_deliveries
         SET payload_json = ?
       WHERE project_path = ? AND session_name = ?
         AND execution_id = ? AND boundary_seq = ?`,
    )
    .run("{malformed", PROJECT_PATH, SESSION_NAME, EXECUTION_ID, BOUNDARY_SEQ);
  bytesLoggedInsideSection = 0;
}

function fallbackNotificationInput() {
  return {
    type: "workflow-result-ready" as const,
    title: "Workflow result ready",
    message: "Execution completed after its origin was deleted.",
    projectName: "p1",
    sessionName: SESSION_NAME,
    executionId: EXECUTION_ID,
    originConversationId: CONVERSATION_ID,
    deepLink: `/projects/p1/${SESSION_NAME}/workflow?execution=${EXECUTION_ID}`,
    dedupeKey: `graph-workflow-origin-missing:${EXECUTION_ID}`,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cc-result-section-"));
  logFile = path.join(tmpRoot, "result-delivery.log");
  _resetLoggerForTesting();
  delete process.env["CC_LOG_SILENT"];
  process.env["CC_LOG_FILE"] = logFile;
  process.env["CC_LOG_LEVEL"] = "debug";

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
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("graph workflow result delivery critical sections", () => {
  it("defers claim validation logs until the write queue is released", async () => {
    seedDelivery();
    corruptDelivery();

    await expect(
      fixture.store.claimGraphWorkflowResultDeliveries(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "attempt-claim",
      ),
    ).rejects.toThrow();

    expect(bytesLoggedInsideSection).toBe(0);
    expect(loggedMessages()).toContain(
      "state-store.graph-workflow-result-deliveries.schema_validation_failure",
    );
  });

  it("defers settlement validation logs until the write queue is released", async () => {
    seedDelivery("attempt-settle");
    corruptDelivery();

    await expect(
      fixture.store.settleGraphWorkflowResultDeliveries(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "attempt-settle",
      ),
    ).rejects.toThrow();

    expect(bytesLoggedInsideSection).toBe(0);
    expect(loggedMessages()).toContain(
      "state-store.graph-workflow-result-deliveries.schema_validation_failure",
    );
  });

  it("defers fallback delivery validation logs until the write queue is released", async () => {
    seedDelivery();
    corruptDelivery();

    await expect(
      fixture.store.commitGraphWorkflowMissingOriginFallback(
        PROJECT_PATH,
        SESSION_NAME,
        EXECUTION_ID,
        BOUNDARY_SEQ,
        fallbackNotificationInput(),
      ),
    ).rejects.toThrow();

    expect(bytesLoggedInsideSection).toBe(0);
    expect(loggedMessages()).toContain(
      "state-store.graph-workflow-result-deliveries.schema_validation_failure",
    );
  });

  it("defers fallback notification validation logs until the write queue is released", async () => {
    seedDelivery();
    createNotificationsRepo(fixture.db).createWorkflowNotification(
      fallbackNotificationInput(),
    );
    fixture.db
      .prepare(
        `UPDATE notifications SET read = 2
          WHERE source = 'workflow' AND dedupe_key = ?`,
      )
      .run(fallbackNotificationInput().dedupeKey);
    bytesLoggedInsideSection = 0;

    await expect(
      fixture.store.commitGraphWorkflowMissingOriginFallback(
        PROJECT_PATH,
        SESSION_NAME,
        EXECUTION_ID,
        BOUNDARY_SEQ,
        fallbackNotificationInput(),
      ),
    ).rejects.toThrow();

    expect(bytesLoggedInsideSection).toBe(0);
    expect(loggedMessages()).toContain(
      "state-store.notifications.schema_validation_failure",
    );
  });
});
