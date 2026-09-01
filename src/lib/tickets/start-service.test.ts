import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SSEEvent } from "@/lib/api/sse-events";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createTicketContentStore,
  type TicketContentStore,
} from "./content-store";
import {
  RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS,
  STATUS_UPDATE_BODY_PREVIEW_CHARS,
  TICKET_RELATIONSHIP_OUTLINE_LIMIT,
  TICKET_STATUS_UPDATE_RECENT_LIMIT,
} from "./disclosure-limits";
import type { MaterializeTicketContextInput } from "./materializer";
import { createTicketOperationLock } from "./operation-lock";
import { ticketChangedEventSchema, type TicketDetail } from "./schemas";
import {
  buildTicketKickoffPrompt,
  buildTicketSessionName,
  createTicketStartService,
  type TicketKickoffInput,
  type TicketStartService,
  type TicketStartServiceDeps,
} from "./start-service";

const PROJECT_NAME = "demo";
const PROJECT_PATH = "/repos/demo";
const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

let base: string;
let fixture: PersistenceFixture;
let repo: TicketsRepo;
let contentStore: TicketContentStore;
let clock: number;
let idSeq: number;

interface Recorded {
  provisions: string[];
  deletions: string[];
  materializations: MaterializeTicketContextInput[];
  charters: Array<{
    projectPath: string;
    sessionName: string;
    ticketIdentifier: string;
    title: string;
    description: string;
  }>;
  kickoffs: Array<{ input: TicketKickoffInput; linkCommittedAtCall: boolean }>;
  snapshotRefreshes: Array<{
    projectName: string;
    number: number;
    attachmentId: string;
  }>;
  events: SSEEvent[];
}

function nextNow(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 6, 10, 1, 0, clock)).toISOString();
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "cc-ticket-start-"));
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  repo = createTicketsRepo(fixture.db, createWriteQueue());
  contentStore = createTicketContentStore({
    contentRoot: path.join(base, "ticket-content"),
    listTicketIdsForProject: () => Promise.resolve([]),
  });
  clock = 0;
  idSeq = 0;
});

afterEach(async () => {
  fixture.close();
  await rm(base, { recursive: true, force: true });
});

async function createTicket(
  overrides: Partial<{ title: string; description: string }> = {},
): Promise<TicketDetail> {
  const ticket = await repo.create({
    id: `ticket-${++idSeq}`,
    projectPath: PROJECT_PATH,
    title: overrides.title ?? "Add durable ticket context",
    description: overrides.description ?? "The mission body.",
    workType: "feature",
    status: "not_started",
    createdAt: nextNow(),
    updatedAt: nextNow(),
  });
  const detail = await repo.find(PROJECT_PATH, ticket.number);
  if (detail === null) throw new Error("ticket seed failed");
  return detail;
}

async function addConversationAttachment(
  ticket: TicketDetail,
  overrides: Partial<{
    attachmentId: string;
    markdown: string;
    capturedAt: string;
  }> = {},
) {
  const attachmentId = overrides.attachmentId ?? `conv-${++idSeq}`;
  const snapshot = await contentStore.captureText({
    ticketId: ticket.id,
    attachmentId,
    fileName: `compaction-${CONVERSATION_ID}.md`,
    text: overrides.markdown ?? "stale snapshot",
  });
  const attachment = await repo.addAttachment({
    id: attachmentId,
    ticketId: ticket.id,
    description: "prior investigation",
    payload: {
      kind: "conversation",
      projectPath: PROJECT_PATH,
      sessionName: null,
      conversationId: CONVERSATION_ID,
      snapshotKey: snapshot.snapshotKey,
      snapshotCapturedAt: overrides.capturedAt ?? "2026-07-01T00:00:00.000Z",
    },
    createdAt: nextNow(),
    updatedAt: nextNow(),
  });
  return { attachment, snapshot };
}

function pendingConversationPayload() {
  return {
    kind: "conversation" as const,
    projectPath: PROJECT_PATH,
    sessionName: null,
    conversationId: CONVERSATION_ID,
    snapshotKey: null,
    snapshotCapturedAt: null,
    snapshotStatus: "pending" as const,
  };
}

