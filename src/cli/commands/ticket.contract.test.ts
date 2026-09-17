import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import type { ConversationListItem } from "@/lib/conversations/schemas";
import { createTicketAttachmentService } from "@/lib/tickets/attachment-service";
import {
  createTicketAttachmentRouteHandlers,
  type TicketAttachmentRouteHandlers,
} from "@/lib/tickets/attachment-route-handlers";
import {
  createTicketContentStore,
  type TicketContentStore,
} from "@/lib/tickets/content-store";
import {
  createTicketRelationshipRouteHandlers,
  type TicketRelationshipRouteHandlers,
} from "@/lib/tickets/relationship-route-handlers";
import { createTicketRelationshipService } from "@/lib/tickets/relationship-service";
import {
  createConversationSnapshotRefreshRouteHandlers,
  type ConversationSnapshotRefreshRouteHandlers,
} from "@/lib/tickets/snapshot-refresh-route-handlers";
import { createConversationSnapshotRefreshService } from "@/lib/tickets/snapshot-refresh";
import {
  createTicketStatusUpdateRouteHandlers,
  type TicketStatusUpdateRouteHandlers,
} from "@/lib/tickets/status-update-route-handlers";
import { createTicketStatusUpdateService } from "@/lib/tickets/status-update-service";
import { createTicketService } from "@/lib/tickets/service";
import {
  createTicketsRouteHandlers,
  type TicketsRouteHandlers,
} from "@/lib/tickets/route-handlers";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { runCcWithHost } from "../testing/domain-runtime";
import type { CliEnv, CliHost } from "../transport";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real ticket and
 * attachment route handlers in-process over a real :memory: store, a real
 * on-disk content store, and the real token gate — so CRUD, every attach kind,
 * the index in both output modes, and the exit-code contract (1 unknown
 * ticket, 2 pre-network usage, 3 auth) are proven against production
 * classification, not fakes. The conversation/session ports (compaction
 * ensure, session overview) are the service's injected external seams.
 */

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "cc";
const PROJECT_PATH = "/repos/cc";
const OTHER_PROJECT_NAME = "other-repo";
const OTHER_PROJECT_PATH = "/repos/other-repo";
const TOKEN = "contract-token";

const PROJECTS: Record<string, string> = {
  [PROJECT_NAME]: PROJECT_PATH,
  [OTHER_PROJECT_NAME]: OTHER_PROJECT_PATH,
};

async function resolveProjectPath(name: string): Promise<string | null> {
  return PROJECTS[name] ?? null;
}

let dir: string;
let db: Db;
let repo: TicketsRepo;
let contentStore: TicketContentStore;
let handlers: TicketsRouteHandlers;
let attachmentHandlers: TicketAttachmentRouteHandlers;
let relationshipHandlers: TicketRelationshipRouteHandlers;
let statusUpdateHandlers: TicketStatusUpdateRouteHandlers;
let snapshotRefreshHandlers: ConversationSnapshotRefreshRouteHandlers;

