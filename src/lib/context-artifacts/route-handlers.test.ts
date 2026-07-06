import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Infrastructure-only mock (module-level createLogger side effect); handler
// deps stay injected. withTracing passes through so tests hit the raw handler.
vi.mock("@/lib/logging", () => ({
  createLogger: () => logSpies,
  withTracing: <T>(handler: T) => handler,
}));

import {
  createContextArtifactRouteHandlers,
  raceCompletion,
  type ContextArtifactRouteDeps,
} from "./route-handlers";
import { createCompactionService } from "./service";
import { createContextArtifactsRepo, type ContextArtifactsRepo } from "./repo";
import {
  compactionEnvelopeSchema,
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type CompactionEnvelope,
  type ContextArtifactRow,
} from "./schemas";
import { PROMPT_VERSION } from "./generation";
import { NORMALIZER_VERSION } from "@/lib/conversations/transcript-render";
import { compactionConfigSchema } from "@/lib/config/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  TranscriptEntriesResult,
  TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";
import type { TaskRunResult } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  AgentAuth,
  OptionalTokenValidation,
} from "@/lib/agent-gateway/token";

function makeConvo(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "convo-1",
    scope: "session",
    name: null,
    transcriptPath: "/tmp/convo-1.jsonl",
    status: "new",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    ...overrides,
  };
}

function makeSession(conversations: ConversationState[]): SessionState {
  return {
    sessionName: "test",
    worktreePath: "/proj/.worktrees/test",
    branchName: "csm/test",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    archived: false,
    finished: false,
    conversations,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
}

function makeEntry(
  seq: number,
  role: "user" | "assistant",
  text: string,
): TranscriptEntryWithSeq {
  return {
    seq,
    entryId: `entry-${seq}`,
    role,
    timestamp: "2026-01-01T00:00:00Z",
    content: [{ type: "text", text }],
  };
}

const ENTRIES: TranscriptEntriesResult = {
  entries: [
    makeEntry(0, "user", "first question"),
    makeEntry(1, "assistant", "first answer"),
    makeEntry(2, "user", "second question"),
    makeEntry(3, "assistant", "second answer"),
  ],
  maxSeq: 3,
};

function extractSourceMeta(prompt: string): {
  kind: "message_compaction" | "conversation_compaction";
  source: CompactionEnvelope["source"];
} {
  const marker =
    "## Source metadata (copy `kind` and `source` verbatim)\n```json\n";
  const jsonStart = prompt.indexOf(marker) + marker.length;
  const jsonEnd = prompt.indexOf("\n```", jsonStart);
  return JSON.parse(prompt.slice(jsonStart, jsonEnd)) as {
    kind: "message_compaction" | "conversation_compaction";
    source: CompactionEnvelope["source"];
  };
}

function envelopeFromPrompt(prompt: string): CompactionEnvelope {
  const meta = extractSourceMeta(prompt);
  return compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: meta.kind,
    source: meta.source,
    agentBrief: "brief",
    currentState: {
      status: "in_progress",
      latestUserGoal: "goal",
      nextBestActions: ["next"],
    },
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
  });
}

function structuredResult(output: unknown): TaskRunResult {
  return {
    kind: "structured",
    structuredOutput: output,
    text: "",
    usage: {
      costUsd: null,
      durationMs: null,
      contextTokens: null,
      contextWindowMax: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
    backendRef: null,
  };
}

function makeEnvelope(
  overrides: Partial<CompactionEnvelope> = {},
): CompactionEnvelope {
  return compactionEnvelopeSchema.parse({
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "test-proj",
      sessionName: "test",
      conversationId: "convo-1",
      coveredStartSeq: 0,
      coveredEndSeq: 1,
      messageCount: 2,
      sourceHash: "hash",
    },
    agentBrief: "old brief",
    currentState: {
      status: "in_progress",
      latestUserGoal: "goal",
      nextBestActions: ["next"],
    },
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
    ...overrides,
  });
}

