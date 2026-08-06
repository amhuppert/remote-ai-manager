/**
 * Library CRUD over HTTP, both scopes end to end (R10.4), the typed
 * library-change event (R10.1), and the library API's half of the
 * no-instruction-leak contract (R6.3 — the conversation-side half belongs to
 * the conversation snapshot task).
 *
 * The handlers run over a REAL storage tree in a temp config dir, so a
 * durability assertion means what it says: the publish spy reads the record
 * files off disk at the instant it is called, and the test asserts the write
 * was already there (or already gone, for a delete). A JS-object fake could
 * not tell "published after commit" from "published instead of committing".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _resetLoggerForTesting } from "@/lib/logging/logger";
import type { SSEEvent } from "@/lib/api/sse-events";

import {
  createAgentProfileRouteHandlers,
  type AgentProfileRouteDeps,
} from "./route-handlers";
import {
  createAgentProfileLibraryService,
  type AgentProfileLibraryService,
} from "./library-service";
import { createAgentProfileStorage } from "./storage";
import {
  agentProfileDeletionReportSchema,
  agentProfileLibraryChangedEventSchema,
  type AgentProfileSavedReferences,
} from "./schemas";

const ALPHA_PATH = "/repos/alpha";
const BETA_PATH = "/repos/beta";
const PROJECT_PATHS: Record<string, string> = {
  alpha: ALPHA_PATH,
  beta: BETA_PATH,
};

/** One publish observation: the event plus what was durable when it fired. */
interface PublishObservation {
  event: SSEEvent;
  /** Every stored record readable at publish time, keyed by `<id>.json`. */
  storedAtPublish: Map<string, { id: string; revision: number }>;
}

let configDir: string;
let library: AgentProfileLibraryService;
let published: PublishObservation[];
let handlers: ReturnType<typeof createAgentProfileRouteHandlers>;
let savedReferences: AgentProfileSavedReferences;

/**
 * Every profile record on disk right now, read synchronously so a publish spy
 * can observe durability at the moment it is called. Keyed by file name (the
 * record id) rather than by scope path, so the assertion does not depend on
 * storage's private directory layout.
 */
function storedRecordsNow(): Map<string, { id: string; revision: number }> {
  const root = path.join(configDir, "agent-profiles");
  const found = new Map<string, { id: string; revision: number }>();
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root, { recursive: true })) {
    const relative = String(entry);
    if (!relative.endsWith(".json")) continue;
    const raw = readFileSync(path.join(root, relative), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const record = parsed as { id: string; revision: number };
    found.set(path.basename(relative), {
      id: record.id,
      revision: record.revision,
    });
  }
  return found;
}

function buildDeps(): AgentProfileRouteDeps {
  return {
    resolveProjectPath: async (name) => PROJECT_PATHS[name] ?? null,
    library,
    publish: (event) => {
      published.push({ event, storedAtPublish: storedRecordsNow() });
      return { delivered: true };
    },
  };
}

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-agent-profile-routes-"));
  savedReferences = {
    definitions: [],
    templates: [],
    workflowDefaults: false,
  };
  library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => configDir }),
    // The workflow-side scan is composed in at the real root; here it stands in
    // so the wire shape of preview and delete is the subject, not the scan.
    referenceReporter: {
      async enumerateSavedReferences() {
        return savedReferences;
      },
    },
  });
  published = [];
  handlers = createAgentProfileRouteHandlers(buildDeps());
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// Request helpers
// ------------------------------------------------------------------