function laneConversation(): ConversationListItem {
  return {
    scope: "session",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    worktreePath: `${PROJECT_PATH}/.worktrees/lane-session`,
    sessionName: "lane-session",
    conversationId: "lane-conversation",
    conversationName: "Implement ticket CLI",
    summary: "Contract fixture",
    firstPromptSnippet: "Implement enhanced tickets",
    backend: "codex",
    backendRef: { backend: "codex", ref: "lane-backend-ref" },
    transcriptPath: `${PROJECT_PATH}/lane-conversation.jsonl`,
    debugLogPath: `${PROJECT_PATH}/lane-conversation.log`,
    status: "awaiting",
    lastActivityAt: "2026-07-10T00:00:00.000Z",
    archived: false,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-ticket-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
  await mkdir(path.join(dir, "ticket-content"), { recursive: true });

  db = _createTestDb({ inMemory: true });
  const insertProject = db.prepare(
    "INSERT INTO projects (root_path) VALUES (?)",
  );
  insertProject.run(PROJECT_PATH);
  insertProject.run(OTHER_PROJECT_PATH);

  repo = createTicketsRepo(db, createWriteQueue());
  let idSeq = 0;
  let clock = 0;
  const now = () => {
    clock += 1;
    return `2026-07-10T00:00:${String(clock).padStart(2, "0")}.000Z`;
  };
  const generateId = () => {
    idSeq += 1;
    return `id-${idSeq}`;
  };
  const service = createTicketService({
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
    resolveProjectPath,
    resolveAvailableProjectPath: resolveProjectPath,
    deleteTicketContent: () => Promise.resolve(),
    publish: () => ({ delivered: true }),
    runProjectTicketOperation: (_projectPath, operation) =>
      operation({ projectDeletionPrecededOperation: false }),
    runTicketOperation: (_key, fn) => fn(),
    now,
    generateId,
  });
  const auth = createAgentAuth({ configDir: dir });
  handlers = createTicketsRouteHandlers({
    getService: () => service,
    resolveProjectPath,
    resolveAvailableProjectPath: resolveProjectPath,
    auth,
  });

  const relationshipService = createTicketRelationshipService({
    repo,
    resolveProjectPath,
    runMultiProjectTicketOperation: (_projectPaths, operation) =>
      operation({ projectDeletionPrecededOperation: false }),
    runTicketOperation: (_key, operation) => operation(),
    publish: () => ({ delivered: true }),
    now,
    generateId,
  });
  relationshipHandlers = createTicketRelationshipRouteHandlers({
    getService: () => relationshipService,
    validateOptionalToken: (request) => auth.validateOptionalToken(request),
  });

  const statusUpdateService = createTicketStatusUpdateService({
    repo,
    resolveProjectPath,
    runProjectTicketOperation: (_projectPath, operation) =>
      operation({ projectDeletionPrecededOperation: false }),
    runTicketOperation: (_key, operation) => operation(),
    publish: () => ({ delivered: true }),
    now,
    generateId,
  });
  statusUpdateHandlers = createTicketStatusUpdateRouteHandlers({
    getService: () => statusUpdateService,
    validateOptionalToken: (request) => auth.validateOptionalToken(request),
    findConversationById: (conversationId) =>
      Promise.resolve(
        conversationId === "lane-conversation" ? laneConversation() : null,
      ),
  });

  contentStore = createTicketContentStore({
    contentRoot: path.join(dir, "ticket-content"),
    listTicketIdsForProject: () => Promise.resolve([]),
  });
  const attachmentService = createTicketAttachmentService({
    repo,
    contentStore,
    resolveProjectPath,
    runProjectTicketOperation: (_projectPath, operation) => operation(),
    scheduleConversationSnapshotRefresh: () => {},
    getLiveCompaction: () =>
      Promise.resolve({
        markdown: "## Live compaction",
        capturedAt: "2026-07-10T02:00:00.000Z",
        coveredEndSeq: 0,
      }),
    resolveConversation: (input) =>
      Promise.resolve(
        input.sessionName === null
          ? { ...input, sessionName: "owner-session" }
          : input,
      ),
    conversationExists: () => Promise.resolve(true),
    getSessionOverview: () =>
      Promise.resolve({
        sessionName: "csm/fix-gate",
        finished: false,
        conversationIds: ["conv-1"],
      }),
    isTicketStartActive: () => false,
    onTicketStartReleased: () => Promise.resolve(),
    publish: () => ({ delivered: true }),
    now,
    generateId,
  });
  attachmentHandlers = createTicketAttachmentRouteHandlers({
    getTicketService: () => service,
    getAttachmentService: () => attachmentService,
    auth,
  });
  const snapshotRefreshService = createConversationSnapshotRefreshService({
    repo,
    contentStore,
    resolveProjectPath,
    runProjectTicketOperation: (_projectPath, operation) => operation(),
    ensureConversationCompaction: () =>
      Promise.resolve({
        ok: true,
        markdown: "## Refreshed compaction",
        capturedAt: "2026-07-10T03:00:00.000Z",
      }),
    publish: () => ({ delivered: true }),
    now,
    generateId,
  });
  snapshotRefreshHandlers = createConversationSnapshotRefreshRouteHandlers({
    getService: () => snapshotRefreshService,
    auth,
  });
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeHost(): CliHost & { fetchCount: () => number } {
  let fetches = 0;
  return {
    fetchCount: () => fetches,
    async fetch(url, init) {
      fetches += 1;
      const segments = new URL(url).pathname.split("/").filter(Boolean);
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.rawBody ?? init.body,
      });

      // /api/tickets
      if (segments[1] === "tickets") {
        return handlers.globalListGET(request);
      }
      // /api/projects/<name>/tickets/<number>/attachments[/<attachmentId>]
      const name = decodeURIComponent(segments[2] ?? "");
      const number = segments[4];
      if (segments[5] === "relationships") {
        const relationshipId = segments[6]
          ? decodeURIComponent(segments[6])
          : undefined;
        const context = {
          params: Promise.resolve({
            name,
            number: number ?? "",
            relationshipId: relationshipId ?? "",
          }),
        };
        if (relationshipId === undefined) {
          return init.method === "POST"
            ? relationshipHandlers.addPOST(request, context)
            : relationshipHandlers.indexGET(request, context);
        }
        if (init.method === "PATCH") {
          return relationshipHandlers.editPATCH(request, context);
        }
        if (init.method === "DELETE") {
          return relationshipHandlers.removeDELETE(request, context);
        }
        return relationshipHandlers.resolveGET(request, context);
      }
      if (segments[5] === "status-updates") {
        const updateId = segments[6]
          ? decodeURIComponent(segments[6])
          : undefined;
        const context = {
          params: Promise.resolve({
            name,
            number: number ?? "",
            updateId: updateId ?? "",
          }),
        };
        if (updateId === undefined) {
          return init.method === "POST"
            ? statusUpdateHandlers.postPOST(request, context)
            : statusUpdateHandlers.indexGET(request, context);
        }
        return statusUpdateHandlers.resolveGET(request, context);
      }
      if (segments[5] === "attachments") {
        const attachmentId = segments[6]
          ? decodeURIComponent(segments[6])
          : undefined;
        const context = {
          params: Promise.resolve({
            name,
            number: number ?? "",
            attachmentId: attachmentId ?? "",
          }),
        };
        if (attachmentId === undefined) {
          return init.method === "POST"
            ? attachmentHandlers.addPOST(request, context)
            : attachmentHandlers.indexGET(request, context);
        }
        if (segments[7] === "refresh-snapshot" && init.method === "POST") {
          return snapshotRefreshHandlers.refreshPOST(request, context);
        }
        if (init.method === "PATCH") {
          return attachmentHandlers.editPATCH(request, context);
        }
        if (init.method === "DELETE") {
          return attachmentHandlers.removeDELETE(request, context);
        }
        return attachmentHandlers.resolveGET(request, context);
      }
      // /api/projects/<name>/tickets[/<number>]
      const context = {
        params: Promise.resolve({ name, number: number ?? "" }),
      };
      if (number === undefined) {
        return init.method === "POST"
          ? handlers.projectCreatePOST(request, context)
          : handlers.projectListGET(request, context);
      }
      if (init.method === "PATCH")
        return handlers.detailPATCH(request, context);
      if (init.method === "DELETE") {
        return handlers.detailDELETE(request, context);
      }
      return handlers.detailGET(request, context);
    },
    async readTextFile(filePath) {
      try {
        return await readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    async readFileBytes(filePath) {
      try {
        return new Uint8Array(await readFile(filePath));
      } catch {
        return null;
      }
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

function makeEnv(overrides: CliEnv = {}): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4999",
    CC_API_TOKEN: TOKEN,
    CC_PROJECT: PROJECT_NAME,
    ...overrides,
  };
}

/** The env CC injects into a graph-workflow lane conversation. */
function makeLaneEnv(overrides: CliEnv = {}): CliEnv {
  return makeEnv({
    CC_SESSION: "lane-session",
    CC_CONVERSATION_ID: "lane-conversation",
    CC_WORKFLOW_EXECUTION_ID: "exec-1",
    CC_WORKFLOW_CONTEXT_ID: "ctx-1",
    ...overrides,
  });
}

describe("cctl ticket against the real route handlers", () => {
  it("create → list → get → update → delete round-trips through the real store", async () => {
    const host = makeHost();

    const created = await runCcWithHost(
      ["ticket", "create", "--title", "First", "--type", "feature"],
      makeEnv(),
      host,
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("created cc#1");

    const second = await runCcWithHost(
      ["ticket", "create", "--title", "Second", "--type", "bug", "--json"],
      makeEnv(),
      host,
    );
    expect(JSON.parse(second.stdout).payload.data.ticket.number).toBe(2);

    const listed = await runCcWithHost(
      ["ticket", "list", "--json"],
      makeEnv(),
      host,
    );
    expect(JSON.parse(listed.stdout).payload.data.tickets).toHaveLength(2);

    const updated = await runCcWithHost(
      ["ticket", "update", "1", "--status", "in_progress"],
      makeEnv(),
      host,
    );
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("updated cc#1");

    const read = await runCcWithHost(
      ["ticket", "get", "1", "--json"],
      makeEnv(),
      host,
    );
    const detail = JSON.parse(read.stdout).payload.data.ticket;
    expect(detail.status).toBe("in_progress");
    expect(detail.title).toBe("First");

    const deleted = await runCcWithHost(
      ["ticket", "delete", "1"],
      makeEnv(),
      host,
    );
    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout).toContain("deleted cc#1");

    const afterDelete = await runCcWithHost(
      ["ticket", "list", "--json"],
      makeEnv(),
      host,
    );
    expect(JSON.parse(afterDelete.stdout).payload.data.tickets).toHaveLength(1);
  });

  it("filters the real list by status", async () => {
    const host = makeHost();
    await runCcWithHost(
      ["ticket", "create", "--title", "A", "--type", "bug"],
      makeEnv(),
      host,
    );
    await runCcWithHost(
      [
        "ticket",
        "create",
        "--title",
        "B",
        "--type",
        "bug",
        "--status",
        "in_progress",
      ],
      makeEnv(),
      host,
    );

    const listed = await runCcWithHost(
      ["ticket", "list", "--status", "in_progress", "--json"],
      makeEnv(),
      host,
    );
    const tickets = JSON.parse(listed.stdout).payload.data.tickets;
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe("B");
  });

  describe("identifier forms and lane identity", () => {
    it("resolves the qualified form cross-scope without any ambient project", async () => {
      const host = makeHost();
      await runCcWithHost(
        [
          "ticket",
          "create",
          "--title",
          "Elsewhere",
          "--type",
          "research",
          "--project",
          OTHER_PROJECT_NAME,
        ],
        makeEnv(),
        host,
      );

      const scopeless = makeEnv();
      delete scopeless["CC_PROJECT"];
      const read = await runCcWithHost(
        ["ticket", "get", `${OTHER_PROJECT_NAME}#1`, "--json"],
        scopeless,
        host,
      );
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout).payload.data.ticket.projectName).toBe(
        OTHER_PROJECT_NAME,
      );
    });

    it("resolves bare and qualified forms from a graph-workflow lane env", async () => {
      const host = makeHost();
      await runCcWithHost(
        ["ticket", "create", "--title", "Lane-local", "--type", "feature"],
        makeLaneEnv(),
        host,
      );
      await runCcWithHost(
        [
          "ticket",
          "create",
          "--title",
          "Cross-project",
          "--type",
          "feature",
          "--project",
          OTHER_PROJECT_NAME,
        ],
        makeLaneEnv(),
        host,
      );

      const bare = await runCcWithHost(
        ["ticket", "get", "1", "--json"],
        makeLaneEnv(),
        host,
      );
      expect(bare.exitCode).toBe(0);
      expect(JSON.parse(bare.stdout).payload.data.ticket.projectName).toBe(
        PROJECT_NAME,
      );

      const qualified = await runCcWithHost(
        ["ticket", "get", `${OTHER_PROJECT_NAME}#1`, "--json"],
        makeLaneEnv(),
        host,
      );
      expect(qualified.exitCode).toBe(0);
      expect(JSON.parse(qualified.stdout).payload.data.ticket.projectName).toBe(
        OTHER_PROJECT_NAME,
      );
    });
  });

  describe("exit codes", () => {
    it("exits 1 with ticket_not_found naming the reference for an unknown ticket", async () => {
      const host = makeHost();
      const result = await runCcWithHost(
        ["ticket", "get", "99", "--json"],
        makeEnv(),
        host,
      );
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.error.details.serverCode).toBe("ticket_not_found");
      expect(envelope.error.message).toContain("cc#99");
    });

    it("rejects an invalid ticket reference before any network call", async () => {
      const host = makeHost();
      const badRef = await runCcWithHost(
        ["ticket", "get", "twelve"],
        makeEnv(),
        host,
      );
      expect(badRef.exitCode).toBe(2);
      expect(host.fetchCount()).toBe(0);
    });

    it("validates relationship and status-update inputs before any request", async () => {
      const host = makeHost();
      const invalidInvocations = [
        ["ticket", "relation", "list", "1", "--cursor", "invented"],
        ["ticket", "status-update", "add", "1", "--body", "   "],
        ["ticket", "status-update", "add", "1", "--body", "progress"],
        [
          "ticket",
          "status-update",
          "add",
          "1",
          "--body",
          "progress",
          "--conversation",
          "override",
        ],
      ];
      for (const argv of invalidInvocations) {
        const result = await runCcWithHost(argv, makeEnv(), host);
        expect(result.exitCode, argv.join(" ")).toBe(2);
      }
      expect(host.fetchCount()).toBe(0);
    });

    it("exits 3 when the real token gate rejects a wrong token", async () => {
      const host = makeHost();
      const result = await runCcWithHost(
        ["ticket", "list"],
        makeEnv({ CC_API_TOKEN: "wrong" }),
        host,
      );
      expect(result.exitCode).toBe(3);
    });
  });

  describe("relationships and status updates over the real handlers", () => {
    async function createTicket(host: CliHost, title: string): Promise<number> {
      const created = await runCcWithHost(
        ["ticket", "create", "--title", title, "--type", "feature", "--json"],
        makeEnv(),
        host,
      );
      expect(created.exitCode).toBe(0);
      return JSON.parse(created.stdout).payload.data.ticket.number as number;
    }

    it("keeps relationship lists bounded in text and JSON while stable IDs reveal full rationale", async () => {
      const host = makeHost();
      await createTicket(host, "Relationship host");
      await createTicket(host, "Dependency");
      await createTicket(host, "Peer");
      const firstRationale = `dependency rationale ${"alpha ".repeat(30)}ALPHA_TAIL`;
      const secondRationale = `peer rationale ${"bravo ".repeat(30)}BRAVO_TAIL`;

      const first = await runCcWithHost(
        [
          "ticket",
          "relation",
          "add",
          "1",
          "2",
          "--role",
          "depends_on",
          "--description",
          firstRationale,
          "--json",
        ],
        makeEnv(),
        host,
      );
      const firstId = JSON.parse(first.stdout).payload.data.relationship
        .id as string;
      const second = await runCcWithHost(
        [
          "ticket",
          "relation",
          "add",
          "1",
          "3",
          "--role",
          "related",
          "--description",
          secondRationale,
          "--json",
        ],
        makeEnv(),
        host,
      );
      const secondId = JSON.parse(second.stdout).payload.data.relationship
        .id as string;

      const listedJson = await runCcWithHost(
        ["ticket", "relation", "list", "1", "--limit", "1", "--json"],
        makeEnv(),
        host,
      );
      expect(listedJson.exitCode).toBe(0);
      const page = JSON.parse(listedJson.stdout).payload.data;
      expect(page).toMatchObject({
        omission: {
          total: { kind: "known", count: 2 },
          returned: 1,
          truncated: true,
        },
        relationships: [
          {
            id: secondId,
            role: "related",
            getCommand: `cctl ticket relation get -- 'cc#1' ${secondId}`,
          },
        ],
        nextCursor: expect.any(String),
        revealCommand: expect.stringContaining("--limit=1 --cursor="),
      });
      expect(
        page.relationships[0].descriptionPreview.length,
      ).toBeLessThanOrEqual(120);
      expect(listedJson.stdout).not.toContain(secondRationale);
      expect(listedJson.stdout).not.toContain("BRAVO_TAIL");

      const listedText = await runCcWithHost(
        ["ticket", "relation", "list", "1", "--limit", "1"],
        makeEnv(),
        host,
      );
      expect(listedText.stdout).toContain("relationships: 2 total, 1 shown");
      expect(listedText.stdout).toContain(secondId);
      expect(listedText.stdout).toContain(
        `cctl ticket relation get -- 'cc#1' ${secondId}`,
      );
      expect(listedText.stdout).not.toContain("BRAVO_TAIL");

      const continued = await runCcWithHost(
        [
          "ticket",
          "relation",
          "list",
          "1",
          "--limit",
          "1",
          "--cursor",
          page.nextCursor,
          "--json",
        ],
        makeEnv(),
        host,
      );
      expect(JSON.parse(continued.stdout).payload.data).toMatchObject({
        omission: {
          total: { kind: "known", count: 2 },
          returned: 1,
          truncated: false,
        },
        relationships: [{ id: firstId }],
      });

      const revealed = await runCcWithHost(
        ["ticket", "relation", "get", "1", firstId, "--json"],
        makeEnv(),
        host,
      );
      expect(
        JSON.parse(revealed.stdout).payload.data.relationship.description,
      ).toBe(firstRationale);

      const cleared = await runCcWithHost(
        ["ticket", "relation", "update", "1", firstId, "--description="],
        makeEnv(),
        host,
      );
      expect(cleared.exitCode).toBe(0);
      const reread = await runCcWithHost(
        ["ticket", "relation", "get", "1", firstId, "--json"],
        makeEnv(),
        host,
      );
      expect(
        JSON.parse(reread.stdout).payload.data.relationship.description,
      ).toBe("");

      const removed = await runCcWithHost(
        ["ticket", "relation", "remove", "1", secondId, "--json"],
        makeEnv(),
        host,
      );
      expect(removed.exitCode).toBe(0);
      expect(JSON.parse(removed.stdout).payload.data.relationshipId).toBe(
        secondId,
      );
    });

    it("keeps update lists bounded while get returns full body and durable provenance", async () => {
      const host = makeHost();
      await createTicket(host, "Update host");
      const firstBody = `first update ${"alpha ".repeat(35)}FIRST_TAIL`;
      const secondBody = `second update ${"bravo ".repeat(35)}SECOND_TAIL`;

      const first = await runCcWithHost(
        ["ticket", "status-update", "add", "1", "--body", firstBody, "--json"],
        makeLaneEnv(),
        host,
      );
      const firstId = JSON.parse(first.stdout).payload.data.update.id as string;
      const second = await runCcWithHost(
        ["ticket", "status-update", "add", "1", "--body", secondBody, "--json"],
        makeLaneEnv(),
        host,
      );
      const secondId = JSON.parse(second.stdout).payload.data.update
        .id as string;

      const listedJson = await runCcWithHost(
        ["ticket", "status-update", "list", "1", "--limit", "1", "--json"],
        makeLaneEnv(),
        host,
      );
      expect(listedJson.exitCode).toBe(0);
      const page = JSON.parse(listedJson.stdout).payload.data;
      expect(page).toMatchObject({
        omission: {
          total: { kind: "known", count: 2 },
          returned: 1,
          truncated: true,
        },
        updates: [
          {
            id: secondId,
            authorKind: "agent",
            backend: "codex",
            conversationId: "lane-conversation",
            getCommand: `cctl ticket status-update get -- 'cc#1' ${secondId}`,
          },
        ],
        nextCursor: expect.any(String),
        revealCommand: expect.stringContaining("--limit=1 --cursor="),
      });
      expect(page.updates[0].bodyPreview.length).toBeLessThanOrEqual(160);
      expect(listedJson.stdout).not.toContain(secondBody);
      expect(listedJson.stdout).not.toContain("SECOND_TAIL");

      const listedText = await runCcWithHost(
        ["ticket", "status-update", "list", "1", "--limit", "1"],
        makeLaneEnv(),
        host,
      );
      expect(listedText.stdout).toContain("status updates: 2 total, 1 shown");
      expect(listedText.stdout).toContain(secondId);
      expect(listedText.stdout).not.toContain("SECOND_TAIL");

      const continued = await runCcWithHost(
        [
          "ticket",
          "status-update",
          "list",
          "1",
          "--limit",
          "1",
          "--cursor",
          page.nextCursor,
          "--json",
        ],
        makeLaneEnv(),
        host,
      );
      expect(JSON.parse(continued.stdout).payload.data).toMatchObject({
        omission: {
          total: { kind: "known", count: 2 },
          returned: 1,
          truncated: false,
        },
        updates: [{ id: firstId }],
      });

      const revealed = await runCcWithHost(
        ["ticket", "status-update", "get", "1", secondId, "--json"],
        makeLaneEnv(),
        host,
      );
      expect(JSON.parse(revealed.stdout).payload.data.update).toMatchObject({
        id: secondId,
        bodyMarkdown: secondBody,
        author: {
          kind: "agent",
          scope: "session",
          sessionName: "lane-session",
          conversationId: "lane-conversation",
          backend: "codex",
        },
      });

      const ticket = await runCcWithHost(
        ["ticket", "get", "1", "--json"],
        makeLaneEnv(),
        host,
      );
      const summary = JSON.parse(ticket.stdout).payload.data.ticket
        .statusUpdates;
      expect(summary).toMatchObject({
        total: 2,
        returned: 2,
        truncated: false,
      });
      expect(summary.items.map((item: { id: string }) => item.id)).toEqual([
        secondId,
        firstId,
      ]);
      expect(ticket.stdout).not.toContain("FIRST_TAIL");
      expect(ticket.stdout).not.toContain("SECOND_TAIL");
    });

    it("maps real semantic graph and actor refusals to exit 1 with context", async () => {
      const host = makeHost();
      await createTicket(host, "Refusal host");

      const selfLink = await runCcWithHost(
        ["ticket", "relation", "add", "1", "1", "--role", "related", "--json"],
        makeEnv(),
        host,
      );
      expect(selfLink.exitCode).toBe(1);
      expect(JSON.parse(selfLink.stdout).error).toMatchObject({
        details: {
          serverCode: "relationship_self_link",
          serverDetails: {
            source: { projectName: PROJECT_NAME, number: 1 },
            target: { projectName: PROJECT_NAME, number: 1 },
          },
        },
        why: expect.any(String),
      });

      const missingActor = await runCcWithHost(
        ["ticket", "status-update", "add", "1", "--body", "Progress", "--json"],
        makeLaneEnv({ CC_CONVERSATION_ID: "missing-conversation" }),
        host,
      );
      expect(missingActor.exitCode).toBe(1);
      expect(JSON.parse(missingActor.stdout).error).toMatchObject({
        details: {
          serverCode: "status_update_actor_not_found",
          serverDetails: { conversationId: "missing-conversation" },
        },
        why: expect.any(String),
      });
    });
  });

  describe("attachments over the real handlers and content store", () => {
    it("attaches a conversation owned by a different session than the caller env", async () => {
      const host = makeHost();
      await runCcWithHost(
        ["ticket", "create", "--title", "Host", "--type", "bug"],
        makeEnv(),
        host,
      );

      const attached = await runCcWithHost(
        [
          "ticket",
          "attach",
          "conversation",
          "1",
          "owner-conversation",
          "--description",
          "cross-session investigation",
          "--json",
        ],
        makeEnv({
          CC_SESSION: "caller-session",
          CC_CONVERSATION_ID: "caller-conversation",
        }),
        host,
      );

      expect(attached.exitCode).toBe(0);
      expect(
        JSON.parse(attached.stdout).payload.data.attachment.payload,
      ).toMatchObject({
        kind: "conversation",
        sessionName: "owner-session",
        conversationId: "owner-conversation",
      });
    });

    /** Creates cc#1/#2, four context attachments, and one related edge. */
    async function seedTicketWithContext(host: CliHost): Promise<void> {
      await runCcWithHost(
        ["ticket", "create", "--title", "Host ticket", "--type", "feature"],
        makeEnv(),
        host,
      );
      await runCcWithHost(
        ["ticket", "create", "--title", "Related work", "--type", "bug"],
        makeEnv(),
        host,
      );

      const filePath = path.join(dir, "notes.txt");
      await writeFile(filePath, "file body from disk\n");
      const attachments: string[][] = [
        [
          "ticket",
          "attach",
          "file",
          "1",
          filePath,
          "--description",
          "captured build notes",
        ],
        [
          "ticket",
          "attach",
          "conversation",
          "1",
          "conv-1",
          "--description",
          "design discussion snapshot",
        ],
        [
          "ticket",
          "attach",
          "session",
          "1",
          "csm/fix-gate",
          "--description",
          "session doing the work",
        ],
        [
          "ticket",
          "relation",
          "add",
          "1",
          "2",
          "--role",
          "related",
          "--description",
          "related bug this depends on",
        ],
        [
          "ticket",
          "attach",
          "note",
          "1",
          "Repro: run it twice.",
          "--description",
          "reproduction steps",
        ],
      ];
      for (const argv of attachments) {
        const result = await runCcWithHost(argv, makeEnv(), host);
        expect(result.exitCode, argv.join(" ")).toBe(0);
      }
    }

    it("keeps canonical attachments separate from the related edge in both modes", async () => {
      const host = makeHost();
      await seedTicketWithContext(host);

      const text = await runCcWithHost(["ticket", "get", "1"], makeEnv(), host);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("attachments:");
      for (const kind of ["file", "conversation", "session", "note"]) {
        expect(text.stdout).toContain(` ${kind} — `);
      }
      expect(text.stdout).toContain("related:");
      expect(text.stdout).toContain("cctl ticket relation get -- 'cc#1'");
      expect(text.stdout).toContain("cctl ticket attachment get 'cc#1' ");

      const json = await runCcWithHost(
        ["ticket", "get", "1", "--json"],
        makeEnv(),
        host,
      );
      const envelope = JSON.parse(json.stdout);
      expect(envelope.payload.data.attachmentIndex).toHaveLength(4);
      const kinds = envelope.payload.data.attachmentIndex.map(
        (entry: { kind: string }) => entry.kind,
      );
      expect(kinds.sort()).toEqual(["conversation", "file", "note", "session"]);
      for (const entry of envelope.payload.data.attachmentIndex) {
        expect(entry.commands[0]).toMatch(
          /^cctl ticket attachment get 'cc#1' /,
        );
        expect(entry.description.length).toBeGreaterThan(0);
      }
      expect(envelope.payload.data.ticket.relationships).toMatchObject({
        total: 1,
        returned: 1,
        truncated: false,
        items: [{ role: "related", otherTicket: "cc#2" }],
      });

      const relationshipId =
        envelope.payload.data.ticket.relationships.items[0].id;
      const relation = await runCcWithHost(
        ["ticket", "relation", "get", "1", relationshipId, "--json"],
        makeEnv(),
        host,
      );
      expect(relation.exitCode).toBe(0);
      expect(
        JSON.parse(relation.stdout).payload.data.relationship,
      ).toMatchObject({
        id: relationshipId,
        role: "related",
      });
    });

    it("includes the bounded index on list --attachments in both modes", async () => {
      const host = makeHost();
      await seedTicketWithContext(host);

      const text = await runCcWithHost(
        ["ticket", "list", "--attachments"],
        makeEnv(),
        host,
      );
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("cctl ticket attachment get 'cc#1' ");

      const json = await runCcWithHost(
        ["ticket", "list", "--attachments", "--json"],
        makeEnv(),
        host,
      );
      const envelope = JSON.parse(json.stdout);
      const first = envelope.payload.data.tickets.find(
        (ticket: { number: number }) => ticket.number === 1,
      );
      expect(first.attachmentIndex).toHaveLength(4);
      const second = envelope.payload.data.tickets.find(
        (ticket: { number: number }) => ticket.number === 2,
      );
      expect(second.attachmentIndex).toEqual([]);
    });

    it("counts attachments on the default list without fetching an index", async () => {
      const host = makeHost();
      await seedTicketWithContext(host);
      const before = host.fetchCount();

      const text = await runCcWithHost(["ticket", "list"], makeEnv(), host);

      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("attachments: 4");
      expect(text.stdout).not.toContain("cctl ticket attachment get");
      expect(host.fetchCount() - before).toBe(1);
    });

    it("retrieves a file snapshot's content after the source file is deleted", async () => {
      const host = makeHost();
      await runCcWithHost(
        ["ticket", "create", "--title", "Host", "--type", "feature"],
        makeEnv(),
        host,
      );
      const filePath = path.join(dir, "doomed.txt");
      await writeFile(filePath, "survives source deletion");
      const attached = await runCcWithHost(
        [
          "ticket",
          "attach",
          "file",
          "1",
          filePath,
          "--description",
          "d",
          "--json",
        ],
        makeEnv(),
        host,
      );
      const attachmentId = JSON.parse(attached.stdout).payload.data.attachment
        .id as string;
      await rm(filePath);

      const resolved = await runCcWithHost(
        ["ticket", "attachment", "get", "1", attachmentId],
        makeEnv(),
        host,
      );
      expect(resolved.exitCode).toBe(0);
      expect(resolved.stdout).toContain("survives source deletion");
      expect(resolved.stdout).toContain("doomed.txt");
    });

    it("updates and removes an attachment through the real store", async () => {
      const host = makeHost();
      await runCcWithHost(
        ["ticket", "create", "--title", "Host", "--type", "feature"],
        makeEnv(),
        host,
      );
      const attached = await runCcWithHost(
        [
          "ticket",
          "attach",
          "note",
          "1",
          "first body",
          "--description",
          "first",
          "--json",
        ],
        makeEnv(),
        host,
      );
      const attachmentId = JSON.parse(attached.stdout).payload.data.attachment
        .id as string;

      const updated = await runCcWithHost(
        [
          "ticket",
          "attachment",
          "update",
          "1",
          attachmentId,
          "--description",
          "second",
          "--markdown",
          "second body",
        ],
        makeEnv(),
        host,
      );
      expect(updated.exitCode).toBe(0);

      const resolved = await runCcWithHost(
        ["ticket", "attachment", "get", "1", attachmentId, "--json"],
        makeEnv(),
        host,
      );
      const resolvedEnvelope = JSON.parse(resolved.stdout).payload.data;
      expect(resolvedEnvelope.attachment.markdown).toBe("second body");
      expect(resolvedEnvelope.attachment.attachment.description).toBe("second");

      const removed = await runCcWithHost(
        ["ticket", "attachment", "remove", "1", attachmentId],
        makeEnv(),
        host,
      );
      expect(removed.exitCode).toBe(0);

      const after = await runCcWithHost(
        ["ticket", "get", "1", "--json"],
        makeEnv(),
        host,
      );
      expect(JSON.parse(after.stdout).payload.data.attachmentIndex).toEqual([]);
    });

    it("refreshes a pending conversation snapshot through the real route and store", async () => {
      const host = makeHost();
      await runCcWithHost(
        ["ticket", "create", "--title", "Host", "--type", "bug"],
        makeEnv(),
        host,
      );
      const ticket = await repo.find(PROJECT_PATH, 1);
      expect(ticket).not.toBeNull();
      await repo.addAttachment({
        id: "pending-conversation",
        ticketId: ticket!.id,
        description: "Conversation being compacted",
        payload: {
          kind: "conversation",
          projectPath: PROJECT_PATH,
          sessionName: "investigation",
          conversationId: "conv-1",
          snapshotKey: null,
          snapshotCapturedAt: null,
          snapshotStatus: "pending",
        },
        createdAt: "2026-07-10T00:10:00.000Z",
        updatedAt: "2026-07-10T00:10:00.000Z",
      });

      const refreshed = await runCcWithHost(
        [
          "ticket",
          "attachment",
          "refresh",
          "1",
          "pending-conversation",
          "--json",
        ],
        makeEnv(),
        host,
      );

      expect(refreshed.exitCode).toBe(0);
      expect(
        JSON.parse(refreshed.stdout).payload.data.attachment.payload,
      ).toMatchObject({
        kind: "conversation",
        snapshotStatus: "captured",
        snapshotCapturedAt: "2026-07-10T03:00:00.000Z",
      });
      const persisted = await repo.find(PROJECT_PATH, 1);
      expect(
        persisted?.attachments.find(
          (attachment) => attachment.id === "pending-conversation",
        )?.payload,
      ).toMatchObject({ snapshotStatus: "captured" });
    });

    it("exits 1 with attachment_not_found for an unknown attachment id", async () => {
      const host = makeHost();
      await runCcWithHost(
        ["ticket", "create", "--title", "Host", "--type", "feature"],
        makeEnv(),
        host,
      );
      const result = await runCcWithHost(
        ["ticket", "attachment", "get", "1", "att-missing", "--json"],
        makeEnv(),
        host,
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error.details.serverCode).toBe(
        "attachment_not_found",
      );
    });
  });
});
