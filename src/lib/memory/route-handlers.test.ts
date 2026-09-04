import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentAuth } from "@/lib/agent-gateway/token";
import { readNextTurnContextLoss } from "@/lib/workflows/conversation/pre-turn/next-turn-context-loss";
import type { PublishFn } from "@/lib/events/publication";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createMemoryRepo,
  type MemoryRepo,
} from "@/lib/state-store/memory-repo";
import {
  createMemoryTelemetryRepo,
  type MemoryTelemetryRepo,
} from "@/lib/state-store/memory-telemetry-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import type { MemoryContributionGate } from "./delivery-policy";
import { createMemoryFreshnessEngine } from "./freshness";
import { createMemoryIndexComposer } from "./index-composer";
import { createMemoryIndexContextProvider } from "./index-live-context";
import { createMemoryRecallService } from "./recall";
import {
  createMemoryTelemetryService,
  type MemoryTelemetryService,
} from "./telemetry";
import {
  createMemoryRouteHandlers,
  MEMORY_CALLER_CONVERSATION_HEADER,
  type MemoryRouteHandlers,
} from "./route-handlers";
import {
  MEMORY_INDEX_BUDGET_DEFAULT_BYTES,
  MEMORY_INDEX_BUDGET_DEFAULT_HOOKS,
} from "./schemas";
import { createMemoryService, type MemoryService } from "./service";
import { openMemoryContributionGate } from "./testing/contribution-gate";
import { createMemorySessionLifecycleReader } from "./session-lifecycle";

/**
 * The production HTTP surface, driven directly. These are the smoke checks the
 * route layer owns rather than the service: that scope authority is resolved
 * SERVER-SIDE from the caller's own conversation, that a request cannot name a
 * scope it does not occupy, and that the service's typed refusals arrive with
 * their status and recovery fields intact.
 *
 * Verb-by-verb coverage lives in the CLI contract test, which drives these same
 * handlers through the real command dispatch.
 */

const TOKEN = "memory-route-token";
const PROJECT_NAME = "cc";
const PROJECT_PATH = "/repos/cc";
const OTHER_PROJECT_PATH = "/repos/other";
const SESSION_NAME = "memory-spike";
const SESSION_CREATED_AT = "2026-08-28T09:00:00.000Z";
const SESSION_CONVERSATION = "conv-session-1";
const PROJECT_CONVERSATION = "conv-project-1";

let dir: string;
let fixture: PersistenceFixture;
let repo: MemoryRepo;
let service: MemoryService;
let handlers: MemoryRouteHandlers;
let contributionGate: MemoryContributionGate;
let telemetryRepo: MemoryTelemetryRepo;
/**
 * The ONE telemetry service the handlers and the index provider share, as
 * production wires them: a preview's no-side-effect claim is only testable
 * against the same delivery state the composition reads.
 */
let telemetry: MemoryTelemetryService;
/**
 * The context-loss signals the fixture's conversations report. Mutable because
 * the parity these tests are about is a DISAGREEMENT that only appears when the
 * signal is true: a suite that only ever ran it false would pass against a
 * preview that ignored it entirely.
 */
let contextLoss: {
  runtimeCreatedWithoutResume: boolean;
  backendReportedCompactionLastTurn: boolean;
};
/**
 * When set, the handlers read context loss through the PRODUCTION pre-turn
 * reader instead of the flat fixture value, so one test can prove the route
 * and that reader actually compose rather than agreeing by construction.
 */
let contextLossReader:
  | ((conversationId: string) => Promise<{
      runtimeCreatedWithoutResume: boolean;
      backendReportedCompactionLastTurn: boolean;
    }>)
  | null;

const publish: PublishFn = () => ({ delivered: true });

