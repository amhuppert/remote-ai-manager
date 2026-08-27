import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishFn } from "@/lib/events/publication";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";

import {
  createNotepadContentStore,
  type NotepadContentStore,
} from "./content-store";
import {
  createNotepadsRouteHandlers,
  NOTEPAD_CALLER_CONVERSATION_HEADER,
  type NotepadsRouteHandlers,
  type RouteContext,
} from "./route-handlers";
import type { Notepad, NotepadListItem, NotepadRevision } from "./schemas";
import { createNotepadService } from "./service";

const TOKEN = "notepad-route-test-token";
const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT_NAME = "other-repo";
const OTHER_PROJECT_PATH = "/repos/other-repo";

const PROJECTS: Record<string, string> = {
  [PROJECT_NAME]: PROJECT_PATH,
  [OTHER_PROJECT_NAME]: OTHER_PROJECT_PATH,
};

let fixture: PersistenceFixture;
let repo: NotepadsRepo;
let contentStore: NotepadContentStore;
let contentBase: string;
let handlers: NotepadsRouteHandlers;
let published: SSEEvent[];

const publish: PublishFn = (event) => {
  published.push(event);
  return { delivered: true };
};

/**
 * Stands in only for the token FILE the real auth reads; every other layer
 * under test is production code against the real database.
 */
const auth: AgentAuth = {
  async requireToken() {
    return null;
  },
  async validateOptionalToken(request) {
    const header = request.headers.get("authorization");
    if (header === null) return { kind: "absent" };
    return header === `Bearer ${TOKEN}`
      ? { kind: "valid" }
      : { kind: "invalid" };
  },
};

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedProject(OTHER_PROJECT_PATH);
  repo = createNotepadsRepo(fixture.db, createWriteQueue());
  contentBase = mkdtempSync(path.join(tmpdir(), "cc-notepad-routes-"));
  contentStore = createNotepadContentStore({
    contentRoot: path.join(contentBase, "notepad-content"),
    listNotepadIdsForProject: (projectPath) => repo.listNotepadIds(projectPath),
  });
  published = [];
  let clock = 0;
  let idSeq = 0;
  const service = createNotepadService({
    repo,
    publish,
    deleteNotepadContent: (notepadId) => contentStore.deleteNotepad(notepadId),
    now: () => {
      clock += 1000;
      return new Date(Date.UTC(2026, 7, 27, 9, 0, 0) + clock).toISOString();
    },
    generateId: () => {
      idSeq += 1;
      return `generated-${idSeq}`;
    },
  });
  handlers = createNotepadsRouteHandlers({
    getService: () => service,
    resolveProjectPath: async (projectName) => PROJECTS[projectName] ?? null,
    auth,
  });
});

