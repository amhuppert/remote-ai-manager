import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth } from "@/lib/agent-gateway/token";
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
  createConversationSnapshotRefreshRouteHandlers,
  type ConversationSnapshotRefreshRouteHandlers,
} from "@/lib/tickets/snapshot-refresh-route-handlers";
import { createConversationSnapshotRefreshService } from "@/lib/tickets/snapshot-refresh";
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
import { runCli } from "../core";
import type { CliEnv, CliHost } from "../shared";

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
let snapshotRefreshHandlers: ConversationSnapshotRefreshRouteHandlers;

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

  contentStore = createTicketContentStore({
    contentRoot: path.join(dir, "ticket-content"),
    listTicketIdsForProject: () => Promise.resolve([]),
  });
  const attachmentService = createTicketAttachmentService({
    repo,
    contentStore,
    resolveProjectPath,
    runProjectTicketOperation: (_projectPath, operation) => operation(),
    ensureConversationCompaction: () =>
      Promise.resolve({
        ok: true,
        markdown: "## Compaction of the design discussion",
        capturedAt: "2026-07-10T01:00:00.000Z",
      }),
    getLiveCompaction: () =>
      Promise.resolve({
        markdown: "## Live compaction",
        capturedAt: "2026-07-10T02:00:00.000Z",
        coveredEndSeq: 0,
      }),
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

    const created = await runCli(
      ["ticket", "create", "--title", "First", "--type", "feature"],
      makeEnv(),
      host,
    );
    expect(created.exitCode).toBe(0);
    expect(created.stdout).toContain("created cc#1");

    const second = await runCli(
      ["ticket", "create", "--title", "Second", "--type", "bug", "--json"],
      makeEnv(),
      host,
    );
    expect(JSON.parse(second.stdout).ticket.number).toBe(2);

    const listed = await runCli(["ticket", "list", "--json"], makeEnv(), host);
    expect(JSON.parse(listed.stdout).tickets).toHaveLength(2);

    const updated = await runCli(
      ["ticket", "update", "1", "--status", "in_progress"],
      makeEnv(),
      host,
    );
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("updated cc#1");

    const read = await runCli(
      ["ticket", "get", "1", "--json"],
      makeEnv(),
      host,
    );
    const detail = JSON.parse(read.stdout).ticket;
    expect(detail.status).toBe("in_progress");
    expect(detail.title).toBe("First");

    const deleted = await runCli(["ticket", "delete", "1"], makeEnv(), host);
    expect(deleted.exitCode).toBe(0);
    expect(deleted.stdout).toContain("deleted cc#1");

    const afterDelete = await runCli(
      ["ticket", "list", "--json"],
      makeEnv(),
      host,
    );
    expect(JSON.parse(afterDelete.stdout).tickets).toHaveLength(1);
  });

  it("filters the real list by status", async () => {
    const host = makeHost();
    await runCli(
      ["ticket", "create", "--title", "A", "--type", "bug"],
      makeEnv(),
      host,
    );
    await runCli(
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

    const listed = await runCli(
      ["ticket", "list", "--status", "in_progress", "--json"],
      makeEnv(),
      host,
    );
    const tickets = JSON.parse(listed.stdout).tickets;
    expect(tickets).toHaveLength(1);
    expect(tickets[0].title).toBe("B");
  });

  describe("identifier forms and lane identity", () => {
    it("resolves the qualified form cross-scope without any ambient project", async () => {
      const host = makeHost();
      await runCli(
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
      const read = await runCli(
        ["ticket", "get", `${OTHER_PROJECT_NAME}#1`, "--json"],
        scopeless,
        host,
      );
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout).ticket.projectName).toBe(
        OTHER_PROJECT_NAME,
      );
    });

    it("resolves bare and qualified forms from a graph-workflow lane env", async () => {
      const host = makeHost();
      await runCli(
        ["ticket", "create", "--title", "Lane-local", "--type", "feature"],
        makeLaneEnv(),
        host,
      );
      await runCli(
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

      const bare = await runCli(
        ["ticket", "get", "1", "--json"],
        makeLaneEnv(),
        host,
      );
      expect(bare.exitCode).toBe(0);
      expect(JSON.parse(bare.stdout).ticket.projectName).toBe(PROJECT_NAME);

      const qualified = await runCli(
        ["ticket", "get", `${OTHER_PROJECT_NAME}#1`, "--json"],
        makeLaneEnv(),
        host,
      );
      expect(qualified.exitCode).toBe(0);
      expect(JSON.parse(qualified.stdout).ticket.projectName).toBe(
        OTHER_PROJECT_NAME,
      );
    });
  });

  describe("exit codes", () => {
    it("exits 1 with ticket_not_found naming the reference for an unknown ticket", async () => {
      const host = makeHost();
      const result = await runCli(
        ["ticket", "get", "99", "--json"],
        makeEnv(),
        host,
      );
      expect(result.exitCode).toBe(1);
      const envelope = JSON.parse(result.stdout);
      expect(envelope.code).toBe("ticket_not_found");
      expect(envelope.error).toContain("cc#99");
    });

    it("exits 2 on usage errors before any network call", async () => {
      const host = makeHost();
      const badRef = await runCli(["ticket", "get", "twelve"], makeEnv(), host);
      expect(badRef.exitCode).toBe(2);
      const missingTitle = await runCli(
        ["ticket", "create", "--type", "bug"],
        makeEnv(),
        host,
      );
      expect(missingTitle.exitCode).toBe(2);
      const badStatus = await runCli(
        ["ticket", "update", "1", "--status", "paused"],
        makeEnv(),
        host,
      );
      expect(badStatus.exitCode).toBe(2);
      expect(host.fetchCount()).toBe(0);
    });

    it("exits 2 before any request on extra positionals for every attachment command shape", async () => {
      const host = makeHost();
      const invocations = [
        ["ticket", "attach", "note", "1", "md", "extra", "--description", "d"],
        ["ticket", "attach", "ticket", "1", "2", "extra", "--description", "d"],
        [
          "ticket",
          "attach",
          "session",
          "1",
          "s1",
          "extra",
          "--description",
          "d",
        ],
        [
          "ticket",
          "attach",
          "conversation",
          "1",
          "conv-1",
          "extra",
          "--description",
          "d",
        ],
        [
          "ticket",
          "attach",
          "file",
          "1",
          "a.txt",
          "extra",
          "--description",
          "d",
        ],
        ["ticket", "attachment", "get", "1", "att-1", "extra"],
        [
          "ticket",
          "attachment",
          "update",
          "1",
          "att-1",
          "extra",
          "--description",
          "d",
        ],
        ["ticket", "attachment", "remove", "1", "att-1", "extra"],
      ];
      for (const argv of invocations) {
        const result = await runCli(argv, makeEnv(), host);
        expect(result.exitCode, argv.join(" ")).toBe(2);
      }
      expect(host.fetchCount()).toBe(0);
    });

    it("exits 3 when the real token gate rejects a wrong token", async () => {
      const host = makeHost();
      const result = await runCli(
        ["ticket", "list"],
        makeEnv({ CC_API_TOKEN: "wrong" }),
        host,
      );
      expect(result.exitCode).toBe(3);
    });
  });

  it("serves group and leaf help offline", async () => {
    const host = makeHost();
    const group = await runCli(["ticket", "--help"], makeEnv(), host);
    expect(group.exitCode).toBe(0);
    for (const verb of ["create", "list", "get", "update", "delete"]) {
      expect(group.stdout).toContain(`ticket ${verb}`);
    }

    const leaf = await runCli(["ticket", "update", "--help"], makeEnv(), host);
    expect(leaf.exitCode).toBe(0);
    expect(leaf.stdout).toContain("--status");
    expect(host.fetchCount()).toBe(0);
  });

  describe("attachments over the real handlers and content store", () => {
    /** Creates ticket cc#1 plus a related cc#2, attaches all five kinds to #1. */
    async function seedTicketWithAllKinds(host: CliHost): Promise<void> {
      await runCli(
        ["ticket", "create", "--title", "Host ticket", "--type", "feature"],
        makeEnv(),
        host,
      );
      await runCli(
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
          "attach",
          "ticket",
          "1",
          "2",
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
        const result = await runCli(argv, makeEnv(), host);
        expect(result.exitCode, argv.join(" ")).toBe(0);
      }
    }

    it("attaches all five kinds and the get index lists every entry with follow commands in both modes", async () => {
      const host = makeHost();
      await seedTicketWithAllKinds(host);

      const text = await runCli(["ticket", "get", "1"], makeEnv(), host);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("attachments:");
      for (const kind of [
        "file",
        "conversation",
        "session",
        "related_ticket",
        "note",
      ]) {
        expect(text.stdout).toContain(` ${kind} — `);
      }
      expect(text.stdout).toContain("cctl ticket attachment get 'cc#1' ");
      expect(text.stdout).toContain("cctl ticket get 'cc#2'");

      const json = await runCli(
        ["ticket", "get", "1", "--json"],
        makeEnv(),
        host,
      );
      const envelope = JSON.parse(json.stdout);
      expect(envelope.attachmentIndex).toHaveLength(5);
      const kinds = envelope.attachmentIndex.map(
        (entry: { kind: string }) => entry.kind,
      );
      expect(kinds.sort()).toEqual([
        "conversation",
        "file",
        "note",
        "related_ticket",
        "session",
      ]);
      for (const entry of envelope.attachmentIndex) {
        expect(entry.commands[0]).toMatch(
          /^cctl ticket attachment get 'cc#1' /,
        );
        expect(entry.description.length).toBeGreaterThan(0);
      }
      const related = envelope.attachmentIndex.find(
        (entry: { kind: string }) => entry.kind === "related_ticket",
      );
      expect(related.commands).toContain("cctl ticket get 'cc#2'");
    });

    it("includes the bounded index on list in both modes", async () => {
      const host = makeHost();
      await seedTicketWithAllKinds(host);

      const text = await runCli(["ticket", "list"], makeEnv(), host);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("cctl ticket attachment get 'cc#1' ");

      const json = await runCli(["ticket", "list", "--json"], makeEnv(), host);
      const envelope = JSON.parse(json.stdout);
      const first = envelope.tickets.find(
        (ticket: { number: number }) => ticket.number === 1,
      );
      expect(first.attachmentIndex).toHaveLength(5);
      const second = envelope.tickets.find(
        (ticket: { number: number }) => ticket.number === 2,
      );
      expect(second.attachmentIndex).toEqual([]);
    });

    it("retrieves a file snapshot's content after the source file is deleted", async () => {
      const host = makeHost();
      await runCli(
        ["ticket", "create", "--title", "Host", "--type", "feature"],
        makeEnv(),
        host,
      );
      const filePath = path.join(dir, "doomed.txt");
      await writeFile(filePath, "survives source deletion");
      const attached = await runCli(
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
      const attachmentId = JSON.parse(attached.stdout).attachment.id as string;
      await rm(filePath);

      const resolved = await runCli(
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
      await runCli(
        ["ticket", "create", "--title", "Host", "--type", "feature"],
        makeEnv(),
        host,
      );
      const attached = await runCli(
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
      const attachmentId = JSON.parse(attached.stdout).attachment.id as string;

      const updated = await runCli(
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

      const resolved = await runCli(
        ["ticket", "attachment", "get", "1", attachmentId, "--json"],
        makeEnv(),
        host,
      );
      const resolvedEnvelope = JSON.parse(resolved.stdout);
      expect(resolvedEnvelope.attachment.markdown).toBe("second body");
      expect(resolvedEnvelope.attachment.attachment.description).toBe("second");

      const removed = await runCli(
        ["ticket", "attachment", "remove", "1", attachmentId],
        makeEnv(),
        host,
      );
      expect(removed.exitCode).toBe(0);

      const after = await runCli(
        ["ticket", "get", "1", "--json"],
        makeEnv(),
        host,
      );
      expect(JSON.parse(after.stdout).attachmentIndex).toEqual([]);
    });

    it("refreshes a pending conversation snapshot through the real route and store", async () => {
      const host = makeHost();
      await runCli(
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

      const refreshed = await runCli(
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
      expect(JSON.parse(refreshed.stdout).attachment.payload).toMatchObject({
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
      await runCli(
        ["ticket", "create", "--title", "Host", "--type", "feature"],
        makeEnv(),
        host,
      );
      const result = await runCli(
        ["ticket", "attachment", "get", "1", "att-missing", "--json"],
        makeEnv(),
        host,
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).code).toBe("attachment_not_found");
    });
  });
});