function buildHandlers(): MemoryRouteHandlers {
  const freshness = createMemoryFreshnessEngine({
    repo,
    sessions: createMemorySessionLifecycleReader({
      async findSession() {
        return null;
      },
    }),
    now: () => "2026-09-02T00:00:00.000Z",
  });
  return createMemoryRouteHandlers({
    getService: () => service,
    // No ticket rows in this fixture, so every ticket handle is unresolvable —
    // the same answer production gives for a ticket that is not there.
    async findTicketId() {
      return null;
    },
    getTelemetry: () => telemetry,
    getRecall: () =>
      createMemoryRecallService({
        repo,
        freshness,
        now: () => "2026-09-02T00:00:00.000Z",
      }),
    getFreshness: () => freshness,
    getIndexProvider: () =>
      createMemoryIndexContextProvider({
        composer: createMemoryIndexComposer({
          repo,
          freshness,
          now: () => "2026-09-02T00:00:00.000Z",
        }),
        async findSessionCreatedAt(projectPath, sessionName) {
          return projectPath === PROJECT_PATH && sessionName === SESSION_NAME
            ? SESSION_CREATED_AT
            : null;
        },
        async findLinkedTicketId() {
          return null;
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
        now: () => "2026-09-02T00:00:00.000Z",
      }),
    findNoteById: (memoryId) => repo.find(memoryId),
    listLinksForNotes: (ids) => repo.listLinksForNotes(ids),
    async resolveProjectPath(projectName) {
      return projectName === PROJECT_NAME ? PROJECT_PATH : null;
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
          projectPath: OTHER_PROJECT_PATH,
          conversation: { kind: "project" },
          role: null,
        };
      }
      return null;
    },
    async findSessionCreatedAt(projectPath, sessionName) {
      return projectPath === PROJECT_PATH && sessionName === SESSION_NAME
        ? SESSION_CREATED_AT
        : null;
    },
    async findLaneBinding() {
      return null;
    },
    readNextTurnContextLoss: (conversationId) =>
      contextLossReader === null
        ? Promise.resolve(contextLoss)
        : contextLossReader(conversationId),
    auth: createAgentAuth({ configDir: dir }),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cc-memory-routes-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });

  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedProject(OTHER_PROJECT_PATH);
  const writeQueue = createWriteQueue();
  repo = createMemoryRepo(fixture.db, writeQueue);
  telemetryRepo = createMemoryTelemetryRepo(fixture.db, writeQueue);
  telemetry = createMemoryTelemetryService({
    repo: telemetryRepo,
    now: () => "2026-09-02T00:00:00.000Z",
  });
  contextLoss = {
    runtimeCreatedWithoutResume: false,
    backendReportedCompactionLastTurn: false,
  };
  contextLossReader = null;

  let clock = 0;
  let ids = 0;
  contributionGate = openMemoryContributionGate();
  service = createMemoryService({
    repo,
    publish,
    contributionGate: { decide: (actor) => contributionGate.decide(actor) },
    sessions: createMemorySessionLifecycleReader({
      async findSession() {
        return null;
      },
    }),
    now: () => {
      clock += 1000;
      return new Date(Date.UTC(2026, 8, 1) + clock).toISOString();
    },
    generateId: () => {
      ids += 1;
      return `mem-${ids}`;
    },
  });
  handlers = buildHandlers();
});

afterEach(async () => {
  fixture.close();
  await rm(dir, { recursive: true, force: true });
});

