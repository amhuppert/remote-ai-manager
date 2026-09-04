import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import {
  listNativeMemoryExceptions,
  renderNativeMemoryDisclosureLine,
} from "@/lib/agent-backends/native-memory";

import { createAgentAuth } from "@/lib/agent-gateway/token";
import type { PublishFn } from "@/lib/events/publication";
import { createMemoryFreshnessEngine } from "@/lib/memory/freshness";
import {
  parseMemoryArchive,
  type MemoryArchiveRecord,
} from "@/lib/memory/export";
import { createMemoryIndexComposer } from "@/lib/memory/index-composer";
import {
  createMemoryIndexContextProvider,
  type MemoryIndexContextProvider,
} from "@/lib/memory/index-live-context";
import { createMemoryRecallService } from "@/lib/memory/recall";
import {
  createMemoryTelemetryService,
  type MemoryTelemetryService,
} from "@/lib/memory/telemetry";
import { createMemoryTelemetryRepo } from "@/lib/state-store/memory-telemetry-repo";
import {
  createMemoryRouteHandlers,
  type MemoryRouteHandlers,
} from "@/lib/memory/route-handlers";
import {
  MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
  type MemoryStatusNote,
} from "@/lib/memory/schemas";
import { createMemoryService, type MemoryService } from "@/lib/memory/service";
import { openMemoryContributionGate } from "@/lib/memory/testing/contribution-gate";
import {
  createMemorySessionLifecycleReader,
  type MemorySessionLifecycleDeps,
} from "@/lib/memory/session-lifecycle";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createMemoryRepo,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import { runCli } from "../core";
import { allHelpEntries } from "../help-registry";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  type CliEnv,
  type CliHost,
  type CliResult,
} from "../shared";

/**
 * The contract layer for `cctl memory`: the real CLI core driving the real
 * memory route handlers in-process, over a real SQLite store and the real token
 * gate. What a CLI unit test with a fake host cannot prove is exactly what R12
 * is about — that a slug an agent copied out of an index hook resolves, that an
 * ambiguous one comes back with a runnable narrowing, and that the internal id
 * the store keys on never reaches the text an agent reads.
 */

const TOKEN = "memory-cli-contract-token";
const PROJECT_NAME = "cc";
const PROJECT_PATH = "/repos/cc";
const SESSION_NAME = "memory-spike";
const SESSION_CREATED_AT = "2026-08-28T09:00:00.000Z";
const SESSION_CONVERSATION = "conv-session-1";
const PROJECT_CONVERSATION = "conv-project-1";
const NOW = "2026-09-02T00:00:00.000Z";

/**
 * The shape `randomUUID()` produces in production. Ids in this fixture are
 * UUID-shaped for one reason: a slug-only assertion against ids spelled `mem-1`
 * proves nothing, because that string could not appear in prose either way.
 */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The text with `ticket:` handles blanked. A ticket's id is not an internal
 * MEMORY id: it is another domain's public handle, printed in a form
 * `--artifact` takes straight back, so the no-internal-ids rule does not reach
 * it. Blanking it keeps the sweep guarding what it claims to guard — before the
 * fixture seeded a real ticket, these assertions passed only because a fake
 * ticket id happened not to be uuid-shaped.
 */
function withoutTicketHandles(text: string): string {
  return text.replace(/ticket:[0-9a-f-]+/gi, "ticket:<handle>");
}

/** Every `cctl memory` node, group and leaf alike — help is agent-facing text. */
const MEMORY_HELP_ENTRIES = allHelpEntries().filter(
  (entry) => entry.path[0] === "memory",
);

let dir: string;
/** The Command Center this suite drives; the export round trip adds a second. */
let primary: MemoryInstance;
/**
 * The context-loss signals the fixture's conversations report to the preview
 * route. Mutable because the parity under test is a disagreement that only
 * appears when a signal is TRUE: a suite that never set one would pass against
 * a preview that ignored them.
 */
let contextLoss: {
  runtimeCreatedWithoutResume: boolean;
  backendReportedCompactionLastTurn: boolean;
};

const publish: PublishFn = () => ({ delivered: true });

/** One Command Center: its store, its service graph, and its route handlers. */
interface MemoryInstance {
  fixture: PersistenceFixture;
  repo: MemoryRepo;
  service: MemoryService;
  handlers: MemoryRouteHandlers;
  /** The very provider the handlers resolve, so a byte comparison is against IT. */
  indexProvider: MemoryIndexContextProvider;
  /** Observation only — read back to prove a verb recorded, never to rank. */
  telemetry: MemoryTelemetryService;
  /** The real tickets repository the ticket handle resolves against. */
  tickets: TicketsRepo;
  /** The one real ticket row this instance seeded, by both of its identities. */
  ticket: { id: string; number: number };
}

async function findSessionCreatedAt(
  projectPath: string,
  sessionName: string,
): Promise<string | null> {
  return projectPath === PROJECT_PATH && sessionName === SESSION_NAME
    ? SESSION_CREATED_AT
    : null;
}

/** The one live session incarnation this suite's notes belong to. */
const sessionLifecycleDeps: MemorySessionLifecycleDeps = {
  async findSession(projectPath, sessionName) {
    return projectPath === PROJECT_PATH && sessionName === SESSION_NAME
      ? { createdAt: SESSION_CREATED_AT, finished: false }
      : null;
  },
};

async function newInstance(): Promise<MemoryInstance> {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  const tickets = createTicketsRepo(fixture.db, writeQueue);
  const seeded = await tickets.create({
    id: "6f0f0d1c-7b23-4f4a-9f6a-1b2c3d4e5f60",
    projectPath: PROJECT_PATH,
    title: "Memory system spike",
    description: "The ticket the memory handle examples name.",
    workType: "feature",
    status: "in_progress",
    createdAt: SESSION_CREATED_AT,
    updatedAt: SESSION_CREATED_AT,
  });
  const repo = createMemoryRepo(fixture.db, writeQueue);
  const telemetry = createMemoryTelemetryService({
    repo: createMemoryTelemetryRepo(fixture.db, writeQueue),
    now: () => NOW,
  });

  let clock = 0;
  let ids = 0;
  const service = createMemoryService({
    repo,
    publish,
    contributionGate: openMemoryContributionGate(),
    sessions: createMemorySessionLifecycleReader(sessionLifecycleDeps),
    now: () => {
      clock += 1000;
      return new Date(Date.UTC(2026, 8, 1) + clock).toISOString();
    },
    generateId: () => {
      ids += 1;
      return `4f75f404-dbd1-4642-a692-${String(ids).padStart(12, "0")}`;
    },
  });

  const freshness = createMemoryFreshnessEngine({
    repo,
    sessions: createMemorySessionLifecycleReader(sessionLifecycleDeps),
    now: () => NOW,
  });
  const indexProvider = createMemoryIndexContextProvider({
    composer: createMemoryIndexComposer({ repo, freshness, now: () => NOW }),
    findSessionCreatedAt,
    async findLinkedTicketId(projectPath, sessionName) {
      const linked = await tickets.findLinkedTicket(projectPath, sessionName);
      return linked?.id ?? null;
    },
    async findBoundSpecId() {
      return null;
    },
    async readBudget() {
      return {
        bytes: MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
        hooks: MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
      };
    },
    async resolveReadPolicy() {
      return "ambient";
    },
    readIndexDelivery: (conversationId) =>
      telemetry.readIndexDelivery(conversationId),
    resetIndexDelivery: (conversationId) =>
      telemetry.resetIndexDelivery(conversationId),
    now: () => NOW,
  });

  const handlers = createMemoryRouteHandlers({
    getService: () => service,
    getRecall: () =>
      createMemoryRecallService({ repo, freshness, now: () => NOW }),
    getTelemetry: () => telemetry,
    getFreshness: () => freshness,
    getIndexProvider: () => indexProvider,
    findNoteById: (memoryId) => repo.find(memoryId),
    listLinksForNotes: (noteIds) => repo.listLinksForNotes(noteIds),
    async resolveProjectPath(projectName) {
      return projectName === PROJECT_NAME ? PROJECT_PATH : null;
    },
    async findTicketId(reference) {
      const found =
        "byId" in reference
          ? await tickets.findById(reference.byId)
          : await tickets.find(reference.projectPath, reference.number);
      return found?.id ?? null;
    },
    async locateConversation(conversationId) {
      if (conversationId === SESSION_CONVERSATION) {
        return {
          projectPath: PROJECT_PATH,
          conversation: { kind: "session", sessionName: SESSION_NAME },
          role: null,
        };
      }
      if (conversationId === PROJECT_CONVERSATION) {
        return {
          projectPath: PROJECT_PATH,
          conversation: { kind: "project" },
          role: null,
        };
      }
      return null;
    },
    findSessionCreatedAt,
    async findLaneBinding() {
      return null;
    },
    async readNextTurnContextLoss() {
      return contextLoss;
    },
    auth: createAgentAuth({ configDir: dir }),
  });

  return {
    fixture,
    repo,
    service,
    handlers,
    indexProvider,
    telemetry,
    tickets,
    ticket: { id: seeded.id, number: seeded.number },
  };
}

beforeEach(async () => {
  contextLoss = {
    runtimeCreatedWithoutResume: false,
    backendReportedCompactionLastTurn: false,
  };
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-memory-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
  primary = await newInstance();
});

