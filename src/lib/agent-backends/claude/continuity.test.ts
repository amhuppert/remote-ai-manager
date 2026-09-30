import { describe, it, expect, vi } from "vitest";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import {
  ContinuityForkError,
  ContinuityRefMismatchError,
  type ForkInput,
} from "../continuity";
import type { LineClassification } from "@/lib/conversations/transcript-logical-units";
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

/** Snapshot rows for `user` then one assistant message stamped `uuid`. */
function snapshotLines(uuid: string | undefined): LineClassification[] {
  return [
    { seq: 0, visible: true, mergedIndex: 0, opensUnit: true, role: "user" },
    { seq: 1, visible: false, mergedIndex: 0, opensUnit: false, role: null },
    {
      seq: 2,
      visible: true,
      mergedIndex: 1,
      opensUnit: true,
      role: "assistant",
      uuid,
    },
  ];
}

function makeDeps(overrides: Partial<ClaudeContinuityDeps> = {}) {
  const forkCalls: Array<{
    sessionId: string;
    options: { dir?: string; upToMessageId?: string };
  }> = [];
  const snapshotReads: string[] = [];
  const seedReads: string[] = [];
  const deps: ClaudeContinuityDeps = {
    forkSession: async (sessionId, options) => {
      forkCalls.push({ sessionId, options });
      return { sessionId: "forked-session-id" };
    },
    readSnapshotLines: async (transcriptPath) => {
      snapshotReads.push(transcriptPath);
      return snapshotLines("uuid-a1");
    },
    buildSyntheticForkSeed: async (transcriptPath) => {
      seedReads.push(transcriptPath);
      return "SYNTHETIC SEED";
    },
    ...overrides,
  };
  return { deps, forkCalls, snapshotReads, seedReads };
}

const context = { projectPath: "/proj", sessionName: "sess" };

function forkInput(overrides: Partial<ForkInput> = {}): ForkInput {
  return {
    projectPath: "/proj",
    transcriptSnapshotPath: "/t/snapshot.jsonl",
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
    it("forks natively through the snapshot's anchored assistant message", async () => {
      const { deps, forkCalls, snapshotReads } = makeDeps();
      const adapter = createClaudeContinuityAdapter(deps);

      const outcome = await adapter.fork(claudeRef, forkInput());

      expect(outcome).toEqual({
        kind: "native",
        ref: { backend: "claude", ref: "forked-session-id" },
        locator: "uuid-a1",
      });
      expect(snapshotReads).toEqual(["/t/snapshot.jsonl"]);
      expect(forkCalls).toEqual([
        {
          sessionId: "sdk-session-1",
          options: { dir: "/proj", upToMessageId: "uuid-a1" },
        },
      ]);
    });

    it("falls back to a seed built from the snapshot when the native fork throws", async () => {
      const { deps, seedReads } = makeDeps({
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
      expect(seedReads).toEqual(["/t/snapshot.jsonl"]);
    });

    it("never calls the SDK when the snapshot has no anchor — goes straight to the synthetic seed", async () => {
      const { deps, forkCalls } = makeDeps({
        readSnapshotLines: async () => snapshotLines(undefined),
      });
      const adapter = createClaudeContinuityAdapter(deps);

      const outcome = await adapter.fork(claudeRef, forkInput());

      expect(forkCalls).toHaveLength(0);
      expect(outcome).toEqual({
        kind: "synthetic_seed",
        seed: "SYNTHETIC SEED",
      });
    });

    it("treats an unreadable snapshot as having no anchor", async () => {
      const { deps, forkCalls } = makeDeps({
        readSnapshotLines: async () => {
          throw new Error("ENOENT");
        },
      });
      const adapter = createClaudeContinuityAdapter(deps);

      const outcome = await adapter.fork(claudeRef, forkInput());

      expect(forkCalls).toHaveLength(0);
      expect(outcome.kind).toBe("synthetic_seed");
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
      const { deps } = makeDeps({
        readSnapshotLines: async () => snapshotLines(undefined),
        buildSyntheticForkSeed: async () => null,
      });
      const adapter = createClaudeContinuityAdapter(deps);

      await expect(adapter.fork(claudeRef, forkInput())).rejects.toBeInstanceOf(
        ContinuityForkError,
      );
    });
  });
});