function agentRequest(
  url: string,
  init: RequestInit & { conversationId?: string } = {},
): Request {
  const { conversationId = SESSION_CONVERSATION, ...rest } = init;
  return new Request(url, {
    ...rest,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      [MEMORY_CALLER_CONVERSATION_HEADER]: conversationId,
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("memory routes — scope authority", () => {
  it("binds an agent's session-scoped create to its own incarnation", async () => {
    const response = await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          scope: "session",
          kind: "state",
          hook: "the halted execution blocks cctl validate",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const payload = await body(response);
    // Nothing in the request named the project or the incarnation: both come
    // from the conversation row the caller header resolves to.
    expect(payload["note"]).toMatchObject({
      scope: "session",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      sessionCreatedAt: SESSION_CREATED_AT,
    });
  });

  it("refuses a scope the caller's conversation does not occupy", async () => {
    // A project conversation in ANOTHER project holds no session, so a
    // session-scoped write has no incarnation to bind to.
    const response = await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        conversationId: PROJECT_CONVERSATION,
        body: JSON.stringify({
          scope: "session",
          kind: "state",
          hook: "borrowed scope",
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({
      code: "scope_unavailable",
      details: { missing: "session" },
    });
  });

  it("keeps one project's notes out of another project's list", async () => {
    await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          scope: "project",
          kind: "lesson",
          hook: "cc project note",
        }),
      }),
    );

    const listed = await handlers.listGET(
      agentRequest("http://cc/api/memory/notes", {
        conversationId: PROJECT_CONVERSATION,
      }),
    );

    expect(listed.status).toBe(200);
    expect(await body(listed)).toEqual({ notes: [] });
  });

  it("refuses a link naming the removed watch kind before any write", async () => {
    const created = await body(
      await handlers.createPOST(
        agentRequest("http://cc/api/memory/notes", {
          method: "POST",
          body: JSON.stringify({
            scope: "project",
            kind: "lesson",
            hook: "a lesson to link",
          }),
        }),
      ),
    );
    const slug = (created["note"] as { slug: string }).slug;

    // The wire body is untyped, so this is the shape a client that still knows
    // about watches would send: the link-kind schema refuses it (R8, D6).
    const response = await handlers.linksPOST(
      agentRequest(`http://cc/api/memory/notes/${slug}/links`, {
        method: "POST",
        body: JSON.stringify({ kind: "watch", artifact: "ticket:74" }),
      }),
      { params: Promise.resolve({ handle: slug }) },
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toMatchObject({ code: "validation_failed" });
  });

  it("refuses a caller conversation Command Center cannot place", async () => {
    const response = await handlers.listGET(
      agentRequest("http://cc/api/memory/notes", {
        conversationId: "conv-ghost",
      }),
    );

    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ code: "caller_unresolved" });
  });

  it("takes the user's scope from the project query parameter", async () => {
    await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          scope: "project",
          kind: "lesson",
          hook: "visible to the library",
        }),
      }),
    );

    const listed = await handlers.listGET(
      new Request(`http://cc/api/memory/notes?project=${PROJECT_NAME}`),
    );

    expect(listed.status).toBe(200);
    const payload = await body(listed);
    expect(Array.isArray(payload["notes"])).toBe(true);
    expect(payload["notes"]).toHaveLength(1);
  });

  it("404s a project name that resolves to no project", async () => {
    const response = await handlers.listGET(
      new Request("http://cc/api/memory/notes?project=ghost"),
    );
    expect(response.status).toBe(404);
  });

  it("rejects a malformed bearer token before doing any work", async () => {
    const response = await handlers.listGET(
      new Request("http://cc/api/memory/notes", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("memory routes — typed refusals", () => {
  it("maps a stale compare-and-swap onto 409 naming the current revision", async () => {
    const created = await body(
      await handlers.createPOST(
        agentRequest("http://cc/api/memory/notes", {
          method: "POST",
          body: JSON.stringify({
            scope: "project",
            kind: "lesson",
            hook: "the original hook",
          }),
        }),
      ),
    );
    const note = created["note"] as { slug: string; revision: number };

    await handlers.detailPATCH(
      agentRequest(`http://cc/api/memory/notes/${note.slug}`, {
        method: "PATCH",
        body: JSON.stringify({ baseRevision: note.revision, hook: "first" }),
      }),
      { params: Promise.resolve({ handle: note.slug }) },
    );

    const stale = await handlers.detailPATCH(
      agentRequest(`http://cc/api/memory/notes/${note.slug}`, {
        method: "PATCH",
        body: JSON.stringify({ baseRevision: note.revision, hook: "second" }),
      }),
      { params: Promise.resolve({ handle: note.slug }) },
    );

    expect(stale.status).toBe(409);
    const refusal = await body(stale);
    expect(refusal).toMatchObject({
      code: "stale_revision",
      details: {
        baseRevision: note.revision,
        currentRevision: note.revision + 1,
      },
    });
    // The server authors the explanation; no surface re-words it.
    expect(refusal["instruction"]).toBeTruthy();
    expect(refusal["rationale"]).toBeTruthy();
  });

  it("maps a contribution-off policy refusal onto 403 with its policy", async () => {
    contributionGate = {
      async decide() {
        return {
          allowed: false,
          reason: "contribution_off",
          policy: {
            role: "validator",
            read: { value: "off", source: "global" },
            contribute: { value: "off", source: "global" },
          },
        };
      },
    };

    const response = await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          scope: "project",
          kind: "lesson",
          hook: "a validator writing memory",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({
      code: "policy_refused",
      details: { verb: "create", reason: "contribution_off" },
    });
  });

  it("leaves retrieval available to a caller whose contribution is off", async () => {
    contributionGate = {
      async decide() {
        return {
          allowed: false,
          reason: "contribution_off",
          policy: {
            role: "validator",
            read: { value: "off", source: "global" },
            contribute: { value: "off", source: "global" },
          },
        };
      },
    };

    const response = await handlers.listGET(
      agentRequest("http://cc/api/memory/notes"),
    );
    expect(response.status).toBe(200);
  });

  it("names the accepted artifact handle forms when one is malformed", async () => {
    const created = await body(
      await handlers.createPOST(
        agentRequest("http://cc/api/memory/notes", {
          method: "POST",
          body: JSON.stringify({
            scope: "project",
            kind: "lesson",
            hook: "linkable",
          }),
        }),
      ),
    );
    const slug = (created["note"] as { slug: string }).slug;

    const response = await handlers.linksPOST(
      agentRequest(`http://cc/api/memory/notes/${slug}/links`, {
        method: "POST",
        body: JSON.stringify({ kind: "about", artifact: "notepad-42" }),
      }),
      { params: Promise.resolve({ handle: slug }) },
    );

    expect(response.status).toBe(400);
    const refusal = await body(response);
    expect(refusal["code"]).toBe("validation_failed");
    expect(JSON.stringify(refusal["issues"])).toContain("ticket:<id>");
  });
});

describe("memory routes — index preview", () => {
  it("renders the block for a named conversation", async () => {
    await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          scope: "project",
          kind: "lesson",
          hook: "check the diagnostic Git SHA before the fix date",
        }),
      }),
    );

    const response = await handlers.indexGET(
      agentRequest(
        `http://cc/api/memory/index?conversation=${SESSION_CONVERSATION}`,
      ),
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    const block = payload["block"] as { text: string } | null;
    expect(block).not.toBeNull();
    expect(block?.text).toContain(
      "check the diagnostic Git SHA before the fix date",
    );
  });

  it("404s a conversation that does not exist", async () => {
    const response = await handlers.indexGET(
      agentRequest("http://cc/api/memory/index?conversation=conv-ghost"),
    );
    expect(response.status).toBe(404);
    expect(await body(response)).toMatchObject({
      code: "conversation_not_found",
    });
  });

  /** One note, created through the same handler an agent calls. */
  async function seedIndexNote(hook: string): Promise<string> {
    const created = await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({ scope: "project", kind: "lesson", hook }),
      }),
    );
    const note = (await body(created))["note"] as {
      id: string;
      slug: string;
      revision: number;
    };
    return note.slug;
  }

  async function previewIndex(full: boolean): Promise<Record<string, unknown>> {
    const response = await handlers.indexGET(
      agentRequest(
        `http://cc/api/memory/index?conversation=${SESSION_CONVERSATION}${
          full ? "&full=true" : ""
        }`,
      ),
    );
    expect(response.status).toBe(200);
    return await body(response);
  }

  /** Settle the block this conversation was shown, exactly as the turn seam does. */
  async function settleFullDelivery(
    entries: readonly {
      memoryId: string;
      revision: number;
      statusDelivered: boolean;
    }[],
  ): Promise<void> {
    await telemetry.recordDelivery({
      conversationId: SESSION_CONVERSATION,
      channel: "index",
      kind: "full",
      composedAt: "2026-09-02T00:00:00.000Z",
      notes: entries.map((entry) => ({
        memoryId: entry.memoryId,
        revision: entry.revision,
        statusDelivered: entry.statusDelivered,
      })),
    });
  }

  it("serves the delta the next turn is due by default and the full block behind the selector", async () => {
    const revised = await seedIndexNote(
      "prune the turbopack FS cache when a build sits at 99% CPU on one core",
    );
    await seedIndexNote(
      "a lane worktree never re-syncs with its session branch",
    );

    const first = await previewIndex(true);
    expect(first["mode"]).toBe("full");
    const firstBlock = first["block"] as {
      entries: readonly {
        memoryId: string;
        revision: number;
        statusDelivered: boolean;
      }[];
    };
    await settleFullDelivery(firstBlock.entries);

    await handlers.detailPATCH(
      agentRequest(`http://cc/api/memory/notes/${revised}`, {
        method: "PATCH",
        body: JSON.stringify({
          baseRevision: 1,
          hook: "an 8.4 GB turbopack FS cache builds 59x slower than a pruned one",
        }),
      }),
      { params: Promise.resolve({ handle: revised }) },
    );

    const delta = await previewIndex(false);
    expect(delta["mode"]).toBe("delta");
    const deltaBlock = delta["block"] as { text: string };
    expect(deltaBlock.text).toContain("builds 59x slower");
    expect(deltaBlock.text).not.toContain("a lane worktree never re-syncs");

    const full = await previewIndex(true);
    expect(full["mode"]).toBe("full");
    const fullBlock = full["block"] as { text: string };
    expect(fullBlock.text).toContain("builds 59x slower");
    expect(fullBlock.text).toContain("a lane worktree never re-syncs");
  });

  it("renders the FULL block a lost runtime is due, not the delta its state alone implies", async () => {
    await seedIndexNote("prune the turbopack FS cache at 99% CPU on one core");
    const first = await previewIndex(true);
    const firstBlock = first["block"] as {
      entries: readonly {
        memoryId: string;
        revision: number;
        statusDelivered: boolean;
      }[];
    };
    await settleFullDelivery(firstBlock.entries);

    // Nothing about the library changed, so delivery state ALONE says delta.
    expect((await previewIndex(false))["mode"]).toBe("delta");

    // But this conversation's next turn must create a runtime with no resume
    // handle: the turn treats that as a context loss, resets, and injects the
    // full block. The preview has to say the same thing without an intervening
    // memory mutation, or it describes a turn that will not happen.
    contextLoss = {
      runtimeCreatedWithoutResume: true,
      backendReportedCompactionLastTurn: false,
    };

    const before = await telemetry.readIndexDelivery(SESSION_CONVERSATION);
    const preview = await previewIndex(false);
    expect(preview["mode"]).toBe("full");
    const previewBlock = preview["block"] as { text: string };
    expect(previewBlock.text).toContain("prune the turbopack FS cache");

    // Still no reset: performing the turn's reset here would leave the
    // sequence claiming a full block nobody was ever given.
    expect(await telemetry.readIndexDelivery(SESSION_CONVERSATION)).toEqual(
      before,
    );
  });

  it("renders the FULL block a self-reported backend compaction is due", async () => {
    await seedIndexNote(
      "a lane worktree never re-syncs with its session branch",
    );
    const first = await previewIndex(true);
    const firstBlock = first["block"] as {
      entries: readonly {
        memoryId: string;
        revision: number;
        statusDelivered: boolean;
      }[];
    };
    await settleFullDelivery(firstBlock.entries);
    expect((await previewIndex(false))["mode"]).toBe("delta");

    // The second context-loss signal travels the same path, so the preview
    // cannot start ignoring it if the turn seam ever begins reporting it.
    contextLoss = {
      runtimeCreatedWithoutResume: false,
      backendReportedCompactionLastTurn: true,
    };

    expect((await previewIndex(false))["mode"]).toBe("full");
  });

  it("renders the FULL block the production reader predicts when the charter moved under a live runtime", async () => {
    // The route and the pre-turn reader, composed. Everything above drives the
    // signal from a fixture value, which proves the route obeys it but not that
    // anything ever sets it: here the real reader answers, from a live runtime
    // that baked charter version 2 while version 3 is the active one. The turn
    // closes such a runtime to bake the new version in (R7.3), and with no
    // resume handle that is a context loss — so "alive" is not "reusable".
    await seedIndexNote(
      "a lane worktree never re-syncs with its session branch",
    );
    const first = await previewIndex(true);
    const firstBlock = first["block"] as {
      entries: readonly {
        memoryId: string;
        revision: number;
        statusDelivered: boolean;
      }[];
    };
    await settleFullDelivery(firstBlock.entries);
    expect((await previewIndex(false))["mode"]).toBe("delta");

    const withCharterVersion = (active: number) => (conversationId: string) =>
      readNextTurnContextLoss(
        {
          async findConversation() {
            return {
              projectPath: PROJECT_PATH,
              sessionName: SESSION_NAME,
              promptCount: 4,
              hasResumeHandle: false,
            };
          },
          getRuntime() {
            return {
              status: "alive",
              modelSelection: { modelId: "claude-opus-5", parameters: {} },
              alignmentVersion: 2,
            };
          },
          async getSessionCreationMode() {
            return "normal";
          },
          async getActiveAlignmentVersion() {
            return active;
          },
        },
        conversationId,
      );

    // The same live runtime under the charter it was built with stays reusable,
    // so this is drift talking rather than the reader answering full for every
    // conversation it is asked about.
    contextLossReader = withCharterVersion(2);
    expect((await previewIndex(false))["mode"]).toBe("delta");

    contextLossReader = withCharterVersion(3);
    expect((await previewIndex(false))["mode"]).toBe("full");
  });

  it("leaves the conversation's delivery state untouched in either mode", async () => {
    await seedIndexNote("a preview shows a block nobody was shown");
    const first = await previewIndex(true);
    const firstBlock = first["block"] as {
      entries: readonly {
        memoryId: string;
        revision: number;
        statusDelivered: boolean;
      }[];
    };
    await settleFullDelivery(firstBlock.entries);

    const before = await telemetry.readIndexDelivery(SESSION_CONVERSATION);
    await previewIndex(false);
    await previewIndex(true);
    const after = await telemetry.readIndexDelivery(SESSION_CONVERSATION);

    // Reading the block a turn is due must not advance, reset, or re-date the
    // sequence the turn itself settles (R12): a preview is shown to nobody.
    expect(after).toEqual(before);
  });
});

