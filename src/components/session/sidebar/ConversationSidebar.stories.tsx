import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useLayoutEffect, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";
import {
  activeConversationsResponseSchema,
  type ActiveConversation,
  type ProjectActiveConversation,
  type SessionActiveConversation,
} from "@/lib/active-conversations/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { SidebarListFilter } from "@/components/session/sidebar/ConversationSidebar.helpers";
import { ACTIVE_LIST_FILTER_STORAGE_KEY } from "@/hooks/use-sidebar-persistent-filters";
import ConversationSidebar from "@/components/session/sidebar/ConversationSidebar";

type ActiveConversationsResponse = z.infer<
  typeof activeConversationsResponseSchema
>;

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const now = new Date();
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();

function makeSessionActive(
  overrides: Partial<SessionActiveConversation> &
    Pick<SessionActiveConversation, "id">,
): SessionActiveConversation {
  return {
    scope: "session",
    archived: overrides.archived ?? false,
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
    pendingApproval: overrides.pendingApproval ?? null,
    backgroundActivity: overrides.backgroundActivity ?? null,
  };
}

function makeProjectActive(
  overrides: Partial<ProjectActiveConversation> &
    Pick<ProjectActiveConversation, "id">,
): ProjectActiveConversation {
  return {
    scope: "project",
    id: overrides.id,
    name: overrides.name ?? "Project-level conversation",
    status: overrides.status ?? "running",
    lastActivityAt: overrides.lastActivityAt ?? minutesAgo(5),
    projectName: overrides.projectName ?? "remote-ai-manager",
    projectPath: overrides.projectPath ?? "/home/alex/github/remote-ai-manager",
    agentBackend: overrides.agentBackend ?? "claude",
    summary: overrides.summary ?? null,
    pendingQuestion: overrides.pendingQuestion ?? null,
    pendingQuestionId: overrides.pendingQuestionId ?? null,
    pendingQuestions: overrides.pendingQuestions ?? null,
    forkedFrom: overrides.forkedFrom ?? null,
    debugActive: overrides.debugActive ?? false,
    role: overrides.role ?? null,
    worktreePath:
      overrides.worktreePath ??
      `/home/alex/github/${overrides.projectName ?? "remote-ai-manager"}`,
    lastActivitySummary: overrides.lastActivitySummary ?? null,
    unread: overrides.unread ?? false,
    pendingApproval: overrides.pendingApproval ?? null,
    backgroundActivity: overrides.backgroundActivity ?? null,
    open: overrides.open ?? true,
  };
}

