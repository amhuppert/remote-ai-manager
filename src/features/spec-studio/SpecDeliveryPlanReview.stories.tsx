import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { finalizeDeliveryPlanLaunch } from "@/lib/specs/delivery-plan-finalization";
import type { DeliveryPlanPreviewView } from "@/lib/specs/delivery-plan-views";
import { createMaximalAuthoredWorkflowLaunchFixture } from "@/lib/workflow-graph/testing/maximal-authored-launch";

import { reviewView } from "./delivery-plan-review.fixtures";
import { SpecDeliveryPlanReviewContent } from "./SpecDeliveryPlanReview";

function finalizedPreview(): DeliveryPlanPreviewView {
  const binding = {
    dispositions: [],
    claims: [
      {
        contextId: "context-integrate",
        criterionElementIds: ["criterion-1"],
      },
    ],
  };
  const launch = finalizeDeliveryPlanLaunch({
    specId: "spec-native-sdd",
    specSlug: "native-sdd",
    attemptId: "attempt-2",
    candidateId: "candidate-2",
    launch: createMaximalAuthoredWorkflowLaunchFixture(),
  });

  return {
    stage: "proposed",
    attemptId: "attempt-2",
    specSlug: "native-sdd",
    draftRevision: 2,
    pinnedRevisionId: "revision-2",
    candidateId: "candidate-2",
    candidateHash: "sha256:candidate-2",
    snapshotId: "snapshot-2",
    approvable: true,
    approvability: "Finalized candidate is ready for sign-off.",
    launch,
    binding,
  };
}

const proposedPreview = finalizedPreview();
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