// Spec R15: the two delivery channels are the ambient block a turn injects and
// a recall pack an agent expanded. The recall half is recorded HERE, at the one
// surface every recall caller (the CLI, the Library, an agent) passes through.
describe("memory routes — recall delivery watermarks", () => {
  async function seedNote(hook: string): Promise<string> {
    const created = await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({ scope: "project", kind: "lesson", hook }),
      }),
    );
    const note = (await body(created))["note"] as { id: string };
    return note.id;
  }

  it("records what a recall put in front of the calling conversation", async () => {
    const memoryId = await seedNote(
      "swap thrash reads as an onTaskUpdate timeout",
    );

    const response = await handlers.recallPOST(
      agentRequest("http://cc/api/memory/recall", {
        method: "POST",
        body: JSON.stringify({ query: "swap thrash" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(
      await telemetryRepo.listDeliveryWatermarks(SESSION_CONVERSATION),
    ).toEqual([
      {
        conversationId: SESSION_CONVERSATION,
        memoryId,
        channel: "expanded",
        revision: 1,
        // The seeded note carries no statusNote, so the pack rendered no
        // status line and the watermark says so.
        statusDelivered: false,
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    ]);
  });

  it("records nothing for a recall that composed the index preview instead", async () => {
    await seedNote("the preview shows a block nobody was shown");

    await handlers.indexGET(
      agentRequest(
        `http://cc/api/memory/index?conversation=${SESSION_CONVERSATION}`,
      ),
    );

    expect(
      await telemetryRepo.listDeliveryWatermarks(SESSION_CONVERSATION),
    ).toEqual([]);
  });
});

// Spec R15: the promoted half of the promotion counter pair. Recorded against
// the SESSION note the promotion retired — the same subject session end counted
// as a candidate — so a missed passive affordance is a per-record comparison
// rather than only a global one.
describe("memory routes — promotion telemetry", () => {
  it("counts the promotion against the session note it retired", async () => {
    const created = await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          scope: "session",
          kind: "lesson",
          hook: "lane worktrees never re-sync with the session branch",
        }),
      }),
    );
    const sessionNote = (await body(created))["note"] as {
      id: string;
      slug: string;
    };

    const response = await handlers.promotePOST(
      agentRequest(`http://cc/api/memory/notes/${sessionNote.slug}/promote`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ handle: sessionNote.slug }) },
    );

    expect(response.status).toBe(200);
    expect(await telemetryRepo.listObservations({ kind: "promoted" })).toEqual([
      expect.objectContaining({
        kind: "promoted",
        memoryId: sessionNote.id,
        count: 1,
      }),
    ]);
  });
});

