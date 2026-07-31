import { describe, it, expect, beforeEach } from "vitest";
import { enableMapSet } from "immer";
import {
  useNotificationStore,
  type InputNeededItem,
  type PromptErrorItem,
} from "./notification.store";
import type { JobStatusEvent } from "@/lib/jobs/schemas";
import type {
  JobNotification,
  ProjectConversationNotification,
} from "@/lib/notifications/schemas";
import type { MergeDoneTicketPrompt } from "@/lib/tickets/merge-done-prompt";
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
    promptErrorQueue: [],
    mergeDonePromptQueue: [],
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

function makeJobNotification(
  overrides: Partial<JobNotification> = {},
): JobNotification {
  return {
    id: "notification-1",
    source: "job",
    type: "merge-completed",
    title: "Merge completed",
    message: "Merged",
    read: false,
    projectName: "my-project",
    sessionName: "my-session",
    branchName: "csm/my-session",
    jobId: "job-123",
    jobType: "merge",
    createdAt: "2026-06-07 12:00:00",
    ...overrides,
  };
}

function makeProjectConversationNotification(): ProjectConversationNotification {
  return {
    id: "plc-notification-1",
    source: "project-conversation",
    type: "project-conversation-ready",
    title: "Agent finished",
    message: "Project conversation is ready",
    read: false,
    projectName: "my-project",
    conversationId: "conversation-1",
    conversationName: "Planning",
    status: "awaiting",
    createdAt: "2026-06-07 12:00:00",
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

  it("keeps ready-to-land jobs in the map and maps preparedSha/parkedRef/refreshWarning", () => {
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        status: "ready-to-land",
        phase: "awaiting-land",
        preparedSha: "abcdef0123456789",
        parkedRef: "refs/cc-merges/job-123",
        refreshWarning: "could not refresh target",
      }),
    );

    const job = useNotificationStore.getState().jobs.get("job-123");
    expect(job?.status).toBe("ready-to-land");
    expect(job?.phase).toBe("awaiting-land");
    expect(job?.preparedSha).toBe("abcdef0123456789");
    expect(job?.parkedRef).toBe("refs/cc-merges/job-123");
    expect(job?.refreshWarning).toBe("could not refresh target");
  });

  it("replaces a stale ready-to-land job when a Land dispatches a new jobId for the same session", () => {
    // Original ready-to-land job for session
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-park",
        status: "ready-to-land",
        preparedSha: "abc",
        parkedRef: "refs/cc-merges/job-park",
      }),
    );
    expect(useNotificationStore.getState().jobs.size).toBe(1);

    // User clicks Land — new merge job dispatches with a different jobId
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-land",
        status: "running",
      }),
    );

    const jobs = useNotificationStore.getState().jobs;
    expect(jobs.size).toBe(1);
    expect(jobs.has("job-park")).toBe(false);
    expect(jobs.get("job-land")?.status).toBe("running");
  });

  it("replaces a stale ready-to-land job when Discard dispatches a new jobId for the same session", () => {
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-park",
        status: "ready-to-land",
        preparedSha: "abc",
        parkedRef: "refs/cc-merges/job-park",
      }),
    );

    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-discard",
        status: "running",
      }),
    );

    const jobs = useNotificationStore.getState().jobs;
    expect(jobs.size).toBe(1);
    expect(jobs.has("job-park")).toBe(false);
    expect(jobs.has("job-discard")).toBe(true);
  });

  it("clears the stale ready-to-land job when the Land terminal event arrives for a different jobId in same session", () => {
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-park",
        status: "ready-to-land",
        preparedSha: "abc",
        parkedRef: "refs/cc-merges/job-park",
      }),
    );

    // Land completes directly without an intervening running event in the store
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-land",
        status: "completed",
      }),
    );

    const jobs = useNotificationStore.getState().jobs;
    expect(jobs.size).toBe(0);
  });

  it("does not affect ready-to-land jobs in other sessions when a new job dispatches", () => {
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-park",
        sessionName: "session-a",
        status: "ready-to-land",
        preparedSha: "abc",
        parkedRef: "refs/cc-merges/job-park",
      }),
    );

    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        jobId: "job-other",
        sessionName: "session-b",
        status: "running",
      }),
    );

    const jobs = useNotificationStore.getState().jobs;
    expect(jobs.size).toBe(2);
    expect(jobs.has("job-park")).toBe(true);
    expect(jobs.has("job-other")).toBe(true);
  });

  it("removes the job when a discarded terminal event arrives", () => {
    useNotificationStore.getState().addOrUpdateJob(
      makeRunningEvent({
        status: "ready-to-land",
        preparedSha: "abc",
        parkedRef: "refs/cc-merges/job-123",
      }),
    );
    expect(useNotificationStore.getState().jobs.size).toBe(1);

    useNotificationStore
      .getState()
      .addOrUpdateJob(makeRunningEvent({ status: "discarded" }));

    expect(useNotificationStore.getState().jobs.size).toBe(0);
  });
});

