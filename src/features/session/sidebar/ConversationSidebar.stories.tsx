import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useLayoutEffect, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";
import {
  activeConversationsResponseSchema,
  type SessionActiveConversation,
} from "@/lib/active-conversations/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type {
  SidebarGroupBy,
  SidebarListFilter,
} from "@/features/session/sidebar/ConversationSidebar.helpers";
import {
  ACTIVE_LIST_FILTER_STORAGE_KEY,
  GROUP_BY_STORAGE_KEY,
} from "@/features/session/hooks/use-sidebar-persistent-filters";
import ConversationSidebar from "@/features/session/sidebar/ConversationSidebar";

type ActiveConversationsResponse = z.infer<
  typeof activeConversationsResponseSchema
>;

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const now = new Date();
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();

function makeActive(
  overrides: Partial<SessionActiveConversation> &
    Pick<SessionActiveConversation, "id">,
): SessionActiveConversation {
  return {
    scope: "session",
    id: overrides.id,
    name: overrides.name ?? "Untitled conversation",
    status: overrides.status ?? "running",
    lastActivityAt: overrides.lastActivityAt ?? minutesAgo(5),
    projectName: overrides.projectName ?? "remote-ai-manager",
    projectPath: overrides.projectPath ?? "/home/alex/github/remote-ai-manager",
    sessionName: overrides.sessionName ?? "conversation-ui-overhaul",
    agentBackend: overrides.agentBackend ?? "claude",
    summary: overrides.summary ?? null,
    pendingQuestion: overrides.pendingQuestion ?? null,
    pendingQuestionId: overrides.pendingQuestionId ?? null,
    pendingQuestions: overrides.pendingQuestions ?? null,
    forkedFrom: overrides.forkedFrom ?? null,
    debugActive: overrides.debugActive ?? false,
    role: overrides.role ?? null,
    branchName:
      overrides.branchName ?? "csm/conversation-ui-overhaul-multi-task",
    worktreePath:
      overrides.worktreePath ??
      `/home/alex/github/${overrides.projectName ?? "remote-ai-manager"}/.worktrees/${overrides.sessionName ?? "conversation-ui-overhaul"}`,
    lastActivitySummary: overrides.lastActivitySummary ?? null,
    unread: overrides.unread ?? false,
  };
}

const mixedActive: SessionActiveConversation[] = [
  makeActive({
    id: "conv-new",
    name: "Draft outline for spec",
    status: "new",
    lastActivityAt: minutesAgo(1),
    sessionName: "conversation-ui-overhaul",
    lastActivitySummary: "No prompts yet.",
  }),
  makeActive({
    id: "conv-running",
    name: "Implement sidebar pipeline",
    status: "running",
    lastActivityAt: minutesAgo(3),
    sessionName: "conversation-ui-overhaul",
    lastActivitySummary: "Iterating on annotateSessionPos.",
    debugActive: true,
  }),
  makeActive({
    id: "conv-awaiting",
    name: "Validate impl",
    status: "awaiting",
    lastActivityAt: minutesAgo(7),
    projectName: "remote-ai-manager",
    sessionName: "validator-sweep",
    role: "validator",
    lastActivitySummary: "Validator awaiting next instruction.",
  }),
  makeActive({
    id: "conv-wfi",
    name: "Plan refactor",
    status: "waiting_for_input",
    lastActivityAt: minutesAgo(12),
    sessionName: "validator-sweep",
    pendingQuestion: "Should we collapse the prompt panel by default?",
    lastActivitySummary: "Agent asked a clarifying question.",
  }),
  makeActive({
    id: "conv-codex",
    name: "Codex investigation",
    status: "running",
    lastActivityAt: minutesAgo(18),
    projectName: "creative-ai",
    projectPath: "/home/alex/github/creative-ai",
    sessionName: "diff-explainer",
    agentBackend: "codex",
    role: "iteration",
    forkedFrom: {
      conversationId: "conv-source-xyz",
      messageIndex: 14,
      mode: "synthetic",
    },
    lastActivitySummary: "Synthetic fork from earlier conversation.",
  }),
  makeActive({
    id: "conv-init",
    name: "Graph init scaffolding",
    status: "running",
    lastActivityAt: minutesAgo(22),
    projectName: "creative-ai",
    projectPath: "/home/alex/github/creative-ai",
    sessionName: "graph-init",
    role: "initialization",
    lastActivitySummary: "Wiring initial context tasks.",
  }),
];

const needsYouActive: SessionActiveConversation[] = [
  makeActive({
    id: "conv-wfi-1",
    name: "Plan refactor",
    status: "waiting_for_input",
    lastActivityAt: minutesAgo(2),
    sessionName: "conversation-ui-overhaul",
    pendingQuestion: "Should we collapse the prompt panel by default?",
    lastActivitySummary: "Agent asked a clarifying question.",
  }),
  makeActive({
    id: "conv-wfi-2",
    name: "Confirm rollout plan",
    status: "waiting_for_input",
    lastActivityAt: minutesAgo(4),
    projectName: "creative-ai",
    projectPath: "/home/alex/github/creative-ai",
    sessionName: "diff-explainer",
    pendingQuestion: "Roll out to all users or behind a flag?",
    lastActivitySummary: "Asking about rollout strategy.",
  }),
  makeActive({
    id: "conv-finished-1",
    name: "Built hotkeys help modal",
    status: "awaiting",
    unread: true,
    lastActivityAt: minutesAgo(8),
    sessionName: "validator-sweep",
    lastActivitySummary:
      "Built hotkeys help modal \u00b7 +88 / \u22124 \u00b7 ready for review",
  }),
  makeActive({
    id: "conv-finished-2",
    name: "Refactored validator pipeline",
    status: "awaiting",
    unread: true,
    lastActivityAt: minutesAgo(11),
    projectName: "creative-ai",
    projectPath: "/home/alex/github/creative-ai",
    sessionName: "graph-init",
    lastActivitySummary: "Refactored validator pipeline \u00b7 ready to merge.",
  }),
  makeActive({
    id: "conv-running-bg",
    name: "Background indexing",
    status: "running",
    lastActivityAt: minutesAgo(15),
    sessionName: "conversation-ui-overhaul",
    lastActivitySummary: "Indexing files in the background.",
  }),
];

