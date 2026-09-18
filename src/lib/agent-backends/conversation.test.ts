import { describe, expect, it } from "vitest";
import type { ConversationBackendEvent } from "./conversation";
import {
  captureAvailabilitySchema,
  captureHandoffResultSchema,
  type CaptureHandoffResult,
} from "./schemas";

describe("ConversationBackendEvent", () => {
  it("includes an input_accepted lifecycle event", () => {
    const event: ConversationBackendEvent = { type: "input_accepted" };

    expect(event.type).toBe("input_accepted");
  });

  it("narrows the existing lifecycle members alongside input_accepted", () => {
    const events: ConversationBackendEvent[] = [
      { type: "input_accepted" },
      { type: "external_turn_started" },
      { type: "error", message: "boom" },
    ];

    const seen = events.map((event) => {
      switch (event.type) {
        case "input_accepted":
          return "accepted";
        case "external_turn_started":
          return "started";
        case "error":
          return event.message;
        default:
          return "other";
      }
    });

    expect(seen).toEqual(["accepted", "started", "boom"]);
  });
});

const captured = (): CaptureHandoffResult => ({
  modeEstablished: true,
  submitted: true,
  correlatedCompletion: true,
  candidateText: "working state",
  omissionReason: null,
  executionSettled: true,
  cleanupFailure: null,
  continuation: {
    disposition: "retain",
    backendRef: { backend: "codex", ref: "opaque" },
    nextRuntime: "recreate_from_ref",
  },
  activity: {
    transport: "complete",
    native: "unavailable",
    prohibited: "not_observed",
    inspectedBytes: null,
  },
  usage: {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    costUsd: null,
    costBasis: null,
    executionMs: null,
    settlementMs: null,
  },
});

describe("capture handoff contract", () => {
  it("preserves unavailable usage and accepts disclosed unavailable native coverage", () => {
    expect(captureHandoffResultSchema.parse(captured())).toEqual(captured());
    expect(
      captureAvailabilitySchema.safeParse({
        available: false,
        mode: null,
        reason: "Not implemented",
      }).success,
    ).toBe(true);
    expect(
      captureAvailabilitySchema.safeParse({ available: false, mode: null })
        .success,
    ).toBe(false);
  });

  it.each([
    ["modeEstablished", false],
    ["submitted", false],
    ["correlatedCompletion", false],
    ["executionSettled", false],
    ["omissionReason", "capture_failed"],
    [
      "cleanupFailure",
      { code: "cleanup_unverified", message: "still running" },
    ],
    [
      "activity",
      {
        transport: "complete",
        native: "incomplete",
        prohibited: "not_observed",
        inspectedBytes: 20,
      },
    ],
    [
      "activity",
      {
        transport: "complete",
        native: "complete",
        prohibited: "observed",
        inspectedBytes: 20,
      },
    ],
    [
      "continuation",
      {
        disposition: "retain",
        backendRef: null,
        nextRuntime: "recreate_from_ref",
      },
    ],
    [
      "continuation",
      {
        disposition: "clear",
        backendRef: { backend: "codex", ref: "opaque" },
        nextRuntime: "unavailable",
      },
    ],
  ])("rejects invalid result %s=%j", (field, value) => {
    const result = captureHandoffResultSchema.safeParse({
      ...captured(),
      [field]: value,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.code === "custom")).toBe(
        true,
      );
  });
});

describe("capture usage attribution", () => {
  it.each([
    { costUsd: 0.2, costBasis: null },
    { costUsd: null, costBasis: "pricing_estimate" },
    { costUsd: null, costBasis: "provider_reported" },
  ])("rejects unmatched cost and basis: %j", (cost) => {
    const result = captureHandoffResultSchema.safeParse({
      ...captured(),
      usage: { ...captured().usage, ...cost },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "custom",
            path: ["usage", "costBasis"],
          }),
        ]),
      );
    }
  });

  it.each(["pricing_estimate", "provider_reported"])(
    "retains a measured zero cost with its %s basis",
    (costBasis) => {
      const result = captureHandoffResultSchema.parse({
        ...captured(),
        usage: { ...captured().usage, costUsd: 0, costBasis },
      });
      expect(result.usage.costUsd).toBe(0);
      expect(result.usage.costBasis).toBe(costBasis);
    },
  );
});
