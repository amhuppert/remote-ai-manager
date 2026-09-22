import { describe, expect, it } from "vitest";
import {
  installServerShutdownGuard,
  type ServerShutdownDeps,
} from "./server-shutdown";

type Signal = "SIGINT" | "SIGTERM";

function harness(closedStreams = 0) {
  const listeners = new Map<Signal, () => void>();
  const timers: Array<{ callback: () => void; ms: number }> = [];
  const exits: number[] = [];
  let closeCalls = 0;
  const deps: ServerShutdownDeps = {
    source: {
      once(signal, listener) {
        listeners.set(signal, listener);
      },
    },
    closeEventStreams() {
      closeCalls += 1;
      return closedStreams;
    },
    armExitTimer(callback, ms) {
      timers.push({ callback, ms });
    },
    exit(code) {
      exits.push(code);
    },
    deadlineMs: 15_000,
  };
  return {
    deps,
    timers,
    exits,
    closeCalls: () => closeCalls,
    fire(signal: Signal) {
      const listener = listeners.get(signal);
      if (listener === undefined) throw new Error(`no ${signal} listener`);
      listener();
    },
    registered: () => [...listeners.keys()],
  };
}

describe("installServerShutdownGuard", () => {
  it("does nothing until a terminating signal arrives", () => {
    const h = harness();

    installServerShutdownGuard(h.deps);

    expect(h.registered()).toEqual(["SIGINT", "SIGTERM"]);
    expect(h.closeCalls()).toBe(0);
    expect(h.timers).toEqual([]);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "on %s closes the event streams, then exits with %i only once the deadline passes",
    (signal, code) => {
      const h = harness(3);
      installServerShutdownGuard(h.deps);

      h.fire(signal);

      expect(h.closeCalls()).toBe(1);
      expect(h.timers.map((t) => t.ms)).toEqual([15_000]);
      expect(h.exits).toEqual([]);

      h.timers[0]?.callback();

      expect(h.exits).toEqual([code]);
    },
  );

  it("still arms the deadline when closing the event streams throws", () => {
    const h = harness();
    h.deps.closeEventStreams = () => {
      throw new Error("stream teardown failed");
    };
    installServerShutdownGuard(h.deps);

    h.fire("SIGTERM");
    h.timers[0]?.callback();

    expect(h.exits).toEqual([143]);
  });
});