function makeRow(
  overrides: Partial<ContextArtifactRow> = {},
): ContextArtifactRow {
  return {
    id: "artifact-1",
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/home/projects/test-proj",
    sessionName: "test",
    conversationId: "convo-1",
    messageId: null,
    messageIndex: null,
    coveredStartSeq: 0,
    coveredEndSeq: 1,
    sourceHash: "hash",
    status: "complete",
    error: null,
    modelProvider: "claude",
    model: "sonnet",
    effort: "medium",
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    createdBy: "user",
    createdByConversationId: null,
    payload: makeEnvelope(),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeAuth(result: OptionalTokenValidation): AgentAuth {
  return {
    async requireToken() {
      return null;
    },
    async validateOptionalToken() {
      return result;
    },
  };
}

let fixture: PersistenceFixture;
let repo: ContextArtifactsRepo;

function createTestDeps(
  overrides: Partial<ContextArtifactRouteDeps> = {},
): ContextArtifactRouteDeps {
  const service = createCompactionService({
    executeTaskRun: async (input) =>
      structuredResult(envelopeFromPrompt(input.prompt)),
    readEntries: async () => ENTRIES,
    repo,
    resolveConfig: async () => compactionConfigSchema.parse({}),
    broadcast: () => {},
    now: () => "2026-07-05T00:00:00Z",
  });
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    getSession: vi.fn().mockResolvedValue(makeSession([makeConvo()])),
    getProjectConversation: vi
      .fn()
      .mockResolvedValue(makeConvo({ id: "proj-convo-1", scope: "project" })),
    readTranscriptEntries: vi.fn().mockResolvedValue(ENTRIES),
    getService: () => service,
    getRepo: () => repo,
    auth: fakeAuth({ kind: "absent" }),
    ...overrides,
  };
}

const SESSION_BASE =
  "http://localhost/api/projects/test-proj/sessions/test/conversations/convo-1/context-artifacts";
const PROJECT_BASE =
  "http://localhost/api/projects/test-proj/conversations/proj-convo-1/context-artifacts";

function sessionCollectionParams(conversationId = "convo-1") {
  return {
    params: Promise.resolve({
      name: "test-proj",
      session: "test",
      conversationId,
    }),
  };
}

function sessionItemParams(artifactId: string, conversationId = "convo-1") {
  return {
    params: Promise.resolve({
      name: "test-proj",
      session: "test",
      conversationId,
      artifactId,
    }),
  };
}

function projectCollectionParams(conversationId = "proj-convo-1") {
  return {
    params: Promise.resolve({ name: "test-proj", conversationId }),
  };
}

function projectItemParams(
  artifactId: string,
  conversationId = "proj-convo-1",
) {
  return {
    params: Promise.resolve({ name: "test-proj", conversationId, artifactId }),
  };
}

function postRequest(
  body: unknown,
  url = SESSION_BASE,
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

let deps: ContextArtifactRouteDeps;
let handlers: ReturnType<typeof createContextArtifactRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  fixture = createPersistenceFixture();
  repo = createContextArtifactsRepo(fixture.db);
  deps = createTestDeps();
  handlers = createContextArtifactRouteHandlers(deps);
});

afterEach(() => {
  fixture.close();
});

// ===========================================================================
// GET list
// ===========================================================================

