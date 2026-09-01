import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import { reviewView } from "./delivery-plan-review.fixtures";
import SpecLifecycleLanes from "./SpecLifecycleLanes";

const meta = {
  title: "Specs/Studio/LifecycleLanes",
  component: SpecLifecycleLanes,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  args: {
    detail: specControlsDetailFixture(),
    deliveryPlan: null,
  },
} satisfies Meta<typeof SpecLifecycleLanes>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DeliveredBaseline: Story = {
  args: { detail: specControlsDetailFixture() },
};

export const ExtensionRequirements: Story = {
  args: {
    detail: (() => {
      const detail = specControlsDetailFixture();
      const approved = detail.currentApprovedRevision;
      if (!approved || !detail.currentRevision) return detail;
      detail.currentRevision.revision = {
        ...detail.currentRevision.revision,
        id: "revision-extension",
        number: approved.revision.number + 1,
        state: "draft",
        authoringStage: "requirements",
        basedOnRevisionId: approved.revision.id,
        approvedAt: null,
      };
      return detail;
    })(),
  },
};

export const DesignReview: Story = {
  args: {
    detail: (() => {
      const detail = specControlsDetailFixture();
      if (!detail.currentRevision) return detail;
      detail.currentRevision.revision = {
        ...detail.currentRevision.revision,
        state: "proposed",
        authoringStage: "design",
      };
      return detail;
    })(),
  },
};

export const ConcurrentOldExecution: Story = {
  args: {
    detail: ExtensionRequirements.args?.detail,
    deliveryPlan: reviewView({ attempt: { status: "launched" } }),
  },
};