// Spec R15: a validator round spent re-deriving a fact a linked note already
// held is an OBSERVATION about the round, not an edit of the note, so it has
// its own production surface. The counter is raised against the note whose
// content was re-derived and the round's own identities ride the structured
// event.
describe("memory routes — validator re-derivation telemetry", () => {
  async function seedNote(): Promise<{ id: string; slug: string }> {
    const created = await handlers.createPOST(
      agentRequest("http://cc/api/memory/notes", {
        method: "POST",
        body: JSON.stringify({
          scope: "project",
          kind: "lesson",
          hook: "a lane worktree never re-syncs with its session branch",
        }),
      }),
    );
    return (await body(created))["note"] as { id: string; slug: string };
  }

  it("counts the round against the note whose fact it re-derived", async () => {
    const note = await seedNote();

    const response = await handlers.rederivedPOST(
      agentRequest(`http://cc/api/memory/notes/${note.slug}/rederived`, {
        method: "POST",
        body: JSON.stringify({ artifact: "context:exec-7/validate-lane" }),
      }),
      { params: Promise.resolve({ handle: note.slug }) },
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      observed: {
        memoryId: note.id,
        slug: note.slug,
        conversationId: SESSION_CONVERSATION,
        executionId: "exec-7",
        contextId: "validate-lane",
      },
    });
    expect(
      await telemetryRepo.listObservations({ kind: "validator_rederivation" }),
    ).toEqual([
      expect.objectContaining({
        kind: "validator_rederivation",
        memoryId: note.id,
        count: 1,
      }),
    ]);
  });

  it("records the round for a caller whose contribution policy is off", async () => {
    // The validator is exactly the caller a contribution refusal names (R10),
    // and its wasted rounds are exactly what R15 asks to count. Gating the
    // observation on the note-mutation policy would leave the hook unreachable
    // for its only subject.
    const note = await seedNote();
    contributionGate = {
      async decide() {
        return {
          allowed: false,
          reason: "contribution_off",
          policy: {
            role: "validator",
            read: { value: "off", source: "global" },
            contribute: { value: "off", source: "global" },
          },
        };
      },
    };

    const response = await handlers.rederivedPOST(
      agentRequest(`http://cc/api/memory/notes/${note.slug}/rederived`, {
        method: "POST",
        body: JSON.stringify({ artifact: "context:exec-7/validate-lane" }),
      }),
      { params: Promise.resolve({ handle: note.slug }) },
    );

    expect(response.status).toBe(200);
    expect(
      await telemetryRepo.listObservations({ kind: "validator_rederivation" }),
    ).toHaveLength(1);
  });

  it("refuses an unresolvable handle rather than counting an unattributed round", async () => {
    const response = await handlers.rederivedPOST(
      agentRequest("http://cc/api/memory/notes/no-such-note/rederived", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ handle: "no-such-note" }) },
    );

    expect(response.status).toBe(404);
    expect(
      await telemetryRepo.listObservations({ kind: "validator_rederivation" }),
    ).toEqual([]);
  });
});
