import { describe, expect, it } from "vitest";

import { checkpointRuntimeCreations, countEvents } from "./run-log";

const OP = "op-1";

describe("counting events in a probe run log", () => {
  it("counts by message, and by operation when one is named", () => {
    const log = [
      { message: "checkpoint.fresh_runtime", operationId: OP },
      { message: "checkpoint.fresh_runtime", operationId: "op-2" },
      { message: "prompt.resume_ref_missing" },
    ];
    expect(countEvents(log, "checkpoint.fresh_runtime")).toBe(2);
    expect(countEvents(log, "checkpoint.fresh_runtime", OP)).toBe(1);
    expect(countEvents(log, "prompt.resume_ref_missing")).toBe(1);
  });
});

describe("reading how a checkpoint's fresh runtime was created", () => {
  it("reports the resume handle the creation immediately before it was given", () => {
    const log = [
      { message: "prompt.runtime_create", hasResumeRef: true },
      { message: "prompt.complete" },
      { message: "prompt.runtime_create", hasResumeRef: false },
      { message: "checkpoint.fresh_runtime", operationId: OP },
    ];
    expect(checkpointRuntimeCreations(log, OP)).toEqual([
      { hasResumeRef: false },
    ]);
  });

  it("reports a resumed creation as resumed rather than hiding it", () => {
    // The failure this exists to catch: a delivery that resumed the retired
    // provider session would still log a fresh-runtime line for the operation.
    const log = [
      { message: "prompt.runtime_create", hasResumeRef: true },
      { message: "checkpoint.fresh_runtime", operationId: OP },
    ];
    expect(checkpointRuntimeCreations(log, OP)).toEqual([
      { hasResumeRef: true },
    ]);
  });

  it("ignores fresh runtimes belonging to another operation", () => {
    const log = [
      { message: "prompt.runtime_create", hasResumeRef: false },
      { message: "checkpoint.fresh_runtime", operationId: "op-2" },
    ];
    expect(checkpointRuntimeCreations(log, OP)).toEqual([]);
  });

  it("reports an unknown handle when no creation precedes the fresh runtime", () => {
    const log = [
      { message: "checkpoint.fresh_runtime", operationId: OP },
      { message: "prompt.runtime_create", hasResumeRef: false },
    ];
    expect(checkpointRuntimeCreations(log, OP)).toEqual([
      { hasResumeRef: null },
    ]);
  });

  it("returns one entry per fresh runtime, so a second seed injection is visible", () => {
    const log = [
      { message: "prompt.runtime_create", hasResumeRef: false },
      { message: "checkpoint.fresh_runtime", operationId: OP },
      { message: "prompt.runtime_create", hasResumeRef: true },
      { message: "checkpoint.fresh_runtime", operationId: OP },
    ];
    expect(checkpointRuntimeCreations(log, OP)).toEqual([
      { hasResumeRef: false },
      { hasResumeRef: true },
    ]);
  });
});
