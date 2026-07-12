import { describe, expect, it } from "vitest";
import { createSessionLifecycleGate } from "./lifecycle-gate";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SessionLifecycleGate", () => {
  it("runs same-session operations FIFO while allowing different sessions concurrently", async () => {
    const gate = createSessionLifecycleGate();
    const releaseFirst = deferred();
    const firstEntered = deferred();
    const order: string[] = [];

    const first = gate.runExclusive("/repo", "same", async () => {
      order.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
    await firstEntered.promise;
    const second = gate.runExclusive("/repo", "same", async () => {
      order.push("second");
    });
    const other = gate.runExclusive("/repo", "other", async () => {
      order.push("other");
    });

    await other;
    expect(order).toEqual(["first:start", "other"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });

  it("acquires multi-session operations in a stable order", async () => {
    const gate = createSessionLifecycleGate();
    const releaseBatch = deferred();
    const batchEntered = deferred();
    const order: string[] = [];

    const batch = gate.runExclusiveMany("/repo", ["b", "a", "b"], async () => {
      order.push("batch:start");
      batchEntered.resolve();
      await releaseBatch.promise;
      order.push("batch:end");
    });
    await batchEntered.promise;
    const a = gate.runExclusive("/repo", "a", async () => {
      order.push("a");
    });
    const b = gate.runExclusive("/repo", "b", async () => {
      order.push("b");
    });

    await Promise.resolve();
    expect(order).toEqual(["batch:start"]);
    releaseBatch.resolve();
    await Promise.all([batch, a, b]);
    expect(order[0]).toBe("batch:start");
    expect(order[1]).toBe("batch:end");
    expect(order.slice(2).sort()).toEqual(["a", "b"]);
  });

  it("excludes project deletion and marks later operations as post-deletion", async () => {
    const gate = createSessionLifecycleGate();
    const releaseActive = deferred();
    const activeEntered = deferred();
    const releaseDeletion = deferred();
    const deletionEntered = deferred();
    const phases: string[] = [];

    const active = gate.runExclusive("/repo", "active", async () => {
      phases.push("active:start");
      activeEntered.resolve();
      await releaseActive.promise;
      phases.push("active:end");
    });
    await activeEntered.promise;
    const deletion = gate.runProjectDeletion("/repo", async () => {
      phases.push("deletion:start");
      deletionEntered.resolve();
      await releaseDeletion.promise;
      phases.push("deletion:end");
    });
    let preceded = false;
    const later = gate.runExclusive("/repo", "later", async (context) => {
      preceded = context.projectDeletionPrecededOperation;
      phases.push("later");
    });

    releaseActive.resolve();
    await deletionEntered.promise;
    expect(phases).toEqual(["active:start", "active:end", "deletion:start"]);
    releaseDeletion.resolve();
    await Promise.all([active, deletion, later]);
    expect(phases).toEqual([
      "active:start",
      "active:end",
      "deletion:start",
      "deletion:end",
      "later",
    ]);
    expect(preceded).toBe(true);
  });
});
