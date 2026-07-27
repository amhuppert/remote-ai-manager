import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { specDetailViewSchema, type SpecDetailView } from "@/lib/specs/queries";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import { SpecDetailContent } from "./SpecDetailPage";

type SpecDetailContentProps = ComponentProps<typeof SpecDetailContent>;

/**
 * Stands in for the address bar the real page navigates: the `view` arg seeds
 * the surface and tab selections move it, so stories stay interactive without
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

function detailFor(
  phase: SpecDetailView["status"]["phase"]["primary"],
): SpecDetailView {
  const base = withProse(
    specControlsDetailFixture(
      phase === "executing" || phase === "delivered" ? "running" : "none",
    ),
  );
  const snapshot = base.currentRevision;
  if (snapshot === null) return parsedDetail(base);
  const revisionState =
    phase === "in_review"
      ? "proposed"
      : phase === "draft"
        ? "draft"
        : "approved";
  const revision = {
    ...snapshot.revision,
    state: revisionState as "approved" | "proposed" | "draft",
    approvedAt: revisionState === "approved" ? SPEC_CONTROLS_FIXTURE_NOW : null,
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
  render: (args) => <AddressBarHarness {...args} />,
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

/** The Controls surface reached through the primary view strip (F14). */
export const Controls: Story = {
  args: { view: "controls", detail: detailFor("executing") },
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