const needsYouQuestionsOnly: SessionActiveConversation[] =
  needsYouActive.filter((c) => c.status === "waiting_for_input" || !c.unread);

const needsYouFinishedOnly: SessionActiveConversation[] = needsYouActive.filter(
  (c) => c.status !== "waiting_for_input",
);

const emptyResponse: ActiveConversationsResponse = {
  conversations: [],
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
};

const mixedResponse: ActiveConversationsResponse = {
  conversations: mixedActive,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
};

const needsYouResponse: ActiveConversationsResponse = {
  conversations: needsYouActive,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
};

const needsYouQuestionsResponse: ActiveConversationsResponse = {
  conversations: needsYouQuestionsOnly,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
};

const needsYouFinishedResponse: ActiveConversationsResponse = {
  conversations: needsYouFinishedOnly,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
};

// ---------------------------------------------------------------------------
// Story harness
// ---------------------------------------------------------------------------

interface HarnessProps {
  active: ActiveConversationsResponse;
  initialFilter?: string;
  initialGroupBy?: SidebarGroupBy;
  initialActiveListFilter?: SidebarListFilter;
  initialSidebarCollapsed?: boolean;
  mobileOpen?: boolean;
  activeConversationId?: string;
}

function SidebarHarness({
  active,
  initialFilter = "",
  initialGroupBy = "project",
  initialActiveListFilter = "all",
  initialSidebarCollapsed = false,
  mobileOpen = false,
  activeConversationId = "conv-running",
}: HarnessProps) {
  const queryClient = useMemo(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    qc.setQueryData(conversationKeys.active(), active);
    return qc;
  }, [active]);

  useLayoutEffect(() => {
    window.sessionStorage.setItem(
      GROUP_BY_STORAGE_KEY,
      JSON.stringify(initialGroupBy),
    );
    window.sessionStorage.setItem(
      ACTIVE_LIST_FILTER_STORAGE_KEY,
      JSON.stringify(initialActiveListFilter),
    );
    useSessionDetailStore.setState({
      sidebarFilter: initialFilter,
      sidebarCollapsed: initialSidebarCollapsed,
    });
    return () => {
      window.sessionStorage.removeItem(GROUP_BY_STORAGE_KEY);
      window.sessionStorage.removeItem(ACTIVE_LIST_FILTER_STORAGE_KEY);
    };
  }, [
    initialActiveListFilter,
    initialFilter,
    initialGroupBy,
    initialSidebarCollapsed,
  ]);

  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.toString();
      const path = new URL(rawUrl, window.location.origin).pathname;
      if (path === "/api/conversations/active") {
        return Promise.resolve(
          new Response(JSON.stringify(active), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return originalFetch(input, init);
    };
    return () => {
      window.fetch = originalFetch;
    };
  }, [active]);

  return (
    <QueryClientProvider client={queryClient}>
      <div
        className="app"
        data-page="detail"
        data-mobile-panel={mobileOpen ? "chat" : "chat"}
        style={{ height: "100%", width: "100%" }}
      >
        <ConversationSidebar
          key={initialGroupBy}
          projectName="remote-ai-manager"
          sessionName="conversation-ui-overhaul"
          activeConversationId={activeConversationId}
          mobileOpen={mobileOpen}
          onMobileClose={() => {}}
        />
      </div>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Session/ConversationSidebar",
  component: SidebarHarness,
  decorators: [
    (Story) => (
      <div
        style={{
          height: 720,
          width: 308,
          position: "relative",
          background: "var(--bg-void)",
          border: "1px solid var(--border-subtle)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    active: mixedResponse,
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof SidebarHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export const Empty = {
  args: {
    active: emptyResponse,
  },
} satisfies Story;

export const MixedStatuses = {
  args: {
    active: mixedResponse,
  },
} satisfies Story;

export const GroupBySession = {
  args: {
    active: mixedResponse,
    initialGroupBy: "session",
  },
} satisfies Story;

export const GroupByProject = {
  args: {
    active: mixedResponse,
    initialGroupBy: "project",
  },
} satisfies Story;

export const SearchFiltered = {
  args: {
    active: mixedResponse,
    initialFilter: "valid",
  },
} satisfies Story;

export const MobileDrawerOpen = {
  args: {
    active: mixedResponse,
    mobileOpen: true,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          height: 720,
          width: 420,
          position: "relative",
          background: "var(--bg-void)",
          border: "1px solid var(--border-subtle)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Story;

export const NeedsYouTwoSections = {
  args: {
    active: needsYouResponse,
    initialGroupBy: "session",
    activeConversationId: "conv-running-bg",
  },
} satisfies Story;

export const NeedsYouQuestionsOnly = {
  args: {
    active: needsYouQuestionsResponse,
    initialGroupBy: "session",
    activeConversationId: "conv-running-bg",
  },
} satisfies Story;

export const NeedsYouFinishedOnly = {
  args: {
    active: needsYouFinishedResponse,
    initialGroupBy: "session",
    activeConversationId: "conv-running-bg",
  },
} satisfies Story;

export const NeedsYouFilter = {
  args: {
    active: needsYouResponse,
    initialActiveListFilter: "needs",
    activeConversationId: "conv-running-bg",
  },
} satisfies Story;
