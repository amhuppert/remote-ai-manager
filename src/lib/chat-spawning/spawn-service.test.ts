import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createChatSpawnService,
  createSpawnSessionCreator,
  type ChatSpawnDeps,
  type SpawnSessionCreatorDeps,
} from "./spawn-service";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import type { ProposedSession, SpawnProposal } from "./schemas";

const COMMITTED_HEAD = "deadbeefcafedeadbeefcafedeadbeefcafe0000";

function makeSession(name: string): SessionState {
  return sessionStateSchema.parse({
    sessionName: name,
    worktreePath: `/wt/${name}`,
    branchName: `csm/${name}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    conversations: [
      {
        id: `${name}-conv`,
        scope: "session",
        transcriptPath: null,
        status: "new",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
    ],
  });
}

function proposed(overrides: Partial<ProposedSession>): ProposedSession {
  return {
    name: "alpha",
    target: "main",
    agent: "claude",
    mode: "fast",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ChatSpawnDeps> = {}): ChatSpawnDeps {
  return {
    createSession: vi
      .fn()
      .mockImplementation(async ({ proposed: p }) => makeSession(p.name)),
    resolveCommittedHeadBase: vi.fn().mockResolvedValue(COMMITTED_HEAD),
    setSessionSpawnedFrom: vi.fn().mockResolvedValue(undefined),
    addPlcSpawnedSessionIds: vi.fn().mockResolvedValue(undefined),
    dispatchFirstTurn: vi.fn().mockResolvedValue({ dispatched: true }),
    broadcast: vi.fn(),
    ...overrides,
  };
}

describe("createChatSpawnService.createFromProposal", () => {
  it("keeps successes and records failures without rolling back the batch", async () => {
    const createSession = vi
      .fn()
      .mockImplementation(async ({ proposed: p }) => {
        if (p.name === "beta") throw new Error("duplicate name");
        return makeSession(p.name);
      });
    const deps = makeDeps({ createSession });
    const service = createChatSpawnService(deps);

    const proposal: SpawnProposal = {
      sessions: [
        proposed({ name: "alpha", initialPrompt: "go alpha" }),
        proposed({ name: "beta", initialPrompt: "go beta" }),
      ],
    };

    const result = await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal,
    });

    expect(result.created.map((c) => c.name)).toEqual(["alpha"]);
    expect(result.failed.map((f) => f.name)).toEqual(["beta"]);
    expect(result.failed[0]!.error).toContain("duplicate name");
    expect(result.created[0]!.initialPromptDispatched).toBe(true);

    // A's prompt dispatched; B's dropped (dispatcher never called for B).
    expect(deps.dispatchFirstTurn).toHaveBeenCalledTimes(1);
    const dispatchCall = (deps.dispatchFirstTurn as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0];
    expect(dispatchCall.session.sessionName).toBe("alpha");
    expect(dispatchCall.initialPrompt).toBe("go alpha");

    // A tagged + back-linked; B excluded from the back-link.
    expect(deps.setSessionSpawnedFrom).toHaveBeenCalledTimes(1);
    expect(deps.setSessionSpawnedFrom).toHaveBeenCalledWith("/repo", "alpha", {
      source: "chat",
      projectName: "repo",
      conversationId: "plc-1",
    });
    expect(deps.addPlcSpawnedSessionIds).toHaveBeenCalledWith(
      "/repo",
      "plc-1",
      ["alpha"],
    );
  });

  it("passes the committed-HEAD ref as baseBranch to every creation", async () => {
    const deps = makeDeps();
    const service = createChatSpawnService(deps);
    await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: { sessions: [proposed({ name: "alpha" })] },
    });
    const call = (deps.createSession as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.baseBranch).toBe(COMMITTED_HEAD);
  });

  it("forwards the proposed model + reasoning effort to the dispatcher", async () => {
    const deps = makeDeps();
    const service = createChatSpawnService(deps);
    await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: {
        sessions: [
          proposed({
            name: "alpha",
            agent: "codex",
            model: "gpt-5.4",
            reasoningEffort: "high",
            initialPrompt: "go",
          }),
        ],
      },
    });
    const call = (deps.dispatchFirstTurn as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.model).toBe("gpt-5.4");
    expect(call.reasoningEffort).toBe("high");
  });

  it("routes a dual proposal's first turn through the dispatcher", async () => {
    const deps = makeDeps();
    const service = createChatSpawnService(deps);
    await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: {
        sessions: [
          proposed({ name: "alpha", agent: "dual", initialPrompt: "race it" }),
        ],
      },
    });
    const call = (deps.dispatchFirstTurn as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.agent).toBe("dual");
    expect(call.initialPrompt).toBe("race it");
  });

  it("does not dispatch when a session carries no initial prompt", async () => {
    const deps = makeDeps();
    const service = createChatSpawnService(deps);
    const result = await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: { sessions: [proposed({ name: "alpha" })] },
    });
    expect(deps.dispatchFirstTurn).not.toHaveBeenCalled();
    expect(result.created[0]!.initialPromptDispatched).toBe(false);
  });

  it("broadcasts a spawn-result event scoped to the project + conversation", async () => {
    const deps = makeDeps();
    const service = createChatSpawnService(deps);
    await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: { sessions: [proposed({ name: "alpha" })] },
    });
    expect(deps.broadcast).toHaveBeenCalledTimes(1);
    const event = (deps.broadcast as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(event.type).toBe("spawn-result");
    expect(event.scope).toBe("project");
    expect(event.conversationId).toBe("plc-1");
    expect(event.result.created).toHaveLength(1);
  });

  it("does not write a back-link when every session fails", async () => {
    const deps = makeDeps({
      createSession: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const service = createChatSpawnService(deps);
    const result = await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: { sessions: [proposed({ name: "alpha" })] },
    });
    expect(result.created).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(deps.addPlcSpawnedSessionIds).not.toHaveBeenCalled();
  });

  it("routes an optimistic session's first turn through the shared dispatcher (mode-independent)", async () => {
    const deps = makeDeps();
    const service = createChatSpawnService(deps);
    const result = await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: {
        sessions: [
          proposed({ name: "alpha", mode: "optimistic", initialPrompt: "run" }),
        ],
      },
    });
    // The dispatcher — not the optimistic auto-run workflow — delivers the turn.
    expect(deps.dispatchFirstTurn).toHaveBeenCalledTimes(1);
    const call = (deps.dispatchFirstTurn as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.initialPrompt).toBe("run");
    expect(call.agent).toBe("claude");
    expect(result.created[0]!.initialPromptDispatched).toBe(true);
  });

  it("routes a codex optimistic session through the dispatcher (backend honored, no auto-run)", async () => {
    const deps = makeDeps();
    const service = createChatSpawnService(deps);
    await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: {
        sessions: [
          proposed({
            name: "alpha",
            mode: "optimistic",
            agent: "codex",
            initialPrompt: "run",
          }),
        ],
      },
    });
    const call = (deps.dispatchFirstTurn as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(call.agent).toBe("codex");
  });

  it("leaves an optimistic session with no initial prompt idle (no dispatch)", async () => {
    const deps = makeDeps();
    const service = createChatSpawnService(deps);
    const result = await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: {
        sessions: [proposed({ name: "alpha", mode: "optimistic" })],
      },
    });
    expect(deps.dispatchFirstTurn).not.toHaveBeenCalled();
    expect(result.created[0]!.initialPromptDispatched).toBe(false);
  });
});

describe("createSpawnSessionCreator (New-Session parity mapping)", () => {
  function makeCreatorDeps(): SpawnSessionCreatorDeps {
    return {
      createSpawnedSession: vi
        .fn()
        .mockImplementation(async (_projectPath, input) =>
          makeSession(input.name),
        ),
    };
  }

  it("honors the proposed name, target, and mode (fast) and omits an explicit branch", async () => {
    const deps = makeCreatorDeps();
    const createSession = createSpawnSessionCreator(deps);
    await createSession({
      projectPath: "/repo",
      proposed: proposed({
        name: "alpha",
        mode: "fast",
        target: "develop",
      }),
      baseBranch: COMMITTED_HEAD,
    });
    // No `branch`: createSpawnedSession derives it from the name, exactly as the
    // New Session dialog does.
    expect(deps.createSpawnedSession).toHaveBeenCalledWith("/repo", {
      name: "alpha",
      targetBranch: "develop",
      mode: "fast",
      baseBranch: COMMITTED_HEAD,
      objective: null,
    });
  });

  it("seeds the focus objective from the initial prompt (or name) without an explicit branch", async () => {
    const deps = makeCreatorDeps();
    const createSession = createSpawnSessionCreator(deps);
    await createSession({
      projectPath: "/repo",
      proposed: proposed({
        name: "alpha",
        mode: "focus",
        initialPrompt: "the objective",
      }),
      baseBranch: COMMITTED_HEAD,
    });
    expect(deps.createSpawnedSession).toHaveBeenCalledWith("/repo", {
      name: "alpha",
      targetBranch: "main",
      mode: "focus",
      baseBranch: COMMITTED_HEAD,
      objective: "the objective",
    });
  });

  it("maps optimistic without firing an auto-run (objective seeded from the prompt)", async () => {
    const deps = makeCreatorDeps();
    const createSession = createSpawnSessionCreator(deps);
    await createSession({
      projectPath: "/repo",
      proposed: proposed({
        name: "alpha",
        mode: "optimistic",
        initialPrompt: "do the work",
      }),
      baseBranch: COMMITTED_HEAD,
    });
    expect(deps.createSpawnedSession).toHaveBeenCalledWith("/repo", {
      name: "alpha",
      targetBranch: "main",
      mode: "optimistic",
      baseBranch: COMMITTED_HEAD,
      objective: "do the work",
    });
  });
});
