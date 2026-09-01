import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  withTracing: (handler: unknown) => handler,
}));

import { redactAgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { OptionalTokenValidation } from "@/lib/agent-gateway/token";
import type { ConversationListItem } from "@/lib/conversations/schemas";
import {
  PROFILE_SECRET_SENTINEL,
  SNAPSHOT_FIXTURE,
} from "@/lib/conversations/testing/profile-snapshot-fixtures";
import {
  createTicketStatusUpdateRouteHandlers,
  type TicketStatusUpdateRouteDeps,
} from "./status-update-route-handlers";
import type {
  GetTicketStatusUpdateServiceInput,
  ListTicketStatusUpdatesServiceInput,
  PostTicketStatusUpdateServiceInput,
  TicketStatusUpdateService,
} from "./status-update-service";
import {
  STATUS_UPDATE_ACTOR_RATIONALE,
  ticketStatusUpdateCreateResponseSchema,
  ticketStatusUpdatePageSchema,
  ticketStatusUpdateSchema,
  type TicketDetail,
  type TicketStatusUpdate,
} from "./schemas";
import { encodeTicketKeysetCursor } from "./ticket-keyset-cursor";

const PROJECT_NAME = "alpha";
const BASE = `http://localhost/api/projects/${PROJECT_NAME}/tickets/7/status-updates`;

function ticket(): TicketDetail {
  return {
    id: "ticket-alpha-7",
    projectPath: "/repos/alpha",
    projectName: PROJECT_NAME,
    number: 7,
    title: "Ship ticket updates",
    description: "",
    workType: "feature",
    status: "not_started",
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:01:00.000Z",
    attachments: [],
    sessions: [],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
  };
}

const update: TicketStatusUpdate = {
  id: "update-1",
  ticketId: "ticket-alpha-7",
  bodyMarkdown: "Storage and API are wired.",
  author: { kind: "user" },
  createdAt: "2026-08-31T10:01:00.000Z",
};

function conversation(
  scope: "session" | "project" = "session",
): ConversationListItem {
  const shared = {
    projectName: "source-project",
    projectPath: "/repos/source-project",
    worktreePath: "/repos/source-project/.worktrees/session-one",
    conversationId: "conversation-agent-1",
    conversationName: "Implement ticket routes",
    summary: "Private operational summary",
    firstPromptSnippet: "Private prompt snippet",
    backend: "codex" as const,
    backendRef: { backend: "codex" as const, ref: "private-backend-ref" },
    transcriptPath: "/private/transcript.jsonl",
    debugLogPath: "/private/debug.log",
    status: "awaiting" as const,
    lastActivityAt: "2026-08-31T10:00:00.000Z",
    archived: false,
    redactedProfileSnapshot: redactAgentProfileSnapshot(SNAPSHOT_FIXTURE),
  };
  return scope === "session"
    ? { ...shared, scope, sessionName: "session-one" }
    : { ...shared, scope, worktreePath: "/repos/source-project" };
}

interface CapturedInputs {
  list: ListTicketStatusUpdatesServiceInput[];
  get: GetTicketStatusUpdateServiceInput[];
  post: PostTicketStatusUpdateServiceInput[];
  conversationIds: string[];
}

function makeHarness(
  options: {
    auth?: OptionalTokenValidation;
    conversation?: ConversationListItem | null;
    service?: Partial<TicketStatusUpdateService>;
  } = {},
) {
  const captured: CapturedInputs = {
    list: [],
    get: [],
    post: [],
    conversationIds: [],
  };
  const detail = ticket();
  const service: TicketStatusUpdateService = {
    async list(input) {
      captured.list.push(input);
      return {
        ok: true,
        value: { items: [update], total: 1, nextCursor: null },
      };
    },
    async get(input) {
      captured.get.push(input);
      return { ok: true, value: update };
    },
    async post(input) {
      captured.post.push(input);
      return {
        ok: true,
        value: {
          update: {
            id: "update-created",
            ticketId: detail.id,
            bodyMarkdown: input.bodyMarkdown,
            author: input.author,
            createdAt: "2026-08-31T10:02:00.000Z",
          },
          ticket: detail,
        },
      };
    },
    ...options.service,
  };
  const deps: TicketStatusUpdateRouteDeps = {
    getService: () => service,
    async validateOptionalToken() {
      return options.auth ?? { kind: "absent" };
    },
    async findConversationById(conversationId) {
      captured.conversationIds.push(conversationId);
      return options.conversation === undefined
        ? conversation()
        : options.conversation;
    },
  };
  return {
    handlers: createTicketStatusUpdateRouteHandlers(deps),
    captured,
  };
}

function context(overrides: Partial<Record<string, string>> = {}) {
  return {
    params: Promise.resolve({
      name: PROJECT_NAME,
      number: "7",
      updateId: update.id,
      ...overrides,
    }),
  };
}

function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ticket status-update HTTP routes", () => {
  it("accepts browser and authenticated reads while refusing an invalid optional token", async () => {
    const browser = makeHarness({ auth: { kind: "absent" } });
    const agent = makeHarness({ auth: { kind: "valid" } });
    const rejected = makeHarness({ auth: { kind: "invalid" } });

    const [browserResponse, agentResponse, rejectedResponse] =
      await Promise.all([
        browser.handlers.indexGET(new Request(BASE), context()),
        agent.handlers.indexGET(new Request(BASE), context()),
        rejected.handlers.indexGET(new Request(BASE), context()),
      ]);

    expect(browserResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);
    expect(rejectedResponse.status).toBe(401);
    expect(await rejectedResponse.json()).toEqual({
      error: "Invalid Command Center API token",
    });
    expect(rejected.captured.list).toEqual([]);
  });

  it("strictly parses a keyset page and returns the canonical page schema", async () => {
    const cursor = encodeTicketKeysetCursor({
      timestamp: update.createdAt,
      id: update.id,
    });
    const { handlers, captured } = makeHarness();
    const response = await handlers.indexGET(
      new Request(`${BASE}?limit=47&cursor=${cursor}`),
      context(),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(ticketStatusUpdatePageSchema.parse(body)).toEqual({
      items: [update],
      total: 1,
      nextCursor: null,
    });
    expect(captured.list).toEqual([
      { projectName: PROJECT_NAME, number: 7, limit: 47, cursor },
    ]);
  });

  it.each([
    ["unknown query key", `${BASE}?offset=2`, "offset"],
    ["limit below one", `${BASE}?limit=0`, "limit"],
    ["limit above one hundred", `${BASE}?limit=101`, "limit"],
    ["fractional limit", `${BASE}?limit=1.5`, "limit"],
    ["malformed cursor", `${BASE}?cursor=not-a-cursor`, "cursor"],
  ])("rejects %s before listing", async (_label, url, path) => {
    const { handlers, captured } = makeHarness();
    const response = await handlers.indexGET(new Request(url), context());
    const body = (await response.json()) as {
      code: string;
      issues: Array<{ path: string }>;
    };

    expect(response.status).toBe(400);
    expect(body.code).toBe("validation_failed");
    expect(body.issues.some((issue) => issue.path === path)).toBe(true);
    expect(captured.list).toEqual([]);
  });

  it("records an unauthenticated browser post as a user-authored update", async () => {
    const { handlers, captured } = makeHarness({ auth: { kind: "absent" } });
    const response = await handlers.postPOST(
      jsonRequest(
        BASE,
        { bodyMarkdown: "Browser-authored progress." },
        {
          "x-cc-conversation-id": "spoofed-agent-id",
        },
      ),
      context(),
    );
    const body: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(ticketStatusUpdateCreateResponseSchema.parse(body)).toEqual(body);
    expect(captured.post).toEqual([
      {
        projectName: PROJECT_NAME,
        number: 7,
        bodyMarkdown: "Browser-authored progress.",
        author: { kind: "user" },
      },
    ]);
    expect(captured.conversationIds).toEqual([]);
  });

  it("refuses an authenticated post without a caller conversation", async () => {
    const { handlers, captured } = makeHarness({ auth: { kind: "valid" } });
    const response = await handlers.postPOST(
      jsonRequest(BASE, { bodyMarkdown: "Agent progress." }),
      context(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: STATUS_UPDATE_ACTOR_RATIONALE,
      code: "status_update_actor_required",
      details: {},
      rationale: STATUS_UPDATE_ACTOR_RATIONALE,
    });
    expect(captured.conversationIds).toEqual([]);
    expect(captured.post).toEqual([]);
  });

  it("enforces authenticated actor provenance before accepting request content", async () => {
    const { handlers, captured } = makeHarness({ auth: { kind: "valid" } });
    const response = await handlers.postPOST(
      new Request(BASE, { method: "POST", body: "not-json" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "status_update_actor_required",
      rationale: STATUS_UPDATE_ACTOR_RATIONALE,
    });
    expect(captured.conversationIds).toEqual([]);
    expect(captured.post).toEqual([]);
  });

  it("refuses an authenticated post whose caller conversation no longer resolves", async () => {
    const { handlers, captured } = makeHarness({
      auth: { kind: "valid" },
      conversation: null,
    });
    const response = await handlers.postPOST(
      jsonRequest(
        BASE,
        { bodyMarkdown: "Agent progress." },
        { "x-cc-conversation-id": "missing-conversation" },
      ),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: STATUS_UPDATE_ACTOR_RATIONALE,
      code: "status_update_actor_not_found",
      details: { conversationId: "missing-conversation" },
      rationale: STATUS_UPDATE_ACTOR_RATIONALE,
    });
    expect(captured.conversationIds).toEqual(["missing-conversation"]);
    expect(captured.post).toEqual([]);
  });

  it("persists only durable redacted provenance for a session agent", async () => {
    const source = conversation("session");
    const { handlers, captured } = makeHarness({
      auth: { kind: "valid" },
      conversation: source,
    });
    const response = await handlers.postPOST(
      jsonRequest(
        BASE,
        { bodyMarkdown: "Agent progress." },
        { "x-cc-conversation-id": `  ${source.conversationId}  ` },
      ),
      context(),
    );
    const bodyText = JSON.stringify(await response.json());

    expect(response.status).toBe(201);
    expect(captured.conversationIds).toEqual([source.conversationId]);
    expect(captured.post[0]?.author).toEqual({
      kind: "agent",
      conversationId: source.conversationId,
      conversationName: source.conversationName,
      projectName: source.projectName,
      scope: "session",
      sessionName: "session-one",
      backend: source.backend,
      redactedProfileSnapshot: redactAgentProfileSnapshot(SNAPSHOT_FIXTURE),
    });
    expect(bodyText).not.toContain(PROFILE_SECRET_SENTINEL);
    expect(bodyText).not.toContain("transcriptPath");
    expect(bodyText).not.toContain("backendRef");
    expect(bodyText).not.toContain("worktreePath");
  });

  it("persists project provenance without inventing a session name", async () => {
    const source = conversation("project");
    const { handlers, captured } = makeHarness({
      auth: { kind: "valid" },
      conversation: source,
    });
    const response = await handlers.postPOST(
      jsonRequest(
        BASE,
        { bodyMarkdown: "Project-level progress." },
        { "x-cc-conversation-id": source.conversationId },
      ),
      context(),
    );

    expect(response.status).toBe(201);
    expect(captured.post[0]?.author).toEqual({
      kind: "agent",
      conversationId: source.conversationId,
      conversationName: source.conversationName,
      projectName: source.projectName,
      scope: "project",
      backend: source.backend,
      redactedProfileSnapshot: redactAgentProfileSnapshot(SNAPSHOT_FIXTURE),
    });
    expect(captured.post[0]?.author).not.toHaveProperty("sessionName");
  });

  it("rejects invalid authentication before parsing or resolving post provenance", async () => {
    const { handlers, captured } = makeHarness({ auth: { kind: "invalid" } });
    const response = await handlers.postPOST(
      new Request(BASE, {
        method: "POST",
        headers: { "x-cc-conversation-id": "conversation-agent-1" },
        body: "not-json",
      }),
      context(),
    );

    expect(response.status).toBe(401);
    expect(captured.conversationIds).toEqual([]);
    expect(captured.post).toEqual([]);
  });

  it.each([
    ["non-object JSON", [], ""],
    ["empty body", { bodyMarkdown: "   " }, "bodyMarkdown"],
    [
      "caller-owned author",
      { bodyMarkdown: "Progress", author: { kind: "user" } },
      "author",
    ],
  ])("rejects a status post with %s", async (_label, body, issuePath) => {
    const { handlers, captured } = makeHarness();
    const response = await handlers.postPOST(
      jsonRequest(BASE, body),
      context(),
    );
    const payload = (await response.json()) as {
      code: string;
      issues: Array<{ path: string }>;
    };

    expect(response.status).toBe(400);
    expect(payload.code).toBe("validation_failed");
    if (issuePath !== "") {
      expect(
        payload.issues.some((issue) => issue.path.startsWith(issuePath)),
      ).toBe(true);
    }
    expect(captured.post).toEqual([]);
  });

  it("gets a full update by a strictly parsed id", async () => {
    const { handlers, captured } = makeHarness();
    const response = await handlers.resolveGET(
      new Request(`${BASE}/${update.id}`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(ticketStatusUpdateSchema.parse(await response.json())).toEqual(
      update,
    );
    expect(captured.get).toEqual([
      { projectName: PROJECT_NAME, number: 7, updateId: update.id },
    ]);
  });

  it("returns a stable 404 when the update is absent from an existing ticket", async () => {
    const { handlers } = makeHarness({
      service: {
        async get() {
          return { ok: true, value: null };
        },
      },
    });
    const response = await handlers.resolveGET(
      new Request(`${BASE}/missing-update`),
      context({ updateId: "missing-update" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Status update not found on alpha#7: missing-update",
      code: "status_update_not_found",
      details: {
        identifier: "alpha#7",
        updateId: "missing-update",
      },
    });
  });

  it("rejects an invalid ticket number or empty update id before lookup", async () => {
    const { handlers, captured } = makeHarness();
    const invalidNumber = await handlers.resolveGET(
      new Request(`${BASE}/${update.id}`),
      context({ number: "seven" }),
    );
    const emptyId = await handlers.resolveGET(
      new Request(`${BASE}/empty`),
      context({ updateId: "" }),
    );

    expect(invalidNumber.status).toBe(400);
    expect(emptyId.status).toBe(400);
    expect(captured.get).toEqual([]);
  });
});