afterEach(async () => {
  primary.fixture.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Routes a request the CLI built to the handler Next.js would have run. The
 * `[handle]` segment is decoded exactly as the app router decodes it, so a slug
 * needing escaping is proven to survive the round trip.
 */
function makeHostFor(instance: MemoryInstance): CliHost & {
  written: Record<string, string>;
  requests: string[];
} {
  const { handlers } = instance;
  const written: Record<string, string> = {};
  const requests: string[] = [];
  return {
    written,
    requests,
    async fetch(url, init) {
      const parsed = new URL(url);
      requests.push(`${init.method ?? "GET"} ${parsed.pathname}`);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });

      // /api/memory/<resource>
      const resource = segments[2];
      if (resource === "recall") return handlers.recallPOST(request);
      if (resource === "index") return handlers.indexGET(request);
      if (resource === "review") return handlers.reviewGET(request);
      if (resource === "export") return handlers.exportGET(request);

      // /api/memory/notes[/<handle>[/<action>]]
      const handle = segments[3];
      if (handle === undefined) {
        return init.method === "POST"
          ? handlers.createPOST(request)
          : handlers.listGET(request);
      }
      const context = {
        params: Promise.resolve({ handle: decodeURIComponent(handle) }),
      };
      switch (segments[4]) {
        case "links":
          return init.method === "DELETE"
            ? handlers.linksDELETE(request, context)
            : handlers.linksPOST(request, context);
        case "reviewed":
          return handlers.reviewedPOST(request, context);
        case "rederived":
          return handlers.rederivedPOST(request, context);
        case "promote":
          return handlers.promotePOST(request, context);
        case "archive":
          return handlers.archivePOST(request, context);
        case "restore":
          return handlers.restorePOST(request, context);
        case "proposal":
          return handlers.proposalPOST(request, context);
        case "revisions":
          return handlers.revisionsGET(request, context);
        default:
          break;
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
    async readFileBytes() {
      return null;
    },
    async writeTextFile(filePath, contents) {
      written[filePath] = contents;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

function makeHost(): ReturnType<typeof makeHostFor> {
  return makeHostFor(primary);
}

/** The env a SESSION conversation's agent receives; it sees all three scopes. */
function makeEnv(overrides: CliEnv = {}): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4997",
    CC_API_TOKEN: TOKEN,
    CC_PROJECT: PROJECT_NAME,
    CC_CONVERSATION_SCOPE: "session",
    CC_SESSION: SESSION_NAME,
    CC_CONVERSATION_ID: SESSION_CONVERSATION,
    ...overrides,
  };
}

function envelopeOf(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

interface CreatedNote {
  id: string;
  slug: string;
  revision: number;
  lifecycle: string;
  statusNote: MemoryStatusNote | null;
}

/** Create a note through the CLI and hand back the identity fields it minted. */
async function createNote(
  host: CliHost,
  args: string[],
  env: CliEnv = makeEnv(),
): Promise<CreatedNote> {
  const result = await runCli(
    ["memory", "create", ...args, "--json"],
    env,
    host,
  );
  expect(result.exitCode, result.stderr).toBe(EXIT_OK);
  return envelopeOf(result)["note"] as CreatedNote;
}

describe("cctl memory identity is slugs, never internal ids", () => {
  it("prints no internal id in the default text of index, recall, list, or get", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--hook",
      "next build opens the LIVE database, so a schema bump breaks older branches",
      "--body",
      "The prerender pass reads config.json from disk.",
    ]);
    expect(note.id).toMatch(UUID_PATTERN);

    for (const argv of [
      ["memory", "index"],
      ["memory", "recall", "next build"],
      ["memory", "list"],
      ["memory", "get", note.slug],
    ]) {
      const result = await runCli(argv, makeEnv(), host);
      expect(result.exitCode, `${argv.join(" ")}: ${result.stderr}`).toBe(
        EXIT_OK,
      );
      expect(result.stdout).toContain(note.slug);
      expect(
        result.stdout,
        `${argv.join(" ")} leaked the internal id into agent-facing text`,
      ).not.toContain(note.id);
      expect(result.stdout).not.toMatch(UUID_PATTERN);
    }
  });

  it("carries both the slug and the internal id in the --json envelope", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--hook",
      "a halted execution blocks cctl validate for the whole worktree",
    ]);

    const got = await runCli(
      ["memory", "get", note.slug, "--json"],
      makeEnv(),
      host,
    );
    expect(got.exitCode, got.stderr).toBe(EXIT_OK);
    expect(envelopeOf(got)["note"]).toMatchObject({
      id: note.id,
      slug: note.slug,
    });

    const listed = await runCli(["memory", "list", "--json"], makeEnv(), host);
    const notes = envelopeOf(listed)["notes"] as { id: string; slug: string }[];
    expect(notes).toContainEqual(
      expect.objectContaining({ id: note.id, slug: note.slug }),
    );
  });

  it("keeps internal ids out of refusal text and out of help", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "shared-handle",
      "--scope",
      "project",
      "--hook",
      "the project reading of the shared handle",
    ]);
    await createNote(host, [
      "--slug",
      "shared-handle",
      "--scope",
      "session",
      "--hook",
      "the session reading of the shared handle",
    ]);

    // A refusal is agent-facing text too, and the disambiguation is the one
    // refusal that HAS a list of records behind it to leak.
    const refusal = await runCli(
      ["memory", "get", "shared-handle"],
      makeEnv(),
      host,
    );
    expect(refusal.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(refusal.stderr).not.toMatch(UUID_PATTERN);
    // The ids ARE in the envelope, so the Library can address a candidate.
    const refusalJson = await runCli(
      ["memory", "get", "shared-handle", "--json"],
      makeEnv(),
      host,
    );
    const details = envelopeOf(refusalJson)["details"] as {
      candidates: { memoryId: string }[];
    };
    expect(details.candidates.map((row) => row.memoryId)).toHaveLength(2);
    for (const candidate of details.candidates) {
      expect(candidate.memoryId).toMatch(UUID_PATTERN);
    }

    // A filter that matched nothing would make the help sweep below vacuous.
    expect(MEMORY_HELP_ENTRIES.length).toBeGreaterThan(14);
    for (const entry of MEMORY_HELP_ENTRIES) {
      const help = await runCli([...entry.path, "--help"], makeEnv(), host);
      expect(help.exitCode, help.stderr).toBe(EXIT_OK);
      expect(
        help.stdout,
        `${entry.path.join(" ")} --help shows an id-shaped handle`,
      ).not.toMatch(UUID_PATTERN);
    }
  });

  it("never echoes an id-addressed handle back into text", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "id-addressed",
      "--hook",
      "addressed by the id an earlier --json read handed over",
    ]);

    // Every CLI-composed line an id-addressed call can produce: a pre-request
    // usage refusal, a stale compare-and-swap recovery, and two success lines.
    const surfaces = [
      ["memory", "update", note.id, "--hook", "no revision stated"],
      ["memory", "delete", note.id],
      ["memory", "link", note.id, "--artifact", `ticket:${primary.ticket.id}`],
      [
        "memory",
        "unlink",
        note.id,
        "--artifact",
        `ticket:${primary.ticket.id}`,
      ],
      ["memory", "archive", note.id],
    ];
    for (const argv of surfaces) {
      const result = await runCli(argv, makeEnv(), host);
      expect(
        `${result.stdout}${result.stderr}`,
        `${argv.join(" ")} echoed the internal id back`,
      ).not.toContain(note.id);
      expect(
        withoutTicketHandles(`${result.stdout}${result.stderr}`),
      ).not.toMatch(UUID_PATTERN);
    }

    // The stale-revision recovery names the note's SLUG, so it is runnable.
    const fresh = await createNote(host, [
      "--slug",
      "contested-by-id",
      "--hook",
      "the original",
    ]);
    await runCli(
      [
        "memory",
        "update",
        fresh.slug,
        "--if-revision",
        String(fresh.revision),
        "--hook",
        "the winner",
      ],
      makeEnv(),
      host,
    );
    const stale = await runCli(
      [
        "memory",
        "update",
        fresh.id,
        "--if-revision",
        String(fresh.revision),
        "--hook",
        "the loser",
      ],
      makeEnv(),
      host,
    );
    expect(stale.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(stale.stderr).toContain("cctl memory get contested-by-id");
    expect(stale.stderr).not.toContain(fresh.id);
  });

  it("names no internal id when a real one resolves to nothing visible", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "archived-then-addressed-by-id",
      "--hook",
      "a note whose id outlives its visibility",
    ]);

    const archived = await runCli(
      ["memory", "archive", note.slug],
      makeEnv(),
      host,
    );
    expect(archived.exitCode, archived.stderr).toBe(EXIT_OK);

    // The id is REAL and the row still exists — it is the lifecycle filter that
    // excludes it. That is the not-found path, and it used to answer by reading
    // the caller's own handle back out, which for an id-addressed call is the
    // internal id itself.
    for (const argv of [
      ["memory", "get", note.id],
      ["memory", "update", note.id, "--if-revision", "1", "--hook", "a fix"],
      ["memory", "archive", note.id],
      ["memory", "mark-reviewed", note.id],
      ["memory", "link", note.id, "--artifact", `ticket:${primary.ticket.id}`],
    ]) {
      const refused = await runCli(argv, makeEnv(), host);
      expect(refused.exitCode, `${argv.join(" ")} was not refused`).not.toBe(
        EXIT_OK,
      );
      expect(
        `${refused.stdout}${refused.stderr}`,
        `${argv.join(" ")} echoed the internal id back`,
      ).not.toContain(note.id);
      expect(`${refused.stdout}${refused.stderr}`).not.toMatch(UUID_PATTERN);
    }

    // An id-shaped handle matching no row at all is refused the same way: the
    // rule is about the SHAPE reaching text, not about the row existing.
    const stranger = await runCli(
      ["memory", "get", "6f1d2c48-9b3a-4e7f-8c21-0a5d7e934bb2"],
      makeEnv(),
      host,
    );
    expect(stranger.exitCode).not.toBe(EXIT_OK);
    expect(`${stranger.stdout}${stranger.stderr}`).not.toMatch(UUID_PATTERN);
    // The refusal still says what to do without the handle to point at.
    expect(stranger.stderr).toContain("cctl memory list");

    // The identifier stays addressable where ids belong.
    const asJson = await runCli(
      ["memory", "get", note.id, "--json"],
      makeEnv(),
      host,
    );
    expect(envelopeOf(asJson)).toMatchObject({
      ok: false,
      details: { handle: note.id },
    });
  });

  it("accepts the internal id wherever it accepts a slug", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--hook",
      "the stash stack is shared across every worktree",
    ]);

    const byId = await runCli(["memory", "get", note.id], makeEnv(), host);
    expect(byId.exitCode, byId.stderr).toBe(EXIT_OK);
    // Even addressed by id, the answer speaks slugs.
    expect(byId.stdout).toContain(note.slug);
    expect(byId.stdout).not.toContain(note.id);
  });
});

