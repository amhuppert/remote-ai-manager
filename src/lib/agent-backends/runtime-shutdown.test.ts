import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  installRuntimeShutdownHook,
  type ShutdownSignalSource,
} from "./runtime-shutdown";
import {
  registerRuntime,
  getRuntime,
  _resetForTesting,
} from "./runtime-registry";
import type { ConversationBackendRuntime } from "./conversation";

function makeRuntime(close: () => Promise<void>): ConversationBackendRuntime {
  return {
    backend: "cursor",
    status: "alive",
    modelSelection: { modelId: "composer-2.5", parameters: { fast: "true" } },
    outputFormat: undefined,
    alignmentVersion: null,
    sendTurn: () => {
      throw new Error("this fixture never dispatches a turn");
    },
    close,
  };
}

/**
 * Captures the listeners a caller registers instead of touching `process`.
 *
 * `fire` hands back whatever the listener returned, so a test can observe when
 * the hook's own work settles rather than guessing at a flush interval.
 */
function fakeSignalSource(): ShutdownSignalSource & {
  fire(signal: "SIGINT" | "SIGTERM"): Promise<void>;
  registered(): ReadonlyArray<"SIGINT" | "SIGTERM">;
} {
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void | Promise<void>>();
  return {
    once(signal, listener) {
      listeners.set(signal, listener);
    },
    async fire(signal) {
      const listener = listeners.get(signal);
      if (listener === undefined) {
        throw new Error(`nothing registered for ${signal}`);
      }
      await listener();
    },
    registered: () => [...listeners.keys()],
  };
}

/** Drain the microtask queue without advancing time. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  _resetForTesting();
});

describe("installRuntimeShutdownHook", () => {
  it("registers for both terminating signals", () => {
    const source = fakeSignalSource();

    installRuntimeShutdownHook(source);

    expect(source.registered()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "closes every registered runtime and empties the registry on %s",
    async (signal) => {
      const closed: string[] = [];
      registerRuntime(
        "conv-1",
        makeRuntime(async () => {
          closed.push("conv-1");
        }),
      );
      registerRuntime(
        "conv-2",
        makeRuntime(async () => {
          closed.push("conv-2");
        }),
      );
      const source = fakeSignalSource();
      installRuntimeShutdownHook(source);

      await source.fire(signal);

      expect(closed.sort()).toEqual(["conv-1", "conv-2"]);
      expect(getRuntime("conv-1")).toBeUndefined();
      expect(getRuntime("conv-2")).toBeUndefined();
    },
  );

  it("still closes the other runtimes when one teardown rejects", async () => {
    const closed: string[] = [];
    registerRuntime(
      "conv-broken",
      makeRuntime(() => Promise.reject(new Error("teardown refused"))),
    );
    registerRuntime(
      "conv-ok",
      makeRuntime(async () => {
        closed.push("conv-ok");
      }),
    );
    const source = fakeSignalSource();
    installRuntimeShutdownHook(source);

    await source.fire("SIGTERM");

    expect(closed).toEqual(["conv-ok"]);
    expect(getRuntime("conv-broken")).toBeUndefined();
  });

  /**
   * The close is what makes shutdown worth hooking at all, so the handler has
   * to still be running while it runs. A fire-and-forget close typechecks
   * identically and leaves every worker alive, so this pins the await itself:
   * the listener must not settle while a teardown is outstanding.
   */
  it("does not settle until every runtime's close has resolved", async () => {
    const release = Promise.withResolvers<void>();
    let closed = false;
    registerRuntime(
      "conv-slow",
      makeRuntime(async () => {
        await release.promise;
        closed = true;
      }),
    );
    const source = fakeSignalSource();
    installRuntimeShutdownHook(source);

    let handlerSettled = false;
    const firing = source.fire("SIGTERM").then(() => {
      handlerSettled = true;
    });
    await settleMicrotasks();
    expect(handlerSettled).toBe(false);
    expect(closed).toBe(false);

    release.resolve();
    await firing;

    expect(closed).toBe(true);
    expect(handlerSettled).toBe(true);
  });

  it("does not terminate the process, leaving the runtime's own drain intact", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("the shutdown hook must not exit the process");
    });
    try {
      registerRuntime(
        "conv-1",
        makeRuntime(async () => {}),
      );
      const source = fakeSignalSource();
      installRuntimeShutdownHook(source);

      await source.fire("SIGTERM");

      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
