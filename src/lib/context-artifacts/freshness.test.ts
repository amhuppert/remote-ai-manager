import { describe, expect, it } from "vitest";
import { deriveFreshness } from "./freshness";

const currentVersions = {
  promptVersion: "1",
  normalizerVersion: "1",
  schemaVersion: 1,
};

const freshRow = { coveredEndSeq: 12, ...currentVersions };

describe("deriveFreshness", () => {
  it("is fresh when coverage reaches maxSeq and all versions match", () => {
    expect(
      deriveFreshness(freshRow, { maxSeq: 12, ...currentVersions }),
    ).toEqual({
      stale: false,
      staleBehindMessages: 0,
      outdated: false,
    });
  });

  it("is stale when the transcript advanced past the covered range", () => {
    const result = deriveFreshness(
      freshRow,
      { maxSeq: 15, ...currentVersions },
      3,
    );
    expect(result.stale).toBe(true);
    expect(result.staleBehindMessages).toBe(3);
    expect(result.outdated).toBe(false);
  });

  it("defaults staleBehindMessages to 0 when the caller supplies no unit count", () => {
    const result = deriveFreshness(freshRow, {
      maxSeq: 15,
      ...currentVersions,
    });
    expect(result).toEqual({
      stale: true,
      staleBehindMessages: 0,
      outdated: false,
    });
  });

  it("clamps staleBehindMessages to 0 when not stale even if a count is supplied", () => {
    const result = deriveFreshness(
      freshRow,
      { maxSeq: 12, ...currentVersions },
      5,
    );
    expect(result).toEqual({
      stale: false,
      staleBehindMessages: 0,
      outdated: false,
    });
  });

  it("is not stale when maxSeq is -1 (empty transcript) or behind coverage", () => {
    expect(
      deriveFreshness(freshRow, { maxSeq: -1, ...currentVersions }).stale,
    ).toBe(false);
    expect(
      deriveFreshness(freshRow, { maxSeq: 11, ...currentVersions }).stale,
    ).toBe(false);
  });

  it.each([
    ["promptVersion", { ...currentVersions, promptVersion: "2" }],
    ["normalizerVersion", { ...currentVersions, normalizerVersion: "2" }],
    ["schemaVersion", { ...currentVersions, schemaVersion: 2 }],
  ])("is outdated on %s drift alone", (_field, current) => {
    const result = deriveFreshness(freshRow, { maxSeq: 12, ...current });
    expect(result.outdated).toBe(true);
    expect(result.stale).toBe(false);
  });

  it("reports stale and outdated independently", () => {
    const result = deriveFreshness(
      freshRow,
      {
        maxSeq: 20,
        promptVersion: "2",
        normalizerVersion: "1",
        schemaVersion: 1,
      },
      4,
    );
    expect(result).toEqual({
      stale: true,
      staleBehindMessages: 4,
      outdated: true,
    });
  });
});
