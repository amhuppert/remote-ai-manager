import { afterEach, describe, expect, it, vi } from "vitest";
import { createInTurnQuestionService } from "./in-turn-questions";
import { askQuestionItemSchema, type AnswerQuestionRequest } from "./schemas";

const scope = {
  projectPath: "/repo",
  sessionName: "session",
  conversationId: "conversation",
};
const questions = [
  askQuestionItemSchema.parse({
    id: "color",
    question: "Which color?",
    options: [{ label: "Blue" }],
  }),
];
const answers = { color: { selected: ["Blue"], note: null, skipped: false } };

afterEach(() => vi.useRealTimers());

function harness() {
  let pending: string | null = null;
  const recorded: AnswerQuestionRequest[] = [];
  let id = 0;
  const service = createInTurnQuestionService({
    register: async (_scope, questionId) => {
      if (pending) return false;
      pending = questionId;
      return true;
    },
    retire: async (_scope, questionId) => {
      if (pending === questionId) pending = null;
    },
    recordAnswer: async (_scope, reply) => {
      recorded.push(reply);
    },
    newId: () => String(++id),
    timeoutMs: 1000,
  });
  return { service, recorded, pending: () => pending };
}

describe("in-turn questions", () => {
  it("does not confirm a reply when retiring the durable question fails", async () => {
    const service = createInTurnQuestionService({
      register: async () => true,
      retire: async () => {
        throw new Error("storage unavailable");
      },
      recordAnswer: async () => {},
      newId: () => "failure",
      timeoutMs: 1000,
    });
    const request = service.request(
      scope,
      questions,
      new AbortController().signal,
    );
    expect(
      await service.answer(scope, {
        questionId: "cc-in-turn-failure",
        answers,
      }),
    ).toBe(false);
    expect((await request).status).toBe("unavailable");
  });

  it.each(["abort", "expiry"] as const)(
    "retires the batch on %s and rejects stale replies",
    async (reason) => {
      vi.useFakeTimers();
      const h = harness();
      const controller = new AbortController();
      const request = h.service.request(scope, questions, controller.signal);
      await Promise.resolve();
      if (reason === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(1000);
      expect((await request).status).toBe(
        reason === "abort" ? "cancelled" : "expired",
      );
      expect(h.pending()).toBeNull();
      expect(
        await h.service.answer(scope, { questionId: "cc-in-turn-1", answers }),
      ).toBe(false);
      expect(h.recorded).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects overlapping subagent questions and cross-conversation replies", async () => {
    const h = harness();
    const controller = new AbortController();
    const first = h.service.request(scope, questions, controller.signal);
    expect(
      (await h.service.request(scope, questions, controller.signal)).status,
    ).toBe("unavailable");
    expect(
      await h.service.answer(
        { ...scope, conversationId: "other" },
        { questionId: "cc-in-turn-1", answers },
      ),
    ).toBe(false);
    expect(h.pending()).toBe("cc-in-turn-1");
    controller.abort();
    await first;
  });

  it("rejects duplicate answers racing while persistence is pending", async () => {
    const h = harness();
    const first = h.service.request(
      scope,
      questions,
      new AbortController().signal,
    );
    await Promise.resolve();
    const results = await Promise.all([
      h.service.answer(scope, { questionId: "cc-in-turn-1", answers }),
      h.service.answer(scope, { questionId: "cc-in-turn-1", answers }),
    ]);
    expect(results).toEqual([true, false]);
    expect((await first).status).toBe("answered");
    expect(h.recorded).toHaveLength(1);
  });
  it("persists an answer before releasing the waiting callback, once", async () => {
    const h = harness();
    const request = h.service.request(
      scope,
      questions,
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(h.pending()).toBe("cc-in-turn-1");
    const reply = { questionId: "cc-in-turn-1", answers };
    expect(await h.service.answer(scope, reply)).toBe(true);
    expect(await request).toEqual({ status: "answered", answers });
    expect(h.recorded).toEqual([reply]);
    expect(h.pending()).toBeNull();
    expect(await h.service.answer(scope, reply)).toBe(false);
  });
});
