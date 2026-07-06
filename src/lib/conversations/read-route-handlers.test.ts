import { describe, it, expect, vi, beforeEach } from "vitest";

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
  createReadRouteHandlers,
  parseReadQuery,
  type ReadRouteDeps,
} from "./read-route-handlers";
import { renderedTranscriptSchema } from "@/lib/conversations/transcript-render";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  TranscriptEntriesResult,
  TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";
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
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
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
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
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
    timestamp: "2024-01-01T00:00:00Z",
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

function createTestDeps(overrides: Partial<ReadRouteDeps> = {}): ReadRouteDeps {
  const convo = makeConvo();
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/home/projects/test-proj"),
    getSession: vi.fn().mockResolvedValue(makeSession([convo])),
    getProjectConversation: vi
      .fn()
      .mockResolvedValue(makeConvo({ id: "proj-convo-1", scope: "project" })),
    readTranscriptEntries: vi.fn().mockResolvedValue(ENTRIES),
    auth: fakeAuth({ kind: "absent" }),
    ...overrides,
  };
}

function sessionRequest(query = "", headers: Record<string, string> = {}) {
  return new Request(
    `http://localhost/api/projects/test-proj/sessions/test/conversations/convo-1/read${query}`,
    { headers },
  );
}

function sessionParams(
  name = "test-proj",
  session = "test",
  conversationId = "convo-1",
) {
  return { params: Promise.resolve({ name, session, conversationId }) };
}

function projectRequest(query = "") {
  return new Request(
    `http://localhost/api/projects/test-proj/conversations/proj-convo-1/read${query}`,
  );
}

function projectParams(name = "test-proj", conversationId = "proj-convo-1") {
  return { params: Promise.resolve({ name, conversationId }) };
}

let deps: ReadRouteDeps;
let handlers: ReturnType<typeof createReadRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createReadRouteHandlers(deps);
});

// ===========================================================================
// parseReadQuery
// ===========================================================================

describe("parseReadQuery", () => {
  it("returns defaults for an empty query", () => {
    const result = parseReadQuery("http://x/read");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options).toMatchObject({
      outline: false,
      includeTools: "summary",
      includeThinking: false,
      includeDebug: true,
      maxBytes: 262_144,
      format: "json",
    });
  });

  it("coerces booleans, integers, and A:B ranges", () => {
    const result = parseReadQuery(
      "http://x/read?outline=true&includeThinking=1&includeDebug=false&maxBytes=1024&messageRange=1:3",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options.outline).toBe(true);
    expect(result.options.includeThinking).toBe(true);
    expect(result.options.includeDebug).toBe(false);
    expect(result.options.maxBytes).toBe(1024);
    expect(result.options.messageRange).toEqual([1, 3]);
  });

  it("coerces seqRange and message", () => {
    const seq = parseReadQuery("http://x/read?seqRange=0:2");
    expect(seq.ok && seq.options.seqRange).toEqual([0, 2]);
    const msg = parseReadQuery("http://x/read?message=2");
    expect(msg.ok && msg.options.message).toBe(2);
  });

  it("rejects a non-integer message with a field-scoped issue", () => {
    const result = parseReadQuery("http://x/read?message=abc");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "message")).toBe(true);
  });

  it("accepts the lenient range forms A-B, A,B, and bare N", () => {
    const dash = parseReadQuery("http://x/read?messageRange=2-3");
    expect(dash.ok && dash.options.messageRange).toEqual([2, 3]);
    const comma = parseReadQuery("http://x/read?seqRange=10,20");
    expect(comma.ok && comma.options.seqRange).toEqual([10, 20]);
    const single = parseReadQuery("http://x/read?messageRange=4");
    expect(single.ok && single.options.messageRange).toEqual([4, 4]);
    const seqDash = parseReadQuery("http://x/read?seqRange=1-2");
    expect(seqDash.ok && seqDash.options.seqRange).toEqual([1, 2]);
  });

  it("rejects a malformed messageRange with a teaching issue", () => {
    const result = parseReadQuery("http://x/read?messageRange=abc");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.path === "messageRange");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("A:B");
    expect(issue?.message).toContain("--message-range 2:3");
    expect(issue?.message).toContain("--seq-range");
    expect(issue?.message).toContain("[sN]");
    expect(result.issues.filter((i) => i.path === "messageRange")).toHaveLength(
      1,
    );
  });

  it("rejects a malformed seqRange with a teaching issue", () => {
    const result = parseReadQuery("http://x/read?seqRange=1:x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issues.find((i) => i.path === "seqRange");
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("A:B");
    expect(issue?.message).toContain("--seq-range 120:180");
    expect(result.issues.filter((i) => i.path === "seqRange")).toHaveLength(1);
  });

  it("rejects mutually exclusive window options", () => {
    const result = parseReadQuery("http://x/read?message=1&seqRange=0:2");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects an invalid search regex", () => {
    const result = parseReadQuery("http://x/read?search=%5B");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "search")).toBe(true);
  });
});

// ===========================================================================
// Session-scoped GET
// ===========================================================================