describe("notification.store — job notification toast queue", () => {
  beforeEach(resetStore);

  it("enqueues job-variant merge, commit, resolve-conflicts, ready-to-land, and discarded notifications", () => {
    const notifications: JobNotification[] = [
      makeJobNotification({
        id: "merge",
        type: "merge-completed",
        jobType: "merge",
      }),
      makeJobNotification({
        id: "commit",
        type: "commit-completed",
        jobType: "commit",
      }),
      makeJobNotification({
        id: "resolve",
        type: "resolve-completed",
        jobType: "resolve-conflicts",
      }),
      makeJobNotification({
        id: "ready",
        type: "merge-ready-to-land",
        jobType: "merge",
      }),
      makeJobNotification({
        id: "discarded",
        type: "merge-discarded",
        jobType: "merge",
      }),
    ];

    for (const notification of notifications) {
      useNotificationStore.getState().enqueueToast(notification);
    }

    expect(useNotificationStore.getState().toastQueue).toEqual(notifications);
  });

  it("does not enqueue project-conversation notifications on the job toast queue", () => {
    useNotificationStore
      .getState()
      .enqueueToast(makeProjectConversationNotification());

    expect(useNotificationStore.getState().toastQueue).toEqual([]);
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

  it("enqueues a project-scoped input toast without a session name", () => {
    const item = {
      scope: "project",
      projectName: "my-project",
      conversationId: "project-convo-1",
      displayContext: "main",
      href: "/projects/my-project?focus=project-convo-1",
    } satisfies InputNeededItem;

    useNotificationStore.getState().enqueueInputToast(item);

    const queue = useNotificationStore.getState().inputToastQueue;
    expect(queue).toEqual([item]);
    expect("sessionName" in queue[0]!).toBe(false);
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

describe("notification.store — prompt error toast queue", () => {
  beforeEach(resetStore);

  it("enqueues a project-scoped prompt error toast without a session name", () => {
    const item = {
      scope: "project",
      projectName: "my-project",
      conversationId: "project-convo-1",
      displayContext: "main",
      href: "/projects/my-project?focus=project-convo-1",
      error: "Tool failed",
    } satisfies PromptErrorItem;

    useNotificationStore.getState().enqueuePromptErrorToast(item);

    const queue = useNotificationStore.getState().promptErrorQueue;
    expect(queue).toEqual([item]);
    expect("sessionName" in queue[0]!).toBe(false);
  });
});

describe("notification.store — merge Done-prompt queue", () => {
  beforeEach(resetStore);

  it("queues one suggestion per merged session and retires it on dismiss", () => {
    const first: MergeDoneTicketPrompt = {
      jobId: "job-1",
      projectName: "my-project",
      sessionName: "sess-a",
      ticketNumber: 37,
      ticketTitle: "Suggest moving ticket to Done on merge",
    };
    const second: MergeDoneTicketPrompt = {
      ...first,
      jobId: "job-2",
      sessionName: "sess-b",
    };

    useNotificationStore.getState().enqueueMergeDonePrompt(first);
    useNotificationStore.getState().enqueueMergeDonePrompt(second);
    expect(useNotificationStore.getState().mergeDonePromptQueue).toEqual([
      first,
      second,
    ]);

    useNotificationStore.getState().dismissMergeDonePrompt();
    expect(useNotificationStore.getState().mergeDonePromptQueue).toEqual([
      second,
    ]);
  });

  it("does not stack a second dialog for the same merge job", () => {
    const prompt: MergeDoneTicketPrompt = {
      jobId: "job-1",
      projectName: "my-project",
      sessionName: "sess-a",
      ticketNumber: 37,
      ticketTitle: "Suggest moving ticket to Done on merge",
    };

    useNotificationStore.getState().enqueueMergeDonePrompt(prompt);
    useNotificationStore.getState().enqueueMergeDonePrompt(prompt);

    expect(useNotificationStore.getState().mergeDonePromptQueue).toEqual([
      prompt,
    ]);
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

  it("retains server-reported ready-to-land jobs", () => {
    useNotificationStore.getState().reconcileJobs([
      {
        jobId: "job-park",
        jobType: "merge",
        status: "ready-to-land",
        projectName: "proj",
        sessionName: "sess",
        branchName: "csm/sess",
        startedAt: "2026-01-01T00:00:00Z",
        phase: "awaiting-land",
        preparedSha: "deadbeef",
        parkedRef: "refs/cc-merges/job-park",
      },
    ]);

    const jobs = useNotificationStore.getState().jobs;
    expect(jobs.size).toBe(1);
    expect(jobs.get("job-park")?.status).toBe("ready-to-land");
    expect(jobs.get("job-park")?.preparedSha).toBe("deadbeef");
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
