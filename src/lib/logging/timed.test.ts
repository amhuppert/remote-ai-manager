import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timed, timedSync, _resetTimedForTesting } from "./timed";
import { runWithTrace, getTraceContext } from "./context";
import type { Logger } from "./logger";

interface CapturedCall {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

function makeFakeLogger(): { logger: Logger; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const logger: Logger = {
    debug: (message, fields) => calls.push({ level: "debug", message, fields }),
    info: (message, fields) => calls.push({ level: "info", message, fields }),
    warn: (message, fields) => calls.push({ level: "warn", message, fields }),
    error: (message, fields) => calls.push({ level: "error", message, fields }),
  };
  return { logger, calls };
}

describe("timed", () => {
  beforeEach(() => {
    _resetTimedForTesting();
    delete process.env["CC_TIMING_INFO_MS"];
    delete process.env["CC_TIMING_WARN_MS"];
    delete process.env["CC_TIMING_START"];
  });

  afterEach(() => {
    _resetTimedForTesting();
    delete process.env["CC_TIMING_INFO_MS"];
    delete process.env["CC_TIMING_WARN_MS"];
    delete process.env["CC_TIMING_START"];
    vi.restoreAllMocks();
  });

  it("emits <event>.complete with durationMs on success", async () => {
    const { logger, calls } = makeFakeLogger();
    const result = await timed(logger, "thing", { foo: "bar" }, async () => 42);

    expect(result).toBe(42);
    const complete = calls.find((c) => c.message === "thing.complete");
    expect(complete).toBeDefined();
    expect(complete?.fields?.["foo"]).toBe("bar");
    expect(typeof complete?.fields?.["durationMs"]).toBe("number");
  });

  it("emits at debug below info threshold", async () => {
    process.env["CC_TIMING_INFO_MS"] = "10000";
    const { logger, calls } = makeFakeLogger();
    await timed(logger, "thing", {}, async () => "ok");

    const complete = calls.find((c) => c.message === "thing.complete");
    expect(complete?.level).toBe("debug");
  });

  it("emits at info at/above info threshold", async () => {
    process.env["CC_TIMING_INFO_MS"] = "0";
    process.env["CC_TIMING_WARN_MS"] = "10000";
    const { logger, calls } = makeFakeLogger();
    await timed(logger, "thing", {}, async () => "ok");

    const complete = calls.find((c) => c.message === "thing.complete");
    expect(complete?.level).toBe("info");
  });

  it("emits at warn at/above warn threshold", async () => {
    process.env["CC_TIMING_INFO_MS"] = "0";
    process.env["CC_TIMING_WARN_MS"] = "0";
    const { logger, calls } = makeFakeLogger();
    await timed(logger, "thing", {}, async () => "ok");

    const complete = calls.find((c) => c.message === "thing.complete");
    expect(complete?.level).toBe("warn");
  });

  it("emits <event>.error and re-throws on rejection", async () => {
    const { logger, calls } = makeFakeLogger();
    const err = new Error("boom");

    await expect(
      timed(logger, "thing", { ctx: "x" }, async () => {
        throw err;
      }),
    ).rejects.toThrow("boom");

    const errLog = calls.find((c) => c.message === "thing.error");
    expect(errLog?.level).toBe("warn");
    expect(errLog?.fields?.["ctx"]).toBe("x");
    expect(errLog?.fields?.["error"]).toBe(err);
    expect(typeof errLog?.fields?.["durationMs"]).toBe("number");
  });

  it("does not emit <event>.start when CC_TIMING_START is unset", async () => {
    const { logger, calls } = makeFakeLogger();
    await timed(logger, "thing", {}, async () => "ok");

    expect(calls.find((c) => c.message === "thing.start")).toBeUndefined();
  });

  it("emits <event>.start at debug when CC_TIMING_START=1", async () => {
    process.env["CC_TIMING_START"] = "1";
    const { logger, calls } = makeFakeLogger();
    await timed(logger, "thing", { foo: 1 }, async () => "ok");

    const start = calls.find((c) => c.message === "thing.start");
    expect(start?.level).toBe("debug");
    expect(start?.fields?.["foo"]).toBe(1);
  });

  it("does not mutate caller's fields object", async () => {
    const { logger } = makeFakeLogger();
    const fields = { a: 1 };
    await timed(logger, "thing", fields, async () => "ok");

    expect(fields).toEqual({ a: 1 });
    expect("durationMs" in fields).toBe(false);
  });

  it("merges resultFields(result) into the complete log on success", async () => {
    const { logger, calls } = makeFakeLogger();
    await timed(
      logger,
      "thing",
      { base: "yes" },
      async () => [1, 2, 3, 4],
      (items) => ({ count: items.length }),
    );

    const complete = calls.find((c) => c.message === "thing.complete");
    expect(complete?.fields?.["base"]).toBe("yes");
    expect(complete?.fields?.["count"]).toBe(4);
    expect(typeof complete?.fields?.["durationMs"]).toBe("number");
  });

  it("does not call resultFields on error", async () => {
    const { logger } = makeFakeLogger();
    const resultFields = vi.fn();

    await expect(
      timed(
        logger,
        "thing",
        {},
        async () => {
          throw new Error("nope");
        },
        resultFields,
      ),
    ).rejects.toThrow("nope");

    expect(resultFields).not.toHaveBeenCalled();
  });

  it("propagates trace context through fn", async () => {
    const { logger } = makeFakeLogger();
    let observedInsideFn: string | undefined;
    await runWithTrace({ traceId: "t-123" }, async () => {
      await timed(logger, "thing", {}, async () => {
        observedInsideFn = getTraceContext()?.traceId;
      });
    });

    expect(observedInsideFn).toBe("t-123");
  });
});

describe("timedSync", () => {
  beforeEach(() => {
    _resetTimedForTesting();
    delete process.env["CC_TIMING_INFO_MS"];
    delete process.env["CC_TIMING_WARN_MS"];
    delete process.env["CC_TIMING_START"];
  });

  afterEach(() => {
    _resetTimedForTesting();
    delete process.env["CC_TIMING_INFO_MS"];
    delete process.env["CC_TIMING_WARN_MS"];
    delete process.env["CC_TIMING_START"];
  });

  it("returns the sync result and logs complete", () => {
    const { logger, calls } = makeFakeLogger();
    const result = timedSync(logger, "sync", { k: "v" }, () => 7);

    expect(result).toBe(7);
    const complete = calls.find((c) => c.message === "sync.complete");
    expect(complete?.fields?.["k"]).toBe("v");
    expect(typeof complete?.fields?.["durationMs"]).toBe("number");
  });

  it("merges resultFields(result) into the complete log for sync", () => {
    const { logger, calls } = makeFakeLogger();
    timedSync(
      logger,
      "sync",
      {},
      () => ({ rows: 5 }),
      (r) => ({ rowCount: r.rows }),
    );

    const complete = calls.find((c) => c.message === "sync.complete");
    expect(complete?.fields?.["rowCount"]).toBe(5);
  });

  it("emits error and re-throws on sync throw", () => {
    const { logger, calls } = makeFakeLogger();
    const err = new Error("sync boom");

    expect(() =>
      timedSync(logger, "sync", {}, () => {
        throw err;
      }),
    ).toThrow("sync boom");

    const errLog = calls.find((c) => c.message === "sync.error");
    expect(errLog?.level).toBe("warn");
    expect(errLog?.fields?.["error"]).toBe(err);
  });
});
