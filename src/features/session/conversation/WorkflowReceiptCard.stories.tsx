import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  makeLaunchDocument,
} from "@/lib/workflow-graph/test-fixtures";
import {
  graphWorkflowExecutionKeys,
  graphWorkflowResultKeys,
} from "@/lib/workflows/query-keys";
import WorkflowReceiptCard from "./WorkflowReceiptCard";

const receipt = {
  executionId: "exec-release-repair",
  status: "running" as const,
  origin: { kind: "one_off" as const, planName: "Repair the release" },
  originConversationId: "conv-origin",
  deepLink:
    "/projects/command-center/session-1/workflow?execution=exec-release-repair",
  startedAt: "2026-08-14T14:00:00.000Z",
};

const execution = createWorkflowExecution({
  id: receipt.executionId,
  origin: receipt.origin,
  ownerConversationId: receipt.originConversationId,
  status: "running",
  launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
    name: "Repair the release",
    description: "One-off repair launched from this conversation turn.",
  }),
});

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
  },
});
client.setQueryData(
  graphWorkflowExecutionKeys.byId(
    "command-center",
    "session-1",
    receipt.executionId,
  ),
  execution,
);
client.setQueryData(
  graphWorkflowResultKeys.latest(
    "command-center",
    "session-1",
    receipt.executionId,
  ),
  null,
);

const meta = {
  title: "Session/Conversation/WorkflowReceiptCard",
  component: WorkflowReceiptCard,
  parameters: { layout: "padded", backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <div className="max-w-[720px] bg-bg-base py-md">
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
  args: {
    projectName: "command-center",
    sessionName: "session-1",
    receipt,
  },
} satisfies Meta<typeof WorkflowReceiptCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};
