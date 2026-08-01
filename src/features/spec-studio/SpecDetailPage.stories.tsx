import { useState, type ComponentProps, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  specDetailViewSchema,
  specQueries,
  type SpecDetailView,
} from "@/lib/specs/queries";
import { elementHandleInSnapshot } from "@/lib/specs/review-state";
import type {
  SpecAuthoringStage,
  SpecRevision,
  SpecRevisionSnapshot,
  SpecRevisionState,
} from "@/lib/specs/schemas";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import { SpecDetailContent } from "./SpecDetailPage";

type SpecDetailContentProps = ComponentProps<typeof SpecDetailContent>;

function createStoryQueryClient(
  detail: SpecDetailView,
  projectName: string,
): QueryClient {
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
  const currentRevisionId =
    detail.currentRevision?.revision.id ??
    detail.currentApprovedRevision?.revision.id ??
    "story-revision";
  client.setQueryData(
    specQueries.lint(projectName, detail.spec.slug).queryKey,
    { revisionId: currentRevisionId, findings: [] },
  );
  client.setQueryData(
    specQueries.integrity(projectName, detail.spec.slug).queryKey,
    {
      ok: true,
      checkedRevisionIds: detail.revisions
        .filter(({ state }) => state === "approved")
        .map(({ id }) => id),
      mismatches: [],
    },
  );

  const snapshots = [
    detail.currentApprovedRevision,
    ...detail.executionRevisionSnapshots,
  ].filter((snapshot): snapshot is SpecRevisionSnapshot => snapshot !== null);
  for (const snapshot of snapshots) {
    for (const entry of snapshot.elements) {
      if (entry.version.payload.kind !== "criterion") continue;
      const handle = elementHandleInSnapshot(snapshot, entry.element.id);
      if (handle === null) continue;
      client.setQueryData(
        specQueries.element(
          projectName,
          detail.spec.slug,
          handle,
          undefined,
          snapshot.revision.id,
        ).queryKey,
        {
          specId: detail.spec.id,
          slug: detail.spec.slug,
          revision: snapshot.revision,
          handle,
          element: entry,
          approvals: [],
          evidenceState: [
            {
              criterionElementId: entry.element.id,
              handle,
              evidence: [],
              verdicts: [],
              waiver: null,
            },
          ],
          referenceState: null,
        },
      );
    }
  }
  return client;
}

