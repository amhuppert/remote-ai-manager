import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import type { SpecDetailView } from "@/lib/specs/queries";

import {
  draftReviewFixture,
  specControlsDetailFixture,
  subjectFingerprintFixture,
} from "./SpecControls.fixtures";
import SpecReviewMode from "./SpecReviewMode";

const NOW = "2026-07-18T12:00:00.000Z";

function reviewDetailFixture(blocked = false): SpecDetailView {
  const detail = specControlsDetailFixture();
  const baseSnapshot = detail.currentRevision;
  if (baseSnapshot === null) throw new Error("Review story requires a base");

  const currentRevision = {
    ...baseSnapshot.revision,
    id: "revision-2",
    number: 2,
    state: "draft" as const,
    basedOnRevisionId: baseSnapshot.revision.id,
    contentHash: "revision-2-hash",
    proposedAt: null,
    approvedAt: null,
  };
  const currentElements = baseSnapshot.elements.map((entry) => ({
    ...entry,
    version: {
      ...entry.version,
      revisionId: currentRevision.id,
      ...(entry.element.id === "requirement-1"
        ? {
            payload: {
              kind: "requirement" as const,
              statement: "Every execution pins the exact selected scope.",
              priority: "must" as const,
              risk: "high" as const,
            },
            payloadHash: "requirement-hash-2",
            elementVersion: 2,
          }
        : entry.element.id === "task-1"
          ? {
              payload: {
                kind: "task" as const,
                title: "Implement immutable scope pinning",
                instructions: "Persist the selected task and criterion set.",
                tracedRequirementElementIds: ["requirement-1"],
                tracedDecisionElementIds: [],
                coveredCriterionElementIds: ["criterion-1"],
                dependsOnTaskElementIds: [],
              },
              payloadHash: "task-hash-2",
              elementVersion: 2,
            }
          : {}),
    },
  }));
  currentElements.push({
    element: {
      id: "decision-1",
      specId: detail.spec.id,
      kind: "decision",
      number: 1,
      parentElementId: null,
      createdAt: NOW,
    },
    version: {
      revisionId: currentRevision.id,
      elementId: "decision-1",
      position: 3,
      payload: {
        kind: "decision",
        title: "Pin scope at execution start",
        chosenApproach: "Store the complete selected scope.",
        rejectedAlternatives: [],
        reason: "Execution must remain reproducible.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      payloadHash: "decision-hash",
      elementVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

  const currentSnapshot = {
    revision: currentRevision,
    elements: currentElements,
    assumptionCitations: [],
  };

  return {
    ...detail,
    revisions: [baseSnapshot.revision, currentRevision],
    draftReview: draftReviewFixture(
      [baseSnapshot.revision, currentRevision],
      [baseSnapshot, currentSnapshot],
    ),
    baseRevision: baseSnapshot,
    currentRevision: currentSnapshot,
    currentApprovedRevision: baseSnapshot,
    approvals: blocked
      ? [
          {
            id: "approval-stale",
            spec_id: detail.spec.id,
            subject_kind: "requirement",
            element_id: "requirement-1",
            revision_id: baseSnapshot.revision.id,
            approver: "alex",
            granted_at: NOW,
            validity: "stale",
            subject_fingerprint_json:
              subjectFingerprintFixture("requirement-1"),
          },
        ]
      : [
          {
            id: "approval-requirement",
            spec_id: detail.spec.id,
            subject_kind: "requirement",
            element_id: "requirement-1",
            revision_id: currentRevision.id,
            approver: "alex",
            granted_at: NOW,
            validity: "valid",
            subject_fingerprint_json:
              subjectFingerprintFixture("requirement-1"),
          },
          {
            id: "approval-decision",
            spec_id: detail.spec.id,
            subject_kind: "decision",
            element_id: "decision-1",
            revision_id: currentRevision.id,
            approver: "alex",
            granted_at: NOW,
            validity: "valid",
            subject_fingerprint_json: subjectFingerprintFixture("decision-1"),
          },
          {
            id: "approval-plan",
            spec_id: detail.spec.id,
            subject_kind: "plan",
            element_id: null,
            revision_id: currentRevision.id,
            approver: "alex",
            granted_at: NOW,
            validity: "valid",
            subject_fingerprint_json: subjectFingerprintFixture(null),
          },
        ],
    comments: [
      {
        id: "comment-1",
        threadId: "thread-1",
        parentCommentId: null,
        elementId: "requirement-1",
        handle: "R1",
        revisionId: currentRevision.id,
        revisionNumber: currentRevision.number,
        anchor: {
          sectionId: "R1",
          headingLabel: "R1",
          line: 1,
          charStart: 0,
          charEnd: 15,
          quote: "Every execution",
          prefix: "",
          suffix: " pins scope.",
          docRevision: baseSnapshot.revision.contentHash,
        },
        quote: "Every execution",
        body: "Confirm the gate screen uses the same scope.",
        author: { kind: "human" },
        blocking: blocked,
        resolution: blocked ? "open" : "resolved",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    questions: [
      {
        id: "question-1",
        number: 1,
        handle: "Q1",
        elementId: "requirement-1",
        text: "Which gate owns pinned-scope validation?",
        recordVersion: 1,
        status: blocked ? "open" : "answered",
        answer: blocked ? null : "The execution-start gate.",
        answeredAt: blocked ? null : NOW,
        withdrawnAt: null,
        provenance: { kind: "human" },
        presentation: {
          state: "current",
          attentionActive: blocked,
          lastMutation: null,
          humanCapability: blocked
            ? { kind: "answer", allowed: true }
            : {
                kind: "answer",
                allowed: false,
                code: "terminal",
                blockingRevisionId: null,
                instruction: "This question is terminal.",
              },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "question-2",
        number: 2,
        handle: "Q2",
        elementId: null,
        text: "Does review retain raw diff access?",
        recordVersion: 1,
        status: "answered",
        answer: "Yes, as a secondary view.",
        answeredAt: NOW,
        withdrawnAt: null,
        provenance: { kind: "agent", conversationId: "conversation-1" },
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: null,
          humanCapability: {
            kind: "answer",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction: "This question is terminal.",
          },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    assumptions: [
      {
        id: "assumption-1",
        number: 1,
        handle: "A1",
        elementId: "requirement-1",
        text: "The gate screen can reuse the pinned scope projection.",
        recordVersion: 1,
        disposition: blocked ? "proposed" : "confirmed",
        disposedAt: blocked ? null : NOW,
        withdrawnAt: null,
        proposedBy: {
          kind: "agent",
          conversationId: "conversation-1",
        },
        supersedesHandle: null,
        supersededByHandle: null,
        currentDraftCitations: null,
        presentation: {
          state: "current",
          attentionActive: blocked,
          lastMutation: null,
          humanCapability: blocked
            ? { kind: "dispose", allowed: true }
            : {
                kind: "dispose",
                allowed: false,
                code: "terminal",
                blockingRevisionId: null,
                instruction: "This assumption is terminal.",
              },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "assumption-2",
        number: 2,
        handle: "A2",
        elementId: null,
        text: "Historical raw diffs use the same formatter.",
        recordVersion: 1,
        disposition: "deferred",
        disposedAt: NOW,
        withdrawnAt: null,
        proposedBy: { kind: "human" },
        supersedesHandle: null,
        supersededByHandle: null,
        currentDraftCitations: null,
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: null,
          humanCapability: {
            kind: "dispose",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction: "This assumption is terminal.",
          },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function fastPathReviewDetailFixture(): SpecDetailView {
  const detail = reviewDetailFixture();
  return {
    ...detail,
    spec: { ...detail.spec, gatePolicy: { preset: "fast-path" } },
  };
}

function threadedReviewDetailFixture(): SpecDetailView {
  const detail = reviewDetailFixture();
  const root = {
    ...detail.comments[0]!,
    resolution: "open" as const,
  };
  return {
    ...detail,
    comments: [
      root,
      {
        ...root,
        id: "comment-agent-reply",
        parentCommentId: root.id,
        body: "The gate now reads the same immutable scope projection.",
        author: {
          kind: "agent",
          conversationId: "conversation-threaded-review",
          backend: "claude",
        },
        createdAt: "2026-08-22T12:05:00.000Z",
        updatedAt: "2026-08-22T12:05:00.000Z",
      },
    ],
  };
}

function historicalOrphanedDetailFixture(): SpecDetailView {
  const detail = reviewDetailFixture();
  const base = detail.baseRevision;
  if (base === null) {
    throw new Error("Historical thread story requires a base revision");
  }
  const root = detail.comments[0]!;
  return {
    ...detail,
    comments: [
      {
        ...root,
        id: "historical-root",
        threadId: "historical-thread",
        revisionId: base.revision.id,
        revisionNumber: base.revision.number,
        resolution: "open",
      },
      {
        ...root,
        id: "orphaned-root",
        threadId: "orphaned-thread",
        elementId: "removed-requirement",
        handle: "R9",
        body: "Preserve why the removed requirement no longer applies.",
        resolution: "open",
      },
    ],
  };
}

function deletionReviewDetailFixture(): SpecDetailView {
  const detail = reviewDetailFixture();
  if (detail.currentRevision === null || detail.baseRevision === null) {
    return detail;
  }
  const shortened = {
    ...detail.currentRevision,
    elements: detail.currentRevision.elements.map((entry) =>
      entry.element.id === "requirement-1" &&
      entry.version.payload.kind === "requirement"
        ? {
            ...entry,
            version: {
              ...entry.version,
              payload: {
                ...entry.version.payload,
                statement: "Every execution.",
              },
              payloadHash: "requirement-deletion-hash",
            },
          }
        : entry,
    ),
  };
  return {
    ...detail,
    // The projection carries the snapshot the review renders, so a story that
    // edits the revision has to hand the edited snapshot to both.
    draftReview: draftReviewFixture(detail.revisions, [
      detail.baseRevision,
      shortened,
    ]),
    currentRevision: shortened,
  };
}

/**
 * Ticket #58: draft revision 2 reopened over a withdrawn attempt, so R1 is
 * unchanged against the immediate base yet never approved — the server still
 * owes its approval and the review surface must offer it individually.
 */
function awaitingUnchangedDetailFixture(): SpecDetailView {
  const detail = reviewDetailFixture();
  const base = detail.baseRevision;
  if (base === null) return detail;
  base.revision.state = "withdrawn";
  base.elements = base.elements.map((entry) =>
    entry.element.id === "requirement-1"
      ? {
          ...entry,
          version: {
            ...entry.version,
            payload: {
              kind: "requirement" as const,
              statement: "Every execution pins the exact selected scope.",
              priority: "must" as const,
              risk: "high" as const,
            },
            payloadHash: "requirement-hash-2",
          },
        }
      : entry,
  );
  return {
    ...detail,
    approvals: detail.approvals.filter(
      (approval) => approval.subject_kind !== "requirement",
    ),
    status: {
      ...detail.status,
      applicableGates: ["requirements", "design", "plan"],
      pendingApprovals: [
        { gate: "requirements", subject: "R1", elementId: "requirement-1" },
      ],
    },
  };
}

const PROJECT_NAME = "command-center";

const meta = {
  title: "Specs/Studio/ReviewMode",
  component: SpecReviewMode,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="h-screen overflow-y-auto bg-bg-void text-text-primary">
        <h1 className="sr-only">Spec revision review</h1>
        <div className="px-xl max-768:px-md">
          <Story />
        </div>
      </main>
    ),
  ],
  args: {
    detail: reviewDetailFixture(),
    projectName: PROJECT_NAME,
    highlightedChangeId: null,
    onComplete: fn(),
  },
} satisfies Meta<typeof SpecReviewMode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SemanticChanges: Story = {};

export const ThreadedReview: Story = {
  args: { detail: threadedReviewDetailFixture() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const thread = canvas.getByTestId("review-thread-thread-1");
    await expect(within(thread).getAllByRole("listitem")).toHaveLength(2);
    await expect(within(thread).getByText("Claude agent")).toBeVisible();
    await expect(
      within(thread).getByRole("button", { name: "Reply" }),
    ).toBeVisible();
    await expect(
      within(thread).getByRole("button", { name: "Resolve" }),
    ).toBeVisible();
  },
};

export const HistoricalOrphanedThreads: Story = {
  args: { detail: historicalOrphanedDetailFixture() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fallback = canvas
      .getByRole("heading", {
        name: "Historical & orphaned review threads",
      })
      .closest("section");
    if (fallback === null) throw new Error("Fallback section missing");
    await expect(
      within(fallback).getByTestId("review-thread-historical-thread"),
    ).toBeVisible();
    await expect(
      within(fallback).getByTestId("review-thread-orphaned-thread"),
    ).toBeVisible();
  },
};

export const ThreadedReviewMobile: Story = {
  args: { detail: threadedReviewDetailFixture() },
  parameters: {
    viewport: {
      defaultViewport: "threaded-review-mobile",
      viewports: {
        "threaded-review-mobile": {
          name: "Threaded review mobile",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
};

export const SemanticDeletion: Story = {
  args: { detail: deletionReviewDetailFixture() },
};

export const FastPathCombined: Story = {
  args: { detail: fastPathReviewDetailFixture() },
};

export const RawDiff: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("tab", { name: "Raw diff" }),
    );
  },
};

export const ExpandedComment: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const change = canvas.getByTestId("review-change-requirement-1");
    await userEvent.click(
      within(change).getByRole("button", { name: "Comment" }),
    );
  },
};

export const BlockedSignoff: Story = {
  args: { detail: reviewDetailFixture(true) },
};

/**
 * An unchanged element the server still owes an approval for gets its own
 * reviewable card in the awaiting-approval section instead of hiding in the
 * quiet carried-forward list (#58).
 */
export const AwaitingUnchangedApproval: Story = {
  args: { detail: awaitingUnchangedDetailFixture() },
};

/** The author asked for review with a disposition of what this round did. */
export const AuthorNotes: Story = {
  args: {
    detail: (() => {
      const detail = reviewDetailFixture();
      return detail.draftReview === null
        ? detail
        : {
            ...detail,
            draftReview: {
              ...detail.draftReview,
              notes:
                "Round 2: tightened R1 to the exact selected scope and added D1 to pin scope at execution start.",
            },
          };
    })(),
  },
};

export const SignOffDialog: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Sign off revision 2",
      }),
    );
  },
};

export const Mobile: Story = {
  args: { detail: reviewDetailFixture(true) },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