describe("cctl memory handle resolution", () => {
  it("answers a slug living in two visible scopes with a labeled narrowing", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "build-skew",
      "--scope",
      "project",
      "--hook",
      "the PATH cctl is prebuilt; run it from source instead",
    ]);
    await createNote(host, [
      "--slug",
      "build-skew",
      "--scope",
      "session",
      "--hook",
      "this lane's build is stale until the session branch is merged",
    ]);

    const ambiguous = await runCli(
      ["memory", "get", "build-skew"],
      makeEnv(),
      host,
    );
    expect(ambiguous.exitCode).toBe(EXIT_OPERATION_FAILED);
    // Both scopes are named, and each carries the exact command that narrows to it.
    expect(ambiguous.stderr).toContain("[project]");
    expect(ambiguous.stderr).toContain("[session]");
    expect(ambiguous.stderr).toContain(
      "cctl memory get build-skew --scope project",
    );
    expect(ambiguous.stderr).toContain(
      "cctl memory get build-skew --scope session",
    );

    const narrowed = await runCli(
      ["memory", "get", "build-skew", "--scope", "project"],
      makeEnv(),
      host,
    );
    expect(narrowed.exitCode, narrowed.stderr).toBe(EXIT_OK);
    expect(narrowed.stdout).toContain("prebuilt");
  });

  it("keeps resolving the old slug after a rename", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "turbopack-root",
      "--hook",
      "pre-16136bf2 branches compile main's middleware",
    ]);

    const renamed = await runCli(
      [
        "memory",
        "update",
        "turbopack-root",
        "--if-revision",
        String(note.revision),
        "--slug",
        "turbopack-root-inference",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(renamed.exitCode, renamed.stderr).toBe(EXIT_OK);
    const updated = envelopeOf(renamed)["note"] as {
      slug: string;
      aliases: string[];
    };
    expect(updated.slug).toBe("turbopack-root-inference");
    expect(updated.aliases).toContain("turbopack-root");

    // The handle an agent learned before the rename still lands on the note.
    const viaAlias = await runCli(
      ["memory", "get", "turbopack-root", "--json"],
      makeEnv(),
      host,
    );
    expect(viaAlias.exitCode, viaAlias.stderr).toBe(EXIT_OK);
    expect(envelopeOf(viaAlias)["note"]).toMatchObject({
      id: note.id,
      slug: "turbopack-root-inference",
    });
  });

  it("resolves bare handles to active notes only, archived ones explicitly", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "settled-lesson",
      "--hook",
      "the 0013 migration base64s the absolute worktree path",
    ]);

    const archived = await runCli(
      [
        "memory",
        "archive",
        "settled-lesson",
        "--if-revision",
        String(note.revision),
      ],
      makeEnv(),
      host,
    );
    expect(archived.exitCode, archived.stderr).toBe(EXIT_OK);

    const bare = await runCli(
      ["memory", "get", "settled-lesson", "--json"],
      makeEnv(),
      host,
    );
    expect(bare.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(envelopeOf(bare)["code"]).toBe("not_found");

    const listed = await runCli(["memory", "list", "--json"], makeEnv(), host);
    expect(envelopeOf(listed)["notes"]).toEqual([]);

    const explicit = await runCli(
      ["memory", "get", "settled-lesson", "--archived", "--json"],
      makeEnv(),
      host,
    );
    expect(explicit.exitCode, explicit.stderr).toBe(EXIT_OK);
    expect(envelopeOf(explicit)["note"]).toMatchObject({
      slug: "settled-lesson",
      lifecycle: "archived",
    });

    const listedArchived = await runCli(
      ["memory", "list", "--archived", "--json"],
      makeEnv(),
      host,
    );
    const rows = envelopeOf(listedArchived)["notes"] as { slug: string }[];
    expect(rows.map((row) => row.slug)).toContain("settled-lesson");
  });
});

