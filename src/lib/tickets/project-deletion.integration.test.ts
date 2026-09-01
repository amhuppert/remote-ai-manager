import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import type { SSEEvent } from "@/lib/api/sse-events";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createStateStore } from "@/lib/state-store/store";
import { createTicketsRepo } from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createTicketAttachmentService } from "./attachment-service";
import { createTicketContentStore, type FileSnapshot } from "./content-store";
import { createTicketLifecycleObserver } from "./lifecycle";
import { createTicketProjectOperationGate } from "./project-operation-gate";
import { createTicketService } from "./service";

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("ticket operations racing project deletion", () => {
  let db: Db;
  let contentBase: string;

  beforeEach(async () => {
    db = _createTestDb({ inMemory: true });
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
    contentBase = await mkdtemp(path.join(tmpdir(), "cc-ticket-delete-race-"));
  });

  afterEach(async () => {
    db.close();
    await rm(contentBase, { recursive: true, force: true });
  });

  it("waits for attachment persistence, deletes its snapshot, emits every deletion, and rejects a late create", async () => {
    const repo = createTicketsRepo(db, createWriteQueue());
    const gate = createTicketProjectOperationGate();
    const events: SSEEvent[] = [];
    let idSequence = 0;
    let clock = 0;
    const now = () =>
      `2026-07-10T00:00:${String(++clock).padStart(2, "0")}.000Z`;
    const contentStore = createTicketContentStore({
      contentRoot: path.join(contentBase, "ticket-content"),
      listTicketIdsForProject(projectPath) {
        return repo.listTicketIds(projectPath);
      },
    });
    const ticketService = createTicketService({
      repo,
      attachmentPlanner: {
        async plan() {
          return {
            attachments: [],
            pendingConversationAttachmentIds: [],
            warnings: [],
            compensate: async () => {},
            afterCommit: () => {},
          };
        },
      },
      resolveProjectPath: async () => PROJECT_PATH,
      resolveAvailableProjectPath: async () => PROJECT_PATH,
      deleteTicketContent(ticketId) {
        return contentStore.deleteTicket(ticketId);
      },
      publish(event) {
        events.push(event);
        return { delivered: true };
      },
      runProjectTicketOperation(projectPath, operation) {
        return gate.runTicketOperation(projectPath, operation);
      },
      runTicketOperation: (_key, operation) => operation(),
      now,
      generateId: () => `ticket-${++idSequence}`,
    });

    const created = await ticketService.create({
      projectName: PROJECT_NAME,
      title: "Persist attachment before deletion",
      workType: "bug",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    events.length = 0;

    const snapshotCaptured = deferred<FileSnapshot>();
    const allowAttachmentPersistence = deferred();
    const attachmentService = createTicketAttachmentService({
      repo,
      contentStore: {
        ...contentStore,
        async capture(input) {
          const snapshot = await contentStore.capture(input);
          snapshotCaptured.resolve(snapshot);
          await allowAttachmentPersistence.promise;
          return snapshot;
        },
      },
      resolveProjectPath: async () => PROJECT_PATH,
      runProjectTicketOperation(projectPath, operation) {
        return gate.runTicketOperation(projectPath, operation);
      },
      scheduleConversationSnapshotRefresh: () => {},
      getLiveCompaction: async () => null,
      resolveConversation: async () => null,
      conversationExists: async () => false,
      getSessionOverview: async () => null,
      isTicketStartActive: () => false,
      onTicketStartReleased: async () => {},
      publish(event) {
        events.push(event);
        return { delivered: true };
      },
      now,
      generateId: () => `attachment-${++idSequence}`,
    });
    const attachment = attachmentService.add({
      projectName: PROJECT_NAME,
      number: created.value.number,
      description: "race fixture",
      payload: {
        kind: "file",
        fileName: "evidence.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("durable evidence"),
      },
    });
    const captured = await snapshotCaptured.promise;

    const lifecycle = createTicketLifecycleObserver({
      repo,
      publish(event) {
        events.push(event);
        return { delivered: true };
      },
      now,
    });
    let deletionStarted = false;
    const deletion = gate.runProjectDeletion(PROJECT_PATH, async () => {
      deletionStarted = true;
      const snapshot = await lifecycle.captureProjectDeletion(PROJECT_PATH);
      await contentStore.deleteProject(PROJECT_PATH);
      db.prepare("DELETE FROM projects WHERE root_path = ?").run(PROJECT_PATH);
      await lifecycle.publishProjectDeletion(snapshot);
    });
    const lateCreate = ticketService.create({
      projectName: PROJECT_NAME,
      title: "Must not recreate the project",
      workType: "feature",
    });

    expect(deletionStarted).toBe(false);
    allowAttachmentPersistence.resolve();
    const [attachmentResult, lateCreateResult] = await Promise.all([
      attachment,
      lateCreate,
      deletion,
    ]).then(([added, late]) => [added, late] as const);

    expect(attachmentResult.ok).toBe(true);
    expect(lateCreateResult.ok).toBe(false);
    expect(
      db
        .prepare("SELECT 1 FROM projects WHERE root_path = ?")
        .get(PROJECT_PATH),
    ).toBeUndefined();
    expect(
      await repo.list({ projectPath: PROJECT_PATH, sort: "updated" }),
    ).toEqual([]);
    await expect(contentStore.read(captured.snapshotKey)).rejects.toMatchObject(
      {
        code: "snapshot_not_found",
      },
    );
    expect(events.map((event) => event.type)).toEqual([
      "ticket-changed",
      "ticket-changed",
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "ticket-changed",
        change: "attachments",
        ticketNumber: created.value.number,
      }),
      expect.objectContaining({
        type: "ticket-changed",
        change: "deleted",
        ticketNumber: created.value.number,
        listItem: null,
      }),
    ]);
  });

  it("removes cross-project relationships and publishes the bumped external survivor after deletion", async () => {
    const externalProjectPath = "/repos/external";
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
      externalProjectPath,
    );
    const queue = createWriteQueue();
    const repo = createTicketsRepo(db, queue);
    const stateStore = createStateStore({ db, writeQueue: queue });
    const deletedTicket = await repo.create({
      id: "deleted-ticket",
      projectPath: PROJECT_PATH,
      title: "Deleted with project",
      description: "",
      workType: "feature",
      status: "not_started",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const externalTicket = await repo.create({
      id: "external-ticket",
      projectPath: externalProjectPath,
      title: "Surviving prerequisite",
      description: "",
      workType: "feature",
      status: "not_started",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    await repo.addRelationship({
      id: "cross-project-dependency",
      anchorTicketId: deletedTicket.id,
      relationType: "depends_on",
      sourceTicketId: deletedTicket.id,
      targetTicketId: externalTicket.id,
      description: "External ticket blocks deletion target",
      createdAt: "2026-07-10T00:00:01.000Z",
    });
    const events: SSEEvent[] = [];
    const lifecycle = createTicketLifecycleObserver({
      repo,
      publish(event) {
        events.push(event);
        return { delivered: true };
      },
      now: () => "2026-07-10T00:00:02.000Z",
    });
    const snapshot = await lifecycle.captureProjectDeletion(PROJECT_PATH);

    await stateStore.deleteProjectRow(
      PROJECT_PATH,
      snapshot.externalNeighborTicketIds,
      "2026-07-10T00:00:02.000Z",
    );
    await lifecycle.publishProjectDeletion(snapshot);

    expect(await repo.find(PROJECT_PATH, deletedTicket.number)).toBeNull();
    expect(
      await repo.find(externalProjectPath, externalTicket.number),
    ).toMatchObject({
      id: externalTicket.id,
      updatedAt: "2026-07-10T00:00:02.000Z",
      relationships: [],
    });
    expect(events).toEqual([
      expect.objectContaining({
        change: "deleted",
        projectName: PROJECT_NAME,
        ticketNumber: deletedTicket.number,
        listItem: null,
      }),
      expect.objectContaining({
        change: "relationships",
        projectName: "external",
        ticketNumber: externalTicket.number,
        listItem: expect.objectContaining({
          id: externalTicket.id,
          updatedAt: "2026-07-10T00:00:02.000Z",
        }),
      }),
    ]);
  });
});
