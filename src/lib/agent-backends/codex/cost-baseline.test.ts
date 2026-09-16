import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendTranscriptEntry } from "@/lib/prompt/transcript";
import { readCodexPersistedCostBaseline } from "./cost-baseline";
import { projectCodexUsageFrame } from "./transcript-projections";
import { codexConversationTranscriptProjection } from "./descriptor";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Codex unknown lineage cost", () => {
  it("does not revive a numeric baseline through a truncated later result", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cc-codex-cost-"));
    dirs.push(dir);
    await appendTranscriptEntry(
      "conversation",
      {
        timestamp: new Date().toISOString(),
        type: "result",
        raw: { backend: "codex", backendRef: { ref: "thread" }, costUsd: 1 },
      },
      dir,
    );
    await appendFile(
      path.join(dir, "transcripts/conversation.jsonl"),
      '{"type":"result","raw":',
    );
    expect(
      await readCodexPersistedCostBaseline("conversation", "thread", dir),
    ).toBeNull();
  });
  it.each(["session-conversation", "project-conversation"])(
    "keeps latest unknown after transcript reload for %s",
    async (conversationId) => {
      const dir = await mkdtemp(path.join(tmpdir(), "cc-codex-cost-"));
      dirs.push(dir);
      for (const costUsd of [1.5, null]) {
        await appendTranscriptEntry(
          conversationId,
          {
            timestamp: new Date().toISOString(),
            type: "result",
            raw: {
              backend: "codex",
              backendRef: { backend: "codex", ref: "thread-1" },
              costUsd,
            },
          },
          dir,
        );
      }
      expect(
        await readCodexPersistedCostBaseline(conversationId, "thread-1", dir),
      ).toEqual({ threadRef: "thread-1", cumulativeCostUsd: null });
    },
  );

  it("retains an unknown-cost result in the neutral replay projection", () => {
    expect(
      projectCodexUsageFrame({
        backend: "codex",
        backendRef: { backend: "codex", ref: "thread-1" },
        costUsd: null,
        numTurns: 1,
      }),
    ).toEqual({ lineageId: "thread-1", cumulativeCostUsd: null, numTurns: 1 });
  });

  it("does not replace explicit unknown cumulative cost with a known turn cost", () => {
    const frame = codexConversationTranscriptProjection.projectTurnResult({
      timestamp: "2026-09-16T00:00:00Z",
      backendRef: { backend: "codex", ref: "thread-1" },
      durationMs: 1,
      numTurns: 1,
      contextTokens: null,
      contextWindowMax: null,
      costUsd: 0.5,
      cumulativeCostUsd: null,
      aborted: false,
      error: null,
    });
    expect(frame?.raw).toMatchObject({ costUsd: null, turnCostUsd: 0.5 });
  });
});
