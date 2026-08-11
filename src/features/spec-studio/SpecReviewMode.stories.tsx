import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fn, userEvent, within } from "storybook/test";

import { specQueries, type SpecDetailView } from "@/lib/specs/queries";

import {
  liveProposalsFixture,
  specControlsDetailFixture,
  specPlanPreviewFixture,
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

  const currentSnapshot = {
    revision: currentRevision,
    elements: currentElements,
  };

  return {
    ...detail,
    revisions: [baseSnapshot.revision, currentRevision],
    liveProposals: liveProposalsFixture(
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
    liveProposals: liveProposalsFixture(detail.revisions, [
      detail.baseRevision,
      shortened,
    ]),
    currentRevision: shortened,
  };
}

/**
 * Ticket #58: revision 2 re-proposed over a withdrawn attempt, so R1 is
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

/**
 * Review compiles a plan preview for the proposal it shows, and Storybook has
 * no server to compile it. Seeding the cache with the payload the route
 * returns is what keeps these stories showing the surface rather than a
 * preview failure — every story here reviews the same revision 2.
 */
function storyQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  const revision = reviewDetailFixture().currentRevision?.revision;
  if (revision !== undefined) {
    client.setQueryData(
      specQueries.planPreview(PROJECT_NAME, "native-sdd", revision.id).queryKey,
      specPlanPreviewFixture(revision),
    );
  }
  return client;
}

const previewSeededClient = storyQueryClient();

const meta = {
  title: "Specs/Studio/ReviewMode",
  component: SpecReviewMode,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  // The layout decorator stays first (innermost); the query provider wraps it.
  decorators: [
    (Story) => (
      <main className="h-screen overflow-y-auto bg-bg-void text-text-primary">
        <h1 className="sr-only">Spec revision review</h1>
        <div className="px-xl max-768:px-md">
          <Story />
        </div>
      </main>
    ),
    (Story) => (
      <QueryClientProvider client={previewSeededClient}>
        <Story />
      </QueryClientProvider>
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

export const SemanticDeletion: Story = {
  args: { detail: deletionReviewDetailFixture() },
};

export const FastPathCombined: Story = {
  args: { detail: fastPathReviewDetailFixture() },
};

/**
 * The compiled plan the reviewed revision would launch, on the same surface as
 * the change set that decides it.
 */
export const CompiledPlanPreview: Story = {
  play: async ({ canvasElement }) => {
    within(canvasElement).getByTestId("plan-preview-panel").scrollIntoView();
  },
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
