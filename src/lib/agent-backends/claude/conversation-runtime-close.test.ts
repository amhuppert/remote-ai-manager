import { afterEach, expect, it, vi } from "vitest";
import { claudeConversationBackendFactory } from "./conversation-runtime";
import { _setSdkQueryForTesting } from "./query-session";
import { scriptedCaptureSdk } from "./capture-test-support";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";

afterEach(() => {
  vi.useRealTimers();
  _setSdkQueryForTesting(null);
});

function createRuntime() {
  return claudeConversationBackendFactory.createRuntime({
    projectPath: process.cwd(),
    executionClass: "ordinary-conversation",
    persistedRef: null,
    conversationId: "ordinary-close-test",
    projectName: "test",
    worktreePath: process.cwd(),
    conversationTarget: sessionConversationTarget(
      "test",
      "session",
      "ordinary-close-test",
    ),
    modelSelection: { modelId: "sonnet", parameters: { effort: "high" } },
    sessionInstructions: [],
    tooling: {},
  });
}

it.each(["child", "pump"])(
  "keeps ordinary retirement pending when %s settles first",
  async (firstSettled) => {
    const child = Promise.withResolvers<void>();
    const pump = Promise.withResolvers<void>();
    _setSdkQueryForTesting(
      scriptedCaptureSdk(() => {}, {
        childCompletion: child.promise,
        pumpCompletion: pump.promise,
      }),
    );
    const runtime = await createRuntime();
    let completed = 0;
    const first = runtime.close().then(() => completed++);
    expect(runtime.status).toBe("dead");
    const second = runtime.close().then(() => completed++);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(completed).toBe(0);
      if (firstSettled === "child") child.resolve();
      else pump.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(completed).toBe(0);
      child.resolve();
      pump.resolve();
      await Promise.all([first, second]);
      expect(completed).toBe(2);
      await runtime.close();
    } finally {
      child.resolve();
      pump.resolve();
      await Promise.allSettled([first, second]);
    }
  },
);

it("does not report retirement success when child collection fails, including repeated close", async () => {
  const child = Promise.withResolvers<void>();
  _setSdkQueryForTesting(
    scriptedCaptureSdk(() => {}, { childCompletion: child.promise }),
  );
  const runtime = await createRuntime();
  const first = expect(runtime.close()).rejects.toThrow("collection failed");
  child.reject(new Error("collection failed"));
  await first;
  expect(runtime.status).toBe("dead");
  await expect(runtime.close()).rejects.toThrow("collection failed");
});

it.each(["child", "pump"])(
  "bounds ordinary retirement when %s collection remains pending and permits a later retry",
  async (pending) => {
    const child = Promise.withResolvers<void>();
    const pump = Promise.withResolvers<void>();
    if (pending === "child") pump.resolve();
    else child.resolve();
    _setSdkQueryForTesting(
      scriptedCaptureSdk(() => {}, {
        childCompletion: child.promise,
        pumpCompletion: pump.promise,
      }),
    );
    const runtime = await createRuntime();
    vi.useFakeTimers();
    const outcomes: string[] = [];
    const close = () =>
      runtime.close().then(
        () => outcomes.push("settled"),
        (error: unknown) =>
          outcomes.push(error instanceof Error ? error.message : String(error)),
      );
    const first = close();
    try {
      await vi.advanceTimersByTimeAsync(4999);
      expect([...outcomes]).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect([...outcomes]).toEqual([
        "Claude runtime collection did not settle within 5000 ms",
      ]);
      expect(runtime.status).toBe("dead");

      const retry = close();
      await vi.advanceTimersByTimeAsync(5000);
      expect([...outcomes]).toEqual([
        "Claude runtime collection did not settle within 5000 ms",
        "Claude runtime collection did not settle within 5000 ms",
      ]);
      await retry;

      child.resolve();
      pump.resolve();
      await expect(runtime.close()).resolves.toBeUndefined();
    } finally {
      child.resolve();
      pump.resolve();
      await first;
      await runtime.close();
    }
  },
);
