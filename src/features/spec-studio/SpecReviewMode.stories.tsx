import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn, userEvent, within } from "storybook/test";

import type { SpecDetailView } from "@/lib/specs/queries";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
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
    state: "proposed" as const,
    basedOnRevisionId: baseSnapshot.revision.id,
    contentHash: "revision-2-hash",
    proposedAt: NOW,
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

  return {
    ...detail,
    revisions: [baseSnapshot.revision, currentRevision],
    baseRevision: baseSnapshot,
    currentRevision: { revision: currentRevision, elements: currentElements },
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
          },
        ],
    comments: [
      {
        id: "comment-1",
        spec_id: detail.spec.id,
        thread_id: "thread-1",
        parent_comment_id: null,
        element_id: "requirement-1",
        anchor_json: JSON.stringify({
          sectionId: "R1",
          headingLabel: "R1",
          line: 1,
          charStart: 0,
          charEnd: 15,
          quote: "Every execution",
          prefix: "",
          suffix: " pins scope.",
          docRevision: baseSnapshot.revision.contentHash,
        }),
        revision_id: currentRevision.id,
        body: "Confirm the gate screen uses the same scope.",
        author_json: JSON.stringify({ kind: "human" }),
        blocking: blocked ? 1 : 0,
        resolution: blocked ? "open" : "resolved",
        created_at: NOW,
        updated_at: NOW,
      },
    ],
    questions: [
      {
        id: "question-1",
        number: 1,
        handle: "Q1",
        elementId: "requirement-1",
        text: "Which gate owns pinned-scope validation?",
        status: blocked ? "open" : "answered",
        answer: blocked ? null : "The execution-start gate.",
        answeredAt: blocked ? null : NOW,
        provenance: { kind: "human" },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "question-2",
        number: 2,
        handle: "Q2",
        elementId: null,
        text: "Does review retain raw diff access?",
        status: "answered",
        answer: "Yes, as a secondary view.",
        answeredAt: NOW,
        provenance: { kind: "agent", conversationId: "conversation-1" },
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
        disposition: blocked ? "proposed" : "confirmed",
        disposedAt: blocked ? null : NOW,
        proposedBy: {
          kind: "agent",
          conversationId: "conversation-1",
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
        disposition: "deferred",
        disposedAt: NOW,
        proposedBy: { kind: "human" },
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

function deletionReviewDetailFixture(): SpecDetailView {
  const detail = reviewDetailFixture();
  if (detail.currentRevision === null) return detail;
  return {
    ...detail,
    currentRevision: {
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
    },
  };
}

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
    projectName: "command-center",
    highlightedChangeId: null,
    onComplete: fn(),
  },
} satisfies Meta<typeof SpecReviewMode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SemanticChanges: Story = {};

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

export const RequestChangesDialog: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Request changes" }),
    );
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
