import { describe, expect, it } from "vitest";
import type { BackgroundJob } from "@/lib/jobs/schemas";
import type {
  ActiveCollaborationExecution,
  ActiveGraphWorkflowExecution,
} from "@/lib/active-conversations/schemas";
import type { Notification } from "@/lib/notifications/schemas";
import {
  adaptCollaborations,
  adaptGraphWorkflows,
  adaptSpecExecutions,
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

function makeWorkflow(
  overrides: Partial<ActiveGraphWorkflowExecution> = {},
): ActiveGraphWorkflowExecution {
  return {
    executionId: "exec-1",
    status: "running",
    projectName: "command-center",
    projectPath: "/repo",
    sessionName: "session-12",
    activeContextIds: ["c1", "c2"],
    activeContextTitles: ["Impl service", "Validation"],
    activeBatchIds: [],
    pendingHaltReason: null,
    contextMergeProgress: [],
    activeJoinIds: [],
    joinProgress: [],
    finalPublishState: null,
    completedContexts: 4,
    totalContexts: 7,
    startedAt: "2026-07-11T09:00:00.000Z",
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

describe("adaptGraphWorkflows", () => {
  it("maps a running execution with context titles and progress", () => {
    const items = adaptGraphWorkflows([makeWorkflow()]);
    expect(items[0]).toMatchObject({
      id: "workflow:exec-1",
      kind: "workflow",
      title: "Impl service + Validation",
      phase: "2 contexts active",
      progress: { completed: 4, total: 7 },
      href: "/projects/command-center/session-12/workflow",
    });
  });

  it("labels paused and pending executions and falls back on empty titles", () => {
    const items = adaptGraphWorkflows([
      makeWorkflow({ executionId: "p1", status: "paused" }),
      makeWorkflow({ executionId: "p2", status: "pending" }),
      makeWorkflow({
        executionId: "p3",
        activeContextIds: [],
        activeContextTitles: [],
      }),
    ]);
    expect(items.map((i) => [i.title, i.phase])).toEqual([
      ["Impl service + Validation", "Paused"],
      ["Impl service + Validation", "Queued"],
      ["Graph workflow", "Running"],
    ]);
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

describe("adaptSpecExecutions", () => {
  it("surfaces only definition-review and running executions in Active Work", () => {
    const items = adaptSpecExecutions([
      {
        executionId: "execution-review",
        state: "definition_review",
        specSlug: "native-sdd",
        specName: "Native SDD",
        projectName: "command-center",
        sessionName: "native-sdd",
        createdAt: "2026-07-18T10:00:00.000Z",
      },
      {
        executionId: "execution-running",
        state: "running",
        specSlug: "native-sdd",
        specName: "Native SDD",
        projectName: "command-center",
        sessionName: "native-sdd",
        createdAt: "2026-07-18T11:00:00.000Z",
      },
      {
        executionId: "execution-delivered",
        state: "delivered",
        specSlug: "native-sdd",
        specName: "Native SDD",
        projectName: "command-center",
        sessionName: "native-sdd",
        createdAt: "2026-07-18T09:00:00.000Z",
      },
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        id: "spec-execution:execution-review",
        kind: "spec",
        title: "Native SDD",
        phase: "Definition review",
        href: "/specs/command-center/native-sdd",
      }),
      expect.objectContaining({
        id: "spec-execution:execution-running",
        kind: "spec",
        phase: "Running",
      }),
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

  it("surfaces a waiver request as an actionable item until an attention-resolved row clears it", () => {
    const request = makeSpecNotification({
      type: "spec-waiver-requested",
      gate: "delivery",
      gateRequestId: "attention-1",
      deepLinkId: "criterion-9",
    });
    const pending = deriveNotificationOutcomes([request], []);
    expect(pending.needsAction).toEqual([
      expect.objectContaining({
        kind: "spec",
        phase: "Waiver decision required",
        href: "/specs/command-center/native-sdd?el=criterion-9",
        needsAction: { primary: { label: "Review", kind: "review" } },
      }),
    ]);

    const resolved = deriveNotificationOutcomes(
      [
        request,
        makeSpecNotification({
          id: "spec-notif-2",
          type: "spec-attention-resolved",
          gate: "delivery",
          gateRequestId: "attention-1",
          deepLinkId: "criterion-9",
          createdAt: "2026-07-18T12:01:00.000Z",
        }),
      ],
      [],
    );
    expect(resolved.needsAction).toEqual([]);
    expect(resolved.attention).toEqual([]);
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

  /**
   * A waiver ask mints a new id every time, so the criterion is the only thing
   * that tells two asks for one decision apart.
   */
  it("collapses repeated waiver requests for one criterion", () => {
    const first = makeSpecNotification({
      id: "n1",
      type: "spec-waiver-requested",
      gate: "delivery",
      gateRequestId: "attention-1",
      deepLinkId: "R1.1",
    });
    const second = makeSpecNotification({
      id: "n2",
      type: "spec-waiver-requested",
      gate: "delivery",
      gateRequestId: "attention-2",
      deepLinkId: "R1.1",
      createdAt: "2026-07-18T12:02:00.000Z",
    });

    const { needsAction } = deriveNotificationOutcomes([first, second], []);
    expect(needsAction).toMatchObject([{ id: "notification:n2" }]);
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
