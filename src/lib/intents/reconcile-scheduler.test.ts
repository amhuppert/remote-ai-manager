import { describe, expect, it } from "vitest";
import { createReconcileScheduler } from "./reconcile-scheduler";

describe("reconcile scheduler", () => {
  it("runs the registered reconcile for a touched owner", async () => {
    const scheduler = createReconcileScheduler();
    const runs: string[] = [];
    scheduler.register("context", {
      reconcile: (id) => {
        runs.push(id);
      },
      onFailure: () => {},
    });

    scheduler.touch({ kind: "context", id: "ctx-1" });
    await scheduler.idle();

    expect(runs).toEqual(["ctx-1"]);
  });

  it("coalesces touches that arrive while the owner reconciles into one rerun", async () => {
    const scheduler = createReconcileScheduler();
    let runs = 0;
    scheduler.register("context", {
      reconcile: async () => {
        runs += 1;
        if (runs === 1) {
          scheduler.touch({ kind: "context", id: "ctx-1" });
          scheduler.touch({ kind: "context", id: "ctx-1" });
          await Promise.resolve();
          scheduler.touch({ kind: "context", id: "ctx-1" });
        }
      },
      onFailure: () => {},
    });

    scheduler.touch({ kind: "context", id: "ctx-1" });
    await scheduler.idle();

    expect(runs).toBe(2);
  });

  it("serializes one owner but lets different owners reconcile concurrently", async () => {
    const scheduler = createReconcileScheduler();
    const release = Promise.withResolvers<void>();
    const started: string[] = [];
    scheduler.register("run", {
      reconcile: async (id) => {
        started.push(id);
        await release.promise;
      },
      onFailure: () => {},
    });

    scheduler.touch({ kind: "run", id: "run-a" });
    scheduler.touch({ kind: "run", id: "run-b" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(started).toEqual(["run-a", "run-b"]);
    release.resolve();
    await scheduler.idle();
  });

  it("reports a failed reconcile and keeps serving later touches", async () => {
    const scheduler = createReconcileScheduler();
    const failures: Array<[string, string]> = [];
    let attempts = 0;
    scheduler.register("context", {
      reconcile: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("advance failed");
      },
      onFailure: (id, error) => {
        failures.push([id, error instanceof Error ? error.message : "?"]);
      },
    });

    scheduler.touch({ kind: "context", id: "ctx-1" });
    await scheduler.idle();
    scheduler.touch({ kind: "context", id: "ctx-1" });
    await scheduler.idle();

    expect(failures).toEqual([["ctx-1", "advance failed"]]);
    expect(attempts).toBe(2);
  });

  it("refuses a touch for an owner kind nobody registered", () => {
    const scheduler = createReconcileScheduler();
    expect(() => scheduler.touch({ kind: "run", id: "run-1" })).toThrow(
      /No reconcile registered for run/,
    );
  });
});
