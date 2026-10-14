import { describe, expect, it } from "vitest";
import type { BackgroundJob } from "@/lib/jobs/schemas";
import type { ActiveCollaborationExecution } from "@/lib/active-conversations/schemas";
import type { Notification } from "@/lib/notifications/schemas";
import type { ActiveRun } from "@/lib/runs/schemas";
import {
  adaptCollaborations,
  adaptRuns,
  adaptStoreJobs,
  deriveNotificationOutcomes,
} from "./active-work-adapters";

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    jobId: "job-1",
    jobType: "merge",
    status: "running",
    projectName: "command-center",
    sessionName: "session-12",
    branchName: "csm/auth-fix",
    startedAt: "2026-07-11T10:00:00.000Z",
    ...overrides,
  };
}

function makeCollab(
  overrides: Partial<ActiveCollaborationExecution> = {},
): ActiveCollaborationExecution {
  return {
    workflowId: "collab-1",
    status: "running",
    phase: "initial_draft",
    projectName: "command-center",
    projectPath: "/repo",
    sessionName: "session-12",
    conversationId: "convo-9",
    createdAt: "2026-07-11T11:00:00.000Z",
    updatedAt: "2026-07-11T11:30:00.000Z",
    ...overrides,
  };
}

function makeJobNotification(
  overrides: Partial<Extract<Notification, { source: "job" }>> = {},
): Notification {
  return {
    id: "notif-1",
    source: "job",
    type: "merge-conflicts",
    title: "Merge conflicts",
    message: "3 conflicts detected merging csm/auth-fix into main",
    read: false,
    projectName: "command-center",
    sessionName: "session-12",
    branchName: "csm/auth-fix",
    jobId: "job-old",
    jobType: "merge",
    createdAt: "2026-07-11T10:00:00.000Z",
    ...overrides,
  };
}

