import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  copyTranscriptUpTo,
  getTranscriptPath,
  type CopyTranscriptMode,
} from "@/lib/prompt/transcript";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import {
  ContinuityForkError,
  ContinuityRefMismatchError,
  type ForkInput,
} from "../continuity";
import {
  createCodexContinuityAdapter,
  type CodexContinuityDeps,
} from "./continuity";
import { readCodexTranscriptRecords } from "./transcript-records";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const SOURCE_THREAD = "thread-1";

function user(text: string) {
  return {
    timestamp: "t",
    type: "user",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistant(text: string) {
  return {
    timestamp: "t",
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function turnCompleted(threadId: string, turnId: string) {
  return {
    timestamp: "t",
    type: "codex_app_server",
    raw: {
      record: JSON.stringify({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      }),
    },
  };
}

/** A settled snapshot whose last message belongs to a completed source turn. */
const SETTLED_SNAPSHOT = [
  user("u0"),
  assistant("a1"),
  turnCompleted(SOURCE_THREAD, "turn-7"),
];

async function* records(items: readonly unknown[]): AsyncGenerator<unknown> {
  yield* items;
}

function makeDeps(overrides: Partial<CodexContinuityDeps> = {}) {
  const forkThreadCalls: Array<
    Parameters<CodexContinuityDeps["forkThread"]>[0]
  > = [];
  const snapshotReads: string[] = [];
  const seedReads: string[] = [];
  const deps: CodexContinuityDeps = {
    buildSyntheticForkSeed: async (transcriptPath) => {
      seedReads.push(transcriptPath);
      return "CODEX SEED";
    },
    readSnapshotRecords: (transcriptPath) => {
      snapshotReads.push(transcriptPath);
      return records(SETTLED_SNAPSHOT);
    },
    forkThread: async (input) => {
      forkThreadCalls.push(input);
      return "forked-thread-9";
    },
    ...overrides,
  };
  return { deps, forkThreadCalls, snapshotReads, seedReads };
}

const context = { projectPath: "/proj", sessionName: "sess" };

function forkInput(overrides: Partial<ForkInput> = {}): ForkInput {
  return {
    projectPath: "/proj",
    transcriptSnapshotPath: "/t/snapshot.jsonl",
    messageIndex: 2,
    ...overrides,
  };
}

const codexRef: AgentSessionRef = { backend: "codex", ref: "thread-1" };
const claudeRef: AgentSessionRef = { backend: "claude", ref: "session-1" };

describe("createCodexContinuityAdapter", () => {
  it("declares the codex backend id", () => {
    expect(createCodexContinuityAdapter(makeDeps().deps).backend).toBe("codex");
  });

  it("rejects refs owned by another backend on every ref-taking operation", async () => {
    const adapter = createCodexContinuityAdapter(makeDeps().deps);

    await expect(adapter.validate(claudeRef, context)).rejects.toBeInstanceOf(
      ContinuityRefMismatchError,
    );
    await expect(
      adapter.resumeOrRecover(claudeRef, context),
    ).rejects.toBeInstanceOf(ContinuityRefMismatchError);
    await expect(adapter.fork(claudeRef, forkInput())).rejects.toBeInstanceOf(
      ContinuityRefMismatchError,
    );
  });

  it("start mints a unique placeholder thread handle owned by codex", async () => {
    const adapter = createCodexContinuityAdapter(makeDeps().deps);

    const first = await adapter.start(context);
    const second = await adapter.start(context);

    expect(first.backend).toBe("codex");
    expect(first.ref.length).toBeGreaterThan(0);
    expect(second.ref).not.toBe(first.ref);
  });

  it("validate accepts an owned ref (thread staleness only surfaces at resume time)", async () => {
    const adapter = createCodexContinuityAdapter(makeDeps().deps);
    await expect(adapter.validate(codexRef, context)).resolves.toEqual({
      status: "valid",
    });
  });

  it("resumeOrRecover echoes the durable thread handle", async () => {
    const adapter = createCodexContinuityAdapter(makeDeps().deps);
    await expect(adapter.resumeOrRecover(codexRef, context)).resolves.toEqual({
      ref: codexRef,
      recovered: false,
    });
  });

  describe("fork", () => {
    it("forks the source thread natively through the turn that completed at the end of the snapshot", async () => {
      const { deps, forkThreadCalls, snapshotReads } = makeDeps();
      const adapter = createCodexContinuityAdapter(deps);

      const outcome = await adapter.fork(codexRef, forkInput());

      expect(outcome).toEqual({
        kind: "native",
        ref: { backend: "codex", ref: "forked-thread-9" },
        locator: "turn-7",
      });
      expect(snapshotReads).toEqual(["/t/snapshot.jsonl"]);
      expect(forkThreadCalls).toEqual([
        { projectPath: "/proj", threadId: "thread-1", lastTurnId: "turn-7" },
      ]);
    });

    it("builds a synthetic seed from the snapshot when it has no exact cut", async () => {
      const { deps, forkThreadCalls, seedReads } = makeDeps({
        readSnapshotRecords: () =>
          records([user("u0"), assistant("a1 still running")]),
      });
      const adapter = createCodexContinuityAdapter(deps);

      const outcome = await adapter.fork(codexRef, forkInput());

      expect(outcome).toEqual({ kind: "synthetic_seed", seed: "CODEX SEED" });
      expect(forkThreadCalls).toHaveLength(0);
      expect(seedReads).toEqual(["/t/snapshot.jsonl"]);
    });

    it("has no cut when the completed turn belongs to a thread other than the source ref", async () => {
      const { deps, forkThreadCalls } = makeDeps({
        readSnapshotRecords: () =>
          records([
            user("u0"),
            assistant("a1"),
            turnCompleted("thread-old", "turn-7"),
          ]),
      });
      const adapter = createCodexContinuityAdapter(deps);

      const outcome = await adapter.fork(codexRef, forkInput());

      expect(outcome.kind).toBe("synthetic_seed");
      expect(forkThreadCalls).toHaveLength(0);
    });

    it("falls back to the synthetic seed when the native fork fails", async () => {
      const { deps } = makeDeps({
        forkThread: async () => {
          throw new Error("no rollout found for thread id thread-1");
        },
      });
      const adapter = createCodexContinuityAdapter(deps);

      const outcome = await adapter.fork(codexRef, forkInput());

      expect(outcome).toEqual({ kind: "synthetic_seed", seed: "CODEX SEED" });
    });

    it("treats an unreadable snapshot as having no cut", async () => {
      const { deps, forkThreadCalls } = makeDeps({
        readSnapshotRecords: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error("ENOENT")),
          }),
        }),
      });
      const adapter = createCodexContinuityAdapter(deps);

      const outcome = await adapter.fork(codexRef, forkInput());

      expect(outcome.kind).toBe("synthetic_seed");
      expect(forkThreadCalls).toHaveLength(0);
    });

    it("throws ContinuityForkError when the native fork fails and the seed cannot be built", async () => {
      const { deps } = makeDeps({
        forkThread: async () => {
          throw new Error("turn not found");
        },
        buildSyntheticForkSeed: async () => null,
      });
      const adapter = createCodexContinuityAdapter(deps);

      await expect(adapter.fork(codexRef, forkInput())).rejects.toBeInstanceOf(
        ContinuityForkError,
      );
    });

    it("throws ContinuityForkError when there is no cut and the seed cannot be built", async () => {
      const { deps } = makeDeps({
        readSnapshotRecords: () => records([user("u0")]),
        buildSyntheticForkSeed: async () => null,
      });
      const adapter = createCodexContinuityAdapter(deps);

      await expect(adapter.fork(codexRef, forkInput())).rejects.toBeInstanceOf(
        ContinuityForkError,
      );
    });
  });

  describe("fork over a real copied snapshot", () => {
    // Two exchanges on the source thread; the second is still streaming.
    const source = [
      user("set ALPHA"),
      assistant("ok"),
      turnCompleted(SOURCE_THREAD, "turn-1"),
      user("set BRAVO"),
      assistant("working"),
    ];

    async function forkAt(messageIndex: number, mode: CopyTranscriptMode) {
      const configDir = await mkdtemp(path.join(os.tmpdir(), "codex-fork-"));
      try {
        const sourcePath = await getTranscriptPath("source", configDir);
        await writeFile(
          sourcePath,
          source.map((line) => JSON.stringify(line)).join("\n") + "\n",
        );
        await copyTranscriptUpTo({
          sourceTranscriptPath: sourcePath,
          targetConversationId: "fork",
          upToMessageIndex: messageIndex,
          mode,
          configDir,
        });
        const { deps, forkThreadCalls } = makeDeps({
          readSnapshotRecords: readCodexTranscriptRecords,
        });
        const outcome = await createCodexContinuityAdapter(deps).fork(
          codexRef,
          {
            projectPath: "/proj",
            transcriptSnapshotPath: await getTranscriptPath("fork", configDir),
            messageIndex:
              mode === "exclusive" ? messageIndex - 1 : messageIndex,
          },
        );
        return { outcome, forkThreadCalls };
      } finally {
        await rm(configDir, { recursive: true, force: true });
      }
    }

    it("cuts at the completed turn for a fork at its assistant message", async () => {
      const { outcome, forkThreadCalls } = await forkAt(1, "inclusive");
      expect(outcome).toMatchObject({ kind: "native", locator: "turn-1" });
      expect(forkThreadCalls).toEqual([
        { projectPath: "/proj", threadId: SOURCE_THREAD, lastTurnId: "turn-1" },
      ]);
    });

    it("cuts at the completed turn for a fork at the next user message", async () => {
      const { outcome } = await forkAt(2, "exclusive");
      expect(outcome).toMatchObject({ kind: "native", locator: "turn-1" });
    });

    it("falls back to synthetic for a fork inside the still-running turn", async () => {
      const { outcome, forkThreadCalls } = await forkAt(3, "inclusive");
      expect(outcome.kind).toBe("synthetic_seed");
      expect(forkThreadCalls).toHaveLength(0);
    });
  });
});
