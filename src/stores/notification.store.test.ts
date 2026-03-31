import { describe, it, expect, beforeEach } from "vitest";
import { enableMapSet } from "immer";
import { useNotificationStore } from "./notification.store";
import type { JobStatusEvent } from "@/types";

enableMapSet();

// ============================================================
// Helpers
// ============================================================

/** Reset the Zustand store between tests */
function resetStore() {
  useNotificationStore.setState({
    jobs: new Map(),
    toastQueue: [],
    inputToastQueue: [],
  });
}

function makeRunningEvent(
  overrides: Partial<JobStatusEvent> = {},
): JobStatusEvent {
  return {
    type: "job-status",
    jobType: "merge",
    status: "running",
    projectName: "my-project",
    sessionName: "my-session",
    jobId: "job-123",
    branchName: "csm/my-session",
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe("notification.store — optimistic job addition", () => {
  beforeEach(resetStore);

  it("adds a running job to the store", () => {
    const event = makeRunningEvent();
    useNotificationStore.getState().addOrUpdateJob(event);

    const jobs = useNotificationStore.getState().jobs;
    expect(jobs.size).toBe(1);

    const job = jobs.get("job-123");
    expect(job).toBeDefined();
    expect(job?.jobType).toBe("merge");
    expect(job?.status).toBe("running");
    expect(job?.projectName).toBe("my-project");
    expect(job?.sessionName).toBe("my-session");
    expect(job?.branchName).toBe("csm/my-session");
  });

  it("SSE dedup: adding the same jobId again does not create duplicates", () => {
    const event = makeRunningEvent();

    // Add optimistically (simulating mutation onSuccess)
    useNotificationStore.getState().addOrUpdateJob(event);
    expect(useNotificationStore.getState().jobs.size).toBe(1);

    // Add again (simulating SSE event arriving)
    useNotificationStore.getState().addOrUpdateJob(event);
    expect(useNotificationStore.getState().jobs.size).toBe(1);

    // Job data is intact
    const job = useNotificationStore.getState().jobs.get("job-123");
    expect(job?.status).toBe("running");
  });

  it("terminal event removes the optimistically-added job", () => {
    // Add running job (optimistic)
    useNotificationStore.getState().addOrUpdateJob(makeRunningEvent());
    expect(useNotificationStore.getState().jobs.size).toBe(1);

    // Terminal event arrives (job completed)
    useNotificationStore
      .getState()
      .addOrUpdateJob(
        makeRunningEvent({ status: "completed", mergeHash: "abc123" }),
      );
    expect(useNotificationStore.getState().jobs.size).toBe(0);
  });

  it("handles multiple different jobs independently", () => {
    useNotificationStore
      .getState()
      .addOrUpdateJob(makeRunningEvent({ jobId: "job-1", jobType: "merge" }));
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-2",
        jobType: "commit",
        sessionName: "other-session",
      }),
    );

    expect(useNotificationStore.getState().jobs.size).toBe(2);

    // Terminal one of them
    useNotificationStore
      .getState()
      .addOrUpdateJob(
        makeRunningEvent({ jobId: "job-1", status: "completed" }),
      );

    expect(useNotificationStore.getState().jobs.size).toBe(1);
    expect(useNotificationStore.getState().jobs.has("job-2")).toBe(true);
  });

  it("preserves startedAt from the first add (optimistic) on SSE dedup", () => {
    const event = makeRunningEvent();
    useNotificationStore.getState().addOrUpdateJob(event);

    const originalStartedAt = useNotificationStore
      .getState()
      .jobs.get("job-123")?.startedAt;
    expect(originalStartedAt).toBeDefined();

    // SSE event arrives slightly later — startedAt should be preserved
    useNotificationStore.getState().addOrUpdateJob(event);
    const updatedStartedAt = useNotificationStore
      .getState()
      .jobs.get("job-123")?.startedAt;
    expect(updatedStartedAt).toBe(originalStartedAt);
  });
});

// ============================================================
// Input Toast Queue Tests
// ============================================================