describe("cctl memory index previews one conversation's next turn", () => {
  it("renders text byte-identical to the block the turn injects", async () => {
    const host = makeHost();
    await createNote(host, [
      "--hook",
      "the FS cache became the bug: an 8.4 GB turbopack cache builds 59x slower",
      "--body",
      "Prune .next/cache/turbopack when a build sits at 99% CPU on one core.",
    ]);
    await createNote(host, [
      "--scope",
      "session",
      "--kind",
      "state",
      "--hook",
      "this lane is on the memory-cli context of the delivery workflow",
    ]);

    const previewed = await runCli(["memory", "index"], makeEnv(), host);
    expect(previewed.exitCode, previewed.stderr).toBe(EXIT_OK);

    // The request the turn itself builds (actor-implementations composes exactly
    // these fields), answered by the very provider the route resolves.
    const injected = await primary.indexProvider.getForConversation({
      projectPath: PROJECT_PATH,
      conversationId: SESSION_CONVERSATION,
      conversation: { kind: "session", sessionName: SESSION_NAME },
      role: null,
      workflowExecutionId: null,
      workflowContextId: null,
      runtimeCreatedWithoutResume: false,
      backendReportedCompactionLastTurn: false,
    });
    expect(injected).not.toBeNull();
    // BYTE-identical, not "the same modulo the terminal's newline": the turn
    // injects `block.text` verbatim, so a trailing newline here would make the
    // preview one byte different from the thing it previews.
    expect(previewed.stdout).toBe(injected?.block);
    expect(previewed.stdout.endsWith("\n")).toBe(
      (injected?.block ?? "").endsWith("\n"),
    );
  });

  it("previews another conversation named by --conversation", async () => {
    const host = makeHost();
    await createNote(host, [
      "--scope",
      "session",
      "--kind",
      "state",
      "--hook",
      "only this session's own conversation is told about the lane",
    ]);
    await createNote(host, [
      "--hook",
      "the project note reaches both conversations",
    ]);

    const projectPreview = await runCli(
      ["memory", "index", "--conversation", PROJECT_CONVERSATION],
      makeEnv(),
      host,
    );
    expect(projectPreview.exitCode, projectPreview.stderr).toBe(EXIT_OK);

    const injected = await primary.indexProvider.getForConversation({
      projectPath: PROJECT_PATH,
      conversationId: PROJECT_CONVERSATION,
      conversation: { kind: "project" },
      role: null,
      workflowExecutionId: null,
      workflowContextId: null,
      runtimeCreatedWithoutResume: false,
      backendReportedCompactionLastTurn: false,
    });
    expect(projectPreview.stdout).toBe(injected?.block);
    // The two previews differ, so the byte comparison above is not a tautology
    // over one block every conversation would receive.
    const sessionPreview = await runCli(["memory", "index"], makeEnv(), host);
    expect(sessionPreview.stdout).not.toBe(projectPreview.stdout);
    expect(sessionPreview.stdout).toContain("only this session's own");
    expect(projectPreview.stdout).not.toContain("only this session's own");
  });

  it("discloses a backend whose native memory could not be disabled, off the byte-exact stdout", async () => {
    // Criterion memory-crit-native-disclosure: the operator must not have to
    // infer that one backend is still running its own memory. The line rides
    // stderr, not stdout, because stdout is the block byte-for-byte — the same
    // split the no-block case already uses.
    const host = makeHost();
    await createNote(host, ["--hook", "something for the block to carry"]);

    const expected = renderNativeMemoryDisclosureLine(
      listNativeMemoryExceptions(listBackendCatalogEntries()),
    );
    // Derived, not restated: were every backend neutralized this would be null
    // and the verb would say nothing at all.
    expect(expected).not.toBeNull();

    const result = await runCli(["memory", "index"], makeEnv(), host);
    expect(result.exitCode, result.stderr).toBe(EXIT_OK);
    expect(result.stderr).toContain(expected!);
    expect(result.stdout).not.toContain("native memory still running");

    // Still byte-identical to what the turn injects: the disclosure changed
    // nothing about the block.
    const injected = await primary.indexProvider.getForConversation({
      projectPath: PROJECT_PATH,
      conversationId: SESSION_CONVERSATION,
      conversation: { kind: "session", sessionName: SESSION_NAME },
      role: null,
      workflowExecutionId: null,
      workflowContextId: null,
      runtimeCreatedWithoutResume: false,
      backendReportedCompactionLastTurn: false,
    });
    expect(result.stdout).toBe(injected?.block);
  });

  it("discloses the exception on the empty-block path too", async () => {
    // A conversation told nothing still runs on a backend with its own memory.
    const host = makeHost();
    const result = await runCli(["memory", "index"], makeEnv(), host);

    expect(result.exitCode, result.stderr).toBe(EXIT_OK);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("native memory still running");
  });

  it("carries the exceptions structurally in the --json envelope", async () => {
    const host = makeHost();
    await createNote(host, ["--hook", "something for the block to carry"]);

    const result = await runCli(["memory", "index", "--json"], makeEnv(), host);
    expect(result.exitCode, result.stderr).toBe(EXIT_OK);
    const envelope = z
      .object({
        nativeMemoryExceptions: z.array(
          z.object({
            backend: z.string(),
            label: z.string(),
            reason: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(result.stdout));
    // The array IS the nothing-to-disclose rendering: empty when every
    // registered backend declares a mechanism.
    expect(envelope.nativeMemoryExceptions).toEqual(
      listNativeMemoryExceptions(listBackendCatalogEntries()),
    );
  });

  /**
   * The request the turn itself builds — `actor-implementations` composes
   * exactly these fields before every turn — so a byte comparison against it
   * is a comparison against the production pre-turn path rather than against a
   * second, test-only composition.
   */
  const SESSION_TURN_REQUEST = {
    projectPath: PROJECT_PATH,
    conversationId: SESSION_CONVERSATION,
    conversation: { kind: "session", sessionName: SESSION_NAME },
    role: null,
    workflowExecutionId: null,
    workflowContextId: null,
    runtimeCreatedWithoutResume: false,
    backendReportedCompactionLastTurn: false,
  } as const;

  it("is byte-identical to the turn's block in BOTH modes, across the full-then-delta transition", async () => {
    // Byte identity only holds within one rendering minute — the block states
    // ages relative to now — so every composition here runs on the pinned
    // clock the fixture injects, exactly as the composer's own tests do.
    const host = makeHost();
    const revised = await createNote(host, [
      "--hook",
      "prune the turbopack FS cache when a build sits at 99% CPU on one core",
    ]);
    await createNote(host, [
      "--hook",
      "a lane worktree never re-syncs with its session branch",
    ]);

    // (1) A FRESH conversation: the default render is the full block its first
    // turn composes, byte for byte.
    const firstTurn =
      await primary.indexProvider.getForConversation(SESSION_TURN_REQUEST);
    expect(firstTurn?.mode).toBe("full");
    const fresh = await runCli(["memory", "index"], makeEnv(), host);
    expect(fresh.exitCode, fresh.stderr).toBe(EXIT_OK);
    expect(fresh.stdout).toBe(firstTurn?.block);
    expect(fresh.stdout.endsWith("\n")).toBe(
      (firstTurn?.block ?? "").endsWith("\n"),
    );

    // Settle it, as the turn seam does once the backend accepts the turn.
    await primary.telemetry.recordDelivery({
      conversationId: SESSION_CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: firstTurn?.composedAt ?? NOW,
      notes: (firstTurn?.entries ?? []).map((entry) => ({
        memoryId: entry.memoryId,
        revision: entry.revision,
        statusDelivered: entry.statusDelivered,
      })),
    });

    // (2) The conversation now HOLDS a block and nothing has changed, so its
    // next turn is due a quiet delta — while --full still renders the very
    // block the first turn composed, byte for byte. That is the whole claim of
    // the flag: the delivery state cannot change what --full prints.
    const settledDefault = await runCli(["memory", "index"], makeEnv(), host);
    expect(settledDefault.stdout).not.toBe(firstTurn?.block);
    const settledFull = await runCli(
      ["memory", "index", "--full"],
      makeEnv(),
      host,
    );
    expect(settledFull.exitCode, settledFull.stderr).toBe(EXIT_OK);
    expect(settledFull.stdout).toBe(firstTurn?.block);

    // (3) A note revision: the default render is now the DELTA the turn would
    // inject, again byte for byte through the same pre-turn path.
    const updated = await runCli(
      [
        "memory",
        "update",
        revised.slug,
        "--if-revision",
        String(revised.revision),
        "--hook",
        "an 8.4 GB turbopack FS cache builds 59x slower than a pruned one",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(updated.exitCode, updated.stderr).toBe(EXIT_OK);

    const nextTurn =
      await primary.indexProvider.getForConversation(SESSION_TURN_REQUEST);
    expect(nextTurn?.mode).toBe("delta");
    const delta = await runCli(["memory", "index"], makeEnv(), host);
    expect(delta.exitCode, delta.stderr).toBe(EXIT_OK);
    expect(delta.stdout).toBe(nextTurn?.block);
    expect(delta.stdout.endsWith("\n")).toBe(
      (nextTurn?.block ?? "").endsWith("\n"),
    );
    // Not a tautology over one text both modes would print: the delta carries
    // only the revised hook, the full block carries the whole index.
    const revisedFull = await runCli(
      ["memory", "index", "--full"],
      makeEnv(),
      host,
    );
    expect(revisedFull.stdout).not.toBe(delta.stdout);
    expect(revisedFull.stdout).toContain("a lane worktree never re-syncs");
    expect(delta.stdout).not.toContain("a lane worktree never re-syncs");
  });

  it("prints the delta the next turn is due by default and the whole index behind --full", async () => {
    const host = makeHost();
    const revised = await createNote(host, [
      "--hook",
      "prune the turbopack FS cache when a build sits at 99% CPU on one core",
    ]);
    await createNote(host, [
      "--hook",
      "a lane worktree never re-syncs with its session branch",
    ]);

    // Settle the full block this conversation was shown, exactly as the turn
    // seam does after the backend accepts a turn — the preview itself settles
    // nothing, so without this the conversation would still be due a full one.
    const firstPreview = await runCli(
      ["memory", "index", "--json"],
      makeEnv(),
      host,
    );
    expect(firstPreview.exitCode, firstPreview.stderr).toBe(EXIT_OK);
    const firstEnvelope = envelopeOf(firstPreview);
    expect(firstEnvelope["mode"]).toBe("full");
    await primary.telemetry.recordDelivery({
      conversationId: SESSION_CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: NOW,
      notes: firstEnvelope["entries"] as {
        memoryId: string;
        revision: number;
        statusDelivered: boolean;
      }[],
    });

    const updated = await runCli(
      [
        "memory",
        "update",
        revised.slug,
        "--if-revision",
        String(revised.revision),
        "--hook",
        "an 8.4 GB turbopack FS cache builds 59x slower than a pruned one",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(updated.exitCode, updated.stderr).toBe(EXIT_OK);

    const delta = await runCli(["memory", "index"], makeEnv(), host);
    expect(delta.exitCode, delta.stderr).toBe(EXIT_OK);
    expect(delta.stdout).toContain("builds 59x slower");
    expect(delta.stdout).not.toContain("a lane worktree never re-syncs");

    const full = await runCli(["memory", "index", "--full"], makeEnv(), host);
    expect(full.exitCode, full.stderr).toBe(EXIT_OK);
    expect(full.stdout).toContain("builds 59x slower");
    expect(full.stdout).toContain("a lane worktree never re-syncs");
    // The default really is the next-turn delivery, not the full block wearing
    // a different name: the two renders differ for this conversation.
    expect(full.stdout).not.toBe(delta.stdout);

    // Both modes name themselves structurally, so a caller comparing a render
    // against an injected block knows which render it holds.
    const deltaEnvelope = envelopeOf(
      await runCli(["memory", "index", "--json"], makeEnv(), host),
    );
    expect(deltaEnvelope["mode"]).toBe("delta");
    expect(deltaEnvelope["block"]).toBe(delta.stdout);
    const fullEnvelope = envelopeOf(
      await runCli(["memory", "index", "--full", "--json"], makeEnv(), host),
    );
    expect(fullEnvelope["mode"]).toBe("full");
    expect(fullEnvelope["block"]).toBe(full.stdout);
  });

  it("neither mode settles or resets the conversation's delivery state", async () => {
    const host = makeHost();
    await createNote(host, ["--hook", "a preview is shown to nobody"]);

    const before =
      await primary.telemetry.readIndexDelivery(SESSION_CONVERSATION);
    await runCli(["memory", "index"], makeEnv(), host);
    await runCli(["memory", "index", "--full"], makeEnv(), host);
    expect(
      await primary.telemetry.readIndexDelivery(SESSION_CONVERSATION),
    ).toEqual(before);
  });

  it("matches the turn byte for byte when a lost runtime makes the next block a full one", async () => {
    // The defect this pins: delivery state alone says delta, but the turn will
    // treat the missing runtime as a context loss and inject the full block. A
    // preview that assumed no context loss printed a delta for exactly the
    // conversation whose agent had just lost everything it was told.
    const host = makeHost();
    await createNote(host, [
      "--hook",
      "a lane worktree never re-syncs with its session branch",
    ]);

    const firstTurn =
      await primary.indexProvider.getForConversation(SESSION_TURN_REQUEST);
    expect(firstTurn?.mode).toBe("full");
    await primary.telemetry.recordDelivery({
      conversationId: SESSION_CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: firstTurn?.composedAt ?? NOW,
      notes: (firstTurn?.entries ?? []).map((entry) => ({
        memoryId: entry.memoryId,
        revision: entry.revision,
        statusDelivered: entry.statusDelivered,
      })),
    });

    const settled = await runCli(
      ["memory", "index", "--json"],
      makeEnv(),
      host,
    );
    expect(envelopeOf(settled)["mode"]).toBe("delta");

    contextLoss = {
      runtimeCreatedWithoutResume: true,
      backendReportedCompactionLastTurn: false,
    };

    // The preview FIRST, while the conversation still holds its delivery
    // state: the turn below is what resets it, and running them the other way
    // round would let a reset preview pass this comparison.
    const previewed = await runCli(["memory", "index"], makeEnv(), host);
    expect(previewed.exitCode, previewed.stderr).toBe(EXIT_OK);
    const stateBeforeTurn =
      await primary.telemetry.readIndexDelivery(SESSION_CONVERSATION);
    expect(stateBeforeTurn.state).not.toBeNull();

    const lostTurn = await primary.indexProvider.getForConversation({
      ...SESSION_TURN_REQUEST,
      runtimeCreatedWithoutResume: true,
    });
    expect(lostTurn?.mode).toBe("full");
    expect(previewed.stdout).toBe(lostTurn?.block);
    // The turn reset the sequence; the preview that preceded it did not.
    expect(
      (await primary.telemetry.readIndexDelivery(SESSION_CONVERSATION)).state,
    ).toBeNull();
  });

  it("refuses a project- or session-level preview, naming the conversation form", async () => {
    const host = makeHost();
    await createNote(host, ["--hook", "something for the block to carry"]);

    for (const argv of [
      ["memory", "index", "--scope", "project"],
      ["memory", "index", "--scope", "session"],
      ["memory", "index", "--session", "another-session"],
    ]) {
      const result = await runCli(argv, makeEnv(), host);
      expect(result.exitCode, `${argv.join(" ")} was not refused`).toBe(
        EXIT_USAGE,
      );
      expect(result.stderr).toContain("cctl memory index --conversation <id>");
    }
  });
});

describe("cctl memory export is a portable current-state archive", () => {
  /**
   * The round trip is proven against a SECOND Command Center: the archive is
   * re-created through the ordinary create and link verbs into an empty store,
   * and the two exports are compared record by record. Re-creating into the
   * source store could only prove that slugs collide.
   *
   * The predecessor's archived lifecycle is not re-created by hand either — the
   * successor's `--supersedes` archives it, which is the same act that produced
   * it in the source store.
   */
  it("re-creates every field through the ordinary verbs into an empty store", async () => {
    const host = makeHost();

    // A predecessor the successor supersedes, so the archive carries a
    // supersession pointer AND an archived lifecycle.
    await createNote(host, [
      "--slug",
      "stale-reading",
      "--hook",
      "the first reading of the turbopack cache balloon",
      "--body",
      "Superseded once the FS cache landed.",
    ]);
    await createNote(host, [
      "--slug",
      "turbopack-build-memory",
      "--alias",
      "turbopack-balloon",
      "--alias",
      "notebook",
      "--kind",
      "lesson",
      "--hook",
      "an unpruned .next/cache/turbopack builds 59x slower than a 1.5 GB one",
      // A body carrying the record delimiter: a memory library is full of notes
      // ABOUT frontmatter, and length-delimited bodies are why they survive.
      "--body",
      "Signature:\n\n---\nnext build stuck at 99% CPU on one of sixteen cores\n---\n",
      "--status-note",
      "resolved on 2026-08-19 by the FS cache",
      "--index-mode",
      "always",
      "--review-after",
      "2026-12-01T00:00:00.000Z",
      "--expires-at",
      "2027-06-01T00:00:00.000Z",
      "--supersedes",
      "stale-reading",
    ]);
    const linked = await runCli(
      [
        "memory",
        "link",
        "turbopack-build-memory",
        "--artifact",
        `ticket:${primary.ticket.id}`,
        "--kind",
        "about",
      ],
      makeEnv(),
      host,
    );
    expect(linked.exitCode, linked.stderr).toBe(EXIT_OK);
    const sourced = await runCli(
      [
        "memory",
        "link",
        "turbopack-build-memory",
        "--artifact",
        `session:${SESSION_NAME}@${SESSION_CREATED_AT}`,
        "--kind",
        "source",
      ],
      makeEnv(),
      host,
    );
    expect(sourced.exitCode, sourced.stderr).toBe(EXIT_OK);

    // A session-scoped note, so the incarnation half of identity is exercised.
    await createNote(host, [
      "--slug",
      "lane-state",
      "--scope",
      "session",
      "--kind",
      "state",
      "--hook",
      "this lane owns the cctl memory command group",
    ]);

    const output = path.join(dir, "memory-archive.md");
    const exported = await runCli(
      ["memory", "export", "--output", output, "--json"],
      makeEnv(),
      host,
    );
    expect(exported.exitCode, exported.stderr).toBe(EXIT_OK);
    expect(envelopeOf(exported)).toMatchObject({ path: output, noteCount: 3 });

    const archiveText = host.written[output] ?? "";
    const archive = parseMemoryArchive(archiveText);
    expect(archive.records).toHaveLength(3);
    // The archive is portable: nothing in it is keyed to this instance.
    expect(withoutTicketHandles(archiveText)).not.toMatch(UUID_PATTERN);

    // The corpus really does carry every field the round trip then has to
    // recover — otherwise the comparison below could pass over three plain notes.
    const source = byHandle(archive.records);
    expect(source["project:stale-reading"]).toMatchObject({
      lifecycle: "archived",
      supersededBy: "project:turbopack-build-memory",
    });
    expect(source["project:turbopack-build-memory"]).toMatchObject({
      lifecycle: "active",
      supersedes: "project:stale-reading",
      aliases: expect.arrayContaining(["turbopack-balloon", "notebook"]),
      indexMode: "always",
      statusNote: "resolved on 2026-08-19 by the FS cache",
      reviewAfter: "2026-12-01T00:00:00.000Z",
      expiresAt: "2027-06-01T00:00:00.000Z",
      links: expect.arrayContaining([
        { kind: "about", artifact: `ticket:${primary.ticket.id}` },
        {
          kind: "source",
          artifact: `session:${SESSION_NAME}@${SESSION_CREATED_AT}`,
        },
      ]),
    });
    expect(source["project:turbopack-build-memory"]?.body).toContain(
      "\n---\nnext build stuck at 99% CPU",
    );
    expect(source["session:lane-state"]).toMatchObject({
      scope: "session",
      kind: "state",
      session: {
        sessionName: SESSION_NAME,
        sessionCreatedAt: SESSION_CREATED_AT,
      },
    });

    // A second Command Center, with nothing in it.
    const destination = await newInstance();
    const destinationHost = makeHostFor(destination);

    for (const record of orderedForRecreation(archive.records)) {
      const created = await runCli(
        [
          "memory",
          "create",
          "--slug",
          record.slug,
          "--scope",
          record.scope,
          "--kind",
          record.kind,
          "--hook",
          record.hook,
          // The parser reads an empty value as a missing one, and an empty body
          // is what `create` already defaults to, so it is recovered by omission.
          ...(record.body === "" ? [] : ["--body", record.body]),
          "--index-mode",
          record.indexMode,
          ...record.aliases.flatMap((alias) => ["--alias", alias]),
          ...(record.statusNote === null
            ? []
            : ["--status-note", record.statusNote.text]),
          ...(record.reviewAfter === null
            ? []
            : ["--review-after", record.reviewAfter]),
          ...(record.expiresAt === null
            ? []
            : ["--expires-at", record.expiresAt]),
          ...(record.supersedes === null
            ? []
            : ["--supersedes", record.supersedes.split(":")[1] ?? ""]),
          "--json",
        ],
        makeEnv(),
        destinationHost,
      );
      expect(created.exitCode, `${record.slug}: ${created.stderr}`).toBe(
        EXIT_OK,
      );

      for (const link of record.links) {
        const relinked = await runCli(
          [
            "memory",
            "link",
            record.slug,
            "--artifact",
            link.artifact,
            "--kind",
            link.kind,
          ],
          makeEnv(),
          destinationHost,
        );
        expect(
          relinked.exitCode,
          `${record.slug} link: ${relinked.stderr}`,
        ).toBe(EXIT_OK);
      }
    }

    const reExportPath = path.join(dir, "re-export.md");
    const reExported = await runCli(
      ["memory", "export", "--output", reExportPath, "--json"],
      makeEnv(),
      destinationHost,
    );
    expect(reExported.exitCode, reExported.stderr).toBe(EXIT_OK);
    const reParsed = parseMemoryArchive(
      destinationHost.written[reExportPath] ?? "",
    );

    // Every current-state field the spec names is compared at once: hook, body,
    // statusNote, slug, aliases, kind, scope, indexMode, lifecycle, the review
    // lease and expiry, links, and both ends of the supersession pointer.
    expect(byHandle(reParsed.records)).toEqual(byHandle(archive.records));

    // The statusNote lease that comparison normalizes away is re-struck by the
    // receiving instance's own clock, which is the point of a lease — but the
    // archive carries the whole record, not only the text.
    const restated = reParsed.records.find(
      (record) => record.slug === "turbopack-build-memory",
    );
    expect(restated?.statusNote).toMatchObject({
      text: "resolved on 2026-08-19 by the FS cache",
      updatedAt: expect.any(String),
      reviewAfter: expect.any(String),
    });

    destination.fixture.close();
  });

  it("keeps a supersession pointer whose target the archive does not hold", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "learned-in-session",
      "--scope",
      "session",
      "--kind",
      "lesson",
      "--hook",
      "a lane worktree never re-syncs with its session branch",
    ]);
    const promoted = await runCli(
      ["memory", "promote", "learned-in-session", "--json"],
      makeEnv(),
      host,
    );
    expect(promoted.exitCode, promoted.stderr).toBe(EXIT_OK);

    // The project-scoped export holds the successor and NOT the session note
    // it replaced, which is exactly when the lineage handle has to be looked
    // up rather than rendered as null.
    const output = path.join(dir, "project-only.md");
    const exported = await runCli(
      ["memory", "export", "--scope", "project", "--output", output, "--json"],
      makeEnv(),
      host,
    );
    expect(exported.exitCode, exported.stderr).toBe(EXIT_OK);
    const archive = parseMemoryArchive(host.written[output] ?? "");
    expect(archive.records).toHaveLength(1);
    expect(archive.records[0]).toMatchObject({
      scope: "project",
      slug: "learned-in-session",
      supersedes: "session:learned-in-session",
    });
    // The pointer names a portable handle, never an internal id.
    expect(host.written[output]).not.toMatch(UUID_PATTERN);
  });

  it("excludes revision history by design and says so", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "edited-twice",
      "--hook",
      "the first hook",
    ]);
    const updated = await runCli(
      [
        "memory",
        "update",
        "edited-twice",
        "--if-revision",
        String(note.revision),
        "--hook",
        "the second hook",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(updated.exitCode, updated.stderr).toBe(EXIT_OK);

    const output = path.join(dir, "history.md");
    const exported = await runCli(
      ["memory", "export", "--output", output],
      makeEnv(),
      host,
    );
    expect(exported.exitCode, exported.stderr).toBe(EXIT_OK);
    const text = host.written[output] ?? "";
    expect(text).toContain("the second hook");
    expect(text).not.toContain("the first hook");
  });
});

/**
 * Records keyed by their portable handle, for a whole-archive comparison. The
 * statusNote collapses to its text: its `updatedAt` and `reviewAfter` are the
 * lease the RECEIVING instance strikes when the line is written there, exactly
 * as `createdAt` and `updatedAt` are, and neither is a field the archive claims
 * to transplant.
 */
function byHandle(records: readonly MemoryArchiveRecord[]): Record<
  string,
  Omit<MemoryArchiveRecord, "statusNote"> & {
    statusNote: string | null;
  }
> {
  return Object.fromEntries(
    records.map((record) => [
      `${record.scope}:${record.slug}`,
      { ...record, statusNote: record.statusNote?.text ?? null },
    ]),
  );
}

/** A note that supersedes another can only be created after its predecessor. */
function orderedForRecreation(
  records: readonly MemoryArchiveRecord[],
): MemoryArchiveRecord[] {
  return [...records].sort((a, b) =>
    a.supersedes === null ? (b.supersedes === null ? 0 : -1) : 1,
  );
}

describe("cctl memory maintenance verbs against the real service", () => {
  it("links, reads the link back, and unlinks it", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "join-conflict-recovery",
      "--hook",
      "auto-retry then halt-repair-resume; never live-tested",
    ]);

    const linked = await runCli(
      [
        "memory",
        "link",
        "join-conflict-recovery",
        "--artifact",
        `ticket:${primary.ticket.id}`,
        "--kind",
        "about",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(linked.exitCode, linked.stderr).toBe(EXIT_OK);
    expect(envelopeOf(linked)).toMatchObject({ ok: true });

    const withLink = await runCli(
      ["memory", "get", "join-conflict-recovery"],
      makeEnv(),
      host,
    );
    // The link prints in the same handle form `--artifact` accepts.
    expect(withLink.stdout).toContain(`about: ticket:${primary.ticket.id}`);

    const unlinked = await runCli(
      [
        "memory",
        "unlink",
        "join-conflict-recovery",
        "--artifact",
        `ticket:${primary.ticket.id}`,
        "--kind",
        "about",
      ],
      makeEnv(),
      host,
    );
    expect(unlinked.exitCode, unlinked.stderr).toBe(EXIT_OK);
    expect(unlinked.stdout).toContain("unlinked");

    const afterUnlink = await runCli(
      ["memory", "get", "join-conflict-recovery", "--json"],
      makeEnv(),
      host,
    );
    expect(envelopeOf(afterUnlink)["links"]).toEqual([]);
  });

  it("queues a note past its review lease and clears it with mark-reviewed", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "premerge-gate-scoping",
      "--hook",
      "the join gate runs a changed-scope suite, so green is not branch green",
      // A lease already in the past at this suite's clock.
      "--review-after",
      "2026-08-01T00:00:00.000Z",
    ]);
    const queued = await runCli(["memory", "review"], makeEnv(), host);
    expect(queued.exitCode, queued.stderr).toBe(EXIT_OK);
    expect(queued.stdout).toContain("premerge-gate-scoping");
    expect(queued.stdout).toContain("note review due");
    // Every row names the command that clears it.
    expect(queued.stdout).toContain(
      "cctl memory mark-reviewed premerge-gate-scoping",
    );

    const reviewed = await runCli(
      ["memory", "mark-reviewed", "premerge-gate-scoping", "--json"],
      makeEnv(),
      host,
    );
    expect(reviewed.exitCode, reviewed.stderr).toBe(EXIT_OK);
    const envelope = envelopeOf(reviewed);
    expect(envelope).toMatchObject({ ok: true });

    const cleared = await runCli(
      ["memory", "review", "--json"],
      makeEnv(),
      host,
    );
    expect(envelopeOf(cleared)["entries"]).toEqual([]);
  });

  it("re-leasing a status line prints the claim, its age, and the new lease", async () => {
    // R2.2/D8: `mark-reviewed --status` asserts "this is still true" about a
    // line that is about to prime every conversation again, so the act names
    // what it re-asserted rather than leaving the operator to go read it.
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "ticket-88-cursor-darwin",
      "--hook",
      "ps -E flattens env; read KERN_PROCARGS2 instead",
      "--status-note",
      "still unmerged as of 2026-09-02",
    ]);

    const text = await runCli(
      ["memory", "mark-reviewed", "ticket-88-cursor-darwin", "--status"],
      makeEnv(),
      host,
    );
    expect(text.exitCode, text.stderr).toBe(EXIT_OK);
    expect(text.stdout).toContain(
      "re-asserted: still unmerged as of 2026-09-02 (status as of ",
    );
    expect(text.stdout).toContain("status-review-after: ");

    const json = await runCli(
      [
        "memory",
        "mark-reviewed",
        "ticket-88-cursor-darwin",
        "--status",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(json.exitCode, json.stderr).toBe(EXIT_OK);
    const reLease = envelopeOf(json)["statusReLease"] as {
      text: string;
      updatedAt: string;
      reviewAfter: string;
    };
    expect(reLease.text).toBe("still unmerged as of 2026-09-02");
    expect(reLease.updatedAt).toBe(note.statusNote?.updatedAt);
    // The lease moved; the claim's own age did not.
    expect(Date.parse(reLease.reviewAfter)).toBeGreaterThan(
      Date.parse(note.statusNote?.reviewAfter ?? ""),
    );

    // A note-level review re-asserts no claim, so it names none.
    const noteReview = await runCli(
      ["memory", "mark-reviewed", "ticket-88-cursor-darwin", "--json"],
      makeEnv(),
      host,
    );
    expect(noteReview.exitCode, noteReview.stderr).toBe(EXIT_OK);
    expect(envelopeOf(noteReview)["statusReLease"]).toBeNull();
  });

  it("promotes a session note to project scope, superseding it", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "lane-worktrees-never-resync",
      "--scope",
      "session",
      "--kind",
      "lesson",
      "--hook",
      "a lane worktree never re-syncs; merge the session branch in pre-resume",
    ]);

    const promoted = await runCli(
      ["memory", "promote", "lane-worktrees-never-resync", "--json"],
      makeEnv(),
      host,
    );
    expect(promoted.exitCode, promoted.stderr).toBe(EXIT_OK);
    const envelope = envelopeOf(promoted);
    expect(envelope).toMatchObject({ ok: true });
    expect(envelope["promoted"]).toMatchObject({
      slug: "lane-worktrees-never-resync",
      scope: "project",
      lifecycle: "active",
    });
    expect(envelope["superseded"]).toMatchObject({
      scope: "session",
      lifecycle: "archived",
    });

    // The handle now resolves to exactly one note: the session one is archived,
    // so there is nothing left to disambiguate against.
    const resolved = await runCli(
      ["memory", "get", "lane-worktrees-never-resync", "--json"],
      makeEnv(),
      host,
    );
    expect(resolved.exitCode, resolved.stderr).toBe(EXIT_OK);
    expect(envelopeOf(resolved)["note"]).toMatchObject({ scope: "project" });
  });

  it("refuses a permanent delete without --confirm, then destroys the note", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "throwaway",
      "--hook",
      "a note captured by mistake",
    ]);

    const unconfirmed = await runCli(
      ["memory", "delete", "throwaway"],
      makeEnv(),
      host,
    );
    expect(unconfirmed.exitCode).toBe(EXIT_USAGE);
    // The reversible act is named beside the irreversible one — with a slug
    // PLACEHOLDER, because a pre-request refusal holds only the handle the
    // caller typed, which may be an internal id.
    expect(unconfirmed.stderr).toContain("cctl memory archive <slug>");
    expect(unconfirmed.stderr).not.toMatch(UUID_PATTERN);
    // Nothing was sent: the confirmation is local, so a mistake never reaches
    // the server at all.
    expect(host.requests.filter((row) => row.startsWith("DELETE"))).toEqual([]);

    const deleted = await runCli(
      ["memory", "delete", "throwaway", "--confirm", "--json"],
      makeEnv(),
      host,
    );
    expect(deleted.exitCode, deleted.stderr).toBe(EXIT_OK);
    expect(envelopeOf(deleted)).toMatchObject({ ok: true });

    const gone = await runCli(
      ["memory", "get", "throwaway", "--archived", "--json"],
      makeEnv(),
      host,
    );
    expect(gone.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(envelopeOf(gone)["code"]).toBe("not_found");
  });
});

