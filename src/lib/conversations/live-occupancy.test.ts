import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetLiveOccupancyForTesting,
  clearLiveOccupancy,
  markLiveCompaction,
  readLiveOccupancy,
  recordLiveOccupancy,
} from "./live-occupancy";

describe("live-occupancy registry", () => {
  beforeEach(() => {
    _resetLiveOccupancyForTesting();
  });

  it("round-trips a recorded occupancy value", () => {
    recordLiveOccupancy("conv-1", 42_000);
    expect(readLiveOccupancy("conv-1")).toEqual({
      contextTokens: 42_000,
      compactedThisTurn: false,
    });
  });

  it("last write wins for contextTokens", () => {
    recordLiveOccupancy("conv-1", 10_000);
    recordLiveOccupancy("conv-1", 55_000);
    expect(readLiveOccupancy("conv-1")).toEqual({
      contextTokens: 55_000,
      compactedThisTurn: false,
    });
  });

  it("markLiveCompaction with no prior entry yields null tokens and compactedThisTurn true", () => {
    markLiveCompaction("conv-1");
    expect(readLiveOccupancy("conv-1")).toEqual({
      contextTokens: null,
      compactedThisTurn: true,
    });
  });

  it("compaction flag survives subsequent record calls", () => {
    markLiveCompaction("conv-1");
    recordLiveOccupancy("conv-1", 30_000);
    expect(readLiveOccupancy("conv-1")).toEqual({
      contextTokens: 30_000,
      compactedThisTurn: true,
    });
  });

  it("markLiveCompaction on an existing recorded entry preserves the recorded tokens", () => {
    recordLiveOccupancy("conv-1", 30_000);
    markLiveCompaction("conv-1");
    expect(readLiveOccupancy("conv-1")).toEqual({
      contextTokens: 30_000,
      compactedThisTurn: true,
    });
  });

  it("returns null for an unknown conversation id", () => {
    expect(readLiveOccupancy("nope")).toBeNull();
  });

  it("clearLiveOccupancy removes the entry", () => {
    recordLiveOccupancy("conv-1", 42_000);
    clearLiveOccupancy("conv-1");
    expect(readLiveOccupancy("conv-1")).toBeNull();
  });

  it("_resetLiveOccupancyForTesting empties the registry", () => {
    recordLiveOccupancy("conv-1", 42_000);
    recordLiveOccupancy("conv-2", 7_000);
    _resetLiveOccupancyForTesting();
    expect(readLiveOccupancy("conv-1")).toBeNull();
    expect(readLiveOccupancy("conv-2")).toBeNull();
  });

  it("keeps entries isolated per conversation id", () => {
    recordLiveOccupancy("conv-1", 10_000);
    markLiveCompaction("conv-2");
    expect(readLiveOccupancy("conv-1")).toEqual({
      contextTokens: 10_000,
      compactedThisTurn: false,
    });
    expect(readLiveOccupancy("conv-2")).toEqual({
      contextTokens: null,
      compactedThisTurn: true,
    });
  });
});
