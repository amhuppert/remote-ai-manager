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
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { CaptureTicketTextInput, FileSnapshot } from "./content-store";
import {
  createConversationSnapshotRefreshService,
  INTERRUPTED_SNAPSHOT_ERROR,
  recoverInterruptedConversationSnapshots,
  SNAPSHOT_CAPTURE_ERROR,
  type ConversationSnapshotRefreshDeps,
} from "./snapshot-refresh";
import type {
  ConversationAttachmentPayload,
  TicketAttachmentPayload,
  TicketDetail,
} from "./schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";
const SOURCE_PATH = "/repos/source-project";
const CREATED_AT = "2026-07-19T12:00:00.000Z";

const pendingPayload: ConversationAttachmentPayload = {
  kind: "conversation",
  projectPath: SOURCE_PATH,
  sessionName: "investigation",
  conversationId: "conversation-1",
  snapshotKey: null,
  snapshotCapturedAt: null,
  snapshotStatus: "pending",
};

function failedPayload(
  error = "An earlier snapshot attempt failed.",
): ConversationAttachmentPayload {
  return {
    ...pendingPayload,
    snapshotStatus: "failed",
    snapshotError: error,
  };
}

function capturedPayload(fileName: string): ConversationAttachmentPayload {
  return {
    ...pendingPayload,
    snapshotKey: `ticket-1/attachment-1/${fileName}`,
    snapshotCapturedAt: "2026-07-19T12:01:00.000Z",
    snapshotStatus: "captured",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let db: Db;
let repo: TicketsRepo;
let idSequence: number;
let nowSequence: number;
let capturedInputs: CaptureTicketTextInput[];
let deletedSnapshotKeys: string[];
let publishedEvents: SSEEvent[];
let gatePhases: string[];

async function createTicketWithAttachment(
  payload: TicketAttachmentPayload = pendingPayload,
  ids: { ticketId?: string; attachmentId?: string } = {},
): Promise<TicketDetail> {
  const ticketId = ids.ticketId ?? "ticket-1";
  const attachmentId = ids.attachmentId ?? "attachment-1";
  return repo.createWithAttachments(
    {
      id: ticketId,
      projectPath: PROJECT_PATH,
      title: "Snapshot refresh",
      description: "",
      workType: "bug",
      status: "not_started",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    [
      {
        id: attachmentId,
        ticketId,
        description: "Observed conversation",
        payload,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
  );
}

function makeDeps(
  overrides: Partial<ConversationSnapshotRefreshDeps> = {},
): ConversationSnapshotRefreshDeps {
  return {
    repo,
    contentStore: {
      async captureText(input) {
        capturedInputs.push(input);
        const bytes = Buffer.byteLength(input.text, "utf8");
        return {
          snapshotKey: `${input.ticketId}/${input.attachmentId}/${input.fileName}`,
          fileName: input.fileName,
          sizeBytes: bytes,
          sha256: `sha-${input.fileName}`,
        };
      },
      async delete(snapshotKey) {
        deletedSnapshotKeys.push(snapshotKey);
      },
    },
    async resolveProjectPath(projectName) {
      return projectName === PROJECT_NAME ? PROJECT_PATH : null;
    },
    async runProjectTicketOperation(projectPath, operation) {
      gatePhases.push(`enter:${projectPath}`);
      try {
        return await operation();
      } finally {
        gatePhases.push(`exit:${projectPath}`);
      }
    },
    async ensureConversationCompaction() {
      gatePhases.push("ensure");
      return {
        ok: true,
        markdown: "# Retained compaction",
        capturedAt: "2026-07-19T12:01:00.000Z",
      };
    },
    publish(event) {
      publishedEvents.push(event);
      return { delivered: true };
    },
    now() {
      nowSequence += 1;
      return new Date(
        Date.parse(CREATED_AT) + nowSequence * 1_000,
      ).toISOString();
    },
    generateId() {
      idSequence += 1;
      return `candidate-${idSequence}`;
    },
    ...overrides,
  };
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  repo = createTicketsRepo(db, createWriteQueue());
  idSequence = 0;
  nowSequence = 0;
  capturedInputs = [];
  deletedSnapshotKeys = [];
  publishedEvents = [];
  gatePhases = [];
});

afterEach(() => {
  db.close();
});

describe("createConversationSnapshotRefreshService", () => {
  it("re-enters the target project gate and captures a pending snapshot through CAS", async () => {
    const ticket = await createTicketWithAttachment();
    const service = createConversationSnapshotRefreshService(makeDeps());

    const result = await service.refresh({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "attachment-1",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        id: "attachment-1",
        payload: {
          snapshotStatus: "captured",
          snapshotCapturedAt: "2026-07-19T12:01:00.000Z",
          snapshotKey:
            "ticket-1/attachment-1/compaction-refresh-candidate-1.md",
        },
      },
    });
    expect(capturedInputs).toEqual([
      expect.objectContaining({
        ticketId: "ticket-1",
        attachmentId: "attachment-1",
        fileName: "compaction-refresh-candidate-1.md",
        text: "# Retained compaction",
      }),
    ]);
    expect(gatePhases).toEqual([
      `enter:${PROJECT_PATH}`,
      "ensure",
      `exit:${PROJECT_PATH}`,
    ]);
    expect(publishedEvents).toEqual([
      expect.objectContaining({
        type: "ticket-changed",
        change: "attachments",
        projectName: PROJECT_NAME,
        ticketNumber: ticket.number,
        attachmentIndexChanged: true,
      }),
    ]);
  });

  it("allows a failed snapshot to be retried", async () => {
    const ticket = await createTicketWithAttachment(failedPayload());
    const service = createConversationSnapshotRefreshService(makeDeps());

    const result = await service.refresh({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "attachment-1",
    });

    expect(result.ok).toBe(true);
    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments[0]?.payload).toMatchObject({
      kind: "conversation",
      snapshotStatus: "captured",
      snapshotKey: "ticket-1/attachment-1/compaction-refresh-candidate-1.md",
    });
    expect(detail?.attachments[0]?.payload).not.toHaveProperty("snapshotError");
  });

  it("rejects captured and non-conversation attachments before capture", async () => {
    const captured = await createTicketWithAttachment(
      capturedPayload("kept.md"),
    );
    const service = createConversationSnapshotRefreshService(makeDeps());

    const capturedResult = await service.refresh({
      projectName: PROJECT_NAME,
      number: captured.number,
      attachmentId: "attachment-1",
    });

    expect(capturedResult).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(capturedInputs).toEqual([]);

    const note = await createTicketWithAttachment(
      { kind: "note", markdown: "context" },
      { ticketId: "ticket-2", attachmentId: "attachment-2" },
    );
    const noteResult = await service.refresh({
      projectName: PROJECT_NAME,
      number: note.number,
      attachmentId: "attachment-2",
    });
    expect(noteResult).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(capturedInputs).toEqual([]);
  });

  it("CAS-transitions compaction failures to a bounded safe error and publishes the winner", async () => {
    const ticket = await createTicketWithAttachment();
    const service = createConversationSnapshotRefreshService(
      makeDeps({
        async ensureConversationCompaction() {
          return {
            ok: false,
            reason: `/Users/alex/private/${"x".repeat(700)}`,
          };
        },
      }),
    );

    const result = await service.refresh({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "attachment-1",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "context_preparation_failed",
        phase: "content",
        reason: SNAPSHOT_CAPTURE_ERROR,
      },
    });
    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments[0]?.payload).toEqual({
      ...pendingPayload,
      snapshotStatus: "failed",
      snapshotError: SNAPSHOT_CAPTURE_ERROR,
    });
    expect(JSON.stringify(detail)).not.toContain("/Users/alex/private");
    expect(SNAPSHOT_CAPTURE_ERROR.length).toBeLessThanOrEqual(500);
    expect(publishedEvents).toHaveLength(1);
  });

  it("deletes a losing retry candidate without overwriting the winning snapshot", async () => {
    const ticket = await createTicketWithAttachment();
    const releaseCaptures = deferred<void>();
    let captureCount = 0;
    const captureText = vi.fn(
      async (input: CaptureTicketTextInput): Promise<FileSnapshot> => {
        captureCount += 1;
        if (captureCount === 2) releaseCaptures.resolve();
        await releaseCaptures.promise;
        return {
          snapshotKey: `${input.ticketId}/${input.attachmentId}/${input.fileName}`,
          fileName: input.fileName,
          sizeBytes: input.text.length,
          sha256: input.fileName,
        };
      },
    );
    const service = createConversationSnapshotRefreshService(
      makeDeps({
        contentStore: {
          captureText,
          async delete(snapshotKey) {
            deletedSnapshotKeys.push(snapshotKey);
          },
        },
      }),
    );
    const input = {
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "attachment-1",
    };

    const [background, retry] = await Promise.all([
      service.refresh(input),
      service.refresh(input),
    ]);

    expect(background.ok).toBe(true);
    expect(retry.ok).toBe(true);
    const detail = await repo.find(PROJECT_PATH, ticket.number);
    const winningKey =
      detail?.attachments[0]?.payload.kind === "conversation"
        ? detail.attachments[0].payload.snapshotKey
        : null;
    expect(winningKey).not.toBeNull();
    expect(deletedSnapshotKeys).toHaveLength(1);
    expect(deletedSnapshotKeys).not.toContain(winningKey);
    expect(publishedEvents).toHaveLength(1);
  });

  it("deletes its candidate and returns missing when removal wins during capture", async () => {
    const ticket = await createTicketWithAttachment();
    const captureStarted = deferred<CaptureTicketTextInput>();
    const releaseCapture = deferred<void>();
    const service = createConversationSnapshotRefreshService(
      makeDeps({
        contentStore: {
          async captureText(input) {
            captureStarted.resolve(input);
            await releaseCapture.promise;
            return {
              snapshotKey: `${input.ticketId}/${input.attachmentId}/${input.fileName}`,
              fileName: input.fileName,
              sizeBytes: input.text.length,
              sha256: "candidate",
            };
          },
          async delete(snapshotKey) {
            deletedSnapshotKeys.push(snapshotKey);
          },
        },
      }),
    );

    const refreshing = service.refresh({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "attachment-1",
    });
    await captureStarted.promise;
    await repo.deleteAttachment({
      ticketId: ticket.id,
      attachmentId: "attachment-1",
      updatedAt: "2026-07-19T12:05:00.000Z",
    });
    releaseCapture.resolve();

    await expect(refreshing).resolves.toEqual({
      ok: false,
      error: {
        code: "attachment_not_found",
        identifier: `${PROJECT_NAME}#${ticket.number}`,
        attachmentId: "attachment-1",
      },
    });
    expect(deletedSnapshotKeys).toEqual([
      "ticket-1/attachment-1/compaction-refresh-candidate-1.md",
    ]);
    expect(publishedEvents).toEqual([]);
  });

  it("reclaims its candidate when persistence fails before adoption", async () => {
    const ticket = await createTicketWithAttachment();
    const persistenceFailure = new Error("snapshot CAS unavailable");
    const service = createConversationSnapshotRefreshService(
      makeDeps({
        repo: {
          ...repo,
          async compareAndSwapConversationSnapshot() {
            throw persistenceFailure;
          },
        },
      }),
    );

    await expect(
      service.refresh({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: "attachment-1",
      }),
    ).rejects.toBe(persistenceFailure);

    expect(deletedSnapshotKeys).toEqual([
      "ticket-1/attachment-1/compaction-refresh-candidate-1.md",
    ]);
    expect(publishedEvents).toEqual([]);
    expect(
      (await repo.find(PROJECT_PATH, ticket.number))?.attachments[0]?.payload,
    ).toEqual(pendingPayload);
  });

  it("does not overwrite a start winner when its failure transition loses", async () => {
    const ticket = await createTicketWithAttachment();
    const ensureStarted = deferred<void>();
    const releaseEnsure = deferred<void>();
    const service = createConversationSnapshotRefreshService(
      makeDeps({
        async ensureConversationCompaction() {
          ensureStarted.resolve();
          await releaseEnsure.promise;
          return { ok: false, reason: "late background failure" };
        },
      }),
    );

    const refreshing = service.refresh({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "attachment-1",
    });
    await ensureStarted.promise;
    const winner = capturedPayload("start-winner.md");
    await repo.compareAndSwapConversationSnapshot({
      ticketId: ticket.id,
      attachmentId: "attachment-1",
      previousPayload: pendingPayload,
      payload: winner,
      updatedAt: "2026-07-19T12:06:00.000Z",
    });
    releaseEnsure.resolve();

    await expect(refreshing).resolves.toEqual({
      ok: true,
      value: expect.objectContaining({
        id: "attachment-1",
        payload: winner,
      }),
    });
    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments[0]?.payload).toEqual(winner);
    expect(publishedEvents).toEqual([]);
  });

  it.each([
    {
      state: "pending" as const,
      winner: {
        ...pendingPayload,
        conversationId: "winning-pending-conversation",
      },
      expectedReason:
        "Conversation snapshot capture is still pending. Retry the snapshot.",
    },
    {
      state: "failed" as const,
      winner: failedPayload("The winning snapshot attempt failed."),
      expectedReason: "The winning snapshot attempt failed.",
    },
  ])(
    "does not report success when a $state snapshot wins the capture CAS",
    async ({ winner, expectedReason }) => {
      const ticket = await createTicketWithAttachment();
      const captureStarted = deferred<void>();
      const releaseCapture = deferred<void>();
      const service = createConversationSnapshotRefreshService(
        makeDeps({
          contentStore: {
            async captureText(input) {
              captureStarted.resolve();
              await releaseCapture.promise;
              return {
                snapshotKey: `${input.ticketId}/${input.attachmentId}/${input.fileName}`,
                fileName: input.fileName,
                sizeBytes: input.text.length,
                sha256: "losing-candidate",
              };
            },
            async delete(snapshotKey) {
              deletedSnapshotKeys.push(snapshotKey);
            },
          },
        }),
      );

      const refreshing = service.refresh({
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: "attachment-1",
      });
      await captureStarted.promise;
      await repo.compareAndSwapConversationSnapshot({
        ticketId: ticket.id,
        attachmentId: "attachment-1",
        previousPayload: pendingPayload,
        payload: winner,
        updatedAt: "2026-07-19T12:06:00.000Z",
      });
      releaseCapture.resolve();

      await expect(refreshing).resolves.toEqual({
        ok: false,
        error: {
          code: "context_preparation_failed",
          phase: "content",
          reason: expectedReason,
        },
      });
      expect(deletedSnapshotKeys).toEqual([
        "ticket-1/attachment-1/compaction-refresh-candidate-1.md",
      ]);
      expect(
        (await repo.find(PROJECT_PATH, ticket.number))?.attachments[0]?.payload,
      ).toEqual(winner);
      expect(publishedEvents).toEqual([]);
    },
  );

  it("waits behind project deletion and observes the deleted ticket", async () => {
    const ticket = await createTicketWithAttachment();
    const deletionStarted = deferred<void>();
    const releaseDeletion = deferred<void>();
    const { createTicketProjectOperationGate } =
      await import("./project-operation-gate");
    const gate = createTicketProjectOperationGate();
    const service = createConversationSnapshotRefreshService(
      makeDeps({
        runProjectTicketOperation(projectPath, operation) {
          return gate.runTicketOperation(projectPath, operation);
        },
      }),
    );
    const deleting = gate.runProjectDeletion(PROJECT_PATH, async () => {
      await repo.delete(PROJECT_PATH, ticket.number);
      deletionStarted.resolve();
      await releaseDeletion.promise;
    });
    await deletionStarted.promise;

    const refreshing = service.refresh({
      projectName: PROJECT_NAME,
      number: ticket.number,
      attachmentId: "attachment-1",
    });
    releaseDeletion.resolve();
    await deleting;

    await expect(refreshing).resolves.toEqual({
      ok: false,
      error: {
        code: "ticket_not_found",
        identifier: `${PROJECT_NAME}#${ticket.number}`,
      },
    });
    expect(capturedInputs).toEqual([]);
  });
});

