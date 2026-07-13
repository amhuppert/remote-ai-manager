import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  withTracing: (handler: unknown) => handler,
}));

import { validateProposal } from "./proposal-validator";
import { createChatSpawnService } from "./spawn-service";
import {
  createFirstTurnDispatcher,
  type FirstTurnDispatcherDeps,
} from "@/lib/prompt/first-turn-dispatch";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";

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

describe("chat-spawning usable without the cockpit UI", () => {
  it("drives validateProposal → createChatSpawnService → real dispatcher end-to-end via DI", async () => {
    // The proposal arrives as untrusted agent output; validate it.
    const validation = validateProposal({
      sessions: [
        {
          name: "alpha",
          agent: "claude",
          mode: "normal",
          initialPrompt: "go",
        },
      ],
    });
    expect(validation.kind).toBe("valid");
    if (validation.kind !== "valid") return;

    // The REAL first-turn dispatcher (not a fake) composes into the service —
    // proving the dispatcher primitive functions against the foundation alone.
    const executePromptStream = vi.fn().mockResolvedValue({
      conversationId: "alpha-conv",
      contextTokens: null,
      contextWindowMax: null,
    });
    const dispatcherDeps: FirstTurnDispatcherDeps = {
      executePromptStream,
      startDualRace: vi.fn().mockResolvedValue(undefined),
      isConversationBusy: vi.fn().mockReturnValue(false),
    };
    const dispatcher = createFirstTurnDispatcher(dispatcherDeps);

    const addPlcSpawnedSessionIds = vi.fn().mockResolvedValue(undefined);
    const service = createChatSpawnService({
      createSession: vi
        .fn()
        .mockImplementation(async ({ proposed }) => makeSession(proposed.name)),
      resolveCommittedHeadBase: vi.fn().mockResolvedValue("HEADSHA"),
      setSessionSpawnedFrom: vi.fn().mockResolvedValue(undefined),
      addPlcSpawnedSessionIds,
      dispatchFirstTurn: dispatcher.dispatchFirstTurn,
      broadcast: vi.fn(),
    });

    const result = await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: validation.proposal,
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.initialPromptQueued).toBe(true);
    // The real dispatcher routed the first turn through executePromptStream.
    expect(executePromptStream).toHaveBeenCalledTimes(1);
    // The PLC back-link is written through the injected foundation write path.
    expect(addPlcSpawnedSessionIds).toHaveBeenCalledWith("/repo", "plc-1", [
      "alpha",
    ]);
  });

  it("delivers an image-only dual proposal to the collaboration boundary with a valid brief", async () => {
    const validation = validateProposal({
      sessions: [
        {
          name: "image-race",
          agent: "dual",
          mode: "normal",
          images: [
            {
              attachmentId: "image-1",
              mediaType: "image/png",
              base64Data: "one",
            },
          ],
        },
      ],
    });
    expect(validation.kind).toBe("valid");
    if (validation.kind !== "valid") return;

    const startDualRace = vi.fn().mockImplementation(async ({ brief }) => {
      if (brief.trim().length === 0) throw new Error("brief required");
    });
    const dispatcher = createFirstTurnDispatcher({
      executePromptStream: vi.fn(),
      startDualRace,
      isConversationBusy: vi.fn().mockReturnValue(false),
    });
    const service = createChatSpawnService({
      createSession: vi
        .fn()
        .mockImplementation(async ({ proposed }) => makeSession(proposed.name)),
      resolveCommittedHeadBase: vi.fn().mockResolvedValue("HEADSHA"),
      setSessionSpawnedFrom: vi.fn().mockResolvedValue(undefined),
      addPlcSpawnedSessionIds: vi.fn().mockResolvedValue(undefined),
      dispatchFirstTurn: dispatcher.dispatchFirstTurn,
      broadcast: vi.fn(),
    });

    const result = await service.createFromProposal({
      projectPath: "/repo",
      projectName: "repo",
      conversationId: "plc-1",
      proposal: validation.proposal,
    });
    await vi.waitFor(() => expect(startDualRace).toHaveBeenCalledTimes(1));

    expect(result.created[0]?.initialPromptQueued).toBe(true);
    expect(startDualRace).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: "Attached image.",
        images: validation.proposal.sessions[0]?.images,
      }),
    );
  });
});

describe("chat-spawning backend primitives do not depend on the cockpit/UI", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const backendFiles = [
    "schemas.ts",
    "proposal-validator.ts",
    "spawn-service.ts",
    "spawn-base.ts",
    "route-handlers.ts",
    "mutations.ts",
    "query-keys.ts",
  ];

  for (const file of backendFiles) {
    it(`${file} imports nothing from src/features`, () => {
      const src = readFileSync(resolve(here, file), "utf8");
      expect(src).not.toMatch(/from\s+["']@\/features/);
    });
  }

  it("the first-turn dispatcher primitive imports nothing from src/features", () => {
    const src = readFileSync(
      resolve(here, "../prompt/first-turn-dispatch.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']@\/features/);
  });
});
