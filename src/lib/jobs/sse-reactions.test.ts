import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  registerJobSseReactions,
  registerJobsReconnectReconciliation,
} from "./sse-reactions";
import type { reconnectReconcile } from "@/lib/events/sse-reconnect";
import type { BackgroundJob, JobStatusEvent } from "@/lib/jobs/schemas";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import type { MergeDoneTicketPrompt } from "@/lib/tickets/merge-done-prompt";
import { ticketKeys } from "@/lib/tickets/query-keys";
import type { TicketLinkSummary } from "@/lib/tickets/schemas";

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

function jobStatus(overrides: Partial<JobStatusEvent> = {}): JobStatusEvent {
  return {
    type: "job-status",
    jobType: "merge",
    status: "completed",
    projectName: "proj",
    sessionName: "sess",
    jobId: "job-1",
    branchName: "csm/x",
    ...overrides,
  };
}

/** Registers the live reactions over a client that already knows the link. */
function setupLive(links?: Record<string, TicketLinkSummary>) {
  const fake = new FakeEventSource("/api/events");
  const queryClient = makeClient();
  if (links) {
    queryClient.setQueryData(ticketKeys.sessionLinks("proj"), links);
  }
  const enqueueMergeDonePrompt =
    vi.fn<(prompt: MergeDoneTicketPrompt) => void>();

  registerJobSseReactions(fake as unknown as EventSource, {
    queryClient,
    addOrUpdateJob: vi.fn(),
    enqueueMergeDonePrompt,
  });

  return { fake, enqueueMergeDonePrompt };
}

const linkedTicket: TicketLinkSummary = {
  ticketId: "ticket-1",
  projectName: "proj",
  number: 37,
  title: "Suggest moving ticket to Done on merge",
  active: true,
  linkedAt: "2026-07-30T00:00:00.000Z",
  endedAt: null,
};

describe("registerJobSseReactions", () => {
  it("suggests moving the linked ticket to Done once the merge completes", () => {
    const { fake, enqueueMergeDonePrompt } = setupLive({ sess: linkedTicket });

    fake.emit("job-status", jobStatus());

    expect(enqueueMergeDonePrompt).toHaveBeenCalledWith({
      jobId: "job-1",
      projectName: "proj",
      sessionName: "sess",
      ticketNumber: 37,
      ticketTitle: "Suggest moving ticket to Done on merge",
    });
  });

  it("does not suggest Done while the merge is still running", () => {
    const { fake, enqueueMergeDonePrompt } = setupLive({ sess: linkedTicket });

    fake.emit("job-status", jobStatus({ status: "running" }));
    fake.emit("job-status", jobStatus({ status: "ready-to-land" }));

    expect(enqueueMergeDonePrompt).not.toHaveBeenCalled();
  });

  it("does not suggest Done for a merged session with no ticket link", () => {
    const { fake, enqueueMergeDonePrompt } = setupLive({});

    fake.emit("job-status", jobStatus());

    expect(enqueueMergeDonePrompt).not.toHaveBeenCalled();
  });
});

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
