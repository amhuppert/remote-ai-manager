/**
 * The budget indicator is SSE-driven rather than polled, so these frames are
 * the only thing that keeps the gauge honest — a dropped phase means a stale
 * number on screen until the next remount.
 */

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";

import { validationKeys } from "./query-keys";
import type { ValidationRunEventPhase } from "./schemas";
import { registerValidationSseReactions } from "./sse-reactions";

function setup() {
  const fake = new FakeEventSource("/api/events");
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  registerValidationSseReactions(fake as unknown as EventSource, {
    queryClient,
  });
  return { fake, invalidate };
}

function emitPhase(
  fake: FakeEventSource,
  phase: ValidationRunEventPhase,
): void {
  fake.emit("validation-run", {
    type: "validation-run",
    phase,
    runId: "vrun-1",
    commandName: "test",
    source: "agent_cli",
    projectPath: "/repos/command-center",
    conversationId: "conv-1",
    requestedScope: "changed",
    effectiveScope: "changed",
    outcome: null,
    timestamp: "2026-08-20T10:00:00.000Z",
  });
}

describe("registerValidationSseReactions", () => {
  it.each<ValidationRunEventPhase>([
    "queued",
    "started",
    "completed",
    "cancelled",
    "interrupted",
    // Oversized queued rows are retired as `rejected`, which drops the queue
    // depth — the phase cannot be skipped just because most rejections are
    // pre-admission.
    "rejected",
  ])("refreshes the budget when a run is %s", (phase) => {
    const { fake, invalidate } = setup();

    emitPhase(fake, phase);

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: validationKeys.budget(),
    });
  });

  it("ignores the pre-admission requested phase", () => {
    const { fake, invalidate } = setup();

    emitPhase(fake, "requested");

    // `requested` always precedes the phase that does move the ledger, so
    // reacting to it would only double the refetches.
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("ignores frames that do not parse as a validation run event", () => {
    const { fake, invalidate } = setup();

    fake.emit("validation-run", { type: "validation-run", phase: "nonsense" });

    expect(invalidate).not.toHaveBeenCalled();
  });
});
