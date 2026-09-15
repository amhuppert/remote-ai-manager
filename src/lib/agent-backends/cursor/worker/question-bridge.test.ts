import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorWorkerQuestions } from "./question-bridge";
import { askQuestionItemSchema } from "@/lib/conversations/schemas";
import type { CursorWorkerFrame } from "./ipc";

afterEach(() => vi.useRealTimers());
const questions = [
  askQuestionItemSchema.parse({ question: "Color?", options: [] }),
];

describe("Cursor callback question bridge", () => {
  it("correlates replies to the owning run and deduplicates tool calls", async () => {
    const frames: CursorWorkerFrame[] = [];
    const bridge = new CursorWorkerQuestions("run-1", (frame) =>
      frames.push(frame),
    );
    const result = bridge.ask(questions, "tool-1");
    expect(bridge.ask(questions, "tool-1")).toBe(result);
    expect(frames).toHaveLength(1);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    bridge.answer("old-run", "tool-1", { status: "answered", answers: {} });
    await Promise.resolve();
    expect(settled).toBe(false);
    bridge.answer("run-1", "tool-1", { status: "answered", answers: {} });
    expect(await result).toEqual({ status: "answered", answers: {} });
    bridge.close();
  });

  it.each(["close", "timeout"] as const)(
    "settles pending callbacks on %s",
    async (reason) => {
      vi.useFakeTimers();
      const bridge = new CursorWorkerQuestions("run-1", () => {}, 100);
      const result = bridge.ask(questions);
      if (reason === "close") bridge.close();
      else await vi.advanceTimersByTimeAsync(100);
      expect((await result).status).toBe(
        reason === "close" ? "cancelled" : "expired",
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
