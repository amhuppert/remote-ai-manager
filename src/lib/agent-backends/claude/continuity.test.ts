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
    // The adapter's deps carry no conversation ports at all, so "start mints a
    // placeholder rather than a CC conversation" is enforced by the type — what
    // is left to pin is that each call yields its own fresh owned handle.
    it("start mints a fresh owned handle per call", async () => {
      const { deps } = makeDeps();
      const adapter = createClaudeContinuityAdapter(deps);

      const first = await adapter.start(context);
      const second = await adapter.start(context);

      expect(first.backend).toBe("claude");
      expect(first.ref.length).toBeGreaterThan(0);
      expect(second.ref).not.toBe(first.ref);
    });

    it("validate treats an owned ref as durable — a headless handle has no cheap probe", async () => {
      const { deps } = makeDeps();
      const adapter = createClaudeContinuityAdapter(deps);

      await expect(
        adapter.validate({ backend: "claude", ref: "sdk-session-9" }, context),
      ).resolves.toEqual({ status: "valid" });
    });

    it("resumeOrRecover echoes the owned ref instead of recovering a replacement", async () => {
      const { deps } = makeDeps();
      const adapter = createClaudeContinuityAdapter(deps);

      await expect(
        adapter.resumeOrRecover(
          { backend: "claude", ref: "sdk-session-9" },
          context,
        ),
      ).resolves.toEqual({
        ref: { backend: "claude", ref: "sdk-session-9" },
        recovered: false,
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
