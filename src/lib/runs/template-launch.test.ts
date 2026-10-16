import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkProfileResolves,
  createAgentProfileLibraryService,
} from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import type { SSEEvent } from "@/lib/api/sse-events";
import { resolveConversationProfileSnapshot } from "@/lib/conversations/profile-resolution";
import {
  createConversationProvenanceReader,
  isEligibleSubscriptionRecipient,
} from "@/lib/conversations/provenance";
import { createConversationService } from "@/lib/conversations/service";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createRunTemplateService,
  type RunTemplateService,
} from "@/lib/run-templates/service";
import { createRunTemplateStorage } from "@/lib/run-templates/storage";
import {
  createSessionLifecycleGate,
  type SessionLifecycleGate,
} from "@/lib/sessions/lifecycle-gate";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { createProjectConversationsRepo } from "@/lib/state-store/project-conversations-repo";
import { createRunsRepo } from "@/lib/state-store/runs-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import type { Supervision } from "@/lib/supervision/supervision";
import {
  createSupervisionHarness,
  quiesce,
} from "@/lib/supervision/testing/supervision-fixture";
import { createRunRouteHandlers, type RunRouteDeps } from "./route-handlers";
import { createSeatResolver } from "./seats";

const PROJECT = "/repo";

let fixture: PersistenceFixture;
let supervision: Supervision;
let routes: ReturnType<typeof createRunRouteHandlers>;
let configDir: string;
let templates: RunTemplateService;
let lifecycle: SessionLifecycleGate;
/** Sessions a merge is delivering, by the merge job's id. */
let finalizing: Map<string, string>;
let published: SSEEvent[];
let logged: Array<{
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}>;
/** When set, preparing a new owner, or creating it, waits on it. */
let holdOwnerPreparation: (() => Promise<void>) | null;
let holdOwnerCreation: (() => Promise<void>) | null;
/** Every owner a launch created, whether or not it was kept. */
let ownersCreated: string[];
/** When set, the launch's placement (its last preparation step) waits on it. */
let holdPlacement: (() => Promise<void>) | null;
/** When set, the next session read runs it first, once: what happens just before the last admission. */
let beforeNextSessionRead: (() => Promise<void>) | null;
let conversations: ReturnType<typeof createConversationService>;
let h: ReturnType<typeof createSupervisionHarness>;
/** This project's registered validation commands. */
let registered: string[];

/** A hold the test releases, and a promise that settles once something waits on it. */
function hold(): {
  wait: () => Promise<void>;
  reached: Promise<void>;
  release: () => void;
} {
  let release = () => {};
  let reach = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return {
    wait: async () => {
      reach();
      await released;
    },
    reached,
    release,
  };
}

function template(overrides: Record<string, unknown> = {}) {
  return {
    name: "Fix a ticket",
    description: "Fixes one ticket",
    parameters: [{ name: "ticket", description: "Ticket", required: true }],
    defaults: {},
    workflow: { contexts: [{ key: "fix", brief: "Fix {{inputs.ticket}}" }] },
    ...overrides,
  };
}

async function saveTemplate(
  content: unknown,
  expectedRevision: number | null = null,
) {
  const saved = await templates.save({
    projectPath: PROJECT,
    tier: "project",
    id: "fix-ticket",
    expectedRevision,
    content,
  });
  if (!saved.ok) throw new Error(saved.refusal.message);
}

/** A person in Command Center: no agent credential. */
const person = {};
function agent(conversationId: string): Record<string, string> {
  return {
    authorization: "Bearer token",
    "x-cc-conversation-identity": JSON.stringify({
      sessionName: "session",
      conversationId,
    }),
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    template: { tier: "project", id: "fix-ticket", revision: 1 },
    parameters: { ticket: "CC-12" },
    ...overrides,
  };
}

