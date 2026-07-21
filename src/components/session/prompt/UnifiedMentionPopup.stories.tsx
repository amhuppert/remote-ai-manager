import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { AllConversationsResponse } from "@/lib/conversations/schemas";
import type { TicketListItem } from "@/lib/tickets/schemas";
import type { SpecPickerSpec } from "@/lib/prompt-editor/reference-registry";
import { createUnifiedMentionPopup } from "./UnifiedMentionPopup";

const conversations: AllConversationsResponse = {
  items: [
    {
      projectName: "command-center",
      projectPath: "/repos/command-center",
      sessionName: "native-sdd",
      worktreePath: "/repos/command-center/.worktrees/native-sdd",
      conversationId: "conv-native-sdd",
      conversationName: "Native SDD reference registry",
      summary: null,
      firstPromptSnippet: null,
      backend: "claude",
      backendRef: null,
      transcriptPath: null,
      debugLogPath: null,
      status: "running",
      lastActivityAt: "2026-07-18T12:00:00Z",
      archived: false,
      compactArtifactId: "artifact-1",
      compactStatus: "fresh",
      compactCoveredSeq: "0..120",
      compactCreatedAt: "2026-07-18T12:00:00Z",
    },
    {
      projectName: "command-center",
      projectPath: "/repos/command-center",
      sessionName: "main",
      worktreePath: "/repos/command-center",
      conversationId: "conv-auth",
      conversationName: "Authentication follow-up",
      summary: null,
      firstPromptSnippet: null,
      backend: "codex",
      backendRef: null,
      transcriptPath: null,
      debugLogPath: null,
      status: "awaiting",
      lastActivityAt: "2026-07-17T12:00:00Z",
      archived: false,
    },
  ],
  totalCount: 2,
};

const tickets: TicketListItem[] = [
  {
    id: "ticket-42",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 42,
    title: "Ship reference registry parity",
    workType: "feature",
    status: "in_progress",
    attachmentCount: 2,
    activeSessionName: "native-sdd",
    createdAt: "2026-07-17T12:00:00Z",
    updatedAt: "2026-07-18T12:00:00Z",
  },
];

const specs: SpecPickerSpec[] = [
  {
    projectName: "command-center",
    specId: "spec-native-sdd",
    slug: "native-sdd",
    name: "Native spec-driven development",
    revision: 4,
    elements: [
      {
        type: "requirement",
        elementId: "requirement-3",
        handle: "R3",
        name: "Granular durable approvals",
        searchText: "Granular durable approvals per element",
      },
      {
        type: "decision",
        elementId: "decision-2",
        handle: "D2",
        name: "Direct-change-only invalidation",
        searchText: "Direct-change-only invalidation",
      },
      {
        type: "task",
        elementId: "task-9",
        handle: "T9",
        name: "Render live reference chips",
        searchText: "Render live reference chips and peek cards",
      },
    ],
  },
];

const Popup = createUnifiedMentionPopup({
  useAllConversations: () => ({
    data: conversations,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useTickets: () => ({
    data: tickets,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useSpecs: () => ({
    data: specs,
    isLoading: false,
    isError: false,
    error: null,
  }),
});

function Demo({ query }: { query: string }): React.JSX.Element {
  return (
    <div className="mx-auto mt-[420px] max-w-[640px]">
      <div className="relative">
        <Popup
          query={query}
          currentProjectName="command-center"
          currentConversationId="storybook-current"
          onSelect={() => {}}
        />
        <div className="min-h-[80px] rounded-md border border-border-default bg-bg-surface px-[14px] py-[12px] font-mono text-[0.85rem] text-text-primary">
          #{query}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Session/PromptEditor/UnifiedMentionPopup",
  component: Demo,
  args: { query: "" },
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GroupedExistingReferences = {} satisfies Story;

export const TicketFiltered = {
  args: { query: "tickets:" },
} satisfies Story;

export const SpecDrillIn = {
  args: { query: "native-sdd/" },
} satisfies Story;