describe("startup snapshot recovery", () => {
  it("exposes a startup callable with the canonical safe failure", async () => {
    const recoverPendingConversationSnapshots = vi.fn(async () => [
      {
        ticketId: "ticket-1",
        attachmentId: "attachment-1",
        projectPath: PROJECT_PATH,
        ticketNumber: 1,
        ticketUpdatedAt: "2026-07-19T13:00:00.000Z",
      },
    ]);

    await expect(
      recoverInterruptedConversationSnapshots({
        repo: { recoverPendingConversationSnapshots },
        now: () => "2026-07-19T13:00:00.000Z",
      }),
    ).resolves.toBe(1);
    expect(recoverPendingConversationSnapshots).toHaveBeenCalledWith({
      updatedAt: "2026-07-19T13:00:00.000Z",
      snapshotError: INTERRUPTED_SNAPSHOT_ERROR,
    });
  });

  it("sweeps only pending rows to failed and leaves captured and failed rows unchanged", async () => {
    const pending = await createTicketWithAttachment();
    const failed = await createTicketWithAttachment(
      failedPayload("kept failure"),
      {
        ticketId: "ticket-2",
        attachmentId: "attachment-2",
      },
    );
    const captured = await createTicketWithAttachment(
      capturedPayload("kept.md"),
      {
        ticketId: "ticket-3",
        attachmentId: "attachment-3",
      },
    );

    const recovered = await repo.recoverPendingConversationSnapshots({
      updatedAt: "2026-07-19T13:00:00.000Z",
      snapshotError: INTERRUPTED_SNAPSHOT_ERROR,
    });

    expect(recovered).toEqual([
      expect.objectContaining({
        ticketId: pending.id,
        attachmentId: "attachment-1",
        projectPath: PROJECT_PATH,
        ticketNumber: pending.number,
      }),
    ]);
    expect(
      (await repo.find(PROJECT_PATH, pending.number))?.attachments[0]?.payload,
    ).toEqual({
      ...pendingPayload,
      snapshotStatus: "failed",
      snapshotError: INTERRUPTED_SNAPSHOT_ERROR,
    });
    expect(
      (await repo.find(PROJECT_PATH, failed.number))?.attachments[0]?.payload,
    ).toEqual(failedPayload("kept failure"));
    expect(
      (await repo.find(PROJECT_PATH, captured.number))?.attachments[0]?.payload,
    ).toEqual(capturedPayload("kept.md"));
  });
});
