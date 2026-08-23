import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useLayoutEffect, useState } from "react";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { notificationKeys } from "@/lib/notifications/query-keys";
import { graphWorkflowExecutionEventPageResponseSchema } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecutionHistoryItem } from "@/lib/workflow-graph/schemas";
import {
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
  graphWorkflowHistoryKeys,
  graphWorkflowResultKeys,
} from "@/lib/workflows/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { validationKeys } from "@/lib/validation/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import SessionWorkflowPage from "./SessionWorkflowPage";
import { artemisBugReporterExecution } from "./fixtures/artemis-bug-reporter-execution";

const PROJECT_NAME = "artemis";
const SESSION_NAME = "Bug reporter functionality";
const SOURCE_EXECUTION_ID = artemisBugReporterExecution.id;

const workflowNavigation = {
  pathname: "/projects/artemis/Bug%20reporter%20functionality/workflow",
  query: { execution: SOURCE_EXECUTION_ID },
  segments: [
    ["name", PROJECT_NAME],
    ["session", encodeURIComponent(SESSION_NAME)],
  ],
};

const archivedExecution = {
  executionId: "ededf68e-dbe4-41c9-9935-9ea6e2e074a0",
  definitionId: "spec-delivery:ededf68e-dbe4-41c9-9935-9ea6e2e074a0",
  definitionRevision: 1,
  status: "aborted",
  startedAt: "2026-08-22T21:36:43.890Z",
  completedAt: "2026-08-22T21:53:17.999Z",
  haltReason: { type: "aborted", cause: null, summary: null },
  archived: true,
} satisfies GraphWorkflowExecutionHistoryItem;

const eventPage = graphWorkflowExecutionEventPageResponseSchema.parse({
  events: [],
  nextCursor: null,
});

function createStoryQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });

  queryClient.setQueryData(
    graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
    artemisBugReporterExecution,
  );
  queryClient.setQueryData(
    graphWorkflowHistoryKeys.list(PROJECT_NAME, SESSION_NAME),
    [archivedExecution],
  );
  queryClient.setQueryData(
    graphWorkflowExecutionKeys.byId(
      PROJECT_NAME,
      SESSION_NAME,
      archivedExecution.executionId,
    ),
    null,
  );
  for (const executionId of [
    SOURCE_EXECUTION_ID,
    archivedExecution.executionId,
  ]) {
    queryClient.setQueryData(
      graphWorkflowResultKeys.detail(
        PROJECT_NAME,
        SESSION_NAME,
        executionId,
        null,
      ),
      null,
    );
  }
  queryClient.setQueryData(
    graphWorkflowEventsKeys.list(
      PROJECT_NAME,
      SESSION_NAME,
      SOURCE_EXECUTION_ID,
    ),
    [],
  );
  queryClient.setQueryData(
    graphWorkflowEventsKeys.pages(
      PROJECT_NAME,
      SESSION_NAME,
      SOURCE_EXECUTION_ID,
    ),
    { pages: [eventPage], pageParams: [null] },
  );
  queryClient.setQueryData(sessionKeys.detail(PROJECT_NAME, SESSION_NAME), {
    conversations: [],
  });
  queryClient.setQueryData(conversationKeys.active(), { conversations: [] });
  queryClient.setQueryData(notificationKeys.list(), {
    notifications: [],
    unreadCount: 0,
    total: 0,
  });
  queryClient.setQueryData(validationKeys.commands(), {
    projects: [
      {
        projectName: PROJECT_NAME,
        commands: [
          {
            name: "test",
            cost: 4,
            description: "Run the scoped Vitest suite",
            pathArgs: "paths",
            changedScope: "native",
          },
          {
            name: "pre-merge",
            cost: 8,
            description: "Run all pre-merge validation",
            pathArgs: "forbid",
            changedScope: "full_fallback",
          },
        ],
      },
    ],
  });
  queryClient.setQueryData(validationKeys.budget(), {
    available: true,
    capacity: { limit: 16, inUse: 12, queueDepth: 0 },
    runs: [],
  });

  return queryClient;
}

function mockEventPageFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, window.location.origin);
    if (
      parsed.pathname.endsWith("/graph-workflow/events") &&
      parsed.searchParams.get("page") === "true"
    ) {
      return Response.json(eventPage);
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function WithSourceExecution({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createStoryQueryClient);
  useLayoutEffect(() => {
    const sidebarWasCollapsed =
      useSessionDetailStore.getState().sidebarCollapsed;
    useSessionDetailStore.setState({ sidebarCollapsed: true });
    const restoreFetch = mockEventPageFetch();
    return () => {
      restoreFetch();
      useSessionDetailStore.setState({
        sidebarCollapsed: sidebarWasCollapsed,
      });
    };
  }, []);
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const meta = {
  title: "Session Workflow/Workflow Execution Page",
  component: SessionWorkflowPage,
  decorators: [
    (Story) => (
      <WithSourceExecution>
        <Story />
      </WithSourceExecution>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
      navigation: workflowNavigation,
    },
  },
} satisfies Meta<typeof SessionWorkflowPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BugReporterExecution: Story = {};
