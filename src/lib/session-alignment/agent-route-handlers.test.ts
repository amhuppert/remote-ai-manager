/**
 * Tests for the agent-facing alignment submission endpoints
 * (`POST /alignment/charter`, `POST /alignment/decisions`).
 *
 * The endpoints run the REAL `SessionAlignmentService` over a real `:memory:`
 * store and assert on state READ BACK through the real repo.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAuth } from "@/lib/agent-gateway/token";
import type { SessionAlignmentUpdatedEvent } from "@/lib/session-alignment/schemas";
import {
  createSessionAlignmentRepo,
  type SessionAlignmentRepo,
} from "@/lib/session-alignment/repo";
import {
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
  usesDigestPointer,
} from "@/lib/session-alignment/render";
import {
  createSessionAlignmentService,
  type SessionAlignmentService,
} from "@/lib/session-alignment/service";
import type { CharterMirrorWriteResult } from "@/lib/session-alignment/mirror";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  _resetForTesting as resetRuntimeRegistry,
  conversationRuntimeKey,
  type ConversationRuntimeState,
} from "@/lib/workflows/conversation/runtime-state";

import {
  createSessionAlignmentAgentRouteHandlers,
  type SessionAlignmentAgentRouteDeps,
} from "./agent-route-handlers";

const PROJECT_NAME = "repo";
const PROJECT_PATH = "/projects/test";
const SESSION_NAME = "test-session";
const WORKTREE_PATH = "/projects/test/.worktrees/test-session";
const CONVERSATION_ID = "conv-1";
const runtimeKey = conversationRuntimeKey(
  PROJECT_PATH,
  SESSION_NAME,
  CONVERSATION_ID,
);

/** Auth that accepts only the exact bearer token, mirroring the real gate. */
function tokenAuth(expected: string): AgentAuth {
  return {
    async requireToken(request: Request): Promise<Response | null> {
      const header = request.headers.get("authorization");
      if (header === `Bearer ${expected}`) return null;
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      });
    },
    async validateOptionalToken(request: Request) {
      const header = request.headers.get("authorization");
      if (header === null) return { kind: "absent" as const };
      if (header === `Bearer ${expected}`) return { kind: "valid" as const };
      return { kind: "invalid" as const };
    },
  };
}

function createRuntimeState(
  overrides: Partial<ConversationRuntimeState> = {},
): ConversationRuntimeState {
  return {
    abortController: new AbortController(),
    sendToMachine: vi.fn(),
    streamEmit: vi.fn(),
    ...overrides,
  };
}

