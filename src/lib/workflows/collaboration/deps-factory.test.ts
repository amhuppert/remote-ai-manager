/**
 * Production deps-factory tests for Collaboration Mode.
 *
 * These tests verify that `createCollaborationDeps` returns a fully-shaped
 * `AsymmetricCollaborationSliceDeps` so the manager can call
 * `runAsymmetricCollaborationSlice(input, deps)` with the result without
 * further threading. We deliberately do NOT exercise the full slice here —
 * the slice has its own coverage in `asymmetric-slice.test.ts`. The shape
 * and the in-process StatusBus default behavior are what callers depend on.
 *
 * `vi.mock` is intentionally avoided per project standards: the production
 * factory is invoked directly. Filesystem-backed sub-services (envelope
 * store, artifact registry) are constructed but never written through, so
 * the lazy `require("@/lib/state")` call doesn't actually hit disk.
 */
import { describe, it, expect, vi } from "vitest";

import { createCollaborationDeps } from "./deps-factory";
import type { AsymmetricCollaborationSliceDeps } from "./asymmetric-slice";
import {
  createStatusBus,
  type StatusBusEnvelope,
} from "@/lib/workflows/primitives/status-bus";

function makeStubCallAgent(): AsymmetricCollaborationSliceDeps["callAgent"] {
  return vi.fn(async () => {
    throw new Error(
      "stub callAgent should not be invoked during deps-factory tests",
    );
  });
}

const baseInput = {
  projectPath: "/tmp/projects/example",
  sessionName: "collab-session",
  worktreePath: "/tmp/projects/example/.worktrees/collab-session",
};

describe("createCollaborationDeps", () => {
  it("returns a fully-shaped AsymmetricCollaborationSliceDeps", () => {
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    expect(typeof deps.callAgent).toBe("function");
    expect(deps.laneService).toBeDefined();
    expect(typeof deps.laneService.resolve).toBe("function");
    expect(typeof deps.laneService.initialize).toBe("function");
    expect(typeof deps.laneService.recordOutcome).toBe("function");
    expect(deps.laneScheduler).toBeDefined();
    expect(typeof deps.laneScheduler.schedule).toBe("function");
    expect(deps.envelopeStore).toBeDefined();
    expect(typeof deps.envelopeStore.read).toBe("function");
    expect(typeof deps.envelopeStore.upsert).toBe("function");
    expect(deps.statusBus).toBeDefined();
    expect(typeof deps.statusBus.publish).toBe("function");
    expect(typeof deps.statusBus.subscribe).toBe("function");
    expect(typeof deps.markConversationAwaiting).toBe("function");
    expect(typeof deps.updateConversationBackendRef).toBe("function");
  });

  it("forwards the injected callAgent verbatim", () => {
    const callAgent = makeStubCallAgent();
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent,
    });

    expect(deps.callAgent).toBe(callAgent);
  });

  it("default StatusBus delivers published envelopes to in-process subscribers", () => {
    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    const received: StatusBusEnvelope[] = [];
    const unsubscribe = deps.statusBus.subscribe((envelope) => {
      received.push(envelope);
    });

    const outcome = deps.statusBus.publish({
      scope: "collaboration",
      scopeId: "wf-001",
      status: "running",
      payload: { type: "round_started", round: 1 },
    });

    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      scope: "collaboration",
      scopeId: "wf-001",
      status: "running",
      payload: { type: "round_started", round: 1 },
    });
  });

  it("honors a caller-supplied StatusBus override", () => {
    const overrideBus = createStatusBus({ broadcast: () => {} });

    const deps = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
      statusBus: overrideBus,
    });

    expect(deps.statusBus).toBe(overrideBus);
  });

  it("creates fresh lane state per call but shares the production scheduler across runs", () => {
    const a = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });
    const b = createCollaborationDeps({
      ...baseInput,
      callAgent: makeStubCallAgent(),
    });

    expect(a.laneService).not.toBe(b.laneService);
    expect(a.laneScheduler).toBe(b.laneScheduler);
    expect(a.statusBus).not.toBe(b.statusBus);
  });
});
