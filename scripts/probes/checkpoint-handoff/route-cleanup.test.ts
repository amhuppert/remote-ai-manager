import { describe, expect, it } from "vitest";
import { collectStoppedRouteProcesses } from "./route-cleanup";

const root = { pid: 10, parentPid: 1, started: "root-start" };
const child = { pid: 20, parentPid: 10, started: "child-start" };
const grandchild = { pid: 30, parentPid: 20, started: "grandchild-start" };

describe("observed route process cleanup", () => {
  it("collects descendant identities before stop and observes their exit", async () => {
    let stopped = false;
    const result = await collectStoppedRouteProcesses(root, {
      snapshot: () => (stopped ? [] : [root, child, grandchild]),
      stopServer() {
        stopped = true;
      },
      async wait() {},
    });
    expect(result.observed).toEqual([root, child, grandchild]);
    expect(result.settled).toBe(true);
  });
  it("does not attest cleanup when a child survives successful server stop", async () => {
    let stopped = false;
    const result = await collectStoppedRouteProcesses(root, {
      snapshot: () => (stopped ? [{ ...child, parentPid: 1 }] : [root, child]),
      stopServer() {
        stopped = true;
      },
      async wait() {},
    });
    expect(result.settled).toBe(false);
    expect(result.remaining).toEqual([{ ...child, parentPid: 1 }]);
  });
  it("does not confuse a reused PID with the original child", async () => {
    let stopped = false;
    const result = await collectStoppedRouteProcesses(root, {
      snapshot: () =>
        stopped ? [{ ...child, started: "different-start" }] : [root, child],
      stopServer() {
        stopped = true;
      },
      async wait() {},
    });
    expect(result.settled).toBe(true);
  });
});