function post(payload: unknown, headers: Record<string, string>): Request {
  return new Request(
    "http://127.0.0.1/api/projects/repo/sessions/session/runs/template",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
    },
  );
}

const params = () => ({
  params: Promise.resolve({ name: "repo", session: "session" }),
});

async function launch(payload: unknown, headers: Record<string, string>) {
  const response = await routes.launchTemplate(
    post(payload, headers),
    params(),
  );
  const json = (await response.json()) as Record<string, unknown>;
  await quiesce(supervision);
  return { response, json };
}

/** The session's conversations as stored. */
function storedConversations(sessionName = "session") {
  return createConversationsRepo(fixture.db).findBySession(
    PROJECT,
    sessionName,
  );
}

function storedRuns() {
  return createRunsRepo(fixture.db).listBySession(PROJECT, "session");
}

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "cc-template-launch-"));
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, "session");
  fixture.seedSession(PROJECT, "session-2");
  const conversation = (id: string, extra: Record<string, unknown> = {}) =>
    makeConversationState({ id, scope: "session", ...extra });
  await fixture.seedConversation(PROJECT, "session", conversation("owner-1"));
  await fixture.seedConversation(
    PROJECT,
    "session",
    conversation("archived-1", { archived: true }),
  );
  await fixture.seedConversation(
    PROJECT,
    "session",
    conversation("lane-1", { role: "iteration" }),
  );
  await fixture.seedConversation(
    PROJECT,
    "session",
    conversation("collab-1", {
      owner: { kind: "collaboration", workflowId: "w-1", attemptEpoch: 0 },
    }),
  );
  // The seat the first launched context's implementer takes.
  await fixture.seedConversation(PROJECT, "session", conversation("conv-1"));
  await fixture.seedConversation(
    PROJECT,
    "session-2",
    conversation("elsewhere-1"),
  );

  h = createSupervisionHarness(fixture);
  supervision = h.compose();
  lifecycle = createSessionLifecycleGate();
  finalizing = new Map();
  published = [];
  logged = [];
  holdOwnerPreparation = null;
  holdOwnerCreation = null;
  ownersCreated = [];
  holdPlacement = null;
  beforeNextSessionRead = null;
  registered = [];

  const profiles = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => configDir }),
  });
  // Saving checks nothing here, so a template can name a profile deleted since.
  templates = createRunTemplateService({
    storage: createRunTemplateStorage({ resolveConfigDir: () => configDir }),
    profiles: { check: async () => ({ ok: true }) },
  });
  await saveTemplate(template());

  conversations = createConversationService({
    mutateSession: fixture.store.mutateSession,
    createSessionConversation: fixture.store.createSessionConversation,
    getSession: fixture.store.getSession,
    getConversation: fixture.store.getConversation,
    getSessionConversations: fixture.store.getSessionConversations,
    setConversationPendingPromptText: async () => {},
    stopConversationActor: async () => {},
    closeBackgroundWork: (_scope, commit) => commit(),
    removeTranscript: async () => {},
  });
  const readConversation = createConversationProvenanceReader({
    conversations: createConversationsRepo(fixture.db),
    projectConversations: createProjectConversationsRepo(fixture.db),
    sessions: createSessionsRepo(fixture.db),
  });
  let sequence = 0;

  const deps: RunRouteDeps = {
    auth: {
      async requireToken() {
        return null;
      },
      async validateOptionalToken(request) {
        return request.headers.has("authorization")
          ? { kind: "valid" }
          : { kind: "absent" };
      },
    },
    async archivedProjects() {
      return new Set();
    },
    async resolveProjectPath(name) {
      return name === "repo" ? PROJECT : null;
    },
    async getSession(projectPath, sessionName) {
      const before = beforeNextSessionRead;
      beforeNextSessionRead = null;
      if (before !== null) await before();
      return fixture.store.getSession(projectPath, sessionName);
    },
    sessionLifecycle: (projectPath, sessionName, operation) =>
      lifecycle.runExclusive(projectPath, sessionName, operation),
    finalizingMerge(_projectPath, sessionName) {
      const jobId = finalizing.get(sessionName);
      return jobId === undefined ? null : { jobId };
    },
    async laneTargets({ sessionWorktreePath }) {
      return (laneId) => ({
        worktreePath: `${sessionWorktreePath}.${laneId}`,
        branch: `csm/lane-${laneId}`,
      });
    },
    async validationCommands() {
      if (holdPlacement !== null) await holdPlacement();
      return [...registered];
    },
    supervision: () => supervision,
    ownerAdmissible({ projectPath, sessionName, conversationId }) {
      const identity = readConversation(conversationId);
      return (
        identity !== null &&
        identity.sessionName === sessionName &&
        isEligibleSubscriptionRecipient(identity, projectPath)
      );
    },
    resolveSeats: createSeatResolver({
      async admitSeat(_projectPath, backend, modelSelection) {
        return {
          ok: true,
          seat: {
            backend: backend ?? "claude",
            modelSelection: modelSelection ?? {
              modelId: "sonnet",
              parameters: {},
            },
          },
        };
      },
      checkProfile: (projectPath, ref) =>
        checkProfileResolves(profiles, projectPath, ref),
    }),
    newRunId: () => {
      sequence += 1;
      return `run-${sequence}`;
    },
    templates,
    async prepareNewOwner(projectPath) {
      if (holdOwnerPreparation !== null) await holdOwnerPreparation();
      return {
        ok: true,
        owner: {
          // The configured default, which is not the built-in one.
          agentBackend: "codex",
          profileSnapshot: await resolveConversationProfileSnapshot(
            projectPath,
            null,
            { resolveProfile: (p, ref) => profiles.resolve(p, ref) },
          ),
        },
      };
    },
    async createOwner({ projectPath, sessionName, name, prepared }) {
      const created = await conversations.createConversation(
        projectPath,
        sessionName,
        {
          name,
          agentBackend: prepared.agentBackend,
          profileSnapshot: prepared.profileSnapshot,
        },
      );
      ownersCreated.push(created.id);
      if (holdOwnerCreation !== null) await holdOwnerCreation();
      return created;
    },
    removeOwner: (projectPath, sessionName, conversationId) =>
      conversations.deleteConversation(
        projectPath,
        sessionName,
        conversationId,
      ),
    publish(event) {
      published.push(event);
      return { delivered: true };
    },
    async snapshotDocuments() {
      return { ok: true, documents: [] };
    },
    async snapshotFile() {
      return { ok: false, message: "unused" };
    },
    async freezeCharter(charter) {
      return { charter, bundles: { default: "sha256:charter", byKey: {} } };
    },
    async sessionConversations() {
      return new Map();
    },
    async readText() {
      return "";
    },
    auditEvidence: {
      conversationFacts: async () => new Map(),
      deliveriesForRun: async () => [],
      wakeBatchesForDeliveries: async () => [],
      promptDispatches: async () => [],
    },
    async candidateChanges() {
      return { ok: false, reason: "unused" };
    },
    log: {
      info: (event, fields) =>
        logged.push({ level: "info", event, fields: fields ?? {} }),
      warn: (event, fields) =>
        logged.push({ level: "warn", event, fields: fields ?? {} }),
      error: (event, fields) =>
        logged.push({ level: "error", event, fields: fields ?? {} }),
    },
  };
  routes = createRunRouteHandlers(deps);
});