/** Build the real service over a fresh fixture, recording broadcast events. */
function makeRealService(fixture: PersistenceFixture): {
  service: SessionAlignmentService;
  repo: SessionAlignmentRepo;
  events: SessionAlignmentUpdatedEvent[];
} {
  const repo = createSessionAlignmentRepo(fixture.db);
  const events: SessionAlignmentUpdatedEvent[] = [];
  let idCounter = 0;
  let clock = 0;
  const service = createSessionAlignmentService({
    repo,
    render: {
      renderAlignmentPromptSection,
      computeAlignmentHash,
      usesDigestPointer,
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: {
      async write(): Promise<CharterMirrorWriteResult> {
        return { ok: true, filePath: ".cc/session-alignment/charter.md" };
      },
    },
    snapshot: {
      write() {
        return Promise.resolve({
          filePath: ".cc/session-alignment/snapshots/frozen.md",
          created: true,
        });
      },
    },
    broadcast(event) {
      events.push(event as SessionAlignmentUpdatedEvent);
      return { delivered: true };
    },
    promptQueue: {
      async enqueue() {},
    },
    loadSession(projectPath, sessionName) {
      return Promise.resolve(
        projectPath === PROJECT_PATH && sessionName === SESSION_NAME
          ? { worktreePath: WORKTREE_PATH, creationMode: "normal" as const }
          : null,
      );
    },
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
  });
  return { service, repo, events };
}

function makeAgentDeps(
  service: SessionAlignmentService,
  runtime: ConversationRuntimeState | undefined,
  overrides: Partial<SessionAlignmentAgentRouteDeps> = {},
): SessionAlignmentAgentRouteDeps {
  return {
    auth: tokenAuth("good-token"),
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    getSession: async (projectPath, sessionName) =>
      projectPath === PROJECT_PATH && sessionName === SESSION_NAME
        ? { sessionName }
        : null,
    getRuntime: (key) => (key === runtimeKey ? runtime : undefined),
    beginDraft: service.beginDraft,
    fillDraft: service.fillDraft,
    proposeDecisions: service.proposeDecisions,
    ...overrides,
  };
}

function makeRequest(body?: unknown, token = "good-token"): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${PROJECT_NAME}/sessions/${SESSION_NAME}/alignment/charter`,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
    },
  );
}

function makeContext(name = PROJECT_NAME, session = SESSION_NAME) {
  return { params: Promise.resolve({ name, session }) };
}

describe("session-alignment agent route handlers", () => {
  let fixture: PersistenceFixture;

  beforeEach(() => {
    resetRuntimeRegistry();
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME, { creationMode: "normal" });
  });
  afterEach(() => {
    resetRuntimeRegistry();
    fixture.close();
  });

  describe("POST /alignment/charter", () => {
    it("fills the session's open draft and persists the content", async () => {
      const { service, repo } = makeRealService(fixture);
      const begun = await service.beginDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
      });
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );

      const response = await handlers.writeCharter(
        makeRequest({
          conversationId: CONVERSATION_ID,
          content: "## Mission\nShip the thing.",
        }),
        makeContext(),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "draft_ready",
        version: null,
      });
      const draft = repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
      expect(draft?.id).toBe(begun.draftId);
      expect(draft?.content).toBe("## Mission\nShip the thing.");
      expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    });

    it("defensively creates a gated draft when none is open, then fills it", async () => {
      const { service, repo } = makeRealService(fixture);
      expect(repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );

      const response = await handlers.writeCharter(
        makeRequest({
          conversationId: CONVERSATION_ID,
          content: "Defensive charter body.",
        }),
        makeContext(),
      );

      expect(response.status).toBe(200);
      const draft = repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
      expect(draft?.content).toBe("Defensive charter body.");
      expect(draft?.status).toBe("draft");
      expect(draft?.autoActivate).toBe(false);
      expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    });

    it("activates and broadcasts when the open draft auto-activates", async () => {
      const { service, repo, events } = makeRealService(fixture);
      repo.insertVersion(PROJECT_PATH, SESSION_NAME, {
        id: "draft-auto",
        version: null,
        content: "",
        contentHash: "",
        status: "draft",
        source: "decision",
        authorConversationId: CONVERSATION_ID,
        autoActivate: true,
        linkedDecisionIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        activatedAt: null,
        approver: null,
      });
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );

      const response = await handlers.writeCharter(
        makeRequest({
          conversationId: CONVERSATION_ID,
          content: "Auto-activated content.",
        }),
        makeContext(),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        status: "activated",
        version: 1,
      });
      expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)?.version).toBe(
        1,
      );
      expect(events.at(-1)).toMatchObject({
        type: "session-alignment-updated",
        activeVersion: 1,
        hasDraft: false,
      });
    });

    it("rejects a missing/invalid token with 401 and does no work", async () => {
      const { service, repo } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );

      const response = await handlers.writeCharter(
        makeRequest(
          { conversationId: CONVERSATION_ID, content: "x" },
          "wrong-token",
        ),
        makeContext(),
      );

      expect(response.status).toBe(401);
      expect(repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    });

    it("returns 404 when the project cannot be resolved", async () => {
      const { service } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );
      const response = await handlers.writeCharter(
        makeRequest({ conversationId: CONVERSATION_ID, content: "x" }),
        makeContext("unknown-project"),
      );
      expect(response.status).toBe(404);
    });

    it("returns 400 for a body missing content", async () => {
      const { service } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );
      const response = await handlers.writeCharter(
        makeRequest({ conversationId: CONVERSATION_ID }),
        makeContext(),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        issues: { path: string }[];
      };
      expect(body.issues.map((i) => i.path)).toContain("content");
    });

    it("returns 400 for whitespace-only charter content without filling the draft", async () => {
      const { service, repo } = makeRealService(fixture);
      const begun = await service.beginDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
      });
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );

      const response = await handlers.writeCharter(
        makeRequest({
          conversationId: CONVERSATION_ID,
          content: " \n\t",
        }),
        makeContext(),
      );

      expect(response.status).toBe(400);
      expect(repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toMatchObject({
        id: begun.draftId,
        content: "",
      });
      expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    });

    it("refuses an autonomous turn with 403 and does no work", async () => {
      const { service, repo } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(
          service,
          createRuntimeState({ currentTurnAutonomous: true }),
        ),
      );
      const response = await handlers.writeCharter(
        makeRequest({ conversationId: CONVERSATION_ID, content: "x" }),
        makeContext(),
      );
      expect(response.status).toBe(403);
      expect(repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    });

    it("refuses with 409 when there is no active runtime", async () => {
      const { service, repo } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, undefined),
      );
      const response = await handlers.writeCharter(
        makeRequest({ conversationId: CONVERSATION_ID, content: "x" }),
        makeContext(),
      );
      expect(response.status).toBe(409);
      expect(repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    });
  });

  describe("POST /alignment/decisions", () => {
    it("rejects a missing/invalid token with 401 and does no work", async () => {
      const { service, repo } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );

      const response = await handlers.proposeDecisions(
        makeRequest(
          {
            conversationId: CONVERSATION_ID,
            decisions: [{ statement: "Use SQLite" }],
          },
          "wrong-token",
        ),
        makeContext(),
      );

      expect(response.status).toBe(401);
      expect(
        repo.findPendingProposalBatches(PROJECT_PATH, SESSION_NAME),
      ).toHaveLength(0);
    });

    it("stores a durable pending batch and returns the count", async () => {
      const { service, repo } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );

      const response = await handlers.proposeDecisions(
        makeRequest({
          conversationId: CONVERSATION_ID,
          decisions: [
            { statement: "Use SQLite", rationale: "Simplicity" },
            { statement: "No focus mode" },
          ],
        }),
        makeContext(),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        count: 2,
      });
      const batches = repo.findPendingProposalBatches(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]?.proposals).toHaveLength(2);
      expect(batches[0]?.proposals.map((p) => p.statement).sort()).toEqual([
        "No focus mode",
        "Use SQLite",
      ]);
    });

    it("persists the current turn message id as the proposal source", async () => {
      const { service, repo } = makeRealService(fixture);
      const runtime = createRuntimeState({
        currentTurnMessageId: "msg-turn-1",
      });
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, runtime),
      );

      const response = await handlers.proposeDecisions(
        makeRequest({
          conversationId: CONVERSATION_ID,
          decisions: [{ statement: "Document approved API constraints" }],
        }),
        makeContext(),
      );

      expect(response.status).toBe(200);
      const batches = repo.findPendingProposalBatches(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(batches[0]?.proposals[0]?.originMessageId).toBe("msg-turn-1");
    });

    it("returns 400 for an empty decisions array with no service work", async () => {
      const { service, repo } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(service, createRuntimeState()),
      );
      const response = await handlers.proposeDecisions(
        makeRequest({ conversationId: CONVERSATION_ID, decisions: [] }),
        makeContext(),
      );
      expect(response.status).toBe(400);
      expect(
        repo.findPendingProposalBatches(PROJECT_PATH, SESSION_NAME),
      ).toHaveLength(0);
    });

    it("refuses an autonomous turn with 403 and does no work", async () => {
      const { service, repo } = makeRealService(fixture);
      const handlers = createSessionAlignmentAgentRouteHandlers(
        makeAgentDeps(
          service,
          createRuntimeState({ currentTurnAutonomous: true }),
        ),
      );
      const response = await handlers.proposeDecisions(
        makeRequest({
          conversationId: CONVERSATION_ID,
          decisions: [{ statement: "x" }],
        }),
        makeContext(),
      );
      expect(response.status).toBe(403);
      expect(
        repo.findPendingProposalBatches(PROJECT_PATH, SESSION_NAME),
      ).toHaveLength(0);
    });
  });
});