afterEach(() => {
  fixture.close();
  rmSync(contentBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function ctx(params: Record<string, string>): RouteContext {
  return { params: Promise.resolve(params) };
}

function browserRequest(url: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${url}`, init);
}

function agentRequest(
  url: string,
  init: RequestInit = {},
  conversationId = "conv-agent",
): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  headers.set(NOTEPAD_CALLER_CONVERSATION_HEADER, conversationId);
  return new Request(`http://localhost${url}`, { ...init, headers });
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function notepadOf(response: Response): Promise<Notepad> {
  const body = await bodyOf(response);
  return body["notepad"] as Notepad;
}

async function listOf(response: Response): Promise<NotepadListItem[]> {
  const body = await bodyOf(response);
  return body["notepads"] as NotepadListItem[];
}

async function createNotepad(
  body: Record<string, unknown>,
  request = browserRequest("/api/notepads", jsonInit("POST", body)),
): Promise<Notepad> {
  const response = await handlers.createPOST(request);
  expect(response.status).toBe(201);
  return notepadOf(response);
}

async function createGlobal(name: string, content = ""): Promise<Notepad> {
  return createNotepad({ scope: "global", name, content });
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("notepad listing", () => {
  it("lists global notepads and merges a project's notepads when asked", async () => {
    await createGlobal("global-pad");
    await createNotepad({
      scope: "project",
      project: PROJECT_NAME,
      name: "project-pad",
    });
    await createNotepad({
      scope: "project",
      project: OTHER_PROJECT_NAME,
      name: "other-pad",
    });

    const globalOnly = await listOf(
      await handlers.listGET(browserRequest("/api/notepads?scope=global")),
    );
    expect(globalOnly.map((item) => item.name)).toEqual(["global-pad"]);

    const unfiltered = await listOf(
      await handlers.listGET(browserRequest("/api/notepads?sort=name")),
    );
    expect(unfiltered.map((item) => item.name)).toEqual([
      "global-pad",
      "other-pad",
      "project-pad",
    ]);

    const merged = await listOf(
      await handlers.listGET(
        browserRequest(`/api/notepads?project=${PROJECT_NAME}`),
      ),
    );
    expect(merged.map((item) => item.name).sort()).toEqual([
      "global-pad",
      "project-pad",
    ]);

    const projectOnly = await listOf(
      await handlers.listGET(
        browserRequest(`/api/notepads?project=${PROJECT_NAME}&scope=project`),
      ),
    );
    expect(projectOnly.map((item) => item.name)).toEqual(["project-pad"]);
  });

  it("404s a project filter that names no known project", async () => {
    const response = await handlers.listGET(
      browserRequest("/api/notepads?project=ghost-repo"),
    );
    expect(response.status).toBe(404);
  });

  it("orders by name or recency and hides archived notepads by default", async () => {
    const beta = await createGlobal("beta");
    await createGlobal("alpha");
    const archived = await createGlobal("zulu");
    await handlers.detailPATCH(
      browserRequest(
        `/api/notepads/${archived.id}`,
        jsonInit("PATCH", { archived: true }),
      ),
      ctx({ notepadId: archived.id }),
    );
    // Re-touching beta makes recency order differ from creation order.
    await handlers.contentPOST(
      browserRequest(
        `/api/notepads/${beta.id}/content`,
        jsonInit("POST", { operation: "update", content: "touched" }),
      ),
      ctx({ notepadId: beta.id }),
    );

    const byName = await listOf(
      await handlers.listGET(browserRequest("/api/notepads?sort=name")),
    );
    expect(byName.map((item) => item.name)).toEqual(["alpha", "beta"]);

    const byRecency = await listOf(
      await handlers.listGET(browserRequest("/api/notepads?sort=recency")),
    );
    expect(byRecency.map((item) => item.name)).toEqual(["beta", "alpha"]);

    const withArchived = await listOf(
      await handlers.listGET(
        browserRequest("/api/notepads?sort=name&archived=true"),
      ),
    );
    expect(withArchived.map((item) => item.name)).toEqual([
      "alpha",
      "beta",
      "zulu",
    ]);
  });

  it("refuses a malformed sort with a validation error", async () => {
    const response = await handlers.listGET(
      browserRequest("/api/notepads?sort=sideways"),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response))["code"]).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

describe("notepad creation", () => {
  it("creates a global notepad that reloads from the database", async () => {
    const created = await createGlobal("plan", "# Plan\n");

    const reloaded = await repo.find(created.id);
    expect(reloaded).toMatchObject({
      name: "plan",
      scope: "global",
      projectPath: null,
      content: "# Plan\n",
      writeMode: "full-edit",
      revision: 1,
    });
  });

  it("resolves the named project for a project-scoped create", async () => {
    const created = await createNotepad({
      scope: "project",
      project: PROJECT_NAME,
      name: "scoped",
    });
    expect(created.projectPath).toBe(PROJECT_PATH);
  });

  it("404s a project-scoped create naming no known project", async () => {
    const response = await handlers.createPOST(
      browserRequest(
        "/api/notepads",
        jsonInit("POST", {
          scope: "project",
          project: "ghost-repo",
          name: "scoped",
        }),
      ),
    );
    expect(response.status).toBe(404);
  });

  it("refuses a duplicate name in the same scope and allows it in another", async () => {
    await createGlobal("shared-name");

    const conflict = await handlers.createPOST(
      browserRequest(
        "/api/notepads",
        jsonInit("POST", { scope: "global", name: "shared-name" }),
      ),
    );
    expect(conflict.status).toBe(409);
    const body = await bodyOf(conflict);
    expect(body["code"]).toBe("name_taken");
    expect(body["error"]).toContain("shared-name");

    const elsewhere = await createNotepad({
      scope: "project",
      project: PROJECT_NAME,
      name: "shared-name",
    });
    expect(elsewhere.scope).toBe("project");
  });

  it("refuses a body that is not a JSON object", async () => {
    const response = await handlers.createPOST(
      browserRequest("/api/notepads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Detail, organization, deletion
// ---------------------------------------------------------------------------

describe("notepad detail, organization, and deletion", () => {
  it("returns the notepad with its content", async () => {
    const created = await createGlobal("readme", "body text");
    const response = await handlers.detailGET(
      browserRequest(`/api/notepads/${created.id}`),
      ctx({ notepadId: created.id }),
    );
    expect(response.status).toBe(200);
    expect(await notepadOf(response)).toMatchObject({
      id: created.id,
      content: "body text",
    });
  });

  it("404s an unknown id and names it", async () => {
    const response = await handlers.detailGET(
      browserRequest("/api/notepads/missing-id"),
      ctx({ notepadId: "missing-id" }),
    );
    expect(response.status).toBe(404);
    const body = await bodyOf(response);
    expect(body["code"]).toBe("not_found");
    expect(body["error"]).toContain("missing-id");
    expect(body["instruction"]).toBeTruthy();
  });

  it("renames, pins, archives, and sets the write mode", async () => {
    const created = await createGlobal("draft");

    const renamed = await handlers.detailPATCH(
      browserRequest(
        `/api/notepads/${created.id}`,
        jsonInit("PATCH", {
          name: "final",
          pinned: true,
          writeMode: "append-only",
        }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(renamed.status).toBe(200);

    expect(await repo.find(created.id)).toMatchObject({
      name: "final",
      pinned: true,
      archived: false,
      writeMode: "append-only",
    });

    await handlers.detailPATCH(
      browserRequest(
        `/api/notepads/${created.id}`,
        jsonInit("PATCH", { archived: true }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(await repo.find(created.id)).toMatchObject({ archived: true });
  });

  it("sorts pinned notepads ahead of unpinned ones", async () => {
    await createGlobal("alpha");
    const zulu = await createGlobal("zulu");
    await handlers.detailPATCH(
      browserRequest(
        `/api/notepads/${zulu.id}`,
        jsonInit("PATCH", { pinned: true }),
      ),
      ctx({ notepadId: zulu.id }),
    );

    const listed = await listOf(
      await handlers.listGET(browserRequest("/api/notepads?sort=name")),
    );
    expect(listed.map((item) => item.name)).toEqual(["zulu", "alpha"]);
  });

  it("refuses an agent-attributed write-mode change with a 403 naming the mode", async () => {
    const created = await createGlobal("guarded");

    const response = await handlers.detailPATCH(
      agentRequest(
        `/api/notepads/${created.id}`,
        jsonInit("PATCH", { writeMode: "read-only" }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(response.status).toBe(403);
    const body = await bodyOf(response);
    expect(body["code"]).toBe("write_mode_refused");
    expect(body["error"]).toContain("full-edit");
    expect(body["rationale"]).toBeTruthy();
    expect(body["instruction"]).toBeTruthy();
    expect(await repo.find(created.id)).toMatchObject({
      writeMode: "full-edit",
    });
  });

  it("deletes a notepad so its next read 404s", async () => {
    const created = await createGlobal("temporary");

    const deleted = await handlers.detailDELETE(
      browserRequest(`/api/notepads/${created.id}`, { method: "DELETE" }),
      ctx({ notepadId: created.id }),
    );
    expect(deleted.status).toBe(200);
    expect(await repo.find(created.id)).toBeNull();

    const missing = await handlers.detailGET(
      browserRequest(`/api/notepads/${created.id}`),
      ctx({ notepadId: created.id }),
    );
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Content writes
// ---------------------------------------------------------------------------

describe("notepad content writes", () => {
  it("updates and appends through the one content route", async () => {
    const created = await createGlobal("notes", "first");

    const updated = await handlers.contentPOST(
      browserRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", { operation: "update", content: "second" }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(updated.status).toBe(200);
    expect(await notepadOf(updated)).toMatchObject({
      content: "second",
      revision: 2,
    });

    const appended = await handlers.contentPOST(
      agentRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", {
          operation: "append",
          content: "third",
          baseRevision: 2,
        }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(appended.status).toBe(200);
    expect((await repo.find(created.id))?.content).toBe("second\n\nthird");
  });

  it("refuses a stale agent write with a 409 carrying the current revision", async () => {
    const created = await createGlobal("contended", "v1");
    await handlers.contentPOST(
      browserRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", { operation: "update", content: "v2" }),
      ),
      ctx({ notepadId: created.id }),
    );

    const stale = await handlers.contentPOST(
      agentRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", {
          operation: "update",
          content: "agent text",
          baseRevision: 1,
        }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(stale.status).toBe(409);
    const body = await bodyOf(stale);
    expect(body["code"]).toBe("stale_revision");
    expect(body["details"]).toMatchObject({ currentRevision: 2 });

    const retried = await handlers.contentPOST(
      agentRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", {
          operation: "update",
          content: "agent text",
          baseRevision: 2,
        }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(retried.status).toBe(200);
    expect((await repo.find(created.id))?.content).toBe("agent text");
  });

  it("refuses an agent update on a read-only notepad with a 403 naming the mode", async () => {
    const created = await createNotepad({
      scope: "global",
      name: "locked",
      writeMode: "read-only",
    });

    const refused = await handlers.contentPOST(
      agentRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", {
          operation: "update",
          content: "agent text",
          baseRevision: 1,
        }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(refused.status).toBe(403);
    const body = await bodyOf(refused);
    expect(body["code"]).toBe("write_mode_refused");
    expect(body["error"]).toContain("read-only");
    expect(body["details"]).toMatchObject({ writeMode: "read-only" });
  });

  it("refuses an agent write that states no base revision", async () => {
    const created = await createGlobal("cas");

    const response = await handlers.contentPOST(
      agentRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", { operation: "update", content: "agent text" }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response))["code"]).toBe("validation_failed");
  });

  it("refuses a body that claims its own author", async () => {
    const created = await createGlobal("attribution");

    const response = await handlers.contentPOST(
      browserRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", {
          operation: "update",
          content: "text",
          author: { kind: "agent", conversationId: "spoofed" },
        }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Revisions and restore
// ---------------------------------------------------------------------------

describe("notepad revisions and restore", () => {
  async function revisionsOf(
    notepadId: string,
    query = "",
  ): Promise<NotepadRevision[]> {
    const response = await handlers.revisionsGET(
      browserRequest(`/api/notepads/${notepadId}/revisions${query}`),
      ctx({ notepadId }),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    return body["revisions"] as NotepadRevision[];
  }

  it("lists revisions in order and bounds to the most recent", async () => {
    const created = await createGlobal("history", "v1");
    for (const content of ["v2", "v3"]) {
      await handlers.contentPOST(
        browserRequest(
          `/api/notepads/${created.id}/content`,
          jsonInit("POST", { operation: "update", content }),
        ),
        ctx({ notepadId: created.id }),
      );
    }

    const all = await revisionsOf(created.id);
    expect(all.map((revision) => revision.revision)).toEqual([1, 2, 3]);

    const bounded = await revisionsOf(created.id, "?limit=2");
    expect(bounded.map((revision) => revision.revision)).toEqual([2, 3]);
  });

  it("resolves one revision and its immediate predecessor by id via ?at", async () => {
    const created = await createGlobal("deep history", "r1");
    for (let revision = 2; revision <= 60; revision += 1) {
      await handlers.contentPOST(
        browserRequest(
          `/api/notepads/${created.id}/content`,
          jsonInit("POST", { operation: "update", content: `r${revision}` }),
        ),
        ctx({ notepadId: created.id }),
      );
    }

    // r5 is far outside the default newest-first window; the resolution must
    // not depend on any listed page.
    const resolved = await revisionsOf(created.id, "?at=5");
    expect(
      resolved.map((revision) => [revision.revision, revision.content]),
    ).toEqual([
      [4, "r4"],
      [5, "r5"],
    ]);

    // The create revision genuinely has no predecessor and resolves alone.
    const create = await revisionsOf(created.id, "?at=1");
    expect(create.map((revision) => revision.revision)).toEqual([1]);
  });

  it("404s an ?at revision that does not exist", async () => {
    const created = await createGlobal("shallow history");
    const response = await handlers.revisionsGET(
      browserRequest(`/api/notepads/${created.id}/revisions?at=9`),
      ctx({ notepadId: created.id }),
    );
    expect(response.status).toBe(404);
    expect((await bodyOf(response))["code"]).toBe("not_found");
  });

  it("refuses a malformed limit", async () => {
    const created = await createGlobal("history");
    const response = await handlers.revisionsGET(
      browserRequest(`/api/notepads/${created.id}/revisions?limit=lots`),
      ctx({ notepadId: created.id }),
    );
    expect(response.status).toBe(400);
  });

  it("restores a prior revision as a new head, leaving history intact", async () => {
    const created = await createGlobal("restorable", "original");
    await handlers.contentPOST(
      browserRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", { operation: "update", content: "replaced" }),
      ),
      ctx({ notepadId: created.id }),
    );

    const restored = await handlers.restorePOST(
      browserRequest(
        `/api/notepads/${created.id}/restore`,
        jsonInit("POST", { revision: 1 }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(restored.status).toBe(200);
    expect(await notepadOf(restored)).toMatchObject({
      content: "original",
      revision: 3,
    });

    const history = await revisionsOf(created.id);
    expect(history.map((revision) => revision.content)).toEqual([
      "original",
      "replaced",
      "original",
    ]);
    expect(history.at(-1)).toMatchObject({
      revision: 3,
      origin: "restore",
      restoredFromRevision: 1,
    });
  });

  it("404s a restore of a revision that does not exist", async () => {
    const created = await createGlobal("restorable");
    const response = await handlers.restorePOST(
      browserRequest(
        `/api/notepads/${created.id}/restore`,
        jsonInit("POST", { revision: 9 }),
      ),
      ctx({ notepadId: created.id }),
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Author keying
// ---------------------------------------------------------------------------

describe("notepad author keying", () => {
  it("records a token-and-conversation request as that agent conversation", async () => {
    const created = await createGlobal("attributed", "v1");

    await handlers.contentPOST(
      agentRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", {
          operation: "update",
          content: "agent text",
          baseRevision: 1,
        }),
        "conv-writer",
      ),
      ctx({ notepadId: created.id }),
    );

    const [head] = await repo.listRevisions(created.id, 1);
    expect(head).toMatchObject({
      authorKind: "agent",
      authorConversationId: "conv-writer",
    });
  });

  it("records a browser request as the user", async () => {
    const created = await createGlobal("attributed", "v1");

    await handlers.contentPOST(
      browserRequest(
        `/api/notepads/${created.id}/content`,
        jsonInit("POST", { operation: "update", content: "user text" }),
      ),
      ctx({ notepadId: created.id }),
    );

    const [head] = await repo.listRevisions(created.id, 1);
    expect(head).toMatchObject({
      authorKind: "user",
      authorConversationId: null,
    });
  });

  it("records a create through the agent surface as that conversation", async () => {
    const created = await createNotepad(
      { scope: "global", name: "agent-made" },
      agentRequest(
        "/api/notepads",
        jsonInit("POST", { scope: "global", name: "agent-made" }),
        "conv-creator",
      ),
    );

    const [first] = await repo.listRevisions(created.id, 1);
    expect(first).toMatchObject({
      authorKind: "agent",
      authorConversationId: "conv-creator",
      origin: "create",
    });
  });

  it("treats a tokened request without a caller conversation as the user", async () => {
    const created = await createGlobal("unattributed", "v1");

    const response = await handlers.contentPOST(
      browserRequest(`/api/notepads/${created.id}/content`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ operation: "update", content: "text" }),
      }),
      ctx({ notepadId: created.id }),
    );
    expect(response.status).toBe(200);

    const [head] = await repo.listRevisions(created.id, 1);
    expect(head).toMatchObject({ authorKind: "user" });
  });
});

// ---------------------------------------------------------------------------
// Token gate
// ---------------------------------------------------------------------------

describe("notepad route token gate", () => {
  it("401s a malformed bearer token on every handler", async () => {
    const created = await createGlobal("gated");
    const badInit: RequestInit = {
      headers: { authorization: "Bearer wrong-token" },
    };

    const responses = await Promise.all([
      handlers.listGET(browserRequest("/api/notepads", badInit)),
      handlers.createPOST(browserRequest("/api/notepads", badInit)),
      handlers.detailGET(
        browserRequest(`/api/notepads/${created.id}`, badInit),
        ctx({ notepadId: created.id }),
      ),
      handlers.detailPATCH(
        browserRequest(`/api/notepads/${created.id}`, badInit),
        ctx({ notepadId: created.id }),
      ),
      handlers.detailDELETE(
        browserRequest(`/api/notepads/${created.id}`, badInit),
        ctx({ notepadId: created.id }),
      ),
      handlers.contentPOST(
        browserRequest(`/api/notepads/${created.id}/content`, badInit),
        ctx({ notepadId: created.id }),
      ),
      handlers.revisionsGET(
        browserRequest(`/api/notepads/${created.id}/revisions`, badInit),
        ctx({ notepadId: created.id }),
      ),
      handlers.restorePOST(
        browserRequest(`/api/notepads/${created.id}/restore`, badInit),
        ctx({ notepadId: created.id }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 401, 401, 401, 401,
    ]);
    expect(await repo.find(created.id)).not.toBeNull();
  });
});
