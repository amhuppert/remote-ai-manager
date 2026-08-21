import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { sessionKeys } from "@/lib/sessions/query-keys";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { DeliveryPlanPreviewView } from "@/lib/specs/delivery-plan-views";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import { previewView, reviewView } from "./delivery-plan-review.fixtures";
import { SpecDeliveryPlanReviewContent } from "./SpecDeliveryPlanReview";

const sessions: SessionListItem[] = [
  {
    sessionName: "delivery-run",
    worktreePath: "/tmp/delivery-run",
    branchName: "cc/delivery-run",
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    lastActivityAt: "2026-08-14T00:00:00.000Z",
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    derivedStatus: "idle",
    promptCount: 0,
    derivedLastActivityAt: "2026-08-14T00:00:00.000Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
  },
];

const proposedPreview = previewView();
const proposedReview = reviewView({
  document: {
    schemaVersion: 2,
    launch: proposedPreview.launch,
    binding: proposedPreview.binding,
  },
});
const authoredLaunch = createMaximalAuthoredWorkflowLaunchFixture();
const {
  approvalRequired: _approvalRequired,
  lockedRegions: _lockedRegions,
  origin: _origin,
  ...authoredDefinition
} = authoredLaunch.definition;
const draftPreview: DeliveryPlanPreviewView = {
  ...proposedPreview,
  stage: "draft",
  candidateId: null,
  candidateHash: null,
  snapshotId: null,
  approvable: false,
  approvability: "The authored launch must be finalized before sign-off.",
  launch: { ...authoredLaunch, definition: authoredDefinition },
};
const draftReview = reviewView({
  attempt: {
    status: "draft",
    candidateId: null,
    candidateHash: null,
    proposedSnapshotId: null,
  },
  nextAct: {
    actor: "agent",
    command: "cctl spec plan propose native-sdd",
    reason: "Finalize and validate the authored launch before sign-off.",
  },
  document: {
    schemaVersion: 2,
    launch: draftPreview.launch,
    binding: draftPreview.binding,
  },
});

const meta = {
  title: "Spec Studio/Delivery Plan Review",
  component: SpecDeliveryPlanReviewContent,
  args: {
    projectName: "demo",
    review: proposedReview,
    preview: proposedPreview,
  },
  decorators: [
    (Story) => {
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
          mutations: { retry: false },
        },
      });
      queryClient.setQueryData(sessionKeys.list("demo"), sessions);
      return (
        <QueryClientProvider client={queryClient}>
          <div className="min-h-[40rem] p-lg">
            <Story />
          </div>
        </QueryClientProvider>
      );
    },
  ],
} satisfies Meta<typeof SpecDeliveryPlanReviewContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FinalizedCandidate = {} satisfies Story;

/** Sign-off is recorded, so the launch control is the one act still owed. */
export const SignedOffReadyToLaunch = {
  args: {
    review: reviewView({
      attempt: { status: "approved" },
      approval: {
        candidateId: "candidate-2",
        candidateHash: "sha256:candidate-2",
        snapshotId: "snapshot-2",
        approvedAt: "2026-08-14T01:00:00.000Z",
        approvedBy: { kind: "human" },
      },
      nextAct: {
        actor: "human",
        command: "cctl spec start native-sdd",
        reason: "Start the signed one-off graph launch.",
      },
      document: {
        schemaVersion: 2,
        launch: proposedPreview.launch,
        binding: proposedPreview.binding,
      },
    }),
    preview: proposedPreview,
  },
} satisfies Story;

export const AuthoredDraft = {
  args: {
    review: draftReview,
    preview: draftPreview,
  },
} satisfies Story;

/** A re-propose landed between the two reads, so no act is offered. */
export const CandidateMovedWhileReading = {
  args: {
    review: reviewView({
      attempt: {
        candidateId: "candidate-3",
        candidateHash: "sha256:candidate-3",
        proposedSnapshotId: "snapshot-3",
      },
    }),
    preview: proposedPreview,
  },
} satisfies Story;
