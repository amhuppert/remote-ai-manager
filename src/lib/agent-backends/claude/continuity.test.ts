import { describe, it, expect, vi } from "vitest";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import {
  ContinuityForkError,
  ContinuityRefMismatchError,
  type ForkInput,
} from "../continuity";
import {
  createClaudeContinuityAdapter,
  type ClaudeContinuityDeps,
} from "./continuity";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeDeps(overrides: Partial<ClaudeContinuityDeps> = {}) {
  const forkCalls: Array<{
    sessionId: string;
    options: { dir?: string; upToMessageId?: string };
  }> = [];
  const deps: ClaudeContinuityDeps = {
    createConversation: async () => ({ id: "conv-fresh" }),
    getConversation: async () => ({ id: "conv-existing" }),
    forkSession: async (sessionId, options) => {
      forkCalls.push({ sessionId, options });
      return { sessionId: "forked-session-id" };
    },
    buildSyntheticForkSeed: async () => "SYNTHETIC SEED",
    ...overrides,
  };
  return { deps, forkCalls };
}

const context = { projectPath: "/proj", sessionName: "sess" };

function forkInput(overrides: Partial<ForkInput> = {}): ForkInput {
  return {
    projectPath: "/proj",
    anchorMessageId: "uuid-a1",
    sourceTranscriptPath: "/t/source.jsonl",
    messageIndex: 1,
    ...overrides,
  };
}

const claudeRef: AgentSessionRef = { backend: "claude", ref: "sdk-session-1" };
const codexRef: AgentSessionRef = { backend: "codex", ref: "thread-1" };

describe("createClaudeContinuityAdapter", () => {
  it("declares the claude backend id", () => {
    const { deps } = makeDeps();
    expect(createClaudeContinuityAdapter(deps).backend).toBe("claude");
  });

  describe("ref ownership", () => {
    it("rejects refs owned by another backend on every ref-taking operation", async () => {
      const { deps } = makeDeps();
      const adapter = createClaudeContinuityAdapter(deps);

      await expect(adapter.validate(codexRef, context)).rejects.toBeInstanceOf(
        ContinuityRefMismatchError,
      );
      await expect(
        adapter.resumeOrRecover(codexRef, context),
      ).rejects.toBeInstanceOf(ContinuityRefMismatchError);
      await expect(adapter.fork(codexRef, forkInput())).rejects.toBeInstanceOf(
        ContinuityRefMismatchError,
      );
    });
  });

  describe("start / validate / resumeOrRecover", () => {
    it("start composes the conversation-creation service and returns its id as the handle", async () => {
      const createConversation = vi
        .fn<ClaudeContinuityDeps["createConversation"]>()
        .mockResolvedValue({ id: "conv-42" });
      const { deps } = makeDeps({ createConversation });
      const adapter = createClaudeContinuityAdapter(deps);

      const ref = await adapter.start(context);

      expect(ref).toEqual({ backend: "claude", ref: "conv-42" });
      expect(createConversation).toHaveBeenCalledWith(context);
    });

    it("validate reports valid when the conversation exists, stale when it does not", async () => {
      const { deps } = makeDeps({
        getConversation: async (_p, _s, conversationId) =>
          conversationId === "conv-live" ? { id: "conv-live" } : null,
      });
      const adapter = createClaudeContinuityAdapter(deps);

      await expect(
        adapter.validate({ backend: "claude", ref: "conv-live" }, context),
      ).resolves.toEqual({ status: "valid" });
      await expect(
        adapter.validate({ backend: "claude", ref: "conv-gone" }, context),
      ).resolves.toEqual({
        status: "stale",
        reason: "conversation_not_found",
      });
    });

    it("resumeOrRecover echoes a live handle and recovers a stale one with a fresh conversation", async () => {
      const { deps } = makeDeps({
        getConversation: async (_p, _s, conversationId) =>
          conversationId === "conv-live" ? { id: "conv-live" } : null,
        createConversation: async () => ({ id: "conv-recovered" }),
      });
      const adapter = createClaudeContinuityAdapter(deps);

      await expect(
        adapter.resumeOrRecover(
          { backend: "claude", ref: "conv-live" },
          context,
        ),
      ).resolves.toEqual({
        ref: { backend: "claude", ref: "conv-live" },
        recovered: false,
      });
      await expect(
        adapter.resumeOrRecover(
          { backend: "claude", ref: "conv-gone" },
          context,
        ),
      ).resolves.toEqual({
        ref: { backend: "claude", ref: "conv-recovered" },
        recovered: true,
      });
    });
  });

  describe("fork", () => {
    it("anchored fork goes native: forkSession receives the SDK session ref, dir, and anchor", async () => {
      const { deps, forkCalls } = makeDeps();
      const adapter = createClaudeContinuityAdapter(deps);

      const outcome = await adapter.fork(claudeRef, forkInput());

      expect(outcome).toEqual({
        kind: "native",
        ref: { backend: "claude", ref: "forked-session-id" },
      });
      expect(forkCalls).toEqual([
        {
          sessionId: "sdk-session-1",
          options: { dir: "/proj", upToMessageId: "uuid-a1" },
        },
      ]);
    });

    it("falls back to a synthetic seed when the native fork throws", async () => {
      const { deps } = makeDeps({
        forkSession: async () => {
          throw new Error("anchor compacted away");
        },
      });
      const adapter = createClaudeContinuityAdapter(deps);

      const outcome = await adapter.fork(claudeRef, forkInput());

      expect(outcome).toEqual({
        kind: "synthetic_seed",
        seed: "SYNTHETIC SEED",
      });
    });

    it("never calls the SDK without an anchor — goes straight to the synthetic seed", async () => {
      const { deps, forkCalls } = makeDeps();
      const adapter = createClaudeContinuityAdapter(deps);

      const outcome = await adapter.fork(
        claudeRef,
        forkInput({ anchorMessageId: null }),
      );

      expect(forkCalls).toHaveLength(0);
      expect(outcome).toEqual({
        kind: "synthetic_seed",
        seed: "SYNTHETIC SEED",
      });
    });

    it("throws ContinuityForkError when the native fork throws and the seed cannot be built", async () => {
      const { deps } = makeDeps({
        forkSession: async () => {
          throw new Error("upstream fork failed");
        },
        buildSyntheticForkSeed: async () => null,
      });
      const adapter = createClaudeContinuityAdapter(deps);

      await expect(adapter.fork(claudeRef, forkInput())).rejects.toBeInstanceOf(
        ContinuityForkError,
      );
      await expect(adapter.fork(claudeRef, forkInput())).rejects.toThrow(
        /upstream fork failed/,
      );
    });

    it("throws ContinuityForkError when no anchor exists and the seed cannot be built", async () => {
      const { deps } = makeDeps({ buildSyntheticForkSeed: async () => null });
      const adapter = createClaudeContinuityAdapter(deps);

      await expect(
        adapter.fork(claudeRef, forkInput({ anchorMessageId: null })),
      ).rejects.toBeInstanceOf(ContinuityForkError);
    });
  });
});
