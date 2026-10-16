import { describe, expect, it } from "vitest";
import { CodexAppServerEvents, CodexAppServerUsage } from "./app-server-events";
import { renderCompleteEntryLines } from "@/lib/conversations/transcript-render";
const item = (
  type: string,
  id: string,
  fields: Record<string, unknown> = {},
) => ({ threadId: "thread", turnId: "turn", item: { type, id, ...fields } });
describe("Codex app-server item projection", () => {
  it("keeps progress visible in ordinary transcript reads while omitting reasoning and preserving the final answer", () => {
    const events = new CodexAppServerEvents();
    const reasoning = events.consume(
      "item/completed",
      item("reasoning", "thought", { summary: ["Consider the alternatives"] }),
    );
    const progress = events.consume(
      "item/completed",
      item("agentMessage", "progress", {
        text: "The reproduction fails at the missing parent directory.",
        phase: "commentary",
      }),
    );
    expect(events.finalText).toBeNull();
    const answer = events.consume(
      "item/completed",
      item("agentMessage", "answer", {
        text: "Fixed and verified.",
        phase: "final_answer",
      }),
    );

    expect(
      renderCompleteEntryLines([...reasoning, ...progress, ...answer], {
        includeThinking: false,
      }),
    ).toEqual({
      lines: [
        "The reproduction fails at the missing parent directory.",
        "Fixed and verified.",
      ],
      thinkingOmitted: 1,
    });
    expect(events.finalText).toBe("Fixed and verified.");
  });

  it("keeps phase-less progress before a tool visible without making it the final answer", () => {
    const events = new CodexAppServerEvents();
    events.consume(
      "item/completed",
      item("agentMessage", "progress", { text: "I will inspect the files." }),
    );
    const blocks = events.consume(
      "item/started",
      item("commandExecution", "cmd", { command: "pwd" }),
    );

    expect(blocks[0]).toEqual({
      type: "text",
      text: "I will inspect the files.",
    });
    expect(events.finalText).toBeNull();
    expect(events.finish()).toEqual([]);
  });

  it("uses the latest phase-less answer after an earlier explicit final", () => {
    const events = new CodexAppServerEvents();
    events.consume(
      "item/completed",
      item("agentMessage", "earlier", { text: "old", phase: "final_answer" }),
    );
    events.consume(
      "item/completed",
      item("agentMessage", "later", { text: "new" }),
    );
    expect(events.finish()).toEqual([{ type: "text", text: "new" }]);
    expect(events.finalText).toBe("new");
  });
  it("retains a known started phase when the completed item omits it", () => {
    const events = new CodexAppServerEvents();
    events.consume(
      "item/started",
      item("agentMessage", "comment", { text: "", phase: "commentary" }),
    );
    expect(
      events.consume(
        "item/completed",
        item("agentMessage", "comment", { text: "aside" }),
      ),
    ).toEqual([{ type: "text", text: "aside" }]);
    expect(events.finish()).toEqual([]);
    expect(events.finalText).toBeNull();
  });
  it("deduplicates completion and uses explicit phases for final answer extraction", () => {
    const events = new CodexAppServerEvents();
    const final = item("agentMessage", "answer", {
      text: "final",
      phase: "final_answer",
    });
    expect(events.consume("item/completed", final)).toEqual([
      { type: "text", text: "final" },
    ]);
    expect(events.consume("item/completed", final)).toEqual([]);
    expect(
      events.consume(
        "item/completed",
        item("agentMessage", "comment", { text: "aside", phase: "commentary" }),
      ),
    ).toEqual([{ type: "text", text: "aside" }]);
    expect(events.finalText).toBe("final");
  });
  it("retains unknown-phase fallback through plan updates and flushes on terminal", () => {
    const events = new CodexAppServerEvents();
    expect(
      events.consume(
        "item/completed",
        item("agentMessage", "answer", { text: "answer" }),
      ),
    ).toEqual([]);
    events.consume("turn/plan/updated", {
      plan: [{ step: "done", status: "completed" }],
    });
    expect(events.finish()).toEqual([{ type: "text", text: "answer" }]);
    expect(events.finalText).toBe("answer");
  });
  it("projects tools and compaction, ignores user echoes and additive items", () => {
    const events = new CodexAppServerEvents();
    expect(
      events.consume(
        "item/started",
        item("commandExecution", "cmd", { command: "pwd" }),
      ),
    ).toEqual([
      { type: "tool_use", id: "cmd", name: "Bash", input: { command: "pwd" } },
    ]);
    expect(
      events.consume(
        "item/completed",
        item("commandExecution", "cmd", {
          command: "pwd",
          aggregatedOutput: "/work",
          exitCode: 0,
          status: "completed",
        }),
      ),
    ).toEqual([
      {
        type: "tool_result",
        tool_use_id: "cmd",
        content: "/work",
        metrics: { exitCode: 0 },
      },
    ]);
    expect(
      events.consume(
        "item/completed",
        item("userMessage", "u", { content: [] }),
      ),
    ).toEqual([]);
    expect(events.consume("item/completed", item("futureItem", "x"))).toEqual(
      [],
    );
    events.consume("item/completed", item("contextCompaction", "c"));
    expect(events.compacted).toBe(true);
  });
});
const usage = (
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
) => ({
  tokenUsage: {
    total: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: inputTokens + outputTokens,
    },
  },
});
describe("Codex process token accounting", () => {
  it("rejects impossible category increments despite individually valid cumulative snapshots", () => {
    const counts = new CodexAppServerUsage({ resumed: true });
    counts.observe(usage(100, 5), true);
    counts.observe(usage(110, 7, 100), false);
    expect(counts.tokens).toBeNull();
    expect(counts.invalid).toBe(true);
  });
  it("uses final process total, with only an observed same-process baseline subtracted", () => {
    const counts = new CodexAppServerUsage({ resumed: true });
    counts.observe(usage(10, 2), true);
    counts.observe(usage(30, 5, 5), false);
    counts.observe(usage(50, 10, 5), false);
    expect(counts.tokens).toEqual({
      input_tokens: 40,
      cached_input_tokens: 5,
      output_tokens: 8,
    });
    const started = new CodexAppServerUsage({ resumed: false });
    started.observe(usage(20, 3), false);
    expect(started.tokens).toEqual({
      input_tokens: 20,
      cached_input_tokens: 0,
      output_tokens: 3,
    });
  });
  it("cannot price a resumed thread's inherited totals without a baseline", () => {
    const counts = new CodexAppServerUsage({ resumed: true });
    counts.observe(usage(20, 3), false);
    expect(counts.tokens).toBeNull();
    expect(counts.invalid).toBe(false);
  });
  it("ignores a pre-turn sample once the turn has been measured", () => {
    const counts = new CodexAppServerUsage({ resumed: true });
    counts.observe(usage(100, 5), true);
    counts.observe(usage(150, 9), false);
    counts.observe(usage(100, 5), true);
    expect(counts.tokens).toEqual({
      input_tokens: 50,
      cached_input_tokens: 0,
      output_tokens: 4,
    });
  });
  it("does not repair a decreasing or invalid counter with a later sample", () => {
    const counts = new CodexAppServerUsage({ resumed: false });
    counts.observe(usage(30, 5), false);
    counts.observe(usage(20, 5), false);
    counts.observe(usage(40, 7), false);
    expect(counts.tokens).toBeNull();
    expect(counts.invalid).toBe(true);
    const invalid = new CodexAppServerUsage({ resumed: false });
    invalid.observe(usage(10, 2, 11), false);
    expect(invalid.tokens).toBeNull();
    expect(invalid.invalid).toBe(true);
  });
});