describe("notification.store — input toast queue", () => {
  beforeEach(resetStore);

  it("starts with an empty input toast queue", () => {
    expect(useNotificationStore.getState().inputToastQueue).toEqual([]);
  });

  it("enqueues an input toast item", () => {
    useNotificationStore.getState().enqueueInputToast({
      projectName: "my-project",
      sessionName: "my-session",
      conversationId: "conv-1",
    });

    const queue = useNotificationStore.getState().inputToastQueue;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual({
      projectName: "my-project",
      sessionName: "my-session",
      conversationId: "conv-1",
    });
  });

  it("enqueues multiple items in FIFO order", () => {
    const { enqueueInputToast } = useNotificationStore.getState();
    enqueueInputToast({
      projectName: "proj-a",
      sessionName: "sess-a",
      conversationId: "conv-1",
    });
    enqueueInputToast({
      projectName: "proj-b",
      sessionName: "sess-b",
      conversationId: "conv-2",
    });

    const queue = useNotificationStore.getState().inputToastQueue;
    expect(queue).toHaveLength(2);
    expect(queue[0]!.conversationId).toBe("conv-1");
    expect(queue[1]!.conversationId).toBe("conv-2");
  });

  it("dismisses the first item from the queue", () => {
    const { enqueueInputToast } = useNotificationStore.getState();
    enqueueInputToast({
      projectName: "proj-a",
      sessionName: "sess-a",
      conversationId: "conv-1",
    });
    enqueueInputToast({
      projectName: "proj-b",
      sessionName: "sess-b",
      conversationId: "conv-2",
    });

    useNotificationStore.getState().dismissInputToast();

    const queue = useNotificationStore.getState().inputToastQueue;
    expect(queue).toHaveLength(1);
    expect(queue[0]!.conversationId).toBe("conv-2");
  });

  it("dismissing from an empty queue is a no-op", () => {
    useNotificationStore.getState().dismissInputToast();
    expect(useNotificationStore.getState().inputToastQueue).toEqual([]);
  });
});

// ============================================================
// reconcileJobs Tests
// ============================================================

describe("notification.store — reconcileJobs", () => {
  beforeEach(resetStore);

  it("removes stale running jobs not present on server", () => {
    // Client has a "running" job from a mutation onSuccess
    useNotificationStore.getState().addOrUpdateJob(makeRunningEvent());
    expect(useNotificationStore.getState().jobs.size).toBe(1);

    // Server reports no active jobs → stale job should be removed
    useNotificationStore.getState().reconcileJobs([]);
    expect(useNotificationStore.getState().jobs.size).toBe(0);
  });

  it("keeps jobs that are still active on server", () => {
    useNotificationStore.getState().addOrUpdateJob(makeRunningEvent());

    // Server confirms the job is still running
    useNotificationStore.getState().reconcileJobs([
      {
        jobId: "job-123",
        jobType: "merge",
        status: "running",
        projectName: "my-project",
        sessionName: "my-session",
        branchName: "csm/my-session",
        startedAt: "2026-01-01T00:00:00Z",
        phase: "validating",
      },
    ]);

    const jobs = useNotificationStore.getState().jobs;
    expect(jobs.size).toBe(1);
    // Phase should be updated from server
    expect(jobs.get("job-123")?.phase).toBe("validating");
  });

  it("adds server-side running jobs not present on client", () => {
    // Client has no jobs, but server has one (e.g. page refreshed mid-job)
    useNotificationStore.getState().reconcileJobs([
      {
        jobId: "job-new",
        jobType: "commit",
        status: "running",
        projectName: "proj",
        sessionName: "sess",
        branchName: "csm/sess",
        startedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    const jobs = useNotificationStore.getState().jobs;
    expect(jobs.size).toBe(1);
    expect(jobs.get("job-new")?.jobType).toBe("commit");
  });

  it("preserves non-job state (toasts, queues)", () => {
    useNotificationStore.getState().enqueueInputToast({
      projectName: "p",
      sessionName: "s",
      conversationId: "c",
    });
    useNotificationStore.getState().addOrUpdateJob(makeRunningEvent());

    useNotificationStore.getState().reconcileJobs([]);

    // Jobs cleared, but toast queue preserved
    expect(useNotificationStore.getState().jobs.size).toBe(0);
    expect(useNotificationStore.getState().inputToastQueue).toHaveLength(1);
  });
});