afterEach(async () => {
  fixture.close();
  await rm(configDir, { recursive: true, force: true });
});

const seeded = ["owner-1", "archived-1", "lane-1", "collab-1", "conv-1"].sort();
const storedIds = () =>
  storedConversations()
    .map((c) => c.id)
    .sort();

describe("template launch", () => {
  it("lets a person launch with a conversation of the session as owner; the run records it and the template as it stood", async () => {
    const { response, json } = await launch(
      body({ owner: { kind: "existing", conversationId: "owner-1" } }),
      person,
    );

    expect(response.status).toBe(202);
    expect(json).toMatchObject({
      runId: "run-1",
      ownerConversationId: "owner-1",
      contextIds: [expect.any(String)],
    });
    const [run] = storedRuns();
    expect(run).toMatchObject({
      runId: "run-1",
      ownerConversationId: "owner-1",
      origin: {
        kind: "template",
        tier: "project",
        id: "fix-ticket",
        revision: 1,
        name: "Fix a ticket",
      },
      facts: {
        title: "Fix a ticket",
        definition: {
          authored: { contexts: [{ key: "fix", brief: "Fix CC-12" }] },
        },
      },
    });
    expect(JSON.stringify(run?.facts)).not.toContain("fix-ticket");
    expect(storedIds()).toEqual(seeded);
    expect(published).toEqual([]);
    expect(logged).toContainEqual({
      level: "info",
      event: "runs.template_launched",
      fields: {
        runId: "run-1",
        templateId: "fix-ticket",
        tier: "project",
        revision: 1,
        owner: "existing",
        contexts: 1,
      },
    });
  });

  it("creates a new owner a person names: never prompted, on the configured default backend, announced once", async () => {
    const { response, json } = await launch(
      body({ owner: { kind: "new", title: "Release owner" } }),
      person,
    );

    expect(response.status).toBe(202);
    const created = storedConversations().find((c) => !seeded.includes(c.id));
    expect(created).toMatchObject({
      name: "Release owner",
      nameOrigin: "manual",
      agentBackend: "codex",
      role: null,
      status: "new",
      promptCount: 0,
    });
    expect(json).toMatchObject({ ownerConversationId: created?.id });
    expect(storedRuns()[0]?.ownerConversationId).toBe(created?.id);
    expect(published).toEqual([
      expect.objectContaining({
        type: "conversation-created",
        scope: "session",
        sessionName: "session",
        conversation: expect.objectContaining({
          id: created?.id,
          name: "Release owner",
        }),
      }),
    ]);
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "runs.template_launched",
        fields: expect.objectContaining({ owner: "new" }),
      }),
    );
  });

  it("lets an agent launch a template it owns, and refuses one that names an owner", async () => {
    const named = await launch(
      body({ owner: { kind: "existing", conversationId: "owner-1" } }),
      agent("owner-1"),
    );
    expect(named.response.status).toBe(403);
    expect(named.json).toMatchObject({ code: "owner_not_allowed" });
    expect(storedRuns()).toEqual([]);

    const owned = await launch(body(), agent("owner-1"));
    expect(owned.response.status).toBe(202);
    expect(owned.json).toMatchObject({ ownerConversationId: "owner-1" });
    expect(storedRuns()[0]?.ownerConversationId).toBe("owner-1");
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "runs.template_launched",
        fields: expect.objectContaining({ owner: "caller" }),
      }),
    );
  });

  it("keeps the refusals every agent launch has: a seat cannot launch, nor a conversation the inbox cannot wake", async () => {
    await launch(body(), agent("owner-1"));

    const fromSeat = await launch(body(), agent("conv-1"));
    expect(fromSeat.response.status).toBe(403);
    expect(fromSeat.json).toMatchObject({ code: "seat_cannot_launch" });

    const unwakeable = await launch(body(), agent("archived-1"));
    expect(unwakeable.response.status).toBe(409);
    expect(unwakeable.json).toMatchObject({ code: "owner_not_wakeable" });
    expect(storedRuns()).toHaveLength(1);
  });

  it("refuses a person who names no owner, or one that is not an ordinary, unarchived conversation of this session", async () => {
    const unnamed = await launch(body(), person);
    expect(unnamed.response.status).toBe(400);
    expect(unnamed.json).toMatchObject({ code: "owner_required" });

    for (const conversationId of [
      "archived-1",
      "lane-1",
      "collab-1",
      "elsewhere-1",
      "nobody",
    ]) {
      const refused = await launch(
        body({ owner: { kind: "existing", conversationId } }),
        person,
      );
      expect(refused.response.status, conversationId).toBe(409);
      expect(refused.json, conversationId).toMatchObject({
        code: "owner_not_eligible",
      });
    }
    expect(storedRuns()).toEqual([]);
    // Every refusal of a request that named a template logs it.
    const refusals = logged.filter(
      (entry) => entry.event === "runs.template_launch_refused",
    );
    expect(refusals).toHaveLength(6);
    for (const refusal of refusals)
      expect(refusal.fields).toMatchObject({
        templateId: "fix-ticket",
        tier: "project",
      });
    expect(refusals[0]?.fields).toMatchObject({ code: "owner_required" });
  });

  it("refuses a revision the person did not see, with the current one, and logs the refusal with its code", async () => {
    await saveTemplate(template({ name: "Fix it fast" }), 1);

    const { response, json } = await launch(
      body({ owner: { kind: "new", title: "Release owner" } }),
      person,
    );

    expect(response.status).toBe(409);
    expect(json).toMatchObject({
      code: "run_template_changed",
      details: { currentRevision: 2 },
    });
    expect(storedIds()).toEqual(seeded);
    expect(storedRuns()).toEqual([]);
    expect(logged).toContainEqual({
      level: "warn",
      event: "runs.template_launch_refused",
      fields: expect.objectContaining({
        code: "run_template_changed",
        templateId: "fix-ticket",
        tier: "project",
      }),
    });
  });

  it("locates a missing required value at its parameter, and names an unreadable template's file", async () => {
    const missing = await launch(
      body({
        owner: { kind: "existing", conversationId: "owner-1" },
        parameters: {},
      }),
      person,
    );
    expect(missing.response.status).toBe(400);
    expect(missing.json).toMatchObject({
      code: "run_template_launch_invalid",
      issues: [{ path: "parameters.ticket", message: expect.any(String) }],
    });

    const dir = path.join(
      configDir,
      "run-templates",
      Buffer.from(PROJECT).toString("base64url"),
    );
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "broken.json"), "{");
    const unreadable = await launch(
      body({
        template: { tier: "project", id: "broken" },
        owner: { kind: "existing", conversationId: "owner-1" },
      }),
      person,
    );
    expect(unreadable.response.status).toBe(404);
    expect(unreadable.json).toMatchObject({
      code: "run_template_not_found",
      error: expect.stringContaining(path.join(dir, "broken.json")),
    });
    expect(storedRuns()).toEqual([]);
  });

  it("refuses a template whose profile no longer resolves before anything is created or recorded", async () => {
    await saveTemplate(
      template({
        defaults: {
          implementer: { profile: { tier: "project", id: "deleted" } },
        },
      }),
      1,
    );

    const { response, json } = await launch(
      body({
        template: { tier: "project", id: "fix-ticket", revision: 2 },
        owner: { kind: "new", title: "Release owner" },
      }),
      person,
    );

    expect(response.status).toBe(400);
    expect(json).toMatchObject({
      code: "agent_profile_not_resolvable",
      context: "fix",
    });
    expect(storedIds()).toEqual(seeded);
    expect(storedRuns()).toEqual([]);
  });

  it("checks a global template's checks against this project's registered commands, leaving no owner or run behind", async () => {
    registered = ["test"];
    const saved = await templates.save({
      projectPath: PROJECT,
      tier: "global",
      id: "checked",
      expectedRevision: null,
      content: template({ defaults: { checks: ["test", "lint"] } }),
    });
    expect(saved.ok).toBe(true);

    const { response, json } = await launch(
      body({
        template: { tier: "global", id: "checked", revision: 1 },
        owner: { kind: "new", title: "Release owner" },
      }),
      person,
    );

    expect(response.status).toBe(400);
    expect(json).toMatchObject({
      code: "checks_not_registered",
      issues: [
        {
          path: "contexts.0.checks.1",
          message: expect.stringContaining('"lint"'),
        },
      ],
    });
    expect(storedRuns()).toEqual([]);
    expect(storedIds()).toEqual(seeded);
    expect(published).toEqual([]);
  });

  it("refuses a launch into a finished session before creating its owner", async () => {
    fixture.seedSession(PROJECT, "session", { finished: true });

    const { response, json } = await launch(
      body({ owner: { kind: "new", title: "Release owner" } }),
      person,
    );

    expect(response.status).toBe(409);
    expect(json).toMatchObject({ code: "session_finished" });
    expect(ownersCreated).toEqual([]);
    expect(storedIds()).toEqual(seeded);
    expect(published).toEqual([]);
  });

  it("refuses a launch whose session a merge began delivering while its new owner was being prepared, leaving no conversation", async () => {
    const preparing = hold();
    holdOwnerPreparation = preparing.wait;

    const launching = routes.launchTemplate(
      post(body({ owner: { kind: "new", title: "Release owner" } }), person),
      params(),
    );
    await preparing.reached;
    // Preparation reads configuration and the profile library: never under the session's lifecycle.
    const gate = lifecycle.runExclusive(PROJECT, "session", async () => "free");
    await expect(
      Promise.race([
        gate,
        new Promise((resolve) => setTimeout(() => resolve("held"), 200)),
      ]),
    ).resolves.toBe("free");
    finalizing.set("session", "merge-job-1");
    preparing.release();
    const response = await launching;

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "session_finalizing",
    });
    expect(ownersCreated).toEqual([]);
    expect(storedIds()).toEqual(seeded);
    expect(storedRuns()).toEqual([]);
    expect(published).toEqual([]);
  });

  it("removes the new owner when a merge begins delivering the session while the owner is created", async () => {
    const creating = hold();
    holdOwnerCreation = creating.wait;

    const launching = routes.launchTemplate(
      post(body({ owner: { kind: "new", title: "Release owner" } }), person),
      params(),
    );
    await creating.reached;
    // The owner exists now, inside the session's lifecycle.
    expect(storedIds()).toHaveLength(seeded.length + 1);
    finalizing.set("session", "merge-job-1");
    creating.release();
    const response = await launching;

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "session_finalizing",
    });
    expect(storedIds()).toEqual(seeded);
    expect(storedRuns()).toEqual([]);
    expect(published).toEqual([]);
  });

  it("removes the new owner of a launch into an archived session, where nothing could wake it", async () => {
    fixture.seedSession(PROJECT, "session", { archived: true });

    const { response, json } = await launch(
      body({ owner: { kind: "new", title: "Release owner" } }),
      person,
    );

    expect(response.status).toBe(409);
    expect(json).toMatchObject({ code: "owner_not_eligible" });
    expect(ownersCreated).toHaveLength(1);
    expect(storedIds()).toEqual(seeded);
    expect(storedRuns()).toEqual([]);
    expect(published).toEqual([]);
  });

  describe("admits the owner as the run is recorded, not only when the launch asked", () => {
    /**
     * Holds the launch at its last preparation step, applies `change` there,
     * and resumes it.
     */
    async function launchWhile(
      payload: unknown,
      headers: Record<string, string>,
      change: () => Promise<void>,
    ) {
      const placing = hold();
      holdPlacement = placing.wait;
      const launching = routes.launchTemplate(post(payload, headers), params());
      await placing.reached;
      await change();
      placing.release();
      const response = await launching;
      const json = (await response.json()) as Record<string, unknown>;
      await quiesce(supervision);
      return { response, json };
    }

    const existingOwner = body({
      owner: { kind: "existing", conversationId: "owner-1" },
    });

    it("refuses when the chosen owner is archived while the launch prepares", async () => {
      const { response, json } = await launchWhile(existingOwner, person, () =>
        conversations.setConversationArchived(
          PROJECT,
          "session",
          "owner-1",
          true,
        ),
      );

      expect(response.status).toBe(409);
      expect(json).toMatchObject({ code: "owner_not_eligible" });
      expect(storedRuns()).toEqual([]);
      expect(h.conversations).toBe(0);
    });

    it("refuses when the chosen owner is deleted while the launch prepares", async () => {
      const { response, json } = await launchWhile(existingOwner, person, () =>
        conversations.deleteConversation(PROJECT, "session", "owner-1"),
      );

      expect(response.status).toBe(409);
      expect(json).toMatchObject({ code: "owner_not_eligible" });
      expect(storedRuns()).toEqual([]);
      expect(h.conversations).toBe(0);
    });

    it("refuses when the owner's session is archived while the launch prepares", async () => {
      const { response, json } = await launchWhile(existingOwner, person, () =>
        fixture.store.setSessionArchived(PROJECT, "session", true),
      );

      expect(response.status).toBe(409);
      expect(json).toMatchObject({ code: "owner_not_eligible" });
      expect(storedRuns()).toEqual([]);
      expect(h.conversations).toBe(0);
    });

    it("refuses an agent whose own conversation is archived while its launch prepares", async () => {
      const { response, json } = await launchWhile(
        body(),
        agent("owner-1"),
        () =>
          conversations.setConversationArchived(
            PROJECT,
            "session",
            "owner-1",
            true,
          ),
      );

      expect(response.status).toBe(409);
      expect(json).toMatchObject({ code: "owner_not_wakeable" });
      expect(storedRuns()).toEqual([]);
      expect(h.conversations).toBe(0);
    });

    it("removes a new owner archived just before the last admission, announcing nothing", async () => {
      const creating = hold();
      holdOwnerCreation = creating.wait;
      const finalRead = hold();

      const launching = routes.launchTemplate(
        post(body({ owner: { kind: "new", title: "Release owner" } }), person),
        params(),
      );
      await creating.reached;
      beforeNextSessionRead = finalRead.wait;
      creating.release();
      await finalRead.reached;
      const [created] = ownersCreated;
      await conversations.setConversationArchived(
        PROJECT,
        "session",
        created ?? "",
        true,
      );
      finalRead.release();
      const response = await launching;

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "owner_not_eligible",
      });
      expect(storedIds()).toEqual(seeded);
      expect(storedRuns()).toEqual([]);
      expect(published).toEqual([]);
    });

    it("reads a merge's delivery after the last session read, with nothing between it and the record", async () => {
      const placing = hold();
      holdPlacement = placing.wait;
      const finalRead = hold();

      const launching = routes.launchTemplate(
        post(existingOwner, person),
        params(),
      );
      await placing.reached;
      beforeNextSessionRead = finalRead.wait;
      placing.release();
      await finalRead.reached;
      finalizing.set("session", "merge-job-1");
      finalRead.release();
      const response = await launching;

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "session_finalizing",
      });
      expect(storedRuns()).toEqual([]);
    });

    it("removes a new owner when the launch fails after creating it, announcing nothing", async () => {
      const creating = hold();
      holdOwnerCreation = creating.wait;

      const launching = routes.launchTemplate(
        post(body({ owner: { kind: "new", title: "Release owner" } }), person),
        params(),
      );
      await creating.reached;
      beforeNextSessionRead = async () => {
        throw new Error("The state store is unavailable");
      };
      creating.release();

      await expect(launching).rejects.toThrow("The state store is unavailable");
      expect(ownersCreated).toHaveLength(1);
      expect(storedIds()).toEqual(seeded);
      expect(storedRuns()).toEqual([]);
      expect(published).toEqual([]);
    });
  });
});