describe("cctl memory refusals name the command that recovers", () => {
  it("names the current revision to re-state after a stale compare-and-swap", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "contested",
      "--hook",
      "the original hook",
    ]);

    const first = await runCli(
      [
        "memory",
        "update",
        "contested",
        "--if-revision",
        String(note.revision),
        "--hook",
        "the winning hook",
      ],
      makeEnv(),
      host,
    );
    expect(first.exitCode, first.stderr).toBe(EXIT_OK);

    // The second writer decided about a revision that is gone.
    const stale = await runCli(
      [
        "memory",
        "update",
        "contested",
        "--if-revision",
        String(note.revision),
        "--hook",
        "the losing hook",
      ],
      makeEnv(),
      host,
    );
    expect(stale.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(stale.stderr).toContain(`--if-revision ${note.revision + 1}`);
    expect(stale.stderr).toContain("cctl memory get contested");

    // The refused payload was not persisted.
    const current = await runCli(
      ["memory", "get", "contested", "--json"],
      makeEnv(),
      host,
    );
    expect(envelopeOf(current)["note"]).toMatchObject({
      hook: "the winning hook",
      revision: note.revision + 1,
    });
  });

  it("refuses a create whose body exceeds the cap, naming the limit", async () => {
    const host = makeHost();
    const oversized = await runCli(
      [
        "memory",
        "create",
        "--hook",
        "a note too large to keep",
        "--body",
        "x".repeat(9 * 1024),
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(oversized.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(JSON.stringify(envelopeOf(oversized))).toContain("8 KiB");
  });
});

describe("cctl memory output stays bounded", () => {
  it("caps the list and names the command that reveals the rest", async () => {
    const host = makeHost();
    for (let n = 0; n < 23; n++) {
      await createNote(host, [
        "--slug",
        `bulk-note-${String(n).padStart(2, "0")}`,
        "--hook",
        `bulk note number ${n} exists only to overflow the default cap`,
      ]);
    }

    const capped = await runCli(["memory", "list"], makeEnv(), host);
    expect(capped.exitCode, capped.stderr).toBe(EXIT_OK);
    const rows = capped.stdout
      .trimEnd()
      .split("\n")
      .filter((line) => line.startsWith("bulk-note-"));
    expect(rows).toHaveLength(20);
    expect(capped.stdout).toContain(
      "notes: 23 total, 20 shown — rest: cctl memory list --limit 23",
    );

    // The reveal command it printed is the one that actually reveals them.
    const revealed = await runCli(
      ["memory", "list", "--limit", "23"],
      makeEnv(),
      host,
    );
    expect(
      revealed.stdout
        .split("\n")
        .filter((line) => line.startsWith("bulk-note-")),
    ).toHaveLength(23);
  });

  it("closes a recall pack with its own showing-of line", async () => {
    const host = makeHost();
    for (let n = 0; n < 12; n++) {
      await createNote(host, [
        "--slug",
        `swap-thrash-${String(n).padStart(2, "0")}`,
        "--hook",
        `swap thrash reading ${n}: a lone test timeout is not a branch defect`,
        "--body",
        "Check sysctl vm.swapusage before blaming the branch.",
      ]);
    }

    const recalled = await runCli(
      ["memory", "recall", "swap thrash", "--budget", "600", "--json"],
      makeEnv(),
      host,
    );
    expect(recalled.exitCode, recalled.stderr).toBe(EXIT_OK);
    const envelope = envelopeOf(recalled);
    expect(envelope).toMatchObject({ ok: true, truncated: true });
    expect(envelope["returned"]).toBeLessThan(envelope["total"] as number);
    // The envelope's omission fragment and the pack's own closing line agree.
    expect(String(envelope["pack"])).toContain(String(envelope["reveal"]));
  });
});

describe("cctl memory query envelopes carry both identities", () => {
  it("puts the memory id beside the slug on every recall and index entry", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "swap-thrash-signature",
      "--hook",
      "a lone test timeout with zero failures is swap thrash, not a defect",
      "--body",
      "Check sysctl vm.swapusage before blaming the branch.",
    ]);

    const recalled = await runCli(
      ["memory", "recall", "swap thrash", "--json"],
      makeEnv(),
      host,
    );
    expect(recalled.exitCode, recalled.stderr).toBe(EXIT_OK);
    const recallEntries = envelopeOf(recalled)["entries"] as {
      memoryId: string;
      slug: string;
    }[];
    expect(recallEntries).toContainEqual(
      expect.objectContaining({ memoryId: note.id, slug: note.slug }),
    );
    // The rendered pack the agent reads still names slugs only.
    expect(String(envelopeOf(recalled)["pack"])).not.toContain(note.id);

    const indexed = await runCli(
      ["memory", "index", "--json"],
      makeEnv(),
      host,
    );
    expect(indexed.exitCode, indexed.stderr).toBe(EXIT_OK);
    const indexEntries = envelopeOf(indexed)["entries"] as {
      memoryId: string;
      slug: string;
      revision: number;
    }[];
    expect(indexEntries).toContainEqual(
      expect.objectContaining({
        memoryId: note.id,
        slug: note.slug,
        revision: note.revision,
      }),
    );
    expect(String(envelopeOf(indexed)["block"])).not.toContain(note.id);
  });

  it("writes nothing to stdout when the turn would be given no block", async () => {
    const host = makeHost();

    // An empty library composes to null, and the turn then injects NOTHING —
    // so a byte comparison against stdout has to see zero bytes.
    const injected = await primary.indexProvider.getForConversation({
      projectPath: PROJECT_PATH,
      conversationId: SESSION_CONVERSATION,
      conversation: { kind: "session", sessionName: SESSION_NAME },
      role: null,
      workflowExecutionId: null,
      workflowContextId: null,
      runtimeCreatedWithoutResume: false,
      backendReportedCompactionLastTurn: false,
    });
    expect(injected?.block).toBeNull();

    const previewed = await runCli(["memory", "index"], makeEnv(), host);
    expect(previewed.exitCode, previewed.stderr).toBe(EXIT_OK);
    expect(previewed.stdout).toBe("");
    // The explanation is not silence — it just is not part of the block.
    expect(previewed.stderr).toContain("no memory block");

    const asJson = await runCli(["memory", "index", "--json"], makeEnv(), host);
    expect(envelopeOf(asJson)).toMatchObject({ ok: true, block: null });
  });
});