const mixedActive: ActiveConversation[] = [
  makeSessionActive({
    id: "conv-new",
    name: "Draft outline for spec",
    status: "new",
    lastActivityAt: minutesAgo(1),
    sessionName: "conversation-ui-overhaul",
    lastActivitySummary: "No prompts yet.",
  }),
  makeSessionActive({
    id: "conv-running",
    name: "Implement sidebar pipeline",
    status: "running",
    lastActivityAt: minutesAgo(3),
    sessionName: "conversation-ui-overhaul",
    lastActivitySummary: "Iterating on annotateSessionPos.",
    debugActive: true,
  }),
  makeSessionActive({
    id: "conv-awaiting",
    name: "Validate impl",
    status: "awaiting",
    lastActivityAt: minutesAgo(7),
    projectName: "remote-ai-manager",
    sessionName: "validator-sweep",
    role: "validator",
    lastActivitySummary: "Validator awaiting next instruction.",
  }),
  makeSessionActive({
    id: "conv-wfi",
    name: "Plan refactor",
    status: "waiting_for_input",
    lastActivityAt: minutesAgo(12),
    sessionName: "validator-sweep",
    pendingQuestion: "Should we collapse the prompt panel by default?",
    lastActivitySummary: "Agent asked a clarifying question.",
  }),
  makeProjectActive({
    id: "project-running",
    name: "Review project-level transcript flow",
    status: "running",
    lastActivityAt: minutesAgo(14),
    projectName: "remote-ai-manager",
    lastActivitySummary: "Checking root-level active conversation routing.",
  }),
  makeProjectActive({
    id: "project-wfi",
    name: "Resolve project prompt",
    status: "waiting_for_input",
    lastActivityAt: minutesAgo(16),
    projectName: "remote-ai-manager",
    pendingQuestion: "Should the main project transcript keep focus?",
    lastActivitySummary: "Asking for project-level routing confirmation.",
  }),
  makeProjectActive({
    id: "project-unread-awaiting",
    name: "Summarize project outcome",
    status: "awaiting",
    unread: true,
    lastActivityAt: minutesAgo(17),
    projectName: "remote-ai-manager",
    agentBackend: "codex",
    lastActivitySummary: "Finished the project summary and is ready.",
  }),
  makeSessionActive({
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
  makeSessionActive({
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

const needsYouActive: ActiveConversation[] = [
  makeSessionActive({
    id: "conv-wfi-1",
    name: "Plan refactor",
    status: "waiting_for_input",
    lastActivityAt: minutesAgo(2),
    sessionName: "conversation-ui-overhaul",
    pendingQuestion: "Should we collapse the prompt panel by default?",
    lastActivitySummary: "Agent asked a clarifying question.",
  }),
  makeProjectActive({
    id: "project-wfi-1",
    name: "Confirm project scope",
    status: "waiting_for_input",
    lastActivityAt: minutesAgo(3),
    projectName: "remote-ai-manager",
    pendingQuestion: "Keep the project row in the global Active tab?",
    lastActivitySummary: "Asking whether the PLC row should stay visible.",
  }),
  makeSessionActive({
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
  makeSessionActive({
    id: "conv-finished-1",
    name: "Built hotkeys help modal",
    status: "awaiting",
    unread: true,
    lastActivityAt: minutesAgo(8),
    sessionName: "validator-sweep",
    lastActivitySummary:
      "Built hotkeys help modal \u00b7 +88 / \u22124 \u00b7 ready for review",
  }),
  makeProjectActive({
    id: "project-finished-1",
    name: "Project-level summary ready",
    status: "awaiting",
    unread: true,
    lastActivityAt: minutesAgo(10),
    projectName: "remote-ai-manager",
    agentBackend: "codex",
    lastActivitySummary: "Project-level summary ready for review.",
  }),
  makeSessionActive({
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
  makeSessionActive({
    id: "conv-running-bg",
    name: "Background indexing",
    status: "running",
    lastActivityAt: minutesAgo(15),
    sessionName: "conversation-ui-overhaul",
    lastActivitySummary: "Indexing files in the background.",
  }),
];

const projectRowsOnly: ActiveConversation[] = [
  makeProjectActive({
    id: "project-running",
    name: "Review project-level transcript flow",
    status: "running",
    lastActivityAt: minutesAgo(2),
    projectName: "remote-ai-manager",
    lastActivitySummary: "Checking root-level active conversation routing.",
  }),
  makeProjectActive({
    id: "project-wfi",
    name: "Resolve project prompt",
    status: "waiting_for_input",
    lastActivityAt: minutesAgo(6),
    projectName: "remote-ai-manager",
    pendingQuestion: "Should the main project transcript keep focus?",
    lastActivitySummary: "Asking for project-level routing confirmation.",
  }),
  makeProjectActive({
    id: "project-unread-awaiting",
    name: "Summarize project outcome",
    status: "awaiting",
    unread: true,
    lastActivityAt: minutesAgo(9),
    projectName: "creative-ai",
    projectPath: "/home/alex/github/creative-ai",
    agentBackend: "codex",
    worktreePath: "/home/alex/github/creative-ai",
    lastActivitySummary: "Project-level summary ready for review.",
  }),
];

const needsYouQuestionsOnly: ActiveConversation[] = needsYouActive.filter(
  (c) => c.status === "waiting_for_input" || !c.unread,
);

const needsYouFinishedOnly: ActiveConversation[] = needsYouActive.filter(
  (c) => c.status !== "waiting_for_input",
);

const emptyResponse: ActiveConversationsResponse = {
  conversations: [],
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
  specExecutions: [],
};

const mixedResponse: ActiveConversationsResponse = {
  conversations: mixedActive,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
  specExecutions: [],
};

const needsYouResponse: ActiveConversationsResponse = {
  conversations: needsYouActive,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
  specExecutions: [],
};

const projectRowsOnlyResponse: ActiveConversationsResponse = {
  conversations: projectRowsOnly,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
  specExecutions: [],
};

const needsYouQuestionsResponse: ActiveConversationsResponse = {
  conversations: needsYouQuestionsOnly,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
  specExecutions: [],
};

const needsYouFinishedResponse: ActiveConversationsResponse = {
  conversations: needsYouFinishedOnly,
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
  specExecutions: [],
};

const archivedAfterActionResponse = {
  conversations: [
    makeSessionActive({
      id: "conv-archive-control",
      name: "Session row remains visible",
      status: "running",
      lastActivityAt: minutesAgo(4),
      lastActivitySummary: "Unaffected session row.",
    }),
    {
      ...makeProjectActive({
        id: "project-archived",
        name: "Archived project conversation",
        status: "awaiting",
        unread: true,
        lastActivityAt: minutesAgo(9),
        projectName: "remote-ai-manager",
        lastActivitySummary: "Archived after a project-level action.",
      }),
      archived: true,
    },
  ],
  graphWorkflowExecutions: [],
  activeCollaborationExecutions: [],
  specExecutions: [],
} as ActiveConversationsResponse;

// ---------------------------------------------------------------------------
// Story harness
// ---------------------------------------------------------------------------

interface HarnessProps {
  active: ActiveConversationsResponse;
  initialFilter?: string;
  initialActiveListFilter?: SidebarListFilter;
  initialSidebarCollapsed?: boolean;
  mobileOpen?: boolean;
  activeConversationId?: string;
}

function SidebarHarness({
  active,
  initialFilter = "",
  initialActiveListFilter = "all",
  initialSidebarCollapsed = false,
  mobileOpen = false,
  activeConversationId = "conv-running",
}: HarnessProps) {
  const current = active.conversations.find(
    (row) => row.id === activeConversationId,
  );
  const queryClient = useMemo(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    qc.setQueryData(conversationKeys.active(), active);
    qc.setQueryData(conversationKeys.sidebar(false), active);
    qc.setQueryData(conversationKeys.sidebar(true), active);
    return qc;
  }, [active]);

  useLayoutEffect(() => {
    window.sessionStorage.setItem(
      ACTIVE_LIST_FILTER_STORAGE_KEY,
      JSON.stringify(initialActiveListFilter),
    );
    useSessionDetailStore.setState({
      sidebarFilter: initialFilter,
      sidebarCollapsed: initialSidebarCollapsed,
    });
    return () => {
      window.sessionStorage.removeItem(ACTIVE_LIST_FILTER_STORAGE_KEY);
    };
  }, [initialActiveListFilter, initialFilter, initialSidebarCollapsed]);

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
        style={
          {
            height: "100%",
            width: "100%",
            "--convo-sidebar-w": "100%",
          } as React.CSSProperties
        }
      >
        <ConversationSidebar
          projectName={current?.projectName ?? "remote-ai-manager"}
          sessionName={current?.scope === "session" ? current.sessionName : ""}
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
          height: 860,
          width: 616,
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

export const ProjectRowsOnly = {
  args: {
    active: projectRowsOnlyResponse,
    activeConversationId: "project-running",
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
    activeConversationId: "conv-running-bg",
  },
} satisfies Story;

export const NeedsYouQuestionsOnly = {
  args: {
    active: needsYouQuestionsResponse,
    activeConversationId: "conv-running-bg",
  },
} satisfies Story;

export const NeedsYouFinishedOnly = {
  args: {
    active: needsYouFinishedResponse,
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

export const ArchivedAfterAction = {
  args: {
    active: archivedAfterActionResponse,
    activeConversationId: "conv-archive-control",
  },
} satisfies Story;

const sessionNames = [
  "Conversation panel redesign",
  "Workflow architecture",
  "Commercial release",
  "Search performance",
  "Conversation runtime",
  "Knowledge capture",
];
const conversationNames = [
  [
    "Polish the conversation panel",
    "Review keyboard navigation",
    "Explore session grouping",
    "Initial design direction",
    "Earlier layout study",
  ],
  [
    "Review graph workflow boundaries",
    "Validate delivery contracts",
    "Document approval semantics",
    "Plan workflow changes",
    "Architecture alternatives",
  ],
  [
    "Prepare release candidate",
    "Check upgrade behavior",
    "Review release checklist",
    "Audit distribution build",
    "Release planning",
  ],
  [
    "Profile search queries",
    "Compare index strategies",
    "Trace slow requests",
    "Measure query baseline",
    "Search design notes",
  ],
  [
    "Fix conversation resume",
    "Review lifecycle transitions",
    "Add cancellation coverage",
    "Investigate stalled turns",
    "Runtime investigation",
  ],
  [
    "Review memory retrieval",
    "Refine note ranking",
    "Test project scoping",
    "Outline capture flow",
    "Memory design notes",
  ],
];
const busyResponse: ActiveConversationsResponse = {
  ...emptyResponse,
  conversations: sessionNames.flatMap((sessionName, sessionIndex) =>
    Array.from({ length: 5 }, (_, index) =>
      makeSessionActive({
        id: `busy-${sessionIndex}-${index}`,
        sessionName,
        projectName:
          sessionIndex === 2 || sessionIndex === 3
            ? "active-recall"
            : "command-center",
        projectPath:
          sessionIndex === 2 || sessionIndex === 3
            ? "/projects/active-recall"
            : "/projects/command-center",
        name: conversationNames[sessionIndex]?.[index] ?? "Conversation",
        agentBackend: (sessionIndex + index) % 2 === 0 ? "codex" : "claude",
        status:
          sessionIndex === 0 && index === 0
            ? "running"
            : sessionIndex === 1 && index === 1
              ? "waiting_for_input"
              : "awaiting",
        lastActivityAt: minutesAgo(sessionIndex * 35 + index * 15 + 2),
        pendingQuestion:
          sessionIndex === 1 && index === 1
            ? "Should approval apply to the full session or only the changed files?"
            : null,
        lastActivitySummary:
          sessionIndex === 0 && index === 0
            ? "Checking layout and keyboard interactions"
            : null,
        unread: sessionIndex === 2 && (index === 0 || index === 2),
        role:
          sessionIndex === 1 && index === 1
            ? "validator"
            : sessionIndex === 1 && index === 2
              ? "iteration"
              : null,
        archived: index === 4,
      }),
    ),
  ),
};

export const Default: Story = {
  args: { active: busyResponse, activeConversationId: "busy-0-0" },
};
export const ThirtyConversations: Story = {
  args: { active: busyResponse, activeConversationId: "busy-0-0" },
};
export const NarrowPanel: Story = {
  args: { active: busyResponse, activeConversationId: "busy-0-0" },
  decorators: [
    (Story) => (
      <div className="h-full w-[280px]">
        <Story />
      </div>
    ),
  ],
};

export const Unread: Story = {
  args: {
    active: busyResponse,
    activeConversationId: "busy-0-0",
    initialActiveListFilter: "unread",
  },
};
export const CurrentProject: Story = {
  args: {
    active: busyResponse,
    activeConversationId: "busy-0-0",
    initialActiveListFilter: "project",
  },
};