function makeSpecNotification(
  overrides: Partial<Extract<Notification, { source: "spec" }>> = {},
): Notification {
  return {
    id: "spec-notif-1",
    source: "spec",
    type: "spec-approval-requested",
    title: "Spec approval required",
    message: "Native SDD needs design approval for D2.",
    read: false,
    projectName: "command-center",
    sessionName: "native-sdd",
    specId: "spec-1",
    specSlug: "native-sdd",
    specName: "Native SDD",
    gate: "design",
    gateRequestId: "request-1",
    deepLinkId: "D2",
    createdAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

describe("adaptStoreJobs", () => {
  it("maps a running merge with phase to a running item", () => {
    const items = adaptStoreJobs([makeJob({ phase: "validating" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "job:job-1",
      kind: "job",
      title: "Merge csm/auth-fix",
      phase: "Validating…",
      projectName: "command-center",
      sessionName: "session-12",
      href: "/projects/command-center/session-12",
      startedAt: "2026-07-11T10:00:00.000Z",
    });
    expect(items[0]?.needsAction).toBeUndefined();
  });

  it("maps commit and resolve-conflicts phases to their labels", () => {
    const items = adaptStoreJobs([
      makeJob({ jobId: "c1", jobType: "commit" }),
      makeJob({ jobId: "r1", jobType: "resolve-conflicts" }),
    ]);
    expect(items.map((i) => [i.title, i.phase])).toEqual([
      ["Commit csm/auth-fix", "Committing…"],
      ["Resolve csm/auth-fix", "Resolving…"],
    ]);
  });

  it("maps a ready-to-land merge to a needs-action item with Land and Discard", () => {
    const items = adaptStoreJobs([makeJob({ status: "ready-to-land" })]);
    expect(items[0]?.phase).toBe("Ready to land");
    expect(items[0]?.needsAction).toEqual({
      primary: { label: "Land", kind: "land" },
      secondary: { label: "Discard", kind: "discard" },
    });
  });
});

describe("adaptCollaborations", () => {
  it("maps a running collaboration to its conversation", () => {
    const items = adaptCollaborations([makeCollab()]);
    expect(items[0]).toMatchObject({
      id: "collab:collab-1",
      kind: "collab",
      title: "Collaboration",
      phase: "Initial draft",
      href: "/conversations?c=convo-9",
      startedAt: "2026-07-11T11:00:00.000Z",
    });
  });

  it("labels paused collaborations and links to the session without a conversation", () => {
    const items = adaptCollaborations([
      makeCollab({ status: "paused", conversationId: null }),
    ]);
    expect(items[0]?.phase).toBe("Paused");
    expect(items[0]?.href).toBe("/projects/command-center/session-12");
  });
});

function makeRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    runId: "run-1",
    title: "Checkout v2 rollout",
    kind: "workflow",
    projectName: "command-center",
    sessionName: "session-12",
    status: { kind: "running" },
    attention: 0,
    approvals: 0,
    contexts: { done: 2, total: 5 },
    startedAt: "2026-10-09T10:00:00.000Z",
    askedAt: null,
    ...overrides,
  };
}

describe("adaptRuns", () => {
  it("lists a running run with its progress, leading to its page", () => {
    expect(adaptRuns([makeRun()])).toEqual([
      {
        id: "run:run-1",
        kind: "run",
        title: "Checkout v2 rollout",
        projectName: "command-center",
        sessionName: "session-12",
        phase: "Running",
        href: "/projects/command-center/session-12/runs?run=run-1",
        startedAt: "2026-10-09T10:00:00.000Z",
        progress: { completed: 2, total: 5 },
      },
    ]);
  });

  it("asks for a review when a result waits for approval, and for a look when something else needs the person", () => {
    const [approval, halted] = adaptRuns([
      makeRun({
        attention: 2,
        approvals: 1,
        status: { kind: "needs_input" },
        askedAt: "2026-10-09T12:00:00.000Z",
      }),
      makeRun({
        runId: "run-2",
        kind: "agent",
        attention: 1,
        status: { kind: "needs_input" },
      }),
    ]);

    expect(approval).toMatchObject({
      phase: "Approval required",
      askedAt: "2026-10-09T12:00:00.000Z",
      needsAction: { primary: { label: "Review", kind: "review" } },
    });
    expect(halted).toMatchObject({
      phase: "Action required",
      needsAction: { primary: { label: "Open", kind: "review" } },
    });
    expect(halted).not.toHaveProperty("progress");
  });

  it("marks a paused or stopping run as held, not running", () => {
    const [paused, stopping, running] = adaptRuns([
      makeRun({ status: { kind: "paused", draining: false } }),
      makeRun({ runId: "run-2", status: { kind: "stopping" } }),
      makeRun({ runId: "run-3" }),
    ]);

    expect([paused?.held, stopping?.held, running?.held]).toEqual([
      true,
      true,
      undefined,
    ]);
  });
});

describe("deriveNotificationOutcomes", () => {
  it("surfaces a spec approval request until a grant row supersedes it", () => {
    const pending = deriveNotificationOutcomes([makeSpecNotification()], []);
    expect(pending.needsAction).toEqual([
      expect.objectContaining({
        kind: "spec",
        href: "/specs/command-center/native-sdd?el=D2",
        needsAction: {
          primary: { label: "Review", kind: "review" },
        },
      }),
    ]);

    const granted = deriveNotificationOutcomes(
      [
        makeSpecNotification(),
        makeSpecNotification({
          id: "spec-notif-2",
          type: "spec-approval-granted",
          approvalId: "approval-1",
          createdAt: "2026-07-18T12:01:00.000Z",
        }),
      ],
      [],
    );
    expect(granted.needsAction).toEqual([]);
  });

  it("lets an approval grant supersede its request when both share a timestamp", () => {
    const { needsAction } = deriveNotificationOutcomes(
      [
        makeSpecNotification(),
        makeSpecNotification({
          id: "spec-notif-2",
          type: "spec-approval-granted",
          approvalId: "approval-1",
        }),
      ],
      [],
    );

    expect(needsAction).toEqual([]);
  });

  it("collapses repeats of one request, and its resolving row clears them all", () => {
    const repeats = [
      makeSpecNotification({ id: "n1", gateRequestId: "request-1" }),
      makeSpecNotification({
        id: "n2",
        gateRequestId: "request-1",
        createdAt: "2026-07-18T12:02:00.000Z",
      }),
    ];
    const open = deriveNotificationOutcomes(repeats, []);
    expect(open.needsAction).toHaveLength(1);
    expect(open.needsAction[0]).toMatchObject({ id: "notification:n2" });

    const cleared = deriveNotificationOutcomes(
      [
        ...repeats,
        makeSpecNotification({
          id: "n3",
          type: "spec-attention-resolved",
          gateRequestId: "request-1",
          createdAt: "2026-07-18T12:03:00.000Z",
        }),
      ],
      [],
    );
    expect(cleared.needsAction).toEqual([]);
  });

  /**
   * At the plan gate the item subject and the gate name are the same word, so
   * two different asks arrive under one deep link. Merging them would let the
   * item approval hide the ask still waiting on the revision sign-off.
   */
  it("keeps two requests at one gate and subject apart, clearing only the answered one", () => {
    const item = makeSpecNotification({
      id: "n1",
      gate: "plan",
      gateRequestId: "request-item",
      deepLinkId: "plan",
    });
    const gate = makeSpecNotification({
      id: "n2",
      gate: "plan",
      gateRequestId: "request-gate",
      deepLinkId: "plan",
      createdAt: "2026-07-18T12:02:00.000Z",
    });

    expect(
      deriveNotificationOutcomes([item, gate], []).needsAction,
    ).toHaveLength(2);

    const afterItemApproval = deriveNotificationOutcomes(
      [
        item,
        gate,
        makeSpecNotification({
          id: "n3",
          type: "spec-approval-granted",
          approvalId: "approval-1",
          gate: "plan",
          gateRequestId: "request-item",
          deepLinkId: "plan",
          createdAt: "2026-07-18T12:03:00.000Z",
        }),
      ],
      [],
    );
    expect(afterItemApproval.needsAction).toMatchObject([
      { id: "notification:n2" },
    ]);
  });

  it("keeps requests for different subjects independent", () => {
    const { needsAction } = deriveNotificationOutcomes(
      [
        makeSpecNotification({ id: "n1", deepLinkId: "D2" }),
        makeSpecNotification({
          id: "n2",
          gateRequestId: "request-2",
          deepLinkId: "D3",
        }),
        makeSpecNotification({
          id: "n3",
          type: "spec-approval-granted",
          approvalId: "approval-1",
          deepLinkId: "D3",
          gateRequestId: "request-2",
          createdAt: "2026-07-18T12:01:00.000Z",
        }),
      ],
      [],
    );

    expect(needsAction).toHaveLength(1);
    expect(needsAction[0]).toMatchObject({
      href: "/specs/command-center/native-sdd?el=D2",
    });
  });

  it("turns the latest merge-conflicts row into a Resolve needs-action item", () => {
    const { needsAction, attention } = deriveNotificationOutcomes(
      [makeJobNotification({ conflictCount: 3 })],
      [],
    );
    expect(attention).toEqual([]);
    expect(needsAction[0]).toMatchObject({
      id: "notification:notif-1",
      title: "Merge csm/auth-fix",
      phase: "3 conflicts",
      href: "/projects/command-center/session-12/conflicts",
      needsAction: { primary: { label: "Resolve", kind: "resolve" } },
      startedAt: "2026-07-11T10:00:00.000Z",
    });
  });

  it("turns the latest merge-ready-to-land row into Land/Discard", () => {
    const { needsAction } = deriveNotificationOutcomes(
      [makeJobNotification({ type: "merge-ready-to-land" })],
      [],
    );
    expect(needsAction[0]?.phase).toBe("Ready to land");
    expect(needsAction[0]?.needsAction).toEqual({
      primary: { label: "Land", kind: "land" },
      secondary: { label: "Discard", kind: "discard" },
    });
  });

  it("keeps only the newest row per merge saga — a completed merge silences older conflicts", () => {
    const { needsAction, attention } = deriveNotificationOutcomes(
      [
        makeJobNotification({ id: "n1", createdAt: "2026-07-11T10:00:00Z" }),
        makeJobNotification({
          id: "n2",
          type: "merge-completed",
          createdAt: "2026-07-11T11:00:00Z",
        }),
      ],
      [],
    );
    expect(needsAction).toEqual([]);
    expect(attention).toEqual([]);
  });

  it("treats resolve-conflicts rows as part of the merge saga", () => {
    const { needsAction } = deriveNotificationOutcomes(
      [
        makeJobNotification({ id: "n1", createdAt: "2026-07-11T10:00:00Z" }),
        makeJobNotification({
          id: "n2",
          type: "resolve-completed",
          jobType: "resolve-conflicts",
          createdAt: "2026-07-11T11:00:00Z",
        }),
      ],
      [],
    );
    expect(needsAction).toEqual([]);
  });

  it("suppresses notification-derived rows when a live job exists for the same saga", () => {
    const { needsAction, attention } = deriveNotificationOutcomes(
      [
        makeJobNotification({ type: "merge-ready-to-land" }),
        makeJobNotification({
          id: "n2",
          type: "merge-failed",
          createdAt: "2026-07-11T09:00:00Z",
        }),
      ],
      [makeJob({ status: "running" })],
    );
    expect(needsAction).toEqual([]);
    expect(attention).toEqual([]);
  });

  it("maps the latest failure row to an attention item keyed by the notification id", () => {
    const { attention } = deriveNotificationOutcomes(
      [
        makeJobNotification({
          id: "n9",
          type: "merge-failed",
          title: "Merge failed",
          errorMessage: "pre-merge validation exited with code 1",
        }),
      ],
      [],
    );
    expect(attention[0]).toMatchObject({
      id: "n9",
      title: "Merge failed",
      detail: "pre-merge validation exited with code 1",
      href: "/projects/command-center/session-12",
      occurredAt: "2026-07-11T10:00:00.000Z",
    });
  });

  it("keeps commit and merge sagas independent within a session", () => {
    const { attention } = deriveNotificationOutcomes(
      [
        makeJobNotification({
          id: "n1",
          type: "commit-failed",
          jobType: "commit",
          title: "Commit failed",
          createdAt: "2026-07-11T09:00:00Z",
        }),
        makeJobNotification({
          id: "n2",
          type: "merge-completed",
          createdAt: "2026-07-11T11:00:00Z",
        }),
      ],
      [],
    );
    expect(attention.map((a) => a.id)).toEqual(["n1"]);
  });

  it("maps a project-conversation failure to attention unless a newer row supersedes it", () => {
    const failed: Notification = {
      id: "pc-1",
      source: "project-conversation",
      type: "project-conversation-failed",
      title: "Conversation failed",
      message: "prompt execution error",
      read: false,
      projectName: "command-center",
      createdAt: "2026-07-11T10:00:00Z",
      conversationId: "convo-3",
      conversationName: "Fix flaky test",
      status: "failed",
    };
    const alone = deriveNotificationOutcomes([failed], []);
    expect(alone.attention[0]).toMatchObject({
      id: "pc-1",
      title: "Conversation failed",
      href: "/conversations?c=convo-3",
    });

    const superseded = deriveNotificationOutcomes(
      [
        failed,
        {
          ...failed,
          id: "pc-2",
          type: "project-conversation-ready",
          status: "awaiting",
          title: "Conversation ready",
          createdAt: "2026-07-11T11:00:00Z",
        },
      ],
      [],
    );
    expect(superseded.attention).toEqual([]);
  });

  it("ignores success and discard rows entirely", () => {
    const { needsAction, attention } = deriveNotificationOutcomes(
      [
        makeJobNotification({ id: "n1", type: "merge-discarded" }),
        makeJobNotification({
          id: "n2",
          type: "commit-completed",
          jobType: "commit",
          sessionName: "session-31",
        }),
      ],
      [],
    );
    expect(needsAction).toEqual([]);
    expect(attention).toEqual([]);
  });
});
