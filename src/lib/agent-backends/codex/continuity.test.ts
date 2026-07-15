import { describe, it, expect, vi } from "vitest";
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

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeDeps(overrides: Partial<CodexContinuityDeps> = {}) {
  const deps: CodexContinuityDeps = {
    buildSyntheticForkSeed: async () => "CODEX SEED",
    ...overrides,
  };
  return deps;
}

const context = { projectPath: "/proj", sessionName: "sess" };

function forkInput(overrides: Partial<ForkInput> = {}): ForkInput {
  return {
    projectPath: "/proj",
    anchorMessageId: null,
    sourceTranscriptPath: "/t/source.jsonl",
    messageIndex: 2,
    ...overrides,
  };
}

const codexRef: AgentSessionRef = { backend: "codex", ref: "thread-1" };
const claudeRef: AgentSessionRef = { backend: "claude", ref: "session-1" };

describe("createCodexContinuityAdapter", () => {
  it("declares the codex backend id", () => {
    expect(createCodexContinuityAdapter(makeDeps()).backend).toBe("codex");
  });

  it("rejects refs owned by another backend on every ref-taking operation", async () => {
    const adapter = createCodexContinuityAdapter(makeDeps());

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
    const adapter = createCodexContinuityAdapter(makeDeps());

    const first = await adapter.start(context);
    const second = await adapter.start(context);

    expect(first.backend).toBe("codex");
    expect(first.ref.length).toBeGreaterThan(0);
    expect(second.ref).not.toBe(first.ref);
  });

  it("validate accepts an owned ref (thread staleness only surfaces at resume time)", async () => {
    const adapter = createCodexContinuityAdapter(makeDeps());
    await expect(adapter.validate(codexRef, context)).resolves.toEqual({
      status: "valid",
    });
  });

  it("resumeOrRecover echoes the durable thread handle", async () => {
    const adapter = createCodexContinuityAdapter(makeDeps());
    await expect(adapter.resumeOrRecover(codexRef, context)).resolves.toEqual({
      ref: codexRef,
      recovered: false,
    });
  });

  it("fork produces a synthetic seed built from the CC transcript", async () => {
    const buildSyntheticForkSeed = vi
      .fn<CodexContinuityDeps["buildSyntheticForkSeed"]>()
      .mockResolvedValue("CODEX SEED");
    const adapter = createCodexContinuityAdapter(
      makeDeps({ buildSyntheticForkSeed }),
    );

    const outcome = await adapter.fork(codexRef, forkInput());

    expect(outcome).toEqual({ kind: "synthetic_seed", seed: "CODEX SEED" });
    expect(buildSyntheticForkSeed).toHaveBeenCalledWith("/t/source.jsonl", 2);
  });

  it("fork throws ContinuityForkError when the seed cannot be built", async () => {
    const adapter = createCodexContinuityAdapter(
      makeDeps({ buildSyntheticForkSeed: async () => null }),
    );

    await expect(adapter.fork(codexRef, forkInput())).rejects.toBeInstanceOf(
      ContinuityForkError,
    );
  });
});