describe("GET …/context-artifacts (list)", () => {
  it("returns rows with derived freshness flags and without payload", async () => {
    repo.upsert(makeRow({ coveredEndSeq: 1 }));

    const response = await handlers.sessionList(
      new Request(SESSION_BASE),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: "artifact-1",
      kind: "conversation_compaction",
      status: "complete",
      stale: true,
      staleBehindMessages: 2,
      outdated: false,
    });
    expect(body[0]).not.toHaveProperty("payload");
  });

  it("counts stale-behind in merged logical messages, not raw entries", async () => {
    // 1 user entry + 30 consecutive assistant entries past coverage: 31 raw
    // entries merging into 2 logical messages.
    const entries: TranscriptEntriesResult = {
      entries: [
        makeEntry(0, "user", "first question"),
        makeEntry(1, "assistant", "first answer"),
        makeEntry(2, "user", "second question"),
        ...Array.from({ length: 30 }, (_, i) =>
          makeEntry(3 + i, "assistant", `tool step ${i}`),
        ),
      ],
      maxSeq: 32,
    };
    handlers = createContextArtifactRouteHandlers(
      createTestDeps({
        readTranscriptEntries: vi.fn().mockResolvedValue(entries),
      }),
    );
    repo.upsert(makeRow({ coveredEndSeq: 1 }));

    const response = await handlers.sessionList(
      new Request(SESSION_BASE),
      sessionCollectionParams(),
    );
    const body = await response.json();
    expect(body[0]).toMatchObject({ stale: true, staleBehindMessages: 2 });
  });

  it("counts a merged unit once when the coverage boundary falls inside it", async () => {
    const entries: TranscriptEntriesResult = {
      entries: [
        makeEntry(0, "user", "first question"),
        makeEntry(1, "assistant", "first answer"),
        makeEntry(2, "user", "second question"),
        ...Array.from({ length: 30 }, (_, i) =>
          makeEntry(3 + i, "assistant", `tool step ${i}`),
        ),
      ],
      maxSeq: 32,
    };
    handlers = createContextArtifactRouteHandlers(
      createTestDeps({
        readTranscriptEntries: vi.fn().mockResolvedValue(entries),
      }),
    );
    // Coverage boundary at seq 5 falls inside the 3..32 merged assistant unit.
    repo.upsert(makeRow({ coveredEndSeq: 5 }));

    const response = await handlers.sessionList(
      new Request(SESSION_BASE),
      sessionCollectionParams(),
    );
    const body = await response.json();
    expect(body[0]).toMatchObject({ stale: true, staleBehindMessages: 1 });
  });

  it("reports message artifacts as always fresh", async () => {
    repo.upsert(
      makeRow({
        id: "msg-artifact",
        kind: "message_compaction",
        messageIndex: 1,
        messageId: "entry-1",
        coveredStartSeq: 1,
        coveredEndSeq: 1,
      }),
    );

    const response = await handlers.sessionList(
      new Request(SESSION_BASE),
      sessionCollectionParams(),
    );
    const body = await response.json();
    expect(body[0]).toMatchObject({
      id: "msg-artifact",
      stale: false,
      staleBehindMessages: 0,
    });
  });

  it("flags version drift as outdated", async () => {
    repo.upsert(makeRow({ promptVersion: "0", coveredEndSeq: 3 }));

    const response = await handlers.sessionList(
      new Request(SESSION_BASE),
      sessionCollectionParams(),
    );
    const body = await response.json();
    expect(body[0]).toMatchObject({ stale: false, outdated: true });
  });

  it("returns 404 with conversation_not_found for an unknown conversation", async () => {
    const response = await handlers.sessionList(
      new Request(SESSION_BASE),
      sessionCollectionParams("missing"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("conversation_not_found");
  });

  it("returns 401 when a bearer token is present but invalid", async () => {
    handlers = createContextArtifactRouteHandlers(
      createTestDeps({ auth: fakeAuth({ kind: "invalid" }) }),
    );
    const response = await handlers.sessionList(
      new Request(SESSION_BASE, { headers: { authorization: "Bearer bad" } }),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(401);
  });
});

// ===========================================================================
// POST create_or_refresh
// ===========================================================================

describe("POST …/context-artifacts", () => {
  it("returns 202 pending and completes the artifact in the background", async () => {
    const response = await handlers.sessionCreate(
      postRequest({
        kind: "conversation_compaction",
        mode: "create_or_refresh",
      }),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.status).toBe("pending");
    expect(typeof body.artifactId).toBe("string");

    await vi.waitFor(() => {
      expect(repo.findById(body.artifactId)?.status).toBe("complete");
    });
    const row = repo.findById(body.artifactId);
    expect(row?.coveredEndSeq).toBe(3);
    expect(row?.createdBy).toBe("user");
  });

  it("returns 200 with the completed artifact when wait=true", async () => {
    const response = await handlers.sessionCreate(
      postRequest({
        kind: "conversation_compaction",
        mode: "create_or_refresh",
        wait: true,
      }),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artifact.status).toBe("complete");
    expect(body.artifact.payload.agentBrief).toBe("brief");
    expect(body.artifact.stale).toBe(false);
    expect(body.artifact.outdated).toBe(false);
  });

  it("no-ops with hint 'already fresh' on a fresh artifact", async () => {
    repo.upsert(makeRow({ coveredEndSeq: 3 }));

    const response = await handlers.sessionCreate(
      postRequest({
        kind: "conversation_compaction",
        mode: "create_or_refresh",
      }),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hint).toBe("already fresh");
    expect(body.artifact.id).toBe("artifact-1");
  });

  it("force regenerates a fresh artifact", async () => {
    repo.upsert(makeRow({ coveredEndSeq: 3 }));

    const response = await handlers.sessionCreate(
      postRequest({
        kind: "conversation_compaction",
        mode: "create_or_refresh",
        force: true,
        wait: true,
      }),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artifact.status).toBe("complete");
    expect(body.artifact.payload.agentBrief).toBe("brief");
  });

  it("returns 400 with issues when messageIndex is missing for message_compaction", async () => {
    const response = await handlers.sessionCreate(
      postRequest({ kind: "message_compaction", mode: "create_or_refresh" }),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_compaction_request");
    expect(
      body.issues.some(
        (issue: { path: string }) => issue.path === "messageIndex",
      ),
    ).toBe(true);
  });

  it("returns 400 on an out-of-range messageIndex", async () => {
    const response = await handlers.sessionCreate(
      postRequest({
        kind: "message_compaction",
        messageIndex: 99,
        mode: "create_or_refresh",
      }),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_compaction_request");
  });

  it("stamps agent provenance when a valid token and caller id are supplied", async () => {
    handlers = createContextArtifactRouteHandlers(
      createTestDeps({ auth: fakeAuth({ kind: "valid" }) }),
    );
    const response = await handlers.sessionCreate(
      postRequest(
        {
          kind: "conversation_compaction",
          mode: "create_or_refresh",
          wait: true,
          callerConversationId: "caller-7",
        },
        SESSION_BASE,
        { authorization: "Bearer good" },
      ),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artifact.createdBy).toBe("agent");
    expect(body.artifact.createdByConversationId).toBe("caller-7");
  });

  it("returns 401 when the bearer token is invalid", async () => {
    handlers = createContextArtifactRouteHandlers(
      createTestDeps({ auth: fakeAuth({ kind: "invalid" }) }),
    );
    const response = await handlers.sessionCreate(
      postRequest(
        { kind: "conversation_compaction", mode: "create_or_refresh" },
        SESSION_BASE,
        { authorization: "Bearer bad" },
      ),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 conversation_not_found for an unknown conversation", async () => {
    const response = await handlers.sessionCreate(
      postRequest({
        kind: "conversation_compaction",
        mode: "create_or_refresh",
      }),
      sessionCollectionParams("missing"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("conversation_not_found");
  });

  it("returns a code-less 404 for an unknown project", async () => {
    handlers = createContextArtifactRouteHandlers(
      createTestDeps({ resolveProjectPath: vi.fn().mockResolvedValue(null) }),
    );
    const response = await handlers.sessionCreate(
      postRequest({
        kind: "conversation_compaction",
        mode: "create_or_refresh",
      }),
      sessionCollectionParams(),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
    expect(body.code).toBeUndefined();
  });
});

// ===========================================================================
// GET one
// ===========================================================================

describe("GET …/context-artifacts/[artifactId]", () => {
  it("returns the full artifact including payload and freshness", async () => {
    repo.upsert(makeRow({ coveredEndSeq: 1 }));

    const response = await handlers.sessionGetOne(
      new Request(`${SESSION_BASE}/artifact-1`),
      sessionItemParams("artifact-1"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe("artifact-1");
    expect(body.payload.agentBrief).toBe("old brief");
    expect(body.stale).toBe(true);
    expect(body.staleBehindMessages).toBe(2);
  });

  it("returns 404 artifact_not_found for an unknown artifact", async () => {
    const response = await handlers.sessionGetOne(
      new Request(`${SESSION_BASE}/nope`),
      sessionItemParams("nope"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("artifact_not_found");
  });

  it("returns 404 when the artifact belongs to another scope (no cross-scope id confusion)", async () => {
    repo.upsert(makeRow({ sessionName: "other-session" }));

    const response = await handlers.sessionGetOne(
      new Request(`${SESSION_BASE}/artifact-1`),
      sessionItemParams("artifact-1"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("artifact_not_found");
  });
});

// ===========================================================================
// DELETE
// ===========================================================================

describe("DELETE …/context-artifacts/[artifactId]", () => {
  it("deletes the artifact and reports it gone on re-read", async () => {
    repo.upsert(makeRow());

    const response = await handlers.sessionDelete(
      new Request(`${SESSION_BASE}/artifact-1`, { method: "DELETE" }),
      sessionItemParams("artifact-1"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).deleted).toBe(true);
    expect(repo.findById("artifact-1")).toBeNull();
  });

  it("returns 404 artifact_not_found for an unknown artifact", async () => {
    const response = await handlers.sessionDelete(
      new Request(`${SESSION_BASE}/nope`, { method: "DELETE" }),
      sessionItemParams("nope"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("artifact_not_found");
  });

  it("refuses to delete an artifact from another conversation's path", async () => {
    repo.upsert(makeRow({ conversationId: "other-convo" }));

    const response = await handlers.sessionDelete(
      new Request(`${SESSION_BASE}/artifact-1`, { method: "DELETE" }),
      sessionItemParams("artifact-1"),
    );
    expect(response.status).toBe(404);
    expect(repo.findById("artifact-1")).not.toBeNull();
  });
});

// ===========================================================================
// Project scope
// ===========================================================================

describe("project-scope handlers", () => {
  it("creates a project-scope artifact via the project route", async () => {
    const response = await handlers.projectCreate(
      postRequest(
        {
          kind: "conversation_compaction",
          mode: "create_or_refresh",
          wait: true,
        },
        PROJECT_BASE,
      ),
      projectCollectionParams(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.artifact.scope).toBe("project");
    expect(body.artifact.sessionName).toBeNull();
    expect(body.artifact.conversationId).toBe("proj-convo-1");

    const reloaded = repo.findById(body.artifact.id);
    expect(reloaded?.scope).toBe("project");
  });

  it("lists project-scope artifacts", async () => {
    repo.upsert(
      makeRow({
        id: "proj-artifact",
        scope: "project",
        sessionName: null,
        conversationId: "proj-convo-1",
      }),
    );
    const response = await handlers.projectList(
      new Request(PROJECT_BASE),
      projectCollectionParams(),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("proj-artifact");
  });

  it("does not serve a session-scope artifact through the project route", async () => {
    repo.upsert(makeRow({ conversationId: "proj-convo-1" }));

    const response = await handlers.projectGetOne(
      new Request(`${PROJECT_BASE}/artifact-1`),
      projectItemParams("artifact-1"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("artifact_not_found");
  });

  it("returns 404 conversation_not_found for an unknown project conversation", async () => {
    handlers = createContextArtifactRouteHandlers(
      createTestDeps({
        getProjectConversation: vi.fn().mockResolvedValue(null),
      }),
    );
    const response = await handlers.projectList(
      new Request(PROJECT_BASE),
      projectCollectionParams("missing"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("conversation_not_found");
  });
});

describe("raceCompletion", () => {
  it("waits for completion (never times out) when timeoutMs is 0 — no timeout", async () => {
    const row = makeRow({ id: "done" });
    // A 0 timeout means "no timeout": the wait must resolve to the completed
    // row after a real delay, not immediately resolve to null on a 0ms timer.
    const completion = new Promise<ContextArtifactRow>((resolve) => {
      setTimeout(() => resolve(row), 10);
    });

    expect(await raceCompletion(completion, 0)).toBe(row);
  });

  it("resolves to null once a positive timeout elapses before completion", async () => {
    const completion = new Promise<ContextArtifactRow>(() => {
      // never resolves
    });

    expect(await raceCompletion(completion, 5)).toBeNull();
  });
});
