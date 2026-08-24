import { useState, type ComponentProps, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  specDetailViewSchema,
  specQueries,
  type SpecDetailView,
} from "@/lib/specs/queries";
import { elementHandleInSnapshot } from "@/lib/specs/review-state";
import type {
  SpecAuthoringStage,
  SpecRevision,
  SpecRevisionElement,
  SpecRevisionSnapshot,
  SpecRevisionState,
} from "@/lib/specs/schemas";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import { reviewView } from "./delivery-plan-review.fixtures";
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
      consistencyFindings: [],
    },
  );
  const phase = detail.status.phase.primary;
  const deliveryPlan =
    phase === "approved" || phase === "executing" || phase === "delivered"
      ? reviewView({
          attempt: {
            status: phase === "approved" ? "approved" : "launched",
          },
          approval: {
            snapshotId: "snapshot-2",
            candidateId: "candidate-2",
            candidateHash: "sha256:candidate-2",
            approvedAt: SPEC_CONTROLS_FIXTURE_NOW,
            approvedBy: { kind: "human" },
          },
        })
      : null;
  client.setQueryData(
    specQueries.planReview(projectName, detail.spec.slug).queryKey,
    deliveryPlan,
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

function withOverviewReviewThreads(
  detail: SpecDetailView,
  grouped = false,
): SpecDetailView {
  const snapshot = detail.currentRevision;
  if (snapshot === null) {
    throw new Error("Overview thread story requires a current revision");
  }
  const revision = snapshot.revision;
  const anchor = {
    sectionId: "",
    headingLabel: "",
    line: 1,
    charStart: 0,
    charEnd: 30,
    quote: "Native spec-driven development",
    prefix: "",
    suffix: " keeps the contract",
    docRevision: revision.contentHash,
  };
  const root = {
    id: "overview-root-1",
    threadId: "overview-thread-1",
    parentCommentId: null,
    elementId: "section-intent",
    handle: null,
    revisionId: revision.id,
    revisionNumber: revision.number,
    anchor,
    quote: anchor.quote,
    body: "Keep the durable contract explicit in the opening sentence.",
    author: { kind: "human" as const },
    blocking: false,
    resolution: "open" as const,
    createdAt: SPEC_CONTROLS_FIXTURE_NOW,
    updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
  };
  const reply = {
    ...root,
    id: "overview-reply-1",
    parentCommentId: root.id,
    body: "The sentence now carries the durable-contract guarantee.",
    author: {
      kind: "agent" as const,
      conversationId: "conversation-overview-thread",
      backend: "claude",
    },
    createdAt: "2026-08-22T12:05:00.000Z",
    updatedAt: "2026-08-22T12:05:00.000Z",
  };
  const groupedRoot = {
    ...root,
    id: "overview-root-2",
    threadId: "overview-thread-2",
    body: "Call out criterion-level proof before the reader reaches the rail.",
    blocking: true,
    createdAt: "2026-08-22T12:06:00.000Z",
    updatedAt: "2026-08-22T12:06:00.000Z",
  };

  return parsedDetail({
    ...detail,
    comments: grouped ? [root, reply, groupedRoot] : [root, reply],
  });
}

/**
 * Every story detail — including the phase mutations below — re-parses
 * through the full response schema, so a story-only variant cannot drift into
 * a shape the live detail route would never emit.
 */
function parsedDetail(detail: SpecDetailView): SpecDetailView {
  return specDetailViewSchema.parse(detail);
}

const AUTHORING_STAGES = ["requirements", "design"] as const;

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
    assumptionCitations: source.assumptionCitations.map((citation) => ({
      ...citation,
      revisionId: revision.id,
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
  const design = revisionFor(template, 2, AUTHORING_STAGES[1], state);
  const requirementsSnapshot = snapshotFor(source, requirements, false);
  const designSnapshot = snapshotFor(source, design, false);

  return parsedDetail({
    ...base,
    revisions: [requirements, design],
    baseRevision: requirementsSnapshot,
    currentRevision: designSnapshot,
    currentApprovedRevision: requirementsSnapshot,
    executionRevisionSnapshots: [],
    approvals: [],
    status: {
      ...base.status,
      phase: {
        primary: state === "draft" ? "draft" : "in_review",
        authoringStage: "design",
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
        recordVersion: 1,
        status: "open",
        answer: null,
        answeredAt: null,
        withdrawnAt: null,
        provenance: { kind: "human" },
        presentation: {
          state: "current",
          attentionActive: true,
          lastMutation: null,
          humanCapability: { kind: "answer", allowed: true },
        },
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
      {
        id: "question-2",
        number: 2,
        handle: "Q2",
        elementId: null,
        text: "Does review retain raw diff access?",
        recordVersion: 1,
        status: "answered",
        answer: "Yes, as a secondary inspection surface.",
        answeredAt: SPEC_CONTROLS_FIXTURE_NOW,
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
        recordVersion: 1,
        disposition: "proposed",
        disposedAt: null,
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
          attentionActive: true,
          lastMutation: null,
          humanCapability: { kind: "dispose", allowed: true },
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
        recordVersion: 1,
        disposition: "deferred",
        disposedAt: SPEC_CONTROLS_FIXTURE_NOW,
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
        createdAt: SPEC_CONTROLS_FIXTURE_NOW,
        updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
      },
    ],
  });
}

function withOverflowingStructureRail(detail: SpecDetailView): SpecDetailView {
  const snapshot = detail.currentRevision;
  if (snapshot === null) {
    throw new Error("Overflowing rail story requires a current revision");
  }
  const criterionTemplate = snapshot.elements.find(
    (entry) => entry.version.payload.kind === "criterion",
  );
  if (
    criterionTemplate === undefined ||
    criterionTemplate.version.payload.kind !== "criterion"
  ) {
    throw new Error("Overflowing rail story requires a criterion template");
  }

  const additionalCriteria: SpecRevisionElement[] = Array.from(
    { length: 14 },
    (_, index) => {
      const number = index + 2;
      return {
        element: {
          ...criterionTemplate.element,
          id: `criterion-${number}`,
          number,
        },
        version: {
          ...criterionTemplate.version,
          elementId: `criterion-${number}`,
          position: snapshot.elements.length + index,
          payload: {
            ...criterionTemplate.version.payload,
            text: `Acceptance criterion ${number} remains fully readable when every structure item is expanded inside the bounded rail.`,
          },
          payloadHash: `criterion-${number}-hash`,
        },
      };
    },
  );
  const decision: SpecRevisionElement = {
    element: {
      id: "decision-1",
      specId: detail.spec.id,
      kind: "decision",
      number: 1,
      parentElementId: null,
      createdAt: SPEC_CONTROLS_FIXTURE_NOW,
    },
    version: {
      revisionId: snapshot.revision.id,
      elementId: "decision-1",
      position: snapshot.elements.length + additionalCriteria.length,
      payload: {
        kind: "decision",
        title: "Keep expanded structure content reachable",
        chosenApproach:
          "The structure rail owns overflow while each group retains its content height.",
        rejectedAlternatives: [
          {
            label: "Clip expanded groups",
            reason:
              "Clipping makes acceptance criteria and later groups unreachable.",
          },
        ],
        reason:
          "A single scroll owner preserves every expanded requirement, decision, question, and task.",
        tracedRequirementElementIds: ["requirement-1"],
      },
      payloadHash: "decision-1-hash",
      elementVersion: 1,
      createdAt: SPEC_CONTROLS_FIXTURE_NOW,
      updatedAt: SPEC_CONTROLS_FIXTURE_NOW,
    },
  };
  const elements = [...snapshot.elements, ...additionalCriteria, decision];

  return parsedDetail({
    ...detail,
    currentRevision: { ...snapshot, elements },
    currentApprovedRevision:
      detail.currentApprovedRevision === null
        ? null
        : { ...detail.currentApprovedRevision, elements },
    executionRevisionSnapshots: detail.executionRevisionSnapshots.map(
      (executionSnapshot) =>
        executionSnapshot.revision.id === snapshot.revision.id
          ? { ...executionSnapshot, elements }
          : executionSnapshot,
    ),
    status: {
      ...detail.status,
      coverage: { coveredCriteria: 1, totalCriteria: 15, percentage: 7 },
    },
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
    authoringStage: "design" as const,
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
    currentApprovedRevision: { ...snapshot, revision },
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
          ? {
              allWaived: false,
              deliveredCount: 1,
              provenCount: 1,
              deliveredExternallyCriterionIds: [],
              totalInScope: 1,
            }
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

export const ExpandedStructureRail: Story = {
  args: {
    detail: withOverflowingStructureRail(
      withQuestionsAndAssumptions(detailFor("approved")),
    ),
  },
  parameters: {
    viewport: {
      defaultViewport: "structure-rail-desktop",
      viewports: {
        "structure-rail-desktop": {
          name: "Structure rail desktop",
          styles: { width: "1440px", height: "900px" },
          type: "desktop",
        },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rail = canvas.getByRole("complementary", {
      name: "Spec structure",
    });
    await userEvent.click(
      within(rail).getByRole("button", {
        name: "Expand all structure items",
      }),
    );

    await expect(
      within(rail).getByRole("button", {
        name: "Collapse all structure items",
      }),
    ).toBeVisible();
    await expect(rail.scrollHeight).toBeGreaterThan(rail.clientHeight);

    const groups = [
      "Requirements",
      "Decisions",
      "Questions & assumptions",
      "Tasks",
    ].map((name) => within(rail).getByRole("region", { name }));
    for (const group of groups) {
      await expect(group.scrollHeight).toBeLessThanOrEqual(
        group.clientHeight + 1,
      );
    }

    rail.scrollTop = rail.scrollHeight;
    await expect(rail.scrollTop).toBeGreaterThan(0);
    const railRect = rail.getBoundingClientRect();
    const finalGroupRect = groups.at(-1)?.getBoundingClientRect();
    if (finalGroupRect === undefined) {
      throw new Error("Structure rail story requires a final group");
    }
    await expect(finalGroupRect.bottom).toBeLessThanOrEqual(
      railRect.bottom + 1,
    );
    await expect(finalGroupRect.bottom).toBeGreaterThan(railRect.top);
  },
};

export const InReview: Story = {
  args: { detail: detailFor("in_review") },
};

export const OverviewReviewThreads: Story = {
  args: {
    detail: withOverviewReviewThreads(detailFor("in_review")),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const thread = await canvas.findByTestId("review-thread-overview-thread-1");
    await expect(within(thread).getAllByRole("listitem")).toHaveLength(2);
    await expect(within(thread).getByText("Claude agent")).toBeVisible();
    await waitFor(() => {
      expect(within(thread).queryByText("Stale anchor")).toBeNull();
    });
  },
};

export const OverviewGroupedThreads: Story = {
  args: {
    detail: withOverviewReviewThreads(detailFor("in_review"), true),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "2 review threads on this passage",
      }),
    );
    await expect(
      canvas.getByRole("group", {
        name: "2 review threads on this passage",
      }),
    ).toHaveFocus();
  },
};

export const OverviewReviewThreadsMobile: Story = {
  args: {
    detail: withOverviewReviewThreads(detailFor("in_review")),
  },
  parameters: {
    viewport: {
      defaultViewport: "overview-thread-mobile",
      viewports: {
        "overview-thread-mobile": {
          name: "Overview thread mobile",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
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