describe("a scope narrowing recovers an ambiguous mutation", () => {
  /**
   * The refusals print `--scope <scope>` recoveries for every handle-taking
   * verb. Each one is RUN here: a narrowing the server drops would reproduce
   * the ambiguity it was printed to resolve, and the refusal would be advice
   * that does not work.
   */
  it("runs the exact command each ambiguous mutation refusal prints", async () => {
    const host = makeHost();
    const project = await createNote(host, [
      "--slug",
      "contested-handle",
      "--scope",
      "project",
      "--hook",
      "the project reading",
    ]);
    await createNote(host, [
      "--slug",
      "contested-handle",
      "--scope",
      "session",
      "--hook",
      "the session reading",
    ]);

    const mutations: { verb: string; argv: string[] }[] = [
      {
        verb: "update",
        argv: [
          "memory",
          "update",
          "contested-handle",
          "--if-revision",
          String(project.revision),
          "--hook",
          "a sharper project reading",
        ],
      },
      {
        verb: "link",
        argv: [
          "memory",
          "link",
          "contested-handle",
          "--artifact",
          `ticket:${primary.ticket.id}`,
        ],
      },
      {
        verb: "unlink",
        argv: [
          "memory",
          "unlink",
          "contested-handle",
          "--artifact",
          `ticket:${primary.ticket.id}`,
        ],
      },
      {
        verb: "mark-reviewed",
        argv: ["memory", "mark-reviewed", "contested-handle"],
      },
      { verb: "archive", argv: ["memory", "archive", "contested-handle"] },
    ];

    for (const { verb, argv } of mutations) {
      const refused = await runCli(argv, makeEnv(), host);
      expect(refused.exitCode, `${verb} was not refused`).toBe(
        EXIT_OPERATION_FAILED,
      );
      const narrowed = `cctl memory ${verb} contested-handle --scope project`;
      expect(refused.stderr, `${verb} printed no project narrowing`).toContain(
        narrowed,
      );

      // Run precisely what it printed.
      const recovered = await runCli(
        [...narrowed.split(" ").slice(1), ...argv.slice(3)],
        makeEnv(),
        host,
      );
      expect(
        recovered.exitCode,
        `the printed recovery for ${verb} failed: ${recovered.stderr}`,
      ).toBe(EXIT_OK);
    }

    // Archive ran last and took the project note, so the session one is now
    // the only active holder of the handle — proof the narrowing chose right.
    const survivor = await runCli(
      ["memory", "get", "contested-handle", "--json"],
      makeEnv(),
      host,
    );
    expect(survivor.exitCode, survivor.stderr).toBe(EXIT_OK);
    expect(envelopeOf(survivor)["note"]).toMatchObject({ scope: "session" });
  });

  it("refuses a permanent delete by narrowed scope and destroys only that note", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "doomed",
      "--scope",
      "project",
      "--hook",
      "the project reading",
    ]);
    await createNote(host, [
      "--slug",
      "doomed",
      "--scope",
      "session",
      "--hook",
      "the session reading",
    ]);

    const ambiguous = await runCli(
      ["memory", "delete", "doomed", "--confirm"],
      makeEnv(),
      host,
    );
    expect(ambiguous.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(ambiguous.stderr).toContain(
      "cctl memory delete doomed --scope project",
    );

    const deleted = await runCli(
      [
        "memory",
        "delete",
        "doomed",
        "--scope",
        "project",
        "--confirm",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(deleted.exitCode, deleted.stderr).toBe(EXIT_OK);
    expect(envelopeOf(deleted)["note"]).toMatchObject({ scope: "project" });

    const survivor = await runCli(
      ["memory", "get", "doomed", "--json"],
      makeEnv(),
      host,
    );
    expect(envelopeOf(survivor)["note"]).toMatchObject({ scope: "session" });
  });
});

