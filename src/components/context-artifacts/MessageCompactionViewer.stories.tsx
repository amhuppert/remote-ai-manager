import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import MessageCompactionViewer from "./MessageCompactionViewer";
import {
  contextArtifactKeys,
  type ContextArtifactTarget,
} from "@/lib/context-artifacts/query-keys";
import { buildArtifactDetail, buildArtifactListItem } from "./fixtures";

const target: ContextArtifactTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

/**
 * Deterministic fixture client: the detail row is seeded into the cache with
 * an infinite staleTime, so the story renders without any network.
 */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const detail = buildArtifactDetail();
  client.setQueryData(contextArtifactKeys.detail(target, detail.id), detail);
  return client;
}

const meta = {
  title: "Components/ContextArtifacts/MessageCompactionViewer",
  component: MessageCompactionViewer,
  parameters: { a11y: { test: "error" }, layout: "padded" },
  args: {
    target,
    artifact: buildArtifactListItem(),
    onRefresh: fn(),
    refreshPending: false,
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={seededClient()}>
        <div className="max-w-[760px] bg-bg-base p-lg">
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof MessageCompactionViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Complete artifact: envelope rendered from the seeded detail row. */
export const Complete = {} satisfies Story;

/** A force-refresh in flight: visible pending state on the Refresh action. */
export const RefreshPending = {
  args: { refreshPending: true },
} satisfies Story;

/** Failed artifact: stored error surfaced; no payload fetch. */
export const Failed = {
  args: {
    artifact: buildArtifactListItem({
      status: "failed",
      error: "transcript_too_large_for_single_pass",
    }),
  },
} satisfies Story;
