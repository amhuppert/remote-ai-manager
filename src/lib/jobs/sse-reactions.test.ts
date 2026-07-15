import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { registerJobsReconnectReconciliation } from "./sse-reactions";
import type { reconnectReconcile } from "@/lib/events/sse-reconnect";
import type { BackgroundJob } from "@/lib/jobs/schemas";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function validJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    jobId: "job-1",
    jobType: "merge",
    status: "completed",
    projectName: "proj",
    sessionName: "sess",
    branchName: "csm/x",
    startedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A `reconnectReconcile` stub that captures the jobs callback and lets the test
 * hand it whatever `/api/jobs` payload it wants — so the parse/reconcile
 * behavior is exercised without real fetch. `FakeEventSource` satisfies the
 * registrar's `SseEventTarget` port structurally, so no cast is needed.
 */
function setup(payload: unknown) {
  const fake = new FakeEventSource("/api/events");
  const client = makeClient();
  const reconcileJobs = vi.fn<(jobs: BackgroundJob[]) => void>();

  const reconnectReconcileStub = vi
    .fn<typeof reconnectReconcile>()
    .mockImplementation(async (_client, cb) => {
      cb(payload);
    });

  registerJobsReconnectReconciliation(fake, {
    queryClient: client,
    reconcileJobs,
    reconnectReconcile: reconnectReconcileStub,
  });

  return { fake, reconcileJobs, reconnectReconcileStub };
}

describe("registerJobsReconnectReconciliation", () => {
  it("reconciles parsed jobs into the store after an error then reconnect", async () => {
    const jobs = [validJob({ jobId: "a" }), validJob({ jobId: "b" })];
    const { fake, reconcileJobs, reconnectReconcileStub } = setup(jobs);

    fake.emit("error", {});
    fake.emit("open", {});
    await vi.waitFor(() => expect(reconnectReconcileStub).toHaveBeenCalled());

    expect(reconcileJobs).toHaveBeenCalledTimes(1);
    expect(reconcileJobs).toHaveBeenCalledWith(jobs);
  });

  it("does not reconcile on a clean open with no preceding error", () => {
    const { fake, reconcileJobs, reconnectReconcileStub } = setup([validJob()]);

    fake.emit("open", {});

    expect(reconnectReconcileStub).not.toHaveBeenCalled();
    expect(reconcileJobs).not.toHaveBeenCalled();
  });

  it("drops a malformed jobs payload without touching the store", async () => {
    const { fake, reconcileJobs, reconnectReconcileStub } = setup([
      { jobId: 123, status: "not-a-status" },
    ]);

    fake.emit("error", {});
    fake.emit("open", {});
    await vi.waitFor(() => expect(reconnectReconcileStub).toHaveBeenCalled());

    expect(reconcileJobs).not.toHaveBeenCalled();
  });

  it("re-arms: a second error/open cycle reconciles again", async () => {
    const jobs = [validJob()];
    const { fake, reconcileJobs, reconnectReconcileStub } = setup(jobs);

    fake.emit("error", {});
    fake.emit("open", {});
    await vi.waitFor(() =>
      expect(reconnectReconcileStub).toHaveBeenCalledTimes(1),
    );

    fake.emit("error", {});
    fake.emit("open", {});
    await vi.waitFor(() =>
      expect(reconnectReconcileStub).toHaveBeenCalledTimes(2),
    );
    expect(reconcileJobs).toHaveBeenCalledTimes(2);
  });
});