function makeService(overrides: Partial<TicketStartServiceDeps> = {}): {
  service: TicketStartService;
  recorded: Recorded;
} {
  const recorded: Recorded = {
    provisions: [],
    deletions: [],
    materializations: [],
    charters: [],
    kickoffs: [],
    snapshotRefreshes: [],
    events: [],
  };
  const liveness = fixture.db.prepare(
    "SELECT created_at, worktree_path, branch_name, finished FROM sessions WHERE project_path = ? AND session_name = ?",
  );
  const openLinkCount = fixture.db.prepare(
    "SELECT COUNT(*) AS n FROM ticket_sessions WHERE session_name = ? AND ended_at IS NULL",
  );
  const deps: TicketStartServiceDeps = {
    repo,
    lock: createTicketOperationLock(),
    runProjectTicketOperation: (_projectPath, operation) => operation(),
    getDefaultAgentBackend() {
      return Promise.resolve("claude");
    },
    admitModelSelection({ modelSelection }) {
      return Promise.resolve({
        ok: true,
        modelSelection: modelSelection ?? {
          modelId: "claude-default",
          parameters: {},
        },
      });
    },
    resolveProjectPath(projectName) {
      return Promise.resolve(
        projectName === PROJECT_NAME ? PROJECT_PATH : null,
      );
    },
    scheduleConversationSnapshotRefresh(input) {
      recorded.snapshotRefreshes.push({ ...input });
    },
    getSessionLiveness(projectPath, sessionName) {
      const row = liveness.get(projectPath, sessionName) as
        | {
            created_at: string;
            worktree_path: string;
            branch_name: string;
            finished: 0 | 1;
          }
        | undefined;
      return Promise.resolve(
        row === undefined
          ? null
          : { createdAt: row.created_at, finished: row.finished === 1 },
      );
    },
    provisionSession(projectPath, sessionName) {
      recorded.provisions.push(sessionName);
      if (liveness.get(projectPath, sessionName) !== undefined) {
        return Promise.reject(
          new Error(`Session "${sessionName}" already exists in this project`),
        );
      }
      // Provisioning happens before the link insert, so the session's
      // created_at precedes linked_at — matching production ordering.
      const createdAt = nextNow();
      fixture.seedSession(projectPath, sessionName, { createdAt });
      return Promise.resolve({
        worktreePath: `${projectPath}/.worktrees/${sessionName}`,
        branchName: `csm/${sessionName}`,
        conversationId: CONVERSATION_ID,
        createdAt,
      });
    },
    deleteSessionIfCurrent(projectPath, sessionName, expected) {
      const row = liveness.get(projectPath, sessionName) as
        | {
            created_at: string;
            worktree_path: string;
            branch_name: string;
            finished: 0 | 1;
          }
        | undefined;
      if (row === undefined) {
        return Promise.resolve({ deleted: false, reason: "missing" as const });
      }
      if (
        row.created_at !== expected.createdAt ||
        row.worktree_path !== expected.worktreePath ||
        row.branch_name !== expected.branchName
      ) {
        return Promise.resolve({ deleted: false, reason: "replaced" as const });
      }
      if (row.finished === 1) {
        return Promise.resolve({ deleted: false, reason: "finished" as const });
      }
      recorded.deletions.push(sessionName);
      return Promise.resolve({ deleted: true, worktreeRemoved: false });
    },
    materializeTicketContext(input) {
      recorded.materializations.push(input);
      return Promise.resolve([]);
    },
    activateTicketCharter(input) {
      recorded.charters.push({ ...input });
      return Promise.resolve(undefined);
    },
    queueKickoff(input) {
      const row = openLinkCount.get(input.sessionName) as { n: number };
      recorded.kickoffs.push({ input, linkCommittedAtCall: row.n === 1 });
      return Promise.resolve(true);
    },
    publish(event) {
      recorded.events.push(event);
      return { delivered: true };
    },
    now: nextNow,
    generateId: () => `generated-${++idSeq}`,
    ...overrides,
  };
  return { service: createTicketStartService(deps), recorded };
}

describe("buildTicketSessionName", () => {
  it("preserves the ticket title in the first session name", () => {
    expect(buildTicketSessionName(12, "Add durable Ticket context!", 1)).toBe(
      "Ticket: Add durable Ticket context!",
    );
  });

  it("adds a readable suffix for later starts of the same ticket", () => {
    expect(buildTicketSessionName(12, "Add durable Ticket context!", 2)).toBe(
      "Ticket: Add durable Ticket context! (2)",
    );
  });

  it("keeps punctuation because it is valid in session names", () => {
    expect(buildTicketSessionName(3, "???", 1)).toBe("Ticket: ???");
  });

  it("fits the readable name within the session-name limit", () => {
    const name = buildTicketSessionName(3, "a".repeat(120), 2);
    expect(name).toHaveLength(100);
    expect(name).toMatch(/^Ticket: a+ \(2\)$/);
  });
});

