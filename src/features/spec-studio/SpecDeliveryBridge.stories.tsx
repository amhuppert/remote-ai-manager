import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { specQueries, type SpecDetailView } from "@/lib/specs/queries";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import {
  pendingReaffirmationReview,
  reviewView,
} from "./delivery-plan-review.fixtures";
import SpecDeliveryBridge from "./SpecDeliveryBridge";

function BridgeState({
  detail,
  review,
}: {
  detail: SpecDetailView;
  review: DeliveryPlanReviewView | null;
}): React.JSX.Element {
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(
      specQueries.planReview("command-center", detail.spec.slug).queryKey,
      review,
    );
    return queryClient;
  });
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-[900px] p-xl">
        <SpecDeliveryBridge detail={detail} projectName="command-center" />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Specs/Studio/DeliveryBridge",
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoPlan: Story = {
  render: () => (
    <BridgeState detail={specControlsDetailFixture()} review={null} />
  ),
};
export const Draft: Story = {
  render: () => (
    <BridgeState
      detail={specControlsDetailFixture()}
      review={reviewView({ attempt: { status: "draft" } })}
    />
  ),
};
export const NeedsReaffirmation: Story = {
  render: () => (
    <BridgeState
      detail={specControlsDetailFixture()}
      review={pendingReaffirmationReview()}
    />
  ),
};
export const InReview: Story = {
  render: () => (
    <BridgeState detail={specControlsDetailFixture()} review={reviewView()} />
  ),
};
export const Launched: Story = {
  render: () => {
    const detail = specControlsDetailFixture("running");
    const executionId = detail.executions.at(-1)?.id ?? "execution-1";
    return (
      <BridgeState
        detail={detail}
        review={reviewView({
          attempt: { status: "launched", launchedExecutionId: executionId },
        })}
      />
    );
  },
};
export const Delivered: Story = {
  render: () => {
    const detail = specControlsDetailFixture("running");
    const execution = detail.executions.at(-1);
    if (execution) {
      execution.state = "delivered";
      execution.deliveredAt = "2026-07-18T13:00:00.000Z";
    }
    const executionId = execution?.id ?? "execution-1";
    return (
      <BridgeState
        detail={detail}
        review={reviewView({
          attempt: { status: "launched", launchedExecutionId: executionId },
        })}
      />
    );
  },
};