function StoryQueryBoundary({
  detail,
  projectName,
  children,
}: {
  detail: SpecDetailView;
  projectName: string;
  children: ReactNode;
}): React.JSX.Element {
  const [queryClient] = useState(() =>
    createStoryQueryClient(detail, projectName),
  );
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/**
 * Stands in for the address bar the real page navigates: the `view` arg seeds
 * the surface and navigation selections move it, so stories stay interactive without
 * a router.
 */
function AddressBarHarness(props: SpecDetailContentProps): React.JSX.Element {
  const [view, setView] = useState(props.view);
  const [seededView, setSeededView] = useState(props.view);
  if (props.view !== seededView) {
    setSeededView(props.view);
    setView(props.view);
  }
  return <SpecDetailContent {...props} view={view} onViewChange={setView} />;
}

function withProse(detail: SpecDetailView): SpecDetailView {
  const snapshot = detail.currentRevision;
  if (snapshot === null) return detail;
  const sections = [
    {
      element: {
        id: "section-intent",
        specId: detail.spec.id,
        kind: "section" as const,
        number: null,
        parentElementId: null,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: snapshot.revision.id,
        elementId: "section-intent",
        position: 0,
        payload: {
          kind: "section" as const,
          role: "intent_problem" as const,
          title: "Intent",
          body: "Native spec-driven development keeps the contract durable while execution remains auditable.\n\nEvery delivery claim resolves to criterion-level proof.",
        },
        payloadHash: "section-intent-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
    {
      element: {
        id: "section-design-narrative",
        specId: detail.spec.id,
        kind: "section" as const,
        number: null,
        parentElementId: null,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      version: {
        revisionId: snapshot.revision.id,
        elementId: "section-design-narrative",
        position: 1,
        payload: {
          kind: "section" as const,
          role: "design_narrative" as const,
          title: "Design narrative",
          body: "Humans review, comment, approve, and sign off. Agents author every revision and keep execution pinned to the approved contract.",
        },
        payloadHash: "section-design-narrative-hash",
        elementVersion: 1,
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    },
  ];
  const currentRevision = {
    ...snapshot,
    elements: [...sections, ...snapshot.elements],
  };
  return {
    ...detail,
    currentRevision,
    currentApprovedRevision:
      detail.currentApprovedRevision === null
        ? null
        : {
            ...detail.currentApprovedRevision,
            elements: currentRevision.elements,
          },
  };
}

/**
 * Every story detail — including the phase mutations below — re-parses
 * through the full response schema, so a story-only variant cannot drift into
 * a shape the live detail route would never emit.
 */
function parsedDetail(detail: SpecDetailView): SpecDetailView {
  return specDetailViewSchema.parse(detail);
}

const AUTHORING_STAGES = ["requirements", "design", "plan"] as const;

function revisionFor(
  template: SpecRevision,
  number: number,
  authoringStage: SpecAuthoringStage,
  state: SpecRevisionState,
): SpecRevision {
  return {
    ...template,
    id: `revision-${number}`,
    number,
    state,
    authoringStage,
    basedOnRevisionId: number === 1 ? null : `revision-${number - 1}`,
    contentHash: `revision-${number}-hash`,
    proposedAt: state === "draft" ? null : SPEC_CONTROLS_FIXTURE_NOW,
    approvedAt: state === "approved" ? SPEC_CONTROLS_FIXTURE_NOW : null,
  };
}

function snapshotFor(
  source: SpecRevisionSnapshot,
  revision: SpecRevision,
  includeTasks: boolean,
): SpecRevisionSnapshot {
  return {
    revision,
    elements: source.elements
      .filter(({ version }) => includeTasks || version.payload.kind !== "task")
      .map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: revision.id },
      })),
  };
}

function authoringDetail(
  base: SpecDetailView,
  state: "draft" | "proposed",
): SpecDetailView {
  const source = base.currentRevision;
  const template = base.revisions[0];
  if (source === null || template === undefined) return parsedDetail(base);

  const requirements = revisionFor(
    template,
    1,
    AUTHORING_STAGES[0],
    "approved",
  );
  const design = revisionFor(template, 2, AUTHORING_STAGES[1], "approved");
  const plan = revisionFor(template, 3, AUTHORING_STAGES[2], state);
  const designSnapshot = snapshotFor(source, design, false);

  return parsedDetail({
    ...base,
    revisions: [requirements, design, plan],
    baseRevision: designSnapshot,
    currentRevision: snapshotFor(source, plan, true),
    currentApprovedRevision: designSnapshot,
    executionRevisionSnapshots: [],
    approvals: [],
    status: {
      ...base.status,
      phase: {
        primary: state === "draft" ? "draft" : "in_review",
        authoringStage: "plan",
      },
    },
  });
}

function withQuestionsAndAssumptions(detail: SpecDetailView): SpecDetailView {
  return parsedDetail({
    ...detail,
    questions: [
      {
        id: "question-1",
        number: 1,
        handle: "Q1",
        elementId: "requirement-1",
        text: "Which gate owns pinned-scope validation?",
        status: "open",
        answer: null,
        answeredAt: null,
        provenance: { kind: "human" },
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      {
        id: "question-2",
        number: 2,
        handle: "Q2",
        elementId: null,
        text: "Does review retain raw diff access?",
        status: "answered",
        answer: "Yes, as a secondary inspection surface.",
        answeredAt: SPEC_CONTROLS_FIXTURE_NOW,
        provenance: { kind: "agent", conversationId: "conversation-1" },
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    ],
    assumptions: [
      {
        id: "assumption-1",
        number: 1,
        handle: "A1",
        elementId: "requirement-1",
        text: "The gate screen can reuse the pinned scope projection.",
        disposition: "proposed",
        disposedAt: null,
        proposedBy: {
          kind: "agent",
          conversationId: "conversation-1",
        },
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      {
        id: "assumption-2",
        number: 2,
        handle: "A2",
        elementId: null,
        text: "Historical raw diffs use the same formatter.",
        disposition: "deferred",
        disposedAt: SPEC_CONTROLS_FIXTURE_NOW,
        proposedBy: { kind: "human" },
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    ],
  });
}

function detailFor(
  phase: SpecDetailView["status"]["phase"]["primary"],
): SpecDetailView {
  const base = withProse(
    specControlsDetailFixture(
      phase === "executing" || phase === "delivered" ? "running" : "none",
    ),
  );
  if (phase === "draft" || phase === "in_review") {
    return authoringDetail(base, phase === "draft" ? "draft" : "proposed");
  }
  const snapshot = base.currentRevision;
  if (snapshot === null) return parsedDetail(base);
  const revision = {
    ...snapshot.revision,
    state: "approved" as const,
    approvedAt: SPEC_CONTROLS_FIXTURE_NOW,
  };
  return parsedDetail({
    ...base,
    spec: {
      ...base.spec,
      abandonedAt: phase === "abandoned" ? SPEC_CONTROLS_FIXTURE_NOW : null,
      abandonedReason:
        phase === "abandoned" ? "Superseded by the platform contract." : null,
    },
    revisions: [revision],
    currentRevision: { ...snapshot, revision },
    status: {
      ...base.status,
      phase: {
        primary: phase,
        ...(phase === "executing"
          ? { authoringFacet: "in_review" as const }
          : {}),
      },
      delivery:
        phase === "delivered"
          ? { allWaived: false, provenCount: 1, totalInScope: 1 }
          : base.status.delivery,
    },
    executions:
      phase === "delivered"
        ? base.executions.map((execution) => ({
            ...execution,
            state: "delivered" as const,
            deliveredAt: SPEC_CONTROLS_FIXTURE_NOW,
          }))
        : base.executions,
  });
}

const meta = {
  title: "Specs/Studio/Detail",
  component: SpecDetailContent,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="h-screen overflow-y-auto bg-bg-void text-text-primary">
        <Story />
      </main>
    ),
  ],
  render: (args) => (
    <StoryQueryBoundary detail={args.detail} projectName={args.projectName}>
      <AddressBarHarness {...args} />
    </StoryQueryBoundary>
  ),
  args: {
    detail: detailFor("approved"),
    projectName: "command-center",
    requestedSlug: "native-sdd",
    view: "overview",
    onViewChange: () => undefined,
  },
} satisfies Meta<typeof SpecDetailContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Approved: Story = {};

export const InReview: Story = {
  args: { detail: detailFor("in_review") },
};

export const DraftBlocked: Story = {
  args: { detail: detailFor("draft") },
};

export const ExecutingWithReview: Story = {
  args: { detail: detailFor("executing") },
};

export const Delivered: Story = {
  args: { detail: detailFor("delivered") },
};

export const Exploratory: Story = {
  args: {
    detail: parsedDetail({
      ...detailFor("draft"),
      spec: {
        ...detailFor("draft").spec,
        gatePolicy: { preset: "exploratory" },
      },
    }),
  },
};

export const JustCreated: Story = {
  args: {
    detail: (() => {
      const detail = detailFor("draft");
      const snapshot = detail.currentRevision;
      if (snapshot === null) return detail;
      return parsedDetail({
        ...detail,
        currentRevision: {
          ...snapshot,
          elements: snapshot.elements.filter(
            (entry) => entry.version.payload.kind === "section",
          ),
        },
        elementStatuses: { requirements: [], tasks: [] },
      });
    })(),
  },
};

export const Abandoned: Story = {
  args: { detail: detailFor("abandoned") },
};

export const History: Story = {
  args: { view: "history" },
};

export const Execution: Story = {
  args: { view: "execution", detail: detailFor("executing") },
};

export const GatePolicy: Story = {
  args: { view: "gate", detail: detailFor("approved") },
};

export const QuestionsAndAssumptions: Story = {
  args: {
    view: "questions",
    detail: withQuestionsAndAssumptions(detailFor("in_review")),
  },
};

export const QuestionsAndAssumptionsMobile: Story = {
  args: {
    view: "questions",
    detail: withQuestionsAndAssumptions(detailFor("in_review")),
  },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const RequirementsReader: Story = {
  args: { view: "requirements", detail: detailFor("approved") },
};

/** A run parked on the delivery gate: the banner names the pending delivery
 *  approval and links it, and the phase CTA targets the approval control
 *  with the ?el=delivery deep link (F15/F16). */
export const ExecutingApprovalNeeded: Story = {
  args: {
    detail: (() => {
      const detail = detailFor("executing");
      return parsedDetail({
        ...detail,
        status: {
          ...detail.status,
          pendingApprovals: [
            { gate: "delivery" as const, subject: "delivery", elementId: null },
          ],
        },
      });
    })(),
  },
};
