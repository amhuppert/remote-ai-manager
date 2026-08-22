import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fn } from "storybook/test";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  makeLaunchDocument,
} from "@/lib/workflow-graph/test-fixtures";
import {
  graphWorkflowExecutionKeys,
  graphWorkflowResultKeys,
} from "@/lib/workflows/query-keys";
import ArchivedExecutionsList from "./ArchivedExecutionsList";

const current = createWorkflowExecution({
  id: "exec-current",
  origin: { kind: "one_off", planName: "Repair flaky tests" },
  ownerConversationId: "conv-current",
  launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
    name: "Repair flaky tests",
    description: "One-off regression repair",
  }),
  status: "running",
  startedAt: "2026-08-14T14:00:00.000Z",
});

const historical = createWorkflowExecution({
  id: "exec-history",
  origin: {
    kind: "template",
    definitionId: "release-flow",
    definitionRevision: 7,
    tier: "project",
  },
  ownerConversationId: null,
  launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
    name: "Release flow",
    description: "Publish the current release candidate",
  }),
  status: "completed",
  startedAt: "2026-08-14T12:00:00.000Z",
  completedAt: "2026-08-14T12:30:00.000Z",
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
  },
});
queryClient.setQueryData(
  graphWorkflowExecutionKeys.byId("command-center", "release", historical.id),
  historical,
);
for (const execution of [current, historical]) {
  queryClient.setQueryData(
    graphWorkflowResultKeys.detail(
      "command-center",
      "release",
      execution.id,
      null,
    ),
    null,
  );
}

const meta = {
  title: "Session workflow/Execution rail",
  component: ArchivedExecutionsList,
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <div className="h-[720px] bg-bg-void">
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
  args: {
    projectName: "command-center",
    sessionName: "release",
    current,
    executions: [
      {
        executionId: historical.id,
        definitionId: historical.seedDefinitionId,
        definitionRevision: historical.seedDefinitionRevision,
        status: historical.status,
        startedAt: historical.startedAt,
        completedAt: historical.completedAt,
        haltReason: historical.haltReason,
        archived: true,
      },
    ],
    sessionConversationIds: new Set(["conv-current"]),
    selectedExecutionId: historical.id,
    onSelect: fn(),
  },
} satisfies Meta<typeof ArchivedExecutionsList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentAndHistory: Story = {};

export const CurrentSelected: Story = {
  args: {
    selectedExecutionId: current.id,
  },
};

/** Tenure, not terminality: a paused run still holds the lease, so it is Current. */
export const PausedCurrent: Story = {
  args: {
    current: { ...current, status: "paused" },
    selectedExecutionId: current.id,
  },
};

/** A resumably halted run also keeps the lease — the halt headline rides its row. */
export const ResumablyHaltedCurrent: Story = {
  args: {
    current: {
      ...current,
      status: "halted",
      haltReason: {
        type: "agent_turn_failed",
        contextId: "context-implement",
        engine: "claude",
        cause: "sdk_error",
        message: "SDK stream ended unexpectedly",
      },
    },
    selectedExecutionId: current.id,
  },
};

/** No run holds the lease: the rail is History alone, read-only and deep-linkable. */
export const HistoryOnly: Story = {
  args: {
    current: null,
  },
};

/** The rail's collapse control appears only for a page that owns the state. */
export const Collapsible: Story = {
  args: {
    onCollapse: fn(),
  },
};