describe("GET …/sessions/[session]/conversations/[conversationId]/read", () => {
  it("returns the rendered transcript as JSON", async () => {
    const response = await handlers.sessionGET(
      sessionRequest(),
      sessionParams(),
    );
    expect(response.status).toBe(200);
    const body = renderedTranscriptSchema.parse(await response.json());
    expect(body.conversationId).toBe("convo-1");
    expect(body.totalMessages).toBe(4);
    expect(body.maxSeq).toBe(3);
    expect(body.units).toHaveLength(4);
    expect(body.units[0]?.lines).toEqual(["[s0] first question"]);
  });

  it("applies windowing options from the query string", async () => {
    const response = await handlers.sessionGET(
      sessionRequest("?message=2"),
      sessionParams(),
    );
    const body = renderedTranscriptSchema.parse(await response.json());
    expect(body.units).toHaveLength(1);
    expect(body.units[0]?.ref.messageIndex).toBe(2);
    expect(body.omissions.unitsOutsideWindow).toBe(3);
  });

  it("returns text/markdown when format=markdown", async () => {
    const response = await handlers.sessionGET(
      sessionRequest("?format=markdown"),
      sessionParams(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const text = await response.text();
    expect(text).toContain("#0 [seq 0] user");
    expect(text).toContain("[s0] first question");
  });

  it("returns 400 with code and issues on invalid query params", async () => {
    const response = await handlers.sessionGET(
      sessionRequest("?message=1&messageRange=0:2"),
      sessionParams(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_read_options");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("returns 404 with conversation_not_found code for an unknown conversation", async () => {
    const response = await handlers.sessionGET(
      sessionRequest(),
      sessionParams("test-proj", "test", "missing"),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Conversation not found");
    expect(body.code).toBe("conversation_not_found");
  });

  it("returns 404 for an unknown project", async () => {
    deps = createTestDeps({
      resolveProjectPath: vi.fn().mockResolvedValue(null),
    });
    handlers = createReadRouteHandlers(deps);

    const response = await handlers.sessionGET(
      sessionRequest(),
      sessionParams("nope"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Project not found");
  });

  it("returns 404 for an unknown session", async () => {
    deps = createTestDeps({ getSession: vi.fn().mockResolvedValue(null) });
    handlers = createReadRouteHandlers(deps);

    const response = await handlers.sessionGET(
      sessionRequest(),
      sessionParams("test-proj", "missing"),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Session not found");
  });

  it("returns 401 when a bearer token is present but invalid", async () => {
    deps = createTestDeps({ auth: fakeAuth({ kind: "invalid" }) });
    handlers = createReadRouteHandlers(deps);

    const response = await handlers.sessionGET(
      sessionRequest("", { authorization: "Bearer wrong" }),
      sessionParams(),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBeDefined();
  });

  it("serves a token-less request (absent) un-gated", async () => {
    const response = await handlers.sessionGET(
      sessionRequest(),
      sessionParams(),
    );
    expect(response.status).toBe(200);
  });

  it("returns 500 when reading the transcript fails", async () => {
    deps = createTestDeps({
      readTranscriptEntries: vi
        .fn()
        .mockRejectedValue(new Error("disk read failed")),
    });
    handlers = createReadRouteHandlers(deps);

    const response = await handlers.sessionGET(
      sessionRequest(),
      sessionParams(),
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("disk read failed");
  });

  it("emits audit.conversation_read with caller, target, window, bytes, truncated", async () => {
    deps = createTestDeps({ auth: fakeAuth({ kind: "valid" }) });
    handlers = createReadRouteHandlers(deps);

    const response = await handlers.sessionGET(
      sessionRequest("?message=1", {
        authorization: "Bearer right",
        "x-cc-conversation-id": "caller-convo-9",
      }),
      sessionParams(),
    );
    expect(response.status).toBe(200);

    const auditCall = logSpies.info.mock.calls.find(
      ([event]) => event === "audit.conversation_read",
    );
    expect(auditCall).toBeDefined();
    const fields = auditCall?.[1] as Record<string, unknown>;
    expect(fields["callerConversationId"]).toBe("caller-convo-9");
    expect(fields["targetConversationId"]).toBe("convo-1");
    expect(fields["window"]).toMatchObject({ message: 1 });
    expect(typeof fields["bytes"]).toBe("number");
    expect(fields["truncated"]).toBe(false);

    const servedCall = logSpies.info.mock.calls.find(
      ([event]) => event === "read.served",
    );
    expect(servedCall).toBeDefined();
    const servedFields = servedCall?.[1] as Record<string, unknown>;
    expect(typeof servedFields["bytes"]).toBe("number");
    expect(servedFields["truncated"]).toBe(false);
  });
});

// ===========================================================================
// Project-scoped GET
// ===========================================================================

describe("GET …/projects/[name]/conversations/[conversationId]/read", () => {
  it("returns the rendered transcript as JSON", async () => {
    const response = await handlers.projectGET(
      projectRequest(),
      projectParams(),
    );
    expect(response.status).toBe(200);
    const body = renderedTranscriptSchema.parse(await response.json());
    expect(body.conversationId).toBe("proj-convo-1");
    expect(body.totalMessages).toBe(4);
    expect(deps.getProjectConversation).toHaveBeenCalledWith(
      "/home/projects/test-proj",
      "proj-convo-1",
    );
  });

  it("returns 404 with conversation_not_found code for an unknown conversation", async () => {
    deps = createTestDeps({
      getProjectConversation: vi.fn().mockResolvedValue(null),
    });
    handlers = createReadRouteHandlers(deps);

    const response = await handlers.projectGET(
      projectRequest(),
      projectParams("test-proj", "missing"),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe("conversation_not_found");
  });

  it("returns 401 when a bearer token is present but invalid", async () => {
    deps = createTestDeps({ auth: fakeAuth({ kind: "invalid" }) });
    handlers = createReadRouteHandlers(deps);

    const response = await handlers.projectGET(
      projectRequest(),
      projectParams(),
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 with issues on invalid query params", async () => {
    const response = await handlers.projectGET(
      projectRequest("?maxBytes=huge"),
      projectParams(),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("invalid_read_options");
    expect(
      body.issues.some((issue: { path: string }) => issue.path === "maxBytes"),
    ).toBe(true);
  });
});