describe("start", () => {
  it("rejects an invalid agent selection before the ticket operation or provisioning", async () => {
    const ticket = await createTicket();
    let ticketOperationCount = 0;
    const { service, recorded } = makeService({
      async runProjectTicketOperation(_projectPath, operation) {
        ticketOperationCount += 1;
        return operation();
      },
      admitModelSelection: vi.fn(async () => ({
        ok: false as const,
        code: "missing_parameter",
        message: 'Parameter "fast" is required for model "composer-2.5".',
        modelId: "composer-2.5",
        parameterId: "fast",
      })),
    });

    await expect(
      service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "agent",
        backend: "cursor",
        modelSelection: { modelId: "composer-2.5", parameters: {} },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "missing_parameter",
        modelId: "composer-2.5",
        parameterId: "fast",
      }),
    );
    expect(ticketOperationCount).toBe(0);
    expect(recorded.provisions).toEqual([]);
    expect(recorded.materializations).toEqual([]);
    expect(recorded.charters).toEqual([]);
    expect(recorded.kickoffs).toEqual([]);
    expect((await repo.find(PROJECT_PATH, ticket.number))?.status).toBe(
      "not_started",
    );
  });

  it("rejects a model selection in prepared mode instead of silently discarding it", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService();

    await expect(
      service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "prepared",
        backend: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "false", reasoning: "high" },
        },
      }),
    ).rejects.toMatchObject({
      code: "model_selection_inapplicable",
      modelId: "gpt-5.4",
    });
    expect(recorded.provisions).toEqual([]);
  });

  it("queues the canonical model selection admitted before provisioning", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService({
      admitModelSelection: vi.fn(async () => ({
        ok: true as const,
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
      })),
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
      backend: "cursor",
      modelSelection: {
        modelId: "composer",
        parameters: { fast: "true" },
      },
    });

    expect(result.ok).toBe(true);
    expect(recorded.kickoffs[0]?.input).toMatchObject({
      backend: "cursor",
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
    });
  });

  it("holds the project ticket-operation gate for the complete start", async () => {
    const ticket = await createTicket();
    const phases: string[] = [];
    const { service } = makeService({
      async runProjectTicketOperation(projectPath, operation) {
        phases.push(`gate:${projectPath}:start`);
        const result = await operation();
        phases.push(`gate:${projectPath}:end`);
        return result;
      },
      async provisionSession(projectPath, sessionName) {
        phases.push("provision");
        const createdAt = nextNow();
        fixture.seedSession(projectPath, sessionName, { createdAt });
        return {
          worktreePath: `${projectPath}/.worktrees/${sessionName}`,
          branchName: `csm/${sessionName}`,
          conversationId: CONVERSATION_ID,
          createdAt,
        };
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "prepared",
    });

    expect(result.ok).toBe(true);
    expect(phases).toEqual([
      `gate:${PROJECT_PATH}:start`,
      "provision",
      `gate:${PROJECT_PATH}:end`,
    ]);
  });

  it("runs the full order and commits one link-plus-status transaction", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { fast: "true", reasoning: "ultra" },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedName = buildTicketSessionName(ticket.number, ticket.title, 1);
    expect(result.value.sessionName).toBe(expectedName);
    expect(result.value.conversationId).toBe(CONVERSATION_ID);
    expect(result.value.initialPromptQueued).toBe(true);
    expect(result.value.ticket.status).toBe("in_progress");

    expect(recorded.provisions).toEqual([expectedName]);
    expect(recorded.materializations).toHaveLength(1);
    expect(recorded.materializations[0]).toMatchObject({
      projectPath: PROJECT_PATH,
      sessionName: expectedName,
      worktreePath: `${PROJECT_PATH}/.worktrees/${expectedName}`,
      ticketNumber: ticket.number,
    });
    expect(recorded.charters).toEqual([
      {
        projectPath: PROJECT_PATH,
        sessionName: expectedName,
        ticketIdentifier: `${PROJECT_NAME}#${ticket.number}`,
        title: ticket.title,
        description: ticket.description,
      },
    ]);
    expect(recorded.deletions).toEqual([]);
    expect(recorded.kickoffs[0]?.input).toMatchObject({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { fast: "true", reasoning: "ultra" },
      },
    });

    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("in_progress");
    expect(persisted?.sessions).toHaveLength(1);
    expect(persisted?.sessions[0]).toMatchObject({
      sessionName: expectedName,
      startMode: "agent",
      endedAt: null,
    });

    const sessionEvents = recorded.events.map((event) =>
      ticketChangedEventSchema.parse(event),
    );
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]).toMatchObject({
      change: "session",
      ticketNumber: ticket.number,
      attachmentIndexChanged: false,
      linkedSessionName: expectedName,
    });
  });

  it("returns the committed start when post-commit event hydration fails", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService({
      repo: {
        ...repo,
        findListItem() {
          return Promise.reject(new Error("event row unavailable"));
        },
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "prepared",
    });

    expect(result.ok).toBe(true);
    expect(recorded.deletions).toEqual([]);
    expect(recorded.events).toEqual([]);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("in_progress");
    expect(persisted?.sessions).toHaveLength(1);
  });

  it("records the prepared mode on the link and provisions identically", async () => {
    const ticket = await createTicket();
    const { service } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "prepared",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ticket.sessions[0]?.startMode).toBe("prepared");
    expect(result.value.initialPromptQueued).toBe(false);
  });

  it("rejects a live active link naming the session and provisions nothing", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService();
    const first = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });
    expect(first.ok).toBe(true);
    recorded.provisions.length = 0;

    const second = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toEqual({
      code: "active_session",
      sessionName: buildTicketSessionName(ticket.number, ticket.title, 1),
    });
    expect(recorded.provisions).toEqual([]);
    expect(recorded.deletions).toEqual([]);
  });

  it("two concurrent starts yield one success and one start_in_progress", async () => {
    const ticket = await createTicket();
    let releaseProvision!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const { service, recorded } = makeService({
      async provisionSession(projectPath, sessionName) {
        recorded.provisions.push(sessionName);
        const createdAt = "2026-01-01T00:00:00Z";
        fixture.seedSession(projectPath, sessionName, { createdAt });
        await gate;
        return {
          worktreePath: `${projectPath}/.worktrees/${sessionName}`,
          branchName: `csm/${sessionName}`,
          conversationId: CONVERSATION_ID,
          createdAt,
        };
      },
    });

    const firstPromise = service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });
    await vi.waitFor(() => {
      expect(recorded.provisions).toHaveLength(1);
    });
    const second = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });
    releaseProvision();
    const first = await firstPromise;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toEqual({
      code: "start_in_progress",
      identifier: `${PROJECT_NAME}#${ticket.number}`,
    });
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.sessions).toHaveLength(1);
  });

  // Capture is a multi-minute LLM run, so no start dependency may reach it:
  // the retained snapshot is what materializes and what stays persisted.
  it("provisions the session without capturing a conversation compaction", async () => {
    const ticket = await createTicket();
    const { attachment, snapshot } = await addConversationAttachment(ticket, {
      attachmentId: "conv-retained",
      markdown: "retained snapshot",
    });
    const { service, recorded } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionName).toBe(
      buildTicketSessionName(ticket.number, ticket.title, 1),
    );
    expect(result.value.initialPromptQueued).toBe(true);

    const materializedPayload = recorded.materializations[0]?.attachments.find(
      (candidate) => candidate.id === attachment.id,
    )?.payload;
    expect(materializedPayload).toEqual(attachment.payload);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(
      persisted?.attachments.find((candidate) => candidate.id === attachment.id)
        ?.payload,
    ).toEqual(attachment.payload);
    const blob = await contentStore.read(snapshot.snapshotKey);
    expect(Buffer.from(blob).toString("utf8")).toBe("retained snapshot");
  });

  it.each(["pending", "failed"] as const)(
    "starts from the persisted %s conversation payload instead of capturing it",
    async (snapshotStatus) => {
      const ticket = await createTicket();
      const attachment = await repo.addAttachment({
        id: `conv-unsettled-${snapshotStatus}`,
        ticketId: ticket.id,
        description: "current investigation",
        payload: {
          ...pendingConversationPayload(),
          snapshotStatus,
          ...(snapshotStatus === "failed"
            ? { snapshotError: "Earlier capture was interrupted." }
            : {}),
        },
        createdAt: nextNow(),
        updatedAt: nextNow(),
      });
      const { service, recorded } = makeService();

      const result = await service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "agent",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.initialPromptQueued).toBe(true);
      // The materializer skips an unsettled snapshot; the start hands it the
      // durable payload rather than a capture made inside the request.
      expect(
        recorded.materializations[0]?.attachments.find(
          (candidate) => candidate.id === attachment.id,
        )?.payload,
      ).toEqual(attachment.payload);
      const persisted = await repo.find(PROJECT_PATH, ticket.number);
      expect(
        persisted?.attachments.find(
          (candidate) => candidate.id === attachment.id,
        )?.payload,
      ).toEqual(attachment.payload);
      expect(persisted?.status).toBe("in_progress");
    },
  );

  it("schedules a background refresh for the unsettled conversation attachments only", async () => {
    const ticket = await createTicket();
    const { attachment: captured } = await addConversationAttachment(ticket, {
      attachmentId: "conv-captured",
    });
    for (const snapshotStatus of ["pending", "failed"] as const) {
      await repo.addAttachment({
        id: `conv-${snapshotStatus}-refresh`,
        ticketId: ticket.id,
        description: `${snapshotStatus} context`,
        payload: {
          ...pendingConversationPayload(),
          snapshotStatus,
          ...(snapshotStatus === "failed"
            ? { snapshotError: "Earlier capture was interrupted." }
            : {}),
        },
        createdAt: nextNow(),
        updatedAt: nextNow(),
      });
    }
    const { service, recorded } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "prepared",
    });

    expect(result.ok).toBe(true);
    expect(recorded.snapshotRefreshes).toEqual([
      {
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: "conv-pending-refresh",
      },
      {
        projectName: PROJECT_NAME,
        number: ticket.number,
        attachmentId: "conv-failed-refresh",
      },
    ]);
    expect(
      recorded.snapshotRefreshes.map((entry) => entry.attachmentId),
    ).not.toContain(captured.id);
  });

  it.each(["provision", "materialize", "charter", "link"] as const)(
    "leaves the conversation attachment and its snapshot untouched when %s fails",
    async (phase) => {
      const ticket = await createTicket();
      const { attachment, snapshot } = await addConversationAttachment(ticket, {
        attachmentId: `conv-rollback-${phase}`,
        markdown: "original retained compaction",
      });
      const overrides: Partial<TicketStartServiceDeps> = {};
      if (phase === "provision") {
        overrides.provisionSession = () =>
          Promise.reject(new Error("provision failed"));
      }
      if (phase === "materialize") {
        overrides.materializeTicketContext = () =>
          Promise.reject(new Error("materialize failed"));
      }
      if (phase === "charter") {
        overrides.activateTicketCharter = () =>
          Promise.reject(new Error("charter failed"));
      }
      if (phase === "link") {
        overrides.repo = {
          ...repo,
          linkStartedSession() {
            return Promise.reject(new Error("link failed"));
          },
        };
      }
      const { service } = makeService(overrides);

      const result = await service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "prepared",
      });

      expect(result.ok).toBe(false);
      const blob = await contentStore.read(snapshot.snapshotKey);
      expect(Buffer.from(blob).toString("utf8")).toBe(
        "original retained compaction",
      );
      expect(
        await readdir(
          path.join(base, "ticket-content", ticket.id, attachment.id),
        ),
      ).toEqual([snapshot.fileName]);
      const persisted = await repo.find(PROJECT_PATH, ticket.number);
      expect(
        persisted?.attachments.find(
          (candidate) => candidate.id === attachment.id,
        )?.payload,
      ).toEqual(attachment.payload);
      expect(persisted?.sessions).toEqual([]);
      expect(persisted?.status).toBe("not_started");
    },
  );

  it("materializes strictly from the entry snapshot even when attachments change mid-start", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService({
      async provisionSession(projectPath, sessionName) {
        // A lock-free attachment add landing mid-start is legitimate drift;
        // the materialization input must still be the lock-entry snapshot.
        await repo.addAttachment({
          id: "late-note",
          ticketId: ticket.id,
          description: "added mid-start",
          payload: { kind: "note", markdown: "late" },
          createdAt: nextNow(),
          updatedAt: nextNow(),
        });
        recorded.provisions.push(sessionName);
        const createdAt = "2026-01-01T00:00:00Z";
        fixture.seedSession(projectPath, sessionName, { createdAt });
        return {
          worktreePath: `${projectPath}/.worktrees/${sessionName}`,
          branchName: `csm/${sessionName}`,
          conversationId: CONVERSATION_ID,
          createdAt,
        };
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(true);
    expect(recorded.materializations[0]?.attachments).toEqual([]);
  });

  it("compensates a materialization failure by deleting the session exactly once", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService({
      materializeTicketContext() {
        return Promise.reject(new Error("worktree write failed"));
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "context_preparation_failed",
      phase: "preparation",
      reason: "worktree write failed",
    });
    expect(recorded.deletions).toEqual([
      buildTicketSessionName(ticket.number, ticket.title, 1),
    ]);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("not_started");
    expect(persisted?.sessions).toEqual([]);
  });

  it("compensates a charter failure exactly once and surfaces the original error even when compensation fails", async () => {
    const ticket = await createTicket();
    const deletions: string[] = [];
    const { service } = makeService({
      activateTicketCharter() {
        return Promise.reject(new Error("charter unavailable"));
      },
      deleteSessionIfCurrent(_projectPath, sessionName) {
        deletions.push(sessionName);
        return Promise.reject(new Error("delete also failed"));
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "context_preparation_failed",
      phase: "preparation",
      reason: "charter unavailable",
    });
    expect(deletions).toHaveLength(1);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("not_started");
    expect(persisted?.sessions).toEqual([]);
  });

  it("retries on the next ordinal when strict compensation cleanup fails", async () => {
    const ticket = await createTicket();
    let materializationAttempts = 0;
    const compensationIncarnations: Array<{
      createdAt: string;
      worktreePath: string;
      branchName: string;
    }> = [];
    const { service } = makeService({
      materializeTicketContext() {
        materializationAttempts += 1;
        if (materializationAttempts === 1) {
          return Promise.reject(new Error("worktree write failed"));
        }
        return Promise.resolve([]);
      },
      deleteSessionIfCurrent(_projectPath, _sessionName, expected) {
        compensationIncarnations.push({ ...expected });
        return Promise.reject(new Error("branch cleanup failed"));
      },
    });

    const first = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "prepared",
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toMatchObject({
      code: "context_preparation_failed",
      reason: "worktree write failed",
    });

    const retry = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "prepared",
    });

    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const firstName = buildTicketSessionName(ticket.number, ticket.title, 1);
    expect(compensationIncarnations).toEqual([
      {
        createdAt: expect.any(String),
        worktreePath: `${PROJECT_PATH}/.worktrees/${firstName}`,
        branchName: `csm/${firstName}`,
      },
    ]);
    expect(retry.value.sessionName).toBe(
      buildTicketSessionName(ticket.number, ticket.title, 2),
    );
  });

  it("classifies a final-link transaction failure as a preparation failure and compensates", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService({
      repo: {
        ...repo,
        linkStartedSession() {
          return Promise.reject(new Error("link transaction failed"));
        },
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "context_preparation_failed",
      phase: "preparation",
      reason: "link transaction failed",
    });
    expect(recorded.deletions).toEqual([
      buildTicketSessionName(ticket.number, ticket.title, 1),
    ]);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("not_started");
    expect(persisted?.sessions).toEqual([]);
  });

  it.each(["deleted", "finished", "replaced"] as const)(
    "rejects without name-only compensation when the provisioned session is %s before the final link",
    async (interference) => {
      const ticket = await createTicket();
      const { service, recorded } = makeService({
        activateTicketCharter(input) {
          if (interference === "deleted" || interference === "replaced") {
            fixture.db
              .prepare(
                "DELETE FROM sessions WHERE project_path = ? AND session_name = ?",
              )
              .run(input.projectPath, input.sessionName);
          }
          if (interference === "replaced") {
            fixture.seedSession(input.projectPath, input.sessionName, {
              createdAt: "2026-07-11T00:00:00.000Z",
            });
          }
          if (interference === "finished") {
            fixture.db
              .prepare(
                "UPDATE sessions SET finished = 1 WHERE project_path = ? AND session_name = ?",
              )
              .run(input.projectPath, input.sessionName);
          }
          return Promise.resolve(undefined);
        },
      });

      const result = await service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "prepared",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatchObject({
        code: "context_preparation_failed",
        phase: "preparation",
      });
      if (result.error.code !== "context_preparation_failed") return;
      expect(result.error.reason).toMatch(new RegExp(interference, "i"));
      expect(recorded.deletions).toEqual([]);
      const persisted = await repo.find(PROJECT_PATH, ticket.number);
      expect(persisted?.status).toBe("not_started");
      expect(persisted?.sessions).toEqual([]);
    },
  );

  it.each(["finished", "replaced"] as const)(
    "advances past an occupied ordinal when a rejected session is %s",
    async (interference) => {
      const ticket = await createTicket();
      let interfered = false;
      const { service, recorded } = makeService({
        activateTicketCharter(input) {
          if (interfered) return Promise.resolve(undefined);
          interfered = true;
          if (interference === "replaced") {
            fixture.db
              .prepare(
                "DELETE FROM sessions WHERE project_path = ? AND session_name = ?",
              )
              .run(input.projectPath, input.sessionName);
            fixture.seedSession(input.projectPath, input.sessionName, {
              createdAt: "2026-07-11T00:00:00.000Z",
            });
          } else {
            fixture.db
              .prepare(
                "UPDATE sessions SET finished = 1 WHERE project_path = ? AND session_name = ?",
              )
              .run(input.projectPath, input.sessionName);
          }
          return Promise.resolve(undefined);
        },
      });

      const first = await service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "prepared",
      });
      expect(first.ok).toBe(false);

      const retry = await service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "prepared",
      });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.value.sessionName).toBe(
        buildTicketSessionName(ticket.number, ticket.title, 2),
      );
      expect(recorded.provisions).toEqual([
        buildTicketSessionName(ticket.number, ticket.title, 1),
        buildTicketSessionName(ticket.number, ticket.title, 2),
      ]);
    },
  );

  it.each(["materialization", "charter"] as const)(
    "preserves a replacement session when %s fails before the final link",
    async (phase) => {
      const ticket = await createTicket();
      const replacementCreatedAt = "2026-07-11T00:00:00.000Z";
      const compensationAttempts: string[] = [];
      const deletionAttempts: string[] = [];
      const replaceProvisionedSession = (
        projectPath: string,
        sessionName: string,
      ) => {
        fixture.db
          .prepare(
            "DELETE FROM sessions WHERE project_path = ? AND session_name = ?",
          )
          .run(projectPath, sessionName);
        fixture.seedSession(projectPath, sessionName, {
          createdAt: replacementCreatedAt,
        });
      };
      const failAfterReplacement = (
        projectPath: string,
        sessionName: string,
      ) => {
        replaceProvisionedSession(projectPath, sessionName);
        return Promise.reject(new Error(`${phase} unavailable`));
      };
      const { service } = makeService({
        materializeTicketContext(input) {
          if (phase === "materialization") {
            return failAfterReplacement(input.projectPath, input.sessionName);
          }
          return Promise.resolve([]);
        },
        activateTicketCharter(input) {
          if (phase === "charter") {
            return failAfterReplacement(input.projectPath, input.sessionName);
          }
          return Promise.resolve(undefined);
        },
        deleteSessionIfCurrent(projectPath, sessionName, expected) {
          compensationAttempts.push(expected.createdAt);
          const current = fixture.db
            .prepare(
              "SELECT created_at, worktree_path, branch_name, finished FROM sessions WHERE project_path = ? AND session_name = ?",
            )
            .get(projectPath, sessionName) as
            | {
                created_at: string;
                worktree_path: string;
                branch_name: string;
                finished: 0 | 1;
              }
            | undefined;
          if (current === undefined) {
            return Promise.resolve({
              deleted: false,
              reason: "missing" as const,
            });
          }
          if (
            current.created_at !== expected.createdAt ||
            current.worktree_path !== expected.worktreePath ||
            current.branch_name !== expected.branchName
          ) {
            return Promise.resolve({
              deleted: false,
              reason: "replaced" as const,
            });
          }
          if (current.finished === 1) {
            return Promise.resolve({
              deleted: false,
              reason: "finished" as const,
            });
          }
          deletionAttempts.push(sessionName);
          fixture.db
            .prepare(
              "DELETE FROM sessions WHERE project_path = ? AND session_name = ?",
            )
            .run(projectPath, sessionName);
          return Promise.resolve({ deleted: true, worktreeRemoved: false });
        },
      });

      const result = await service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "prepared",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toEqual({
        code: "context_preparation_failed",
        phase: "preparation",
        reason: `${phase} unavailable`,
      });
      expect(compensationAttempts).toHaveLength(1);
      expect(deletionAttempts).toEqual([]);
      const replacement = fixture.db
        .prepare(
          "SELECT created_at FROM sessions WHERE project_path = ? AND session_name = ?",
        )
        .get(
          PROJECT_PATH,
          buildTicketSessionName(ticket.number, ticket.title, 1),
        ) as { created_at: string } | undefined;
      expect(replacement?.created_at).toBe(replacementCreatedAt);
      const persisted = await repo.find(PROJECT_PATH, ticket.number);
      expect(persisted?.status).toBe("not_started");
      expect(persisted?.sessions).toEqual([]);
    },
  );

  it("reports a provisioning failure without compensation", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService({
      provisionSession() {
        return Promise.reject(new Error("worktree add failed"));
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "session_provision_failed",
      reason: "worktree add failed",
    });
    expect(recorded.deletions).toEqual([]);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("not_started");
  });

  it("demotes a stale own link (finished session) and restarts with the next ordinal, preserving history", async () => {
    const ticket = await createTicket();
    const { service } = makeService();
    const first = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });
    expect(first.ok).toBe(true);
    const firstName = buildTicketSessionName(ticket.number, ticket.title, 1);
    fixture.db
      .prepare(
        "UPDATE sessions SET finished = 1 WHERE project_path = ? AND session_name = ?",
      )
      .run(PROJECT_PATH, firstName);

    const second = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.sessionName).toBe(
      buildTicketSessionName(ticket.number, ticket.title, 2),
    );
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.sessions).toHaveLength(2);
    const ended = persisted?.sessions.find(
      (link) => link.sessionName === firstName,
    );
    expect(ended).toMatchObject({ endReason: "finished" });
    expect(ended?.endedAt).not.toBeNull();
  });

  it("detects a replacement by incarnation even when linkedAt is a future logical revision", async () => {
    const ticket = await createTicket();
    const oldSessionName = buildTicketSessionName(
      ticket.number,
      ticket.title,
      1,
    );
    const oldCreatedAt = "2026-01-01T00:00:00.000Z";
    fixture.seedSession(PROJECT_PATH, oldSessionName, {
      createdAt: oldCreatedAt,
    });
    await repo.linkStartedSession({
      id: "future-logical-link",
      projectPath: PROJECT_PATH,
      number: ticket.number,
      sessionName: oldSessionName,
      startMode: "agent",
      linkedAt: "9999-12-31T23:59:59.999Z",
      sessionCreatedAt: oldCreatedAt,
    });
    fixture.db
      .prepare(
        "DELETE FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .run(PROJECT_PATH, oldSessionName);
    fixture.seedSession(PROJECT_PATH, oldSessionName, {
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const { service } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "prepared",
    });

    expect(result.ok).toBe(true);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.sessions).toHaveLength(2);
    expect(
      persisted?.sessions.find((link) => link.id === "future-logical-link"),
    ).toMatchObject({ endReason: "replaced" });
  });

  it.each(["provision", "materialize", "charter"] as const)(
    "leaves a stale own link unchanged when %s fails",
    async (phase) => {
      const ticket = await createTicket();
      await addConversationAttachment(ticket, {
        attachmentId: `conv-stale-${phase}`,
      });
      const oldSessionName = buildTicketSessionName(
        ticket.number,
        ticket.title,
        1,
      );
      fixture.seedSession(PROJECT_PATH, oldSessionName, {
        createdAt: "2026-01-01T00:00:00Z",
      });
      const linked = await repo.linkStartedSession({
        id: `old-link-${phase}`,
        projectPath: PROJECT_PATH,
        number: ticket.number,
        sessionName: oldSessionName,
        startMode: "agent",
        linkedAt: nextNow(),
        sessionCreatedAt: "2026-01-01T00:00:00Z",
      });
      fixture.seedSession(PROJECT_PATH, oldSessionName, {
        createdAt: "2026-01-01T00:00:00Z",
        finished: true,
      });

      const overrides: Partial<TicketStartServiceDeps> = {};
      if (phase === "provision") {
        overrides.provisionSession = () =>
          Promise.reject(new Error("provision failed"));
      }
      if (phase === "materialize") {
        overrides.materializeTicketContext = () =>
          Promise.reject(new Error("materialize failed"));
      }
      if (phase === "charter") {
        overrides.activateTicketCharter = () =>
          Promise.reject(new Error("charter failed"));
      }
      const { service } = makeService(overrides);

      const result = await service.start({
        projectName: PROJECT_NAME,
        number: ticket.number,
        mode: "prepared",
      });

      expect(result.ok).toBe(false);
      const persisted = await repo.find(PROJECT_PATH, ticket.number);
      expect(persisted?.status).toBe(linked.status);
      expect(persisted?.sessions).toHaveLength(1);
      expect(persisted?.sessions[0]).toEqual(linked.sessions[0]);
      expect(persisted?.sessions[0]?.endedAt).toBeNull();
      expect(persisted?.sessions[0]?.endReason).toBeNull();
    },
  );

  it("reconciles a stale foreign link on a reused session name and retries the insert once", async () => {
    const blocker = await createTicket({ title: "Blocker" });
    const ticket = await createTicket();
    const reusedName = buildTicketSessionName(ticket.number, ticket.title, 1);
    // The foreign ticket holds an open link on the same name, but its session
    // row no longer exists — a stale leftover, not a live conflict.
    const oldCreatedAt = "2026-01-01T00:00:00Z";
    fixture.seedSession(PROJECT_PATH, reusedName, {
      createdAt: oldCreatedAt,
    });
    await repo.linkStartedSession({
      id: "stale-foreign-link",
      projectPath: PROJECT_PATH,
      number: blocker.number,
      sessionName: reusedName,
      startMode: "agent",
      linkedAt: nextNow(),
      sessionCreatedAt: oldCreatedAt,
    });
    fixture.db
      .prepare(
        "DELETE FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .run(PROJECT_PATH, reusedName);
    const { service, recorded } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(true);
    const foreign = await repo.find(PROJECT_PATH, blocker.number);
    // The freshly provisioned session now owns the reused name, so the stale
    // predecessor link classifies as replaced by a newer incarnation.
    expect(foreign?.sessions[0]).toMatchObject({
      endReason: "replaced",
    });
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.sessions[0]).toMatchObject({
      sessionName: reusedName,
      endedAt: null,
    });
    const sessionEvents = recorded.events.map((event) =>
      ticketChangedEventSchema.parse(event),
    );
    expect(sessionEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: "session",
          ticketNumber: blocker.number,
          linkedSessionName: reusedName,
        }),
        expect.objectContaining({
          change: "session",
          ticketNumber: ticket.number,
          linkedSessionName: reusedName,
        }),
      ]),
    );
  });

  it("returns the live-conflict error and compensates when the reused name is genuinely live", async () => {
    const blocker = await createTicket({ title: "Blocker" });
    const ticket = await createTicket();
    const reusedName = buildTicketSessionName(ticket.number, ticket.title, 1);
    fixture.seedSession(PROJECT_PATH, reusedName, {
      createdAt: "2026-01-01T00:00:00Z",
    });
    await repo.linkStartedSession({
      id: "live-foreign-link",
      projectPath: PROJECT_PATH,
      number: blocker.number,
      sessionName: reusedName,
      startMode: "agent",
      linkedAt: nextNow(),
      sessionCreatedAt: "2026-01-01T00:00:00Z",
    });
    fixture.db
      .prepare(
        "DELETE FROM sessions WHERE project_path = ? AND session_name = ?",
      )
      .run(PROJECT_PATH, reusedName);
    const { service, recorded } = makeService({
      provisionSession(projectPath, sessionName) {
        recorded.provisions.push(sessionName);
        fixture.seedSession(projectPath, sessionName, {
          createdAt: "2026-01-01T00:00:00Z",
        });
        return Promise.resolve({
          worktreePath: `${projectPath}/.worktrees/${sessionName}`,
          branchName: `csm/${sessionName}`,
          conversationId: CONVERSATION_ID,
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({
      code: "active_session",
      sessionName: reusedName,
    });
    expect(recorded.deletions).toEqual([reusedName]);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("not_started");
    expect(persisted?.sessions).toEqual([]);
  });

  it("rejects unknown tickets and invalid input", async () => {
    const { service, recorded } = makeService();

    const missing = await service.start({
      projectName: PROJECT_NAME,
      number: 99,
      mode: "agent",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("ticket_not_found");
    }

    const invalid = await service.start({
      projectName: PROJECT_NAME,
      number: 1,
      // @ts-expect-error invalid mode must be rejected at the boundary
      mode: "yolo",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("validation_failed");
    }
    expect(recorded.provisions).toEqual([]);
  });
});

describe("kickoff dispatch", () => {
  async function seedNoteAttachment(
    ticket: TicketDetail,
    description: string,
  ): Promise<string> {
    const attachment = await repo.addAttachment({
      id: `note-${++idSeq}`,
      ticketId: ticket.id,
      description,
      payload: { kind: "note", markdown: "Repro steps live here." },
      createdAt: nextNow(),
      updatedAt: nextNow(),
    });
    return attachment.id;
  }

  it("agent mode queues exactly one kickoff, only after the link transaction commits", async () => {
    const ticket = await createTicket();
    const attachmentId = await seedNoteAttachment(ticket, "reproduction steps");
    const { service, recorded } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.initialPromptQueued).toBe(true);
    expect(recorded.kickoffs).toHaveLength(1);
    const kickoff = recorded.kickoffs[0];
    expect(kickoff?.linkCommittedAtCall).toBe(true);
    expect(kickoff?.input).toMatchObject({
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      sessionName: result.value.sessionName,
      conversationId: CONVERSATION_ID,
      ticketIdentifier: `${PROJECT_NAME}#${ticket.number}`,
    });
    const prompt = kickoff?.input.prompt ?? "";
    expect(prompt).toContain(`${PROJECT_NAME}#${ticket.number}`);
    expect(prompt).toContain(ticket.title);
    expect(prompt).toContain(ticket.description);
    expect(prompt).toContain(attachmentId);
    expect(prompt).toContain("reproduction steps");
    expect(prompt).toContain(
      `cctl ticket attachment get '${PROJECT_NAME}#${ticket.number}' '${attachmentId}'`,
    );
  });

  it("queues bounded relationship and status-update indexes with stable drill-down handles", async () => {
    const ticket = await createTicket();
    const relationshipDescriptions: string[] = [];
    for (
      let index = 1;
      index <= TICKET_RELATIONSHIP_OUTLINE_LIMIT + 1;
      index += 1
    ) {
      const otherTicket = await createTicket({
        title: `Related ticket ${index}`,
      });
      const description = `relationship rationale ${index} ${"r".repeat(200)}`;
      relationshipDescriptions.push(description);
      await repo.addRelationship({
        id: `kickoff-relationship-${String(index).padStart(2, "0")}`,
        anchorTicketId: ticket.id,
        relationType: "related",
        sourceTicketId: ticket.id,
        targetTicketId: otherTicket.id,
        description,
        createdAt: nextNow(),
      });
    }
    const statusBodies: string[] = [];
    for (
      let index = 1;
      index <= TICKET_STATUS_UPDATE_RECENT_LIMIT + 2;
      index += 1
    ) {
      const bodyMarkdown = `status update ${index} ${"s".repeat(240)}`;
      statusBodies.push(bodyMarkdown);
      await repo.addStatusUpdate({
        id: `kickoff-update-${String(index).padStart(2, "0")}`,
        ticketId: ticket.id,
        bodyMarkdown,
        author: { kind: "user" },
        createdAt: nextNow(),
      });
    }
    const { service, recorded } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prompt = recorded.kickoffs[0]?.input.prompt ?? "";
    const identifier = `${PROJECT_NAME}#${ticket.number}`;
    expect(prompt.match(/cctl ticket relation get /g)).toHaveLength(
      TICKET_RELATIONSHIP_OUTLINE_LIMIT,
    );
    expect(prompt.match(/cctl ticket status-update get /g)).toHaveLength(
      TICKET_STATUS_UPDATE_RECENT_LIMIT,
    );
    expect(prompt).toContain(
      `relationships: ${TICKET_RELATIONSHIP_OUTLINE_LIMIT + 1} total, ${TICKET_RELATIONSHIP_OUTLINE_LIMIT} returned, truncated=yes; rest: cctl ticket relation list '${identifier}'`,
    );
    expect(prompt).toContain(
      `status updates: ${TICKET_STATUS_UPDATE_RECENT_LIMIT + 2} total, ${TICKET_STATUS_UPDATE_RECENT_LIMIT} returned, truncated=yes; rest: cctl ticket status-update list '${identifier}'`,
    );
    expect(prompt).toContain(
      `cctl ticket relation get '${identifier}' 'kickoff-relationship-21'`,
    );
    expect(prompt).not.toContain(
      `cctl ticket relation get '${identifier}' 'kickoff-relationship-01'`,
    );
    expect(prompt).toContain(
      `cctl ticket status-update get '${identifier}' 'kickoff-update-07'`,
    );
    expect(prompt).not.toContain(
      `cctl ticket status-update get '${identifier}' 'kickoff-update-01'`,
    );

    const newestRelationship = relationshipDescriptions.at(-1) ?? "";
    expect(prompt).toContain(
      `${newestRelationship.slice(0, RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS - 1)}…`,
    );
    expect(prompt).not.toContain(newestRelationship);
    const newestStatus = statusBodies.at(-1) ?? "";
    expect(prompt).toContain(
      `${newestStatus.slice(0, STATUS_UPDATE_BODY_PREVIEW_CHARS - 1)}…`,
    );
    expect(prompt).not.toContain(newestStatus);
  });

  it("prepared mode runs no kickoff and reports initialPromptQueued false", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService();

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "prepared",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.initialPromptQueued).toBe(false);
    expect(recorded.kickoffs).toEqual([]);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("in_progress");
  });

  it("keeps the start committed and usable when the kickoff dep throws", async () => {
    const ticket = await createTicket();
    const { service, recorded } = makeService({
      queueKickoff() {
        return Promise.reject(new Error("dispatcher unavailable"));
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.initialPromptQueued).toBe(false);
    expect(recorded.deletions).toEqual([]);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("in_progress");
    expect(persisted?.sessions).toHaveLength(1);
    expect(persisted?.sessions[0]?.endedAt).toBeNull();
  });

  it("reports initialPromptQueued false when the kickoff dep declines to queue", async () => {
    const ticket = await createTicket();
    const { service } = makeService({
      queueKickoff() {
        return Promise.resolve(false);
      },
    });

    const result = await service.start({
      projectName: PROJECT_NAME,
      number: ticket.number,
      mode: "agent",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.initialPromptQueued).toBe(false);
    const persisted = await repo.find(PROJECT_PATH, ticket.number);
    expect(persisted?.status).toBe("in_progress");
  });
});

describe("buildTicketKickoffPrompt", () => {
  it("renders identifier, title, description, and the bounded attachment index with retrieval commands", () => {
    const prompt = buildTicketKickoffPrompt({
      identifier: "demo#7",
      title: "Fix the flaky gate",
      description: "It fails on Tuesdays.",
      attachments: [
        {
          id: "att-1",
          ticketId: "ticket-1",
          description: `long description ${"x".repeat(200)}`,
          payload: { kind: "note", markdown: "body" },
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      relationships: [
        {
          id: "relationship-1",
          role: "blocks",
          otherTicket: {
            id: "ticket-2",
            projectName: "other",
            number: 4,
            title: "Dependent rollout",
            status: "blocked",
          },
          description: "This ticket must land before rollout.",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      statusUpdates: {
        total: 1,
        recent: [
          {
            id: "update-1",
            ticketId: "ticket-1",
            bodyMarkdown: "Investigated the flaky gate.",
            author: { kind: "user" },
            createdAt: "2026-07-10T01:00:00.000Z",
          },
        ],
      },
    });

    expect(prompt).toContain("demo#7");
    expect(prompt).toContain("Fix the flaky gate");
    expect(prompt).toContain("It fails on Tuesdays.");
    expect(prompt).toContain("att-1 note");
    expect(prompt).toContain("cctl ticket attachment get 'demo#7' 'att-1'");
    // Bounded mode: long descriptions are shortened with an explicit ellipsis.
    expect(prompt).toContain("…");
    expect(prompt).not.toContain("x".repeat(200));
    expect(prompt).toContain("relationship-1 blocks other#4");
    expect(prompt).toContain(
      "cctl ticket relation get 'demo#7' 'relationship-1'",
    );
    expect(prompt).toContain("update-1 2026-07-10T01:00:00.000Z User");
    expect(prompt).toContain(
      "cctl ticket status-update get 'demo#7' 'update-1'",
    );
  });

  it("states the absence of attachments instead of rendering an empty index", () => {
    const prompt = buildTicketKickoffPrompt({
      identifier: "demo#7",
      title: "Fix the flaky gate",
      description: "",
      attachments: [],
      relationships: [],
      statusUpdates: { total: 0, recent: [] },
    });
    expect(prompt).toContain("no attachments");
    expect(prompt).toContain(
      "relationships: 0 total, 0 returned, truncated=no",
    );
    expect(prompt).toContain(
      "status updates: 0 total, 0 returned, truncated=no",
    );
  });
});