function request(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function authoring(overrides: Record<string, unknown> = {}) {
  return {
    name: "Contract Reviewer",
    description: "Reviews a change against its stated contract.",
    instructions: "Review the change exactly as written.",
    recommendedFor: ["workflow_validator" as const],
    tags: ["review"],
    ...overrides,
  };
}

/** The one profile-library event a call published, failing loudly on 0 or 2+. */
function onlyPublishedEvent(): PublishObservation {
  const observations = published.filter(
    (observation) => observation.event.type === "agent-profile-library-changed",
  );
  expect(observations).toHaveLength(1);
  const [only] = observations;
  if (only === undefined) throw new Error("no library-change event published");
  return only;
}

// ==================================================================
// R10.4 — both scopes end to end
// ==================================================================

describe("agent profile routes — global scope end to end (R10.4)", () => {
  it("creates, lists, reads, updates, and deletes a global-tier profile", async () => {
    const created = await handlers.global.create(
      request("POST", "/api/agent-profiles", authoring()),
    );
    expect(created.status).toBe(201);
    const createdBody = await body(created);
    expect(createdBody["ref"]).toEqual({
      tier: "global",
      id: "contract-reviewer",
    });
    expect(createdBody["revision"]).toBe(1);

    const listed = await handlers.global.list(
      request("GET", "/api/agent-profiles"),
    );
    expect(listed.status).toBe(200);
    const listing = await body(listed);
    const profiles = listing["profiles"] as { ref: { tier: string } }[];
    expect(profiles.filter((item) => item.ref.tier === "global")).toHaveLength(
      1,
    );
    // A global-scope listing has no project in play, so it shows exactly the
    // tiers that exist outside one.
    expect(profiles.some((item) => item.ref.tier === "project")).toBe(false);
    expect(profiles.some((item) => item.ref.tier === "builtin")).toBe(true);

    const read = await handlers.global.get(
      request("GET", "/api/agent-profiles/global/contract-reviewer"),
      ctx({ tier: "global", id: "contract-reviewer" }),
    );
    expect(read.status).toBe(200);
    const entry = await body(read);
    expect(entry["instructions"]).toBe("Review the change exactly as written.");
    expect(entry["tier"]).toBe("global");
    expect(entry["readOnly"]).toBe(false);

    const updated = await handlers.global.update(
      request("PUT", "/api/agent-profiles/global/contract-reviewer", {
        expectedRevision: 1,
        content: authoring({ instructions: "Review it against the contract." }),
      }),
      ctx({ tier: "global", id: "contract-reviewer" }),
    );
    expect(updated.status).toBe(200);
    expect((await body(updated))["revision"]).toBe(2);

    const deleted = await handlers.global.remove(
      request("DELETE", "/api/agent-profiles/global/contract-reviewer", {
        expectedRevision: 2,
        confirm: true,
      }),
      ctx({ tier: "global", id: "contract-reviewer" }),
    );
    expect(deleted.status).toBe(200);
    expect((await body(deleted))["deletedRevision"]).toBe(2);

    const gone = await handlers.global.get(
      request("GET", "/api/agent-profiles/global/contract-reviewer"),
      ctx({ tier: "global", id: "contract-reviewer" }),
    );
    expect(gone.status).toBe(404);
  });

  it("refuses the project tier, which no global-scope route can address", async () => {
    const response = await handlers.global.get(
      request("GET", "/api/agent-profiles/project/anything"),
      ctx({ tier: "project", id: "anything" }),
    );
    expect(response.status).toBe(400);
    expect((await body(response))["code"]).toBe(
      "agent_profile_project_scope_required",
    );
  });

  it("refuses to mutate a builtin through the wire, on the service's tier rule", async () => {
    const response = await handlers.global.update(
      request("PUT", "/api/agent-profiles/builtin/general-reviewer", {
        expectedRevision: 1,
        content: authoring(),
      }),
      ctx({ tier: "builtin", id: "general-reviewer" }),
    );
    expect(response.status).toBe(403);
    expect((await body(response))["code"]).toBe("agent_profile_tier_read_only");
    expect(published).toHaveLength(0);
  });
});

describe("agent profile routes — project scope end to end (R10.4)", () => {
  it("creates, lists, reads, updates, and deletes a project-tier profile", async () => {
    const created = await handlers.project.create(
      request("POST", "/api/projects/alpha/agent-profiles", authoring()),
      ctx({ name: "alpha" }),
    );
    expect(created.status).toBe(201);
    expect((await body(created))["ref"]).toEqual({
      tier: "project",
      id: "contract-reviewer",
    });

    const listed = await handlers.project.list(
      request("GET", "/api/projects/alpha/agent-profiles"),
      ctx({ name: "alpha" }),
    );
    const profiles = (await body(listed))["profiles"] as {
      ref: { tier: string; id: string };
    }[];
    expect(
      profiles.some(
        (item) =>
          item.ref.tier === "project" && item.ref.id === "contract-reviewer",
      ),
    ).toBe(true);
    expect(profiles.some((item) => item.ref.tier === "builtin")).toBe(true);

    const read = await handlers.project.get(
      request(
        "GET",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );
    expect(read.status).toBe(200);
    expect((await body(read))["instructions"]).toBe(
      "Review the change exactly as written.",
    );

    const updated = await handlers.project.update(
      request(
        "PUT",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        {
          expectedRevision: 1,
          content: authoring({
            name: "Contract Reviewer",
            tags: ["review", "v2"],
          }),
        },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );
    expect(updated.status).toBe(200);
    expect((await body(updated))["revision"]).toBe(2);

    const deleted = await handlers.project.remove(
      request(
        "DELETE",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        {
          expectedRevision: 2,
          confirm: true,
        },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );
    expect(deleted.status).toBe(200);
  });

  it("404s an unknown project before it reaches the library", async () => {
    const response = await handlers.project.list(
      request("GET", "/api/projects/nope/agent-profiles"),
      ctx({ name: "nope" }),
    );
    expect(response.status).toBe(404);
  });

  it("reaches a global-tier record through a project route and reports it as a global change", async () => {
    await library.create({
      projectPath: null,
      tier: "global",
      id: "shared-reviewer",
      ...authoring(),
    });
    published = [];

    const updated = await handlers.project.update(
      request(
        "PUT",
        "/api/projects/alpha/agent-profiles/global/shared-reviewer",
        {
          expectedRevision: 1,
          content: authoring({ description: "Edited from a project surface." }),
        },
      ),
      ctx({ name: "alpha", tier: "global", id: "shared-reviewer" }),
    );
    expect(updated.status).toBe(200);

    // The event describes the CHANGED RECORD, not the route: a global record
    // edited from one project is visible to every project, so its change must
    // invalidate every project's library queries.
    const { event } = onlyPublishedEvent();
    expect(event).toMatchObject({ scope: "global", tier: "global" });
    expect(event).not.toHaveProperty("projectPath");
  });
});

// ==================================================================
// R10.4 — schema validation, conflicts, isolation, confirmation
// ==================================================================

describe("agent profile routes — request validation (R10.4)", () => {
  it("400s a body missing a required field", async () => {
    const response = await handlers.global.create(
      request("POST", "/api/agent-profiles", { name: "No Description" }),
    );
    expect(response.status).toBe(400);
    expect(published).toHaveLength(0);
  });

  it("400s a body carrying runtime or policy keys a profile may never hold", async () => {
    const response = await handlers.global.create(
      request("POST", "/api/agent-profiles", authoring({ model: "opus" })),
    );
    expect(response.status).toBe(400);
  });

  it("400s an update whose content tries to carry an id", async () => {
    await library.create({
      projectPath: null,
      tier: "global",
      id: "contract-reviewer",
      ...authoring(),
    });
    const response = await handlers.global.update(
      request("PUT", "/api/agent-profiles/global/contract-reviewer", {
        expectedRevision: 1,
        content: authoring({ id: "renamed" }),
      }),
      ctx({ tier: "global", id: "contract-reviewer" }),
    );
    expect(response.status).toBe(400);
  });

  it("409s a create whose id is already taken in the tier", async () => {
    await library.create({
      projectPath: null,
      tier: "global",
      id: "contract-reviewer",
      ...authoring(),
    });
    published = [];

    const response = await handlers.global.create(
      request("POST", "/api/agent-profiles", authoring()),
    );
    expect(response.status).toBe(409);
    expect((await body(response))["code"]).toBe("agent_profile_id_conflict");
    expect(published).toHaveLength(0);
  });
});

describe("agent profile routes — expected-revision conflicts (R10.4)", () => {
  beforeEach(async () => {
    await library.create({
      projectPath: ALPHA_PATH,
      tier: "project",
      id: "contract-reviewer",
      ...authoring(),
    });
    await library.update({
      projectPath: ALPHA_PATH,
      ref: { tier: "project", id: "contract-reviewer" },
      expectedRevision: 1,
      content: authoring({ description: "Second revision." }),
    });
    published = [];
  });

  it("409s a stale update and names the winning revision", async () => {
    const response = await handlers.project.update(
      request(
        "PUT",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        {
          expectedRevision: 1,
          content: authoring({ description: "Losing edit." }),
        },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );

    expect(response.status).toBe(409);
    const payload = await body(response);
    expect(payload["code"]).toBe("agent_profile_revision_conflict");
    expect(payload["details"]).toMatchObject({
      expectedRevision: 1,
      winningRevision: 2,
    });
    expect(published).toHaveLength(0);
  });

  it("409s a stale delete and leaves the record intact", async () => {
    const response = await handlers.project.remove(
      request(
        "DELETE",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        {
          expectedRevision: 1,
          confirm: true,
        },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );

    expect(response.status).toBe(409);
    expect(published).toHaveLength(0);
    const survivor = await library.read(ALPHA_PATH, {
      tier: "project",
      id: "contract-reviewer",
    });
    expect(survivor.revision).toBe(2);
  });
});

describe("agent profile routes — cross-project isolation (R10.4)", () => {
  beforeEach(async () => {
    await library.create({
      projectPath: ALPHA_PATH,
      tier: "project",
      id: "alpha-only",
      ...authoring({ name: "Alpha Only" }),
    });
    published = [];
  });

  it("does not list one project's profiles through another project", async () => {
    const response = await handlers.project.list(
      request("GET", "/api/projects/beta/agent-profiles"),
      ctx({ name: "beta" }),
    );
    const profiles = (await body(response))["profiles"] as {
      ref: { id: string };
    }[];
    expect(profiles.some((item) => item.ref.id === "alpha-only")).toBe(false);
  });

  it("404s a read of another project's profile", async () => {
    const response = await handlers.project.get(
      request("GET", "/api/projects/beta/agent-profiles/project/alpha-only"),
      ctx({ name: "beta", tier: "project", id: "alpha-only" }),
    );
    expect(response.status).toBe(404);
  });

  it("refuses to mutate or delete another project's profile", async () => {
    const updated = await handlers.project.update(
      request("PUT", "/api/projects/beta/agent-profiles/project/alpha-only", {
        expectedRevision: 1,
        content: authoring({ instructions: "Hijacked." }),
      }),
      ctx({ name: "beta", tier: "project", id: "alpha-only" }),
    );
    expect(updated.status).toBe(404);

    const deleted = await handlers.project.remove(
      request(
        "DELETE",
        "/api/projects/beta/agent-profiles/project/alpha-only",
        {
          expectedRevision: 1,
          confirm: true,
        },
      ),
      ctx({ name: "beta", tier: "project", id: "alpha-only" }),
    );
    expect(deleted.status).toBe(404);

    expect(published).toHaveLength(0);
    const survivor = await library.read(ALPHA_PATH, {
      tier: "project",
      id: "alpha-only",
    });
    expect(survivor.instructions).toBe("Review the change exactly as written.");
  });
});

describe("agent profile routes — server-enforced delete confirmation (R10.4)", () => {
  beforeEach(async () => {
    await library.create({
      projectPath: null,
      tier: "global",
      id: "contract-reviewer",
      ...authoring(),
    });
    published = [];
  });

  it("refuses an unconfirmed delete without touching storage", async () => {
    const response = await handlers.global.remove(
      request("DELETE", "/api/agent-profiles/global/contract-reviewer", {
        expectedRevision: 1,
        confirm: false,
      }),
      ctx({ tier: "global", id: "contract-reviewer" }),
    );

    expect(response.status).toBe(400);
    expect((await body(response))["code"]).toBe(
      "agent_profile_deletion_not_confirmed",
    );
    expect(published).toHaveLength(0);
    await expect(
      library.read(null, { tier: "global", id: "contract-reviewer" }),
    ).resolves.toMatchObject({ revision: 1 });
  });

  it("refuses a delete that omits confirmation entirely", async () => {
    const response = await handlers.global.remove(
      request("DELETE", "/api/agent-profiles/global/contract-reviewer", {
        expectedRevision: 1,
      }),
      ctx({ tier: "global", id: "contract-reviewer" }),
    );
    expect(response.status).toBe(400);
    expect(published).toHaveLength(0);
  });
});

describe("agent profile routes — quarantine diagnostics (R10.4)", () => {
  it("reports an unreadable record in the listing instead of failing the request", async () => {
    await library.create({
      projectPath: ALPHA_PATH,
      tier: "project",
      id: "healthy",
      ...authoring({ name: "Healthy" }),
    });
    const scopeDir = path.join(
      configDir,
      "agent-profiles",
      Buffer.from(ALPHA_PATH).toString("base64url"),
    );
    await mkdir(scopeDir, { recursive: true });
    await writeFile(path.join(scopeDir, "broken.json"), "{ not json", "utf-8");

    const response = await handlers.project.list(
      request("GET", "/api/projects/alpha/agent-profiles"),
      ctx({ name: "alpha" }),
    );

    expect(response.status).toBe(200);
    const listing = await body(response);
    const profiles = listing["profiles"] as { ref: { id: string } }[];
    expect(profiles.some((item) => item.ref.id === "healthy")).toBe(true);
    const diagnostics = listing["diagnostics"] as {
      tier: string;
      id: string;
      reason: string;
    }[];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ tier: "project", id: "broken" });
    expect(diagnostics[0]?.reason).toContain("JSON");
  });
});

describe("agent profile routes — duplicate to scope (R10.4)", () => {
  it("duplicates a builtin into the project tier", async () => {
    const response = await handlers.project.duplicate(
      request("POST", "/api/projects/alpha/agent-profiles/duplicate", {
        source: { tier: "builtin", id: "general-reviewer" },
        targetId: "house-reviewer",
      }),
      ctx({ name: "alpha" }),
    );

    expect(response.status).toBe(201);
    expect((await body(response))["ref"]).toEqual({
      tier: "project",
      id: "house-reviewer",
    });
    const copy = await library.read(ALPHA_PATH, {
      tier: "project",
      id: "house-reviewer",
    });
    expect(copy.revision).toBe(1);
    expect(copy.readOnly).toBe(false);
  });

  it("promotes a project profile into the global tier and says so on the wire", async () => {
    await library.create({
      projectPath: ALPHA_PATH,
      tier: "project",
      id: "contract-reviewer",
      ...authoring(),
    });
    published = [];

    const response = await handlers.project.duplicate(
      request("POST", "/api/projects/alpha/agent-profiles/duplicate", {
        source: { tier: "project", id: "contract-reviewer" },
        targetTier: "global",
      }),
      ctx({ name: "alpha" }),
    );

    expect(response.status).toBe(201);
    const { event } = onlyPublishedEvent();
    expect(event).toMatchObject({
      scope: "global",
      tier: "global",
      id: "contract-reviewer",
      action: "created",
    });
  });

  it("refuses a global-scope duplicate that names a project source", async () => {
    const response = await handlers.global.duplicate(
      request("POST", "/api/agent-profiles/duplicate", {
        source: { tier: "project", id: "contract-reviewer" },
      }),
    );
    expect(response.status).toBe(400);
    expect((await body(response))["code"]).toBe(
      "agent_profile_project_scope_required",
    );
  });

  it("404s a duplicate whose source does not resolve", async () => {
    const response = await handlers.project.duplicate(
      request("POST", "/api/projects/alpha/agent-profiles/duplicate", {
        source: { tier: "global", id: "missing" },
      }),
      ctx({ name: "alpha" }),
    );
    expect(response.status).toBe(404);
    expect(published).toHaveLength(0);
  });
});

// ==================================================================
// R10.1 — the typed library-change event
// ==================================================================

describe("agent profile routes — typed library-change event (R10.1)", () => {
  it("publishes a schema-valid created event only after the write is durable", async () => {
    await handlers.project.create(
      request("POST", "/api/projects/alpha/agent-profiles", authoring()),
      ctx({ name: "alpha" }),
    );

    const observation = onlyPublishedEvent();
    const parsed = agentProfileLibraryChangedEventSchema.parse(
      observation.event,
    );
    expect(parsed).toEqual({
      type: "agent-profile-library-changed",
      scope: "project",
      projectPath: ALPHA_PATH,
      tier: "project",
      id: "contract-reviewer",
      revision: 1,
      action: "created",
    });
    // The record was already on disk when the event fired — a subscriber that
    // refetches on this event cannot read a state older than the event.
    expect(observation.storedAtPublish.get("contract-reviewer.json")).toEqual({
      id: "contract-reviewer",
      revision: 1,
    });
  });

  it("publishes an updated event carrying the committed revision", async () => {
    await library.create({
      projectPath: ALPHA_PATH,
      tier: "project",
      id: "contract-reviewer",
      ...authoring(),
    });
    published = [];

    await handlers.project.update(
      request(
        "PUT",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        {
          expectedRevision: 1,
          content: authoring({ description: "Revised." }),
        },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );

    const observation = onlyPublishedEvent();
    expect(observation.event).toMatchObject({ action: "updated", revision: 2 });
    expect(observation.storedAtPublish.get("contract-reviewer.json")).toEqual({
      id: "contract-reviewer",
      revision: 2,
    });
  });

  it("publishes a deleted event only after the record is gone from disk", async () => {
    await library.create({
      projectPath: ALPHA_PATH,
      tier: "project",
      id: "contract-reviewer",
      ...authoring(),
    });
    published = [];

    await handlers.project.remove(
      request(
        "DELETE",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        {
          expectedRevision: 1,
          confirm: true,
        },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );

    const observation = onlyPublishedEvent();
    expect(observation.event).toMatchObject({
      action: "deleted",
      revision: 1,
      scope: "project",
      projectPath: ALPHA_PATH,
    });
    expect(observation.storedAtPublish.has("contract-reviewer.json")).toBe(
      false,
    );
  });

  it("still answers the request when publication fails", async () => {
    handlers = createAgentProfileRouteHandlers({
      ...buildDeps(),
      publish: () => {
        throw new Error("wire is down");
      },
    });

    const response = await handlers.global.create(
      request("POST", "/api/agent-profiles", authoring()),
    );

    expect(response.status).toBe(201);
    await expect(
      library.read(null, { tier: "global", id: "contract-reviewer" }),
    ).resolves.toMatchObject({ revision: 1 });
  });
});

// ==================================================================
// R6.3 — the library API never leaks instruction text (T7's half)
// ==================================================================

const SENTINEL = "ZQ7-library-secret-sentinel-4K2";

describe("agent profile routes — no instruction text outside the authorized get (R6.3)", () => {
  let logFile: string;

  beforeEach(() => {
    logFile = path.join(configDir, "capture.log");
    _resetLoggerForTesting();
    delete process.env["CC_LOG_SILENT"];
    process.env["CC_LOG_FILE"] = logFile;
    process.env["CC_LOG_LEVEL"] = "debug";
  });

  afterEach(() => {
    rmSync(logFile, { force: true });
    _resetLoggerForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_LEVEL"];
  });

  it("keeps a secret sentinel out of every response, event, and log line but the authorized get", async () => {
    const secret = authoring({
      instructions: `Follow the house rules. ${SENTINEL}`,
    });

    const created = await handlers.project.create(
      request("POST", "/api/projects/alpha/agent-profiles", secret),
      ctx({ name: "alpha" }),
    );
    expect(created.status).toBe(201);
    const createdText = await created.clone().text();

    const listed = await handlers.project.list(
      request("GET", "/api/projects/alpha/agent-profiles"),
      ctx({ name: "alpha" }),
    );
    const listedText = await listed.clone().text();

    const duplicated = await handlers.project.duplicate(
      request("POST", "/api/projects/alpha/agent-profiles/duplicate", {
        source: { tier: "project", id: "contract-reviewer" },
        targetTier: "global",
      }),
      ctx({ name: "alpha" }),
    );
    const duplicatedText = await duplicated.clone().text();

    const updated = await handlers.project.update(
      request(
        "PUT",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        {
          expectedRevision: 1,
          content: authoring({ instructions: `Still secret. ${SENTINEL}` }),
        },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );
    const updatedText = await updated.clone().text();

    const removed = await handlers.project.remove(
      request(
        "DELETE",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        {
          expectedRevision: 2,
          confirm: true,
        },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );
    const removedText = await removed.clone().text();

    for (const [label, text] of [
      ["create", createdText],
      ["list", listedText],
      ["duplicate", duplicatedText],
      ["update", updatedText],
      ["delete", removedText],
    ] as const) {
      expect(text, `${label} response leaked instruction text`).not.toContain(
        SENTINEL,
      );
    }

    // Every mutation event on the wire, too.
    expect(JSON.stringify(published.map((o) => o.event))).not.toContain(
      SENTINEL,
    );

    // The redacted identity IS present — the rule removes the text, not the
    // provenance a picker and an auditor need.
    const listing = JSON.parse(listedText) as {
      profiles: {
        ref: { tier: string; id: string };
        name: string;
        revision: number;
      }[];
    };
    const item = listing.profiles.find(
      (profile) =>
        profile.ref.tier === "project" &&
        profile.ref.id === "contract-reviewer",
    );
    expect(item).toMatchObject({
      ref: { tier: "project", id: "contract-reviewer" },
      name: "Contract Reviewer",
      revision: 1,
    });

    // Structured logs carry ids and revisions, never instructions.
    const logs = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    expect(logs).not.toContain(SENTINEL);
    expect(logs).toContain("contract-reviewer");
  });

  it("serves the instructions through the authorized get, which is the one place they belong", async () => {
    await handlers.global.create(
      request(
        "POST",
        "/api/agent-profiles",
        authoring({ instructions: `Follow the house rules. ${SENTINEL}` }),
      ),
    );

    const read = await handlers.global.get(
      request("GET", "/api/agent-profiles/global/contract-reviewer"),
      ctx({ tier: "global", id: "contract-reviewer" }),
    );

    expect(await read.text()).toContain(SENTINEL);
  });
});

// ==================================================================
// R15.1 — the read-only deletion preview over the wire
// ==================================================================

describe("agent profile routes — deletion preview (R15.1)", () => {
  const HOLDERS: AgentProfileSavedReferences = {
    definitions: [
      {
        scope: { kind: "project", projectPath: ALPHA_PATH },
        id: "wf-1",
        name: "Alpha Delivery",
        contextId: "context-implement",
        dormant: true,
      },
    ],
    templates: [
      {
        scope: { kind: "global" },
        id: "tpl-1",
        name: "Shared Template",
        dormant: false,
      },
    ],
    workflowDefaults: true,
  };

  it("answers a GET with the report shape a delete would return, having changed nothing", async () => {
    await handlers.project.create(
      request("POST", "/api/projects/alpha/agent-profiles", authoring()),
      ctx({ name: "alpha" }),
    );
    savedReferences = HOLDERS;
    published = [];

    const preview = await handlers.project.deletionPreview(
      request(
        "GET",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer/deletion-preview",
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );

    expect(preview.status).toBe(200);
    // Parsed through the shared strict schema: preview and delete answer with
    // the same contract, or this fails.
    const report = agentProfileDeletionReportSchema.parse(await preview.json());
    expect(report).toEqual({
      ref: { tier: "project", id: "contract-reviewer" },
      deletedRevision: 1,
      conversationSnapshotsExempt: true,
      savedReferenceEnumeration: HOLDERS,
    });

    // A read: nothing was deleted and nothing was announced.
    expect(published).toHaveLength(0);
    const stillThere = await handlers.project.get(
      request(
        "GET",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );
    expect(stillThere.status).toBe(200);
  });

  it("answers 404 for a reference that does not resolve and 403 for the read-only tier", async () => {
    const missing = await handlers.project.deletionPreview(
      request(
        "GET",
        "/api/projects/alpha/agent-profiles/project/nope/deletion-preview",
      ),
      ctx({ name: "alpha", tier: "project", id: "nope" }),
    );
    expect(missing.status).toBe(404);

    const builtin = await handlers.project.deletionPreview(
      request(
        "GET",
        "/api/projects/alpha/agent-profiles/builtin/general-reviewer/deletion-preview",
      ),
      ctx({ name: "alpha", tier: "builtin", id: "general-reviewer" }),
    );
    expect(builtin.status).toBe(403);
  });

  it("carries the same enumeration into the delete that the preview showed", async () => {
    await handlers.project.create(
      request("POST", "/api/projects/alpha/agent-profiles", authoring()),
      ctx({ name: "alpha" }),
    );
    savedReferences = HOLDERS;

    const deleted = await handlers.project.remove(
      request(
        "DELETE",
        "/api/projects/alpha/agent-profiles/project/contract-reviewer",
        { expectedRevision: 1, confirm: true },
      ),
      ctx({ name: "alpha", tier: "project", id: "contract-reviewer" }),
    );

    expect(deleted.status).toBe(200);
    const report = agentProfileDeletionReportSchema.parse(await deleted.json());
    expect(report.savedReferenceEnumeration).toEqual(HOLDERS);
  });
});
