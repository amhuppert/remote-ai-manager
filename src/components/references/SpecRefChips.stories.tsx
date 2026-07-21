import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import type { SpecElementView, SpecSummaryView } from "@/lib/specs/queries";

import { createSpecRefChips } from "./SpecRefChips";

const TIMESTAMP = "2026-07-18T12:00:00.000Z";

const summary: SpecSummaryView = {
  spec: {
    id: "spec-native-sdd",
    projectPath: "/repos/command-center",
    slug: "native-sdd",
    name: "Native spec-driven development",
    gatePolicy: { preset: "contract-bearing" },
    abandonedAt: null,
    abandonedReason: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  phase: { primary: "in_review" },
  currentRevision: {
    id: "revision-4",
    specId: "spec-native-sdd",
    number: 4,
    state: "proposed",
    basedOnRevisionId: "revision-3",
    contentHash: "revision-4-hash",
    proposedAt: TIMESTAMP,
    approvedAt: null,
    createdAt: TIMESTAMP,
  },
  counts: { requirements: 11, criteria: 16, decisions: 4, tasks: 13 },
  pendingApprovalCount: 6,
  approvalState: "pending",
  delivery: { allWaived: false, provenCount: 7, totalInScope: 12 },
  linkedWork: {
    tickets: 2,
    conversations: 1,
    sessions: 0,
    workflowExecutions: 1,
    mergeJobs: 0,
  },
};

function element(
  latestHash: string,
  validity: "valid" | "stale",
): SpecElementView {
  return {
    specId: summary.spec.id,
    slug: summary.spec.slug,
    revision: summary.currentRevision!,
    handle: "R3",
    element: {
      element: {
        id: "requirement-3",
        specId: summary.spec.id,
        kind: "requirement",
        number: 3,
        parentElementId: null,
        createdAt: TIMESTAMP,
      },
      version: {
        revisionId: "revision-4",
        elementId: "requirement-3",
        position: 3,
        payload: {
          kind: "requirement",
          statement: "Granular durable approvals remain revision-aware.",
          priority: "must",
          risk: "high",
        },
        payloadHash: latestHash,
        elementVersion: 4,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    },
    approvals: [
      {
        id: "approval-r3",
        spec_id: summary.spec.id,
        subject_kind: "requirement",
        element_id: "requirement-3",
        revision_id: "revision-3",
        approver: "alex",
        granted_at: TIMESTAMP,
        validity,
      },
    ],
    evidenceState: [],
    referenceState: {
      observedRevision: 3,
      observedPayloadHash: "revision-3-r3-hash",
      latestContainingRevision: 4,
      latestPayloadHash: latestHash,
    },
  };
}

const freshElement = element("revision-3-r3-hash", "valid");
const changedElement = element("revision-4-r3-hash", "stale");

const specAttrs = {
  "project-name": "command-center",
  slug: "native-sdd",
  name: summary.spec.name,
  revision: "4",
  "read-command": "cctl spec show native-sdd --project command-center",
};

const elementAttrs = {
  ...specAttrs,
  revision: "3",
  handle: "R3",
  name: "Granular durable approvals remain revision-aware.",
  "read-command": "cctl spec get native-sdd/R3 --project command-center",
};

function ReferenceChipsDemo({
  variant,
}: {
  variant: "spec" | "fresh-element" | "changed-element";
}): React.JSX.Element {
  const chips = createSpecRefChips({
    useSpecSummary: () => ({ data: summary, isLoading: false, isError: false }),
    useSpecElement: () => ({
      data: variant === "changed-element" ? changedElement : freshElement,
      isLoading: false,
      isError: false,
    }),
  });
  return variant === "spec" ? (
    <chips.SpecRefTranscriptChip attrs={specAttrs} />
  ) : (
    <chips.SpecElementRefTranscriptChip attrs={elementAttrs} />
  );
}

const meta = {
  title: "Specs/References/TranscriptChips",
  component: ReferenceChipsDemo,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  decorators: [
    (Story) => (
      <div className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg font-body text-text-primary">
        Compare <Story /> against the approved contract.
      </div>
    ),
  ],
  args: { variant: "spec" },
} satisfies Meta<typeof ReferenceChipsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveSpec: Story = {};

export const FreshElement: Story = {
  args: { variant: "fresh-element" },
};

export const ChangedElement: Story = {
  args: { variant: "changed-element" },
};