describe("a bare handle reaches active records only", () => {
  it("does not resolve a global note still awaiting approval", async () => {
    const host = makeHost();
    const proposed = await createNote(host, [
      "--slug",
      "unapproved-global",
      "--scope",
      "global",
      "--hook",
      "a lesson an agent proposed for every project",
    ]);
    expect(proposed.lifecycle).toBe("proposed");

    const bare = await runCli(
      ["memory", "get", "unapproved-global", "--json"],
      makeEnv(),
      host,
    );
    expect(bare.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(envelopeOf(bare)["code"]).toBe("not_found");

    // It is real, and the approval queue still lists it — the proposal
    // boundary holds the RECORD back, it does not lose it.
    const queued = await runCli(
      ["memory", "list", "--lifecycle", "proposed", "--json"],
      makeEnv(),
      host,
    );
    const rows = envelopeOf(queued)["notes"] as { slug: string }[];
    expect(rows.map((row) => row.slug)).toContain("unapproved-global");
  });
});

/**
 * Spec R15's validator re-derivation hook, end to end: the judgement that a
 * round re-derived what a linked note already held is made by an agent or a
 * human, so the CLI verb is the production path that turns it into the counter
 * and the greppable event.
 */
describe("cctl memory records a validator re-derivation", () => {
  it("counts the round against the note and names only its slug", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--scope",
      "project",
      "--slug",
      "lane-branches-dont-inherit-session-fixes",
      "--hook",
      "a lane worktree never re-syncs with its session branch",
    ]);

    const observed = await runCli(
      [
        "memory",
        "observe-rederivation",
        "lane-branches-dont-inherit-session-fixes",
        "--artifact",
        "context:exec-7/validate-lane",
      ],
      makeEnv(),
      host,
    );

    expect(observed.exitCode, observed.stderr).toBe(EXIT_OK);
    expect(observed.stdout).toContain(
      "lane-branches-dont-inherit-session-fixes",
    );
    expect(observed.stdout).toContain("context:exec-7/validate-lane");
    expect(observed.stdout).not.toMatch(UUID_PATTERN);
    expect(
      await primary.telemetry.listObservations({
        kind: "validator_rederivation",
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "validator_rederivation",
        memoryId: note.id,
        count: 1,
      }),
    ]);
  });

  it("carries both identities in the --json envelope", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--scope",
      "project",
      "--slug",
      "turbopack-build-memory",
      "--hook",
      "an unpruned turbopack cache builds far slower than a pruned one",
    ]);

    const observed = await runCli(
      ["memory", "observe-rederivation", "turbopack-build-memory", "--json"],
      makeEnv(),
      host,
    );

    expect(observed.exitCode, observed.stderr).toBe(EXIT_OK);
    expect(envelopeOf(observed)).toEqual({
      ok: true,
      observed: {
        memoryId: note.id,
        slug: "turbopack-build-memory",
        conversationId: SESSION_CONVERSATION,
        executionId: null,
        contextId: null,
      },
    });
  });

  it("refuses a slug living in two scopes with the narrowing that recovers", async () => {
    const host = makeHost();
    for (const scope of ["project", "session"]) {
      await createNote(host, [
        "--scope",
        scope,
        "--slug",
        "shared-slug",
        "--hook",
        `a ${scope} note whose slug collides`,
      ]);
    }

    const ambiguous = await runCli(
      ["memory", "observe-rederivation", "shared-slug"],
      makeEnv(),
      host,
    );

    expect(ambiguous.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(ambiguous.stderr).toContain(
      "cctl memory observe-rederivation shared-slug --scope",
    );
    expect(
      await primary.telemetry.listObservations({
        kind: "validator_rederivation",
      }),
    ).toEqual([]);
  });
});

