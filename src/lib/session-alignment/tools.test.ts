/**
 * Tests for the agent-facing alignment MCP tools (`write_session_charter`,
 * `propose_decisions`).
 *
 * The two core behaviors — filling the open draft and persisting a pending
 * proposal batch — run against the REAL `SessionAlignmentService` over a real
 * `:memory:` store (`createPersistenceFixture().db` + `createSessionAlignmentRepo`),
 * and assert on state READ BACK through the real repo. This is the higher-fidelity
 * approach: a tool that silently dropped its write would still pass against a
 * recording fake, but fails here because the round-tripped state would be wrong.
 *
 * The refusal paths (no runtime / autonomous turn / empty input) short-circuit
 * before any service call, so they assert on the result and on the service not
 * being touched, using a recording service double for "no service call".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetForTesting as resetRuntimeRegistry,
  conversationRuntimeKey,
  type ConversationRuntimeState,
} from "@/lib/workflows/conversation/runtime-state";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  createSessionAlignmentRepo,
  type SessionAlignmentRepo,
} from "@/lib/session-alignment/repo";
import {
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
} from "@/lib/session-alignment/render";
import {
  createSessionAlignmentService,
  type SessionAlignmentService,
} from "@/lib/session-alignment/service";
import type { CharterMirrorWriteResult } from "@/lib/session-alignment/mirror";

import {
  registerSessionAlignmentTools,
  type SessionAlignmentToolDeps,
} from "./tools";

type ToolHandler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

interface CapturedTool {
  name: string;
  config: { description?: string; inputSchema?: unknown };
  handler: ToolHandler;
}

function createCapturingServer(tools: Map<string, CapturedTool>) {
  return {
    registerTool(name: string, config: unknown, handler: ToolHandler): void {
      tools.set(name, {
        name,
        config: config as CapturedTool["config"],
        handler,
      });
    },
  };
}

const PROJECT_PATH = "/projects/test";
const SESSION_NAME = "test-session";
const WORKTREE_PATH = "/projects/test/.worktrees/test-session";
const CONVERSATION_ID = "conv-1";
const runtimeKey = conversationRuntimeKey(
  PROJECT_PATH,
  SESSION_NAME,
  CONVERSATION_ID,
);

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

/** Build the real service over a fresh fixture, with a recording mirror. */
function makeRealService(fixture: PersistenceFixture): {
  service: SessionAlignmentService;
  repo: SessionAlignmentRepo;
} {
  const repo = createSessionAlignmentRepo(fixture.db);
  let idCounter = 0;
  let clock = 0;
  const service = createSessionAlignmentService({
    repo,
    render: {
      renderAlignmentPromptSection,
      computeAlignmentHash,
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: {
      async write(): Promise<CharterMirrorWriteResult> {
        return { ok: true, filePath: ".cc/session-alignment/charter.md" };
      },
    },
    broadcast() {},
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
  return { service, repo };
}

/** Deps wired to a real service plus a controllable runtime. */
function realDeps(
  service: SessionAlignmentService,
  runtime: ConversationRuntimeState | undefined,
): SessionAlignmentToolDeps {
  return {
    getRuntime: (key) => (key === runtimeKey ? runtime : undefined),
    beginDraft: service.beginDraft,
    fillDraft: service.fillDraft,
    proposeDecisions: service.proposeDecisions,
  };
}

function registerTools(
  deps: SessionAlignmentToolDeps,
): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  registerSessionAlignmentTools(
    createCapturingServer(tools) as never,
    {
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    },
    deps,
  );
  return tools;
}

function handlerFor(deps: SessionAlignmentToolDeps, name: string): ToolHandler {
  const tool = registerTools(deps).get(name);
  if (!tool) {
    throw new Error(`${name} tool was not registered`);
  }
  return tool.handler;
}

describe("session-alignment tools", () => {
  beforeEach(() => {
    resetRuntimeRegistry();
  });
  afterEach(() => {
    resetRuntimeRegistry();
  });

  describe("registration", () => {
    it("registers exactly the two alignment tool names", () => {
      const tools = registerTools({
        getRuntime: () => undefined,
        beginDraft: vi.fn(),
        fillDraft: vi.fn(),
        proposeDecisions: vi.fn(),
      });
      expect([...tools.keys()].sort()).toEqual([
        "propose_decisions",
        "write_session_charter",
      ]);
    });
  });

  describe("write_session_charter (real service over real store)", () => {
    let fixture: PersistenceFixture;

    beforeEach(() => {
      fixture = createPersistenceFixture();
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME, {
        creationMode: "normal",
      });
    });
    afterEach(() => {
      fixture.close();
    });

    it("fills the session's open draft with the content", async () => {
      const { service, repo } = makeRealService(fixture);
      const begun = await service.beginDraft({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
      });

      const runtime = createRuntimeState();
      const handler = handlerFor(
        realDeps(service, runtime),
        "write_session_charter",
      );

      const result = await handler({ content: "## Mission\nShip the thing." });

      expect(result.isError).toBeFalsy();
      const draft = repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
      expect(draft?.id).toBe(begun.draftId);
      expect(draft?.content).toBe("## Mission\nShip the thing.");
      // `/align` draft is not auto-activate: it stays pending approval.
      expect(result.content[0]?.text).toMatch(/pending/i);
      expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    });

    it("defensively creates a gated draft when none is open, then fills it", async () => {
      const { service, repo } = makeRealService(fixture);
      // No beginDraft called: there is no open draft.
      expect(repo.findDraftVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();

      const runtime = createRuntimeState();
      const handler = handlerFor(
        realDeps(service, runtime),
        "write_session_charter",
      );

      const result = await handler({ content: "Defensive charter body." });

      expect(result.isError).toBeFalsy();
      const draft = repo.findDraftVersion(PROJECT_PATH, SESSION_NAME);
      expect(draft).not.toBeNull();
      expect(draft?.content).toBe("Defensive charter body.");
      expect(draft?.status).toBe("draft");
      expect(draft?.autoActivate).toBe(false);
      // The defensively-created draft is gated, not active.
      expect(repo.findActiveVersion(PROJECT_PATH, SESSION_NAME)).toBeNull();
    });

    it("reports activation when the open draft auto-activates", async () => {
      const { service, repo } = makeRealService(fixture);
      // Seed an auto-activate (decision-origin) draft directly so the tool's
      // fill activates it on the spot.
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

      const runtime = createRuntimeState();
      const handler = handlerFor(
        realDeps(service, runtime),
        "write_session_charter",
      );

      const result = await handler({ content: "Auto-activated content." });

      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toMatch(/activated as version 1/i);
      const active = repo.findActiveVersion(PROJECT_PATH, SESSION_NAME);
      expect(active?.version).toBe(1);
      expect(active?.content).toBe("Auto-activated content.");
    });
  });

  describe("propose_decisions (real service over real store)", () => {
    let fixture: PersistenceFixture;

    beforeEach(() => {
      fixture = createPersistenceFixture();
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME, {
        creationMode: "normal",
      });
    });
    afterEach(() => {
      fixture.close();
    });

    it("stores a durable pending batch and returns immediately (non-blocking)", async () => {
      const { service, repo } = makeRealService(fixture);
      const runtime = createRuntimeState();
      const handler = handlerFor(
        realDeps(service, runtime),
        "propose_decisions",
      );

      const result = await handler({
        decisions: [
          { statement: "Use SQLite", rationale: "Simplicity" },
          { statement: "No focus mode" },
        ],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0]?.text).toMatch(/2/);

      const batches = repo.findPendingProposalBatches(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]?.proposals).toHaveLength(2);
      const statements = batches[0]?.proposals.map((p) => p.statement).sort();
      expect(statements).toEqual(["No focus mode", "Use SQLite"]);
      // Non-blocking: the resolver is never installed.
      expect(runtime.activeQuestionResolver).toBeUndefined();
    });

    it("persists the current turn message id as the proposal source", async () => {
      const { service, repo } = makeRealService(fixture);
      const runtime = createRuntimeState();
      (
        runtime as ConversationRuntimeState & { currentTurnMessageId: string }
      ).currentTurnMessageId = "msg-turn-1";
      const handler = handlerFor(
        realDeps(service, runtime),
        "propose_decisions",
      );

      const result = await handler({
        decisions: [{ statement: "Document approved API constraints" }],
      });

      expect(result.isError).toBeFalsy();
      const batches = repo.findPendingProposalBatches(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(batches[0]?.proposals[0]?.originMessageId).toBe("msg-turn-1");
    });
  });

  describe("gating: refusals short-circuit before any service work", () => {
    function recordingDeps(runtime: ConversationRuntimeState | undefined): {
      deps: SessionAlignmentToolDeps;
      calls: {
        beginDraft: number;
        fillDraft: number;
        proposeDecisions: number;
      };
    } {
      const calls = { beginDraft: 0, fillDraft: 0, proposeDecisions: 0 };
      const deps: SessionAlignmentToolDeps = {
        getRuntime: (key) => (key === runtimeKey ? runtime : undefined),
        async beginDraft() {
          calls.beginDraft += 1;
          return { authoringPrompt: "", draftId: "x" };
        },
        async fillDraft() {
          calls.fillDraft += 1;
          return { status: "draft_ready", version: null };
        },
        async proposeDecisions() {
          calls.proposeDecisions += 1;
          return { batchId: "b" };
        },
      };
      return { deps, calls };
    }

    it("write_session_charter refuses with no runtime and does no work", async () => {
      const { deps, calls } = recordingDeps(undefined);
      const handler = handlerFor(deps, "write_session_charter");
      const result = await handler({ content: "x" });
      expect(result.isError).toBe(true);
      expect(calls.fillDraft + calls.beginDraft).toBe(0);
    });

    it("propose_decisions refuses with no runtime and does no work", async () => {
      const { deps, calls } = recordingDeps(undefined);
      const handler = handlerFor(deps, "propose_decisions");
      const result = await handler({ decisions: [{ statement: "x" }] });
      expect(result.isError).toBe(true);
      expect(calls.proposeDecisions).toBe(0);
    });

    it("write_session_charter refuses on an autonomous turn", async () => {
      const runtime = createRuntimeState({ currentTurnAutonomous: true });
      const { deps, calls } = recordingDeps(runtime);
      const handler = handlerFor(deps, "write_session_charter");
      const result = await handler({ content: "x" });
      expect(result.isError).toBe(true);
      expect(calls.fillDraft + calls.beginDraft).toBe(0);
    });

    it("propose_decisions refuses on an autonomous turn", async () => {
      const runtime = createRuntimeState({ currentTurnAutonomous: true });
      const { deps, calls } = recordingDeps(runtime);
      const handler = handlerFor(deps, "propose_decisions");
      const result = await handler({ decisions: [{ statement: "x" }] });
      expect(result.isError).toBe(true);
      expect(calls.proposeDecisions).toBe(0);
    });

    it("write_session_charter rejects empty content with no service call", async () => {
      const runtime = createRuntimeState();
      const { deps, calls } = recordingDeps(runtime);
      const handler = handlerFor(deps, "write_session_charter");
      const result = await handler({ content: "" });
      expect(result.isError).toBe(true);
      expect(calls.fillDraft + calls.beginDraft).toBe(0);
    });

    it("propose_decisions rejects an empty array with no service call", async () => {
      const runtime = createRuntimeState();
      const { deps, calls } = recordingDeps(runtime);
      const handler = handlerFor(deps, "propose_decisions");
      const result = await handler({ decisions: [] });
      expect(result.isError).toBe(true);
      expect(calls.proposeDecisions).toBe(0);
    });
  });
});
