import { describe, expect, it } from "vitest";

import {
  decideMemoryIndexDelivery,
  isRuntimeCreatedWithoutResume,
} from "./delivery-decision";

describe("decideMemoryIndexDelivery", () => {
  it.each([
    {
      case: "has no prior delivery",
      input: {
        hasDeliveryState: false,
        runtimeCreatedWithoutResume: false,
        backendReportedCompactionLastTurn: false,
      },
      expected: { mode: "full", reset: false },
    },
    {
      case: "created a runtime without a resume handle",
      input: {
        hasDeliveryState: true,
        runtimeCreatedWithoutResume: true,
        backendReportedCompactionLastTurn: false,
      },
      expected: { mode: "full", reset: true },
    },
    {
      case: "received a backend compaction signal",
      input: {
        hasDeliveryState: true,
        runtimeCreatedWithoutResume: false,
        backendReportedCompactionLastTurn: true,
      },
      expected: { mode: "full", reset: true },
    },
    {
      case: "received both context-loss signals without prior delivery",
      input: {
        hasDeliveryState: false,
        runtimeCreatedWithoutResume: true,
        backendReportedCompactionLastTurn: true,
      },
      expected: { mode: "full", reset: true },
    },
    {
      case: "retains its delivered context",
      input: {
        hasDeliveryState: true,
        runtimeCreatedWithoutResume: false,
        backendReportedCompactionLastTurn: false,
      },
      expected: { mode: "delta", reset: false },
    },
  ] as const)(
    "returns the expected decision when the conversation $case",
    ({ input, expected }) => {
      expect(decideMemoryIndexDelivery(input)).toEqual(expected);
    },
  );
});

describe("isRuntimeCreatedWithoutResume", () => {
  it.each([
    {
      case: "must create a runtime and has no handle to resume from",
      input: {
        willCreateRuntime: true,
        promptCount: 3,
        hasResumeHandle: false,
      },
      expected: true,
    },
    {
      case: "reuses a live runtime",
      input: {
        willCreateRuntime: false,
        promptCount: 3,
        hasResumeHandle: false,
      },
      expected: false,
    },
    {
      case: "has never completed a turn, so nothing was lost",
      input: {
        willCreateRuntime: true,
        promptCount: 0,
        hasResumeHandle: false,
      },
      expected: false,
    },
    {
      case: "hands the new runtime a resume handle",
      input: { willCreateRuntime: true, promptCount: 3, hasResumeHandle: true },
      expected: false,
    },
  ] as const)(
    "is $expected when the conversation $case",
    ({ input, expected }) => {
      expect(isRuntimeCreatedWithoutResume(input)).toBe(expected);
    },
  );
});

describe("isRuntimeCreatedWithoutResume with a pending checkpoint", () => {
  it("treats the checkpoint's fresh-start intent as a context loss even when a handle is stored", () => {
    expect(
      isRuntimeCreatedWithoutResume({
        willCreateRuntime: true,
        promptCount: 4,
        hasResumeHandle: true,
        pendingCheckpoint: true,
      }),
    ).toBe(true);
  });

  it("changes nothing for a continuing conversation without a pending checkpoint", () => {
    expect(
      isRuntimeCreatedWithoutResume({
        willCreateRuntime: true,
        promptCount: 4,
        hasResumeHandle: true,
        pendingCheckpoint: false,
      }),
    ).toBe(false);
    expect(
      isRuntimeCreatedWithoutResume({
        willCreateRuntime: true,
        promptCount: 4,
        hasResumeHandle: false,
        pendingCheckpoint: false,
      }),
    ).toBe(true);
  });
});