describe("cctl memory takes the ticket identifier operators actually hold", () => {
  /**
   * The two ticket identities only diverge on a real row: `tickets.id` is an
   * immutable uuid, and the per-project display number is what every
   * human-facing surface prints and every `cctl memory` help example writes.
   * A link stored against the wrong one is accepted and then never fires, so
   * these assertions run the documented form all the way to the block.
   */
  async function linkSessionToTicket(): Promise<void> {
    primary.fixture.seedSession(PROJECT_PATH, SESSION_NAME, {
      createdAt: SESSION_CREATED_AT,
    });
    await primary.tickets.linkStartedSession({
      id: "0d6b7d9c-2f4e-4a1b-8c3d-5e6f70819203",
      projectPath: PROJECT_PATH,
      number: primary.ticket.number,
      sessionName: SESSION_NAME,
      sessionCreatedAt: SESSION_CREATED_AT,
      startMode: "agent",
      linkedAt: SESSION_CREATED_AT,
    });
  }

  async function storedTicketId(memoryId: string): Promise<string | null> {
    const links = await primary.repo.listLinksForNotes([memoryId]);
    const ticketLink = links.find((link) => link.artifact.kind === "ticket");
    return ticketLink === undefined || ticketLink.artifact.kind !== "ticket"
      ? null
      : ticketLink.artifact.ticketId;
  }

  it("links by the display number its own help example uses, and the note reaches the about section", async () => {
    const host = makeHost();
    await linkSessionToTicket();
    const note = await createNote(host, [
      "--slug",
      "linked-by-display-number",
      "--hook",
      "the note an operator linked using the number printed on the ticket",
    ]);

    // Exactly the form `cctl memory link --help` teaches.
    const linked = await runCli(
      [
        "memory",
        "link",
        note.slug,
        "--artifact",
        `ticket:${primary.ticket.number}`,
      ],
      makeEnv(),
      host,
    );
    expect(linked.exitCode, linked.stderr).toBe(EXIT_OK);

    // Stored against the id space the index composer builds its active-artifact
    // ref from — not against the string the operator typed.
    expect(await storedTicketId(note.id)).toBe(primary.ticket.id);

    const block = await primary.indexProvider.getForConversation({
      projectPath: PROJECT_PATH,
      conversationId: SESSION_CONVERSATION,
      conversation: { kind: "session", sessionName: SESSION_NAME },
      role: null,
      workflowExecutionId: null,
      workflowContextId: null,
      runtimeCreatedWithoutResume: false,
      backendReportedCompactionLastTurn: false,
    });
    expect(block?.block).toContain(`## about ticket:${primary.ticket.id}`);
    expect(block?.block).toContain("linked-by-display-number");
  });

  it("takes the project-qualified form and the raw id to the same ticket", async () => {
    const host = makeHost();
    for (const [slug, handle] of [
      ["qualified-form", `ticket:${PROJECT_NAME}#${primary.ticket.number}`],
      ["raw-id-form", `ticket:${primary.ticket.id}`],
    ] as const) {
      const note = await createNote(host, [
        "--slug",
        slug,
        "--hook",
        `linked through ${handle}`,
      ]);
      const linked = await runCli(
        ["memory", "link", note.slug, "--artifact", handle],
        makeEnv(),
        host,
      );
      expect(linked.exitCode, linked.stderr).toBe(EXIT_OK);
      expect(await storedTicketId(note.id)).toBe(primary.ticket.id);
    }
  });

  it("refuses the removed watch kind and the removed --watch flag before any request", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "links-are-not-freshness",
      "--hook",
      "typed links are about and source only; leases carry freshness",
    ]);
    const artifact = `ticket:${primary.ticket.id}`;

    const badKind = await runCli(
      ["memory", "link", note.slug, "--artifact", artifact, "--kind", "watch"],
      makeEnv(),
      host,
    );
    expect(badKind.exitCode).toBe(EXIT_USAGE);
    // The placeholder is derived from the link-kind schema, so the refusal
    // names exactly the two kinds that remain.
    expect(badKind.stderr).toContain("about");
    expect(badKind.stderr).toContain("source");

    const badFlag = await runCli(
      [
        "memory",
        "link",
        note.slug,
        "--artifact",
        artifact,
        "--watch",
        "statusNote",
      ],
      makeEnv(),
      host,
    );
    expect(badFlag.exitCode).toBe(EXIT_USAGE);
    expect(badFlag.stderr).toContain("--watch");

    // Neither attempt reached the server.
    expect(await storedTicketId(note.id)).toBeNull();
  });

  it("refuses a handle naming no ticket for every link kind rather than storing it", async () => {
    const host = makeHost();
    const missing = `ticket:${primary.ticket.number + 4100}`;
    for (const kind of ["about", "source"] as const) {
      const note = await createNote(host, [
        "--slug",
        `unresolvable-${kind}`,
        "--hook",
        `a link of kind ${kind} against a ticket that does not exist`,
      ]);
      const linked = await runCli(
        ["memory", "link", note.slug, "--artifact", missing, "--kind", kind],
        makeEnv(),
        host,
      );
      expect(linked.exitCode, linked.stdout).not.toBe(EXIT_OK);
      // The refusal names the project and the number the caller actually wrote.
      expect(`${linked.stdout}${linked.stderr}`).toContain(
        String(primary.ticket.number + 4100),
      );
      expect(`${linked.stdout}${linked.stderr}`).toContain(PROJECT_NAME);
      // Nothing was persisted — the silent half of the defect.
      expect(await storedTicketId(note.id)).toBeNull();
    }
  });

  it("narrows a ticket recall to the same ticket whichever identifier names it", async () => {
    const host = makeHost();
    const note = await createNote(host, [
      "--slug",
      "recallable-by-number",
      "--hook",
      "the note a --related ticket query should return",
    ]);
    await runCli(
      [
        "memory",
        "link",
        note.slug,
        "--artifact",
        `ticket:${primary.ticket.number}`,
      ],
      makeEnv(),
      host,
    );

    const recalled = await runCli(
      ["memory", "recall", "--related", `ticket:${primary.ticket.number}`],
      makeEnv(),
      host,
    );
    expect(recalled.exitCode, recalled.stderr).toBe(EXIT_OK);
    expect(recalled.stdout).toContain("recallable-by-number");
  });
});

describe("cctl memory get names the note that replaced this one", () => {
  /**
   * Supersession exists so a reader who follows a stale slug out of an old
   * transcript is told the note was replaced. Being fetchable is half of that;
   * the other half only counts on the surface an agent actually reads, which is
   * the default text of the get verb.
   */
  async function superseded(
    host: ReturnType<typeof makeHost>,
  ): Promise<{ retired: string; successor: string }> {
    await createNote(host, [
      "--slug",
      "the-retired-claim",
      "--hook",
      "the design this note recorded as current",
    ]);
    await createNote(host, [
      "--slug",
      "the-standing-claim",
      "--hook",
      "the design that actually shipped",
      "--supersedes",
      "the-retired-claim",
    ]);
    return { retired: "the-retired-claim", successor: "the-standing-claim" };
  }

  it("names the successor by slug in the default text, and no internal id", async () => {
    const host = makeHost();
    const { retired, successor } = await superseded(host);

    const read = await runCli(
      ["memory", "get", retired, "--archived"],
      makeEnv(),
      host,
    );
    expect(read.exitCode, read.stderr).toBe(EXIT_OK);
    expect(read.stdout).toContain(`superseded by: project:${successor}`);
    expect(withoutTicketHandles(read.stdout)).not.toMatch(UUID_PATTERN);
  });

  it("names the predecessor from the successor's side", async () => {
    const host = makeHost();
    const { retired, successor } = await superseded(host);

    const read = await runCli(["memory", "get", successor], makeEnv(), host);
    expect(read.exitCode, read.stderr).toBe(EXIT_OK);
    expect(read.stdout).toContain(`supersedes: project:${retired}`);
    expect(withoutTicketHandles(read.stdout)).not.toMatch(UUID_PATTERN);
  });

  it("carries the resolved handle beside the id in the --json envelope", async () => {
    const host = makeHost();
    const { retired, successor } = await superseded(host);

    const read = await runCli(
      ["memory", "get", retired, "--archived", "--json"],
      makeEnv(),
      host,
    );
    expect(read.exitCode, read.stderr).toBe(EXIT_OK);
    const envelope = envelopeOf(read);
    expect(envelope["lineage"]).toEqual({
      supersedes: null,
      supersededBy: `project:${successor}`,
    });
    // The id is still on the wire — the handle sits BESIDE it, so a consumer
    // reads one resolved value instead of re-deriving it.
    expect(
      (envelope["note"] as { supersededById: string }).supersededById,
    ).toMatch(UUID_PATTERN);
  });

  it("names nothing rather than an id when the target is outside the reader's reach", async () => {
    const host = makeHost();
    await createNote(host, [
      "--slug",
      "learned-in-one-session",
      "--scope",
      "session",
      "--kind",
      "lesson",
      "--hook",
      "the lesson a session learned before it was promoted",
    ]);
    const promoted = await runCli(
      ["memory", "promote", "learned-in-one-session", "--json"],
      makeEnv(),
      host,
    );
    expect(promoted.exitCode, promoted.stderr).toBe(EXIT_OK);

    // A PROJECT conversation cannot see any session-scoped note, so the
    // promoted note's predecessor is unreachable for this reader.
    const projectEnv = makeEnv({
      CC_CONVERSATION_SCOPE: "project",
      CC_CONVERSATION_ID: PROJECT_CONVERSATION,
      CC_SESSION: undefined,
    });
    const read = await runCli(
      ["memory", "get", "learned-in-one-session", "--json"],
      projectEnv,
      host,
    );
    expect(read.exitCode, read.stderr).toBe(EXIT_OK);
    const envelope = envelopeOf(read);
    expect(envelope["lineage"]).toEqual({
      supersedes: null,
      supersededBy: null,
    });

    const text = await runCli(
      ["memory", "get", "learned-in-one-session"],
      projectEnv,
      host,
    );
    expect(text.stdout).not.toContain("supersedes:");
    expect(withoutTicketHandles(text.stdout)).not.toMatch(UUID_PATTERN);
  });
});
