import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "@/lib/agent-backends/registry-core";
import { bootstrapBackends } from "@/lib/agent-backends/registry";
import {
  createTestFakeBackend,
  TESTFAKE_BACKEND_ID,
} from "@/lib/agent-backends/testing/testfake-backend";
import {
  shouldBuildRuntimeSyntheticSeed,
  resolveSyntheticForkSeed,
  acknowledgeSyntheticForkSeed,
} from "./fork-seed";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

beforeAll(() => {
  _resetBackendRegistryForTesting();
  bootstrapBackends();
  _registerBackendForTesting(createTestFakeBackend().descriptor);
});

afterAll(() => {
  _resetBackendRegistryForTesting();
  bootstrapBackends();
});

describe("shouldBuildRuntimeSyntheticSeed", () => {
  const forkedFromBase = {
    sourceConversationId: "src",
    messageIndex: 1,
    sourceBackend: "claude",
    sourceBackendRef: null,
    forkLocator: null,
    forkMode: null,
  };

  it("returns false for a new (non-forked) conversation", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: null,
        backendRef: null,
        agentBackend: "codex",
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(false);
  });

  it("returns false for Claude native fork (backendRef populated)", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: { ...forkedFromBase, forkMode: "native" },
        backendRef: { backend: "claude", sessionId: "s" },
        agentBackend: "claude",
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(false);
  });

  it("does not rebuild Claude synthetic history from the transcript", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: { ...forkedFromBase, forkMode: "synthetic" },
        backendRef: null,
        agentBackend: "claude",
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(false);
  });

  it("returns false for Claude case 3 (user fork at index 0)", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: {
          ...forkedFromBase,
          messageIndex: 0,
          sourceBackend: null,
          sourceBackendRef: null,
        },
        backendRef: null,
        agentBackend: "claude",
        transcriptPath: null,
      }),
    ).toBe(false);
  });

  it("returns true for non-Claude fork with a transcript and no backendRef", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: { ...forkedFromBase, sourceBackend: "codex" },
        backendRef: null,
        agentBackend: "codex",
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(true);
  });

  it("returns false for non-Claude case 3 (no transcript)", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: {
          ...forkedFromBase,
          messageIndex: 0,
          sourceBackend: null,
          sourceBackendRef: null,
        },
        backendRef: null,
        agentBackend: "codex",
        transcriptPath: null,
      }),
    ).toBe(false);
  });

  it("returns false when a registered backend declares fork support unavailable", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: { ...forkedFromBase, sourceBackend: "codex" },
        backendRef: null,
        agentBackend: TESTFAKE_BACKEND_ID,
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(false);
  });
});

describe("resolveSyntheticForkSeed", () => {
  const messages: TranscriptMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: null,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
      timestamp: null,
    },
    {
      role: "user",
      content: [{ type: "text", text: "after the fork" }],
      timestamp: null,
    },
  ];

  it("builds a seed from the transcript slice up to the fork point for a non-Claude fork", async () => {
    const readConversationMessages = vi.fn(async () => messages);
    const seed = await resolveSyntheticForkSeed(
      { readConversationMessages },
      {
        sessionName: "s",
        agentBackend: "codex",
        backendRef: null,
        forkedFrom: { messageIndex: 1 },
        transcriptPath: "/p.jsonl",
      },
    );
    expect(seed).toContain("User: hello");
    expect(seed).toContain("Assistant: hi there");
    expect(seed).not.toContain("after the fork");
    expect(readConversationMessages).toHaveBeenCalledWith("/p.jsonl");
  });

  it("returns undefined (gate closed) without reading the transcript for a non-forked conversation", async () => {
    const readConversationMessages = vi.fn(async () => messages);
    const seed = await resolveSyntheticForkSeed(
      { readConversationMessages },
      {
        sessionName: "s",
        agentBackend: "codex",
        backendRef: null,
        forkedFrom: null,
        transcriptPath: "/p.jsonl",
      },
    );
    expect(seed).toBeUndefined();
    expect(readConversationMessages).not.toHaveBeenCalled();
  });

  it("returns undefined for a Claude fork (continuity handled elsewhere)", async () => {
    const readConversationMessages = vi.fn(async () => messages);
    const seed = await resolveSyntheticForkSeed(
      { readConversationMessages },
      {
        sessionName: "s",
        agentBackend: "claude",
        backendRef: null,
        forkedFrom: { messageIndex: 1 },
        transcriptPath: "/p.jsonl",
      },
    );
    expect(seed).toBeUndefined();
    expect(readConversationMessages).not.toHaveBeenCalled();
  });

  it("resolves null (gate fired, no seed) when the transcript slice is empty", async () => {
    const readConversationMessages = vi.fn(
      async (): Promise<TranscriptMessage[]> => [],
    );
    const seed = await resolveSyntheticForkSeed(
      { readConversationMessages },
      {
        sessionName: "s",
        agentBackend: "codex",
        backendRef: null,
        forkedFrom: { messageIndex: 1 },
        transcriptPath: "/p.jsonl",
      },
    );
    expect(seed).toBeNull();
  });
});

it.each(["claude", "codex", "cursor"] as const)(
  "uses the immutable %s fork seed without reading a mutable transcript",
  async (agentBackend) => {
    const readConversationMessages = vi.fn(async () => []);
    const input = {
      sessionName: "test",
      agentBackend,
      backendRef: null,
      forkedFrom: { messageIndex: 2, syntheticSeed: "anchored history" },
      transcriptPath: "/fork.jsonl",
    };
    expect(
      await resolveSyntheticForkSeed({ readConversationMessages }, input),
    ).toBe("anchored history");
    expect(readConversationMessages).not.toHaveBeenCalled();
    expect(
      await resolveSyntheticForkSeed(
        { readConversationMessages },
        {
          ...input,
          backendRef: { backend: agentBackend, ref: "independent-agent" },
        },
      ),
    ).toBe("anchored history");
    expect(
      await resolveSyntheticForkSeed(
        { readConversationMessages },
        {
          ...input,
          backendRef: { backend: agentBackend, ref: "independent-agent" },
          forkedFrom: {
            ...input.forkedFrom,
            syntheticSeedAcceptedRef: {
              backend: agentBackend,
              ref: "independent-agent",
            },
          },
        },
      ),
    ).toBeUndefined();
    expect(
      await resolveSyntheticForkSeed(
        { readConversationMessages },
        {
          ...input,
          backendRef: { backend: agentBackend, ref: "replacement-agent" },
          forkedFrom: {
            ...input.forkedFrom,
            syntheticSeedAcceptedRef: {
              backend: agentBackend,
              ref: "independent-agent",
            },
          },
        },
      ),
    ).toBe("anchored history");
  },
);

it("retains a failed required fork acceptance receipt", async () => {
  await expect(
    acknowledgeSyntheticForkSeed(
      {
        mutateConversation: async () => {
          throw new Error("fork receipt unavailable");
        },
      },
      {
        projectPath: "/p",
        sessionName: "s",
        conversationId: "c",
        seed: "history",
        backendRef: { backend: "codex", ref: "accepted-ref" },
      },
    ),
  ).rejects.toThrow("fork receipt unavailable");
});
