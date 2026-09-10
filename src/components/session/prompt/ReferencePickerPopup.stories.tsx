import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { AllConversationsResponse } from "@/lib/conversations/schemas";
import type { NotepadListItem } from "@/lib/notepads/schemas";
import type { SpecPickerSpec } from "@/lib/prompt-editor/reference-registry";
import type { PickerTrigger } from "@/lib/prompt-editor/reference-picker";
import type { TicketListItem } from "@/lib/tickets/schemas";
import { createReferencePickerPopup } from "./ReferencePickerPopup";

const conversations: AllConversationsResponse = {
  items: [
    {
      projectName: "command-center",
      projectPath: "/repos/command-center",
      scope: "session" as const,
      sessionName: "api-hardening",
      worktreePath: "/repos/command-center/.worktrees/api-hardening",
      conversationId: "conv-auth",
      conversationName: "Auth token refresh review",
      summary: null,
      firstPromptSnippet: null,
      backend: "claude",
      backendRef: null,
      transcriptPath: null,
      debugLogPath: null,
      status: "running",
      lastActivityAt: "2026-08-16T12:00:00Z",
      archived: false,
    },
    {
      projectName: "command-center",
      projectPath: "/repos/command-center",
      scope: "session" as const,
      sessionName: "main",
      worktreePath: "/repos/command-center",
      conversationId: "conv-perf",
      conversationName: "Perf audit follow-ups",
      summary: null,
      firstPromptSnippet: null,
      backend: "codex",
      backendRef: null,
      transcriptPath: null,
      debugLogPath: null,
      status: "waiting_for_input",
      lastActivityAt: "2026-08-15T12:00:00Z",
      archived: false,
    },
    {
      projectName: "command-center",
      projectPath: "/repos/command-center",
      scope: "session" as const,
      sessionName: "mcp",
      worktreePath: "/repos/command-center/.worktrees/mcp",
      conversationId: "conv-mcp",
      conversationName: "MCP config spike",
      summary: null,
      firstPromptSnippet: null,
      backend: "claude",
      backendRef: null,
      transcriptPath: null,
      debugLogPath: null,
      status: "awaiting",
      lastActivityAt: "2026-08-02T12:00:00Z",
      archived: true,
    },
  ],
  totalCount: 3,
};

const tickets: TicketListItem[] = [
  {
    id: "ticket-142",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 142,
    title: "Redesign prompt autocomplete",
    workType: "feature",
    status: "in_progress",
    attachmentCount: 3,
    activeSessionName: "ux-lab",
    createdAt: "2026-08-01T12:00:00Z",
    updatedAt: "2026-08-16T12:00:00Z",
  },
  {
    id: "ticket-138",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 138,
    title: "Ticket list ranking ignores status",
    workType: "bug",
    status: "blocked",
    attachmentCount: 1,
    activeSessionName: null,
    createdAt: "2026-08-01T12:00:00Z",
    updatedAt: "2026-08-14T12:00:00Z",
  },
  {
    id: "ticket-097",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 97,
    title: "File scanner truncation flag",
    workType: "tech_debt",
    status: "done",
    attachmentCount: 2,
    activeSessionName: null,
    createdAt: "2026-07-01T12:00:00Z",
    updatedAt: "2026-07-20T12:00:00Z",
  },
];

const specs: SpecPickerSpec[] = [
  {
    projectName: "command-center",
    specId: "spec-prompt-autocomplete",
    slug: "prompt-autocomplete",
    name: "Prompt input reference picker",
    revision: 4,
    elements: [
      {
        type: "requirement",
        elementId: "r1",
        handle: "R1",
        name: "Unified popup shell shared by @ # ! triggers",
        searchText: "Unified popup shell shared by triggers",
      },
      {
        type: "requirement",
        elementId: "r2",
        handle: "R2",
        name: "Tickets default to active statuses",
        searchText: "Tickets default to active statuses",
      },
      {
        type: "decision",
        elementId: "d1",
        handle: "D1",
        name: "Scope tabs over a sectioned list",
        searchText: "Scope tabs over a sectioned list",
      },
      {
        type: "task",
        elementId: "t1",
        handle: "T1",
        name: "Extract the shared picker shell",
        searchText: "Extract the shared picker shell",
      },
    ],
  },
  {
    projectName: "command-center",
    specId: "spec-session-workflows",
    slug: "session-workflows",
    name: "Workflow graph execution",
    revision: 11,
    elements: [],
  },
];

const files = [
  { path: "src/components/session/prompt/PromptEditor.tsx" },
  { path: "src/components/session/prompt/ReferencePickerPopup.tsx" },
  { path: "src/components/ui/Autocomplete.tsx" },
  { path: "src/lib/prompt-editor/reference-picker.ts" },
  { path: "src/lib/tickets/ticket-autocomplete-filter.ts" },
  { path: "docs/reports/combobox-autocomplete-decision.md" },
];

const notepads: NotepadListItem[] = [
  {
    id: "np-working-context",
    scope: "project",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    name: "slice-1 working context",
    revision: 12,
    writeMode: "full-edit",
    pinned: true,
    archived: false,
    createdAt: "2026-08-01T12:00:00Z",
    updatedAt: "2026-08-16T09:30:00Z",
  },
  {
    id: "np-house-rules",
    scope: "global",
    projectPath: null,
    projectName: null,
    name: "Standing house rules",
    revision: 4,
    writeMode: "read-only",
    pinned: false,
    archived: false,
    createdAt: "2026-06-02T12:00:00Z",
    updatedAt: "2026-08-10T18:05:00Z",
  },
  {
    id: "np-review-log",
    scope: "project",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    name: "Review findings log",
    revision: 31,
    writeMode: "append-only",
    pinned: false,
    archived: false,
    createdAt: "2026-07-11T12:00:00Z",
    updatedAt: "2026-08-15T14:20:00Z",
  },
];

const idle = { isLoading: false, isError: false, error: null } as const;

const Popup = createReferencePickerPopup({
  useAllConversations: () => ({ data: conversations, ...idle }),
  useTickets: () => ({ data: tickets, ...idle }),
  useSpecs: () => ({ data: specs, ...idle }),
  useFiles: () => ({ data: { items: files }, ...idle }),
  useExecutions: () => ({ data: [], ...idle }),
  useNotepads: () => ({ data: notepads, ...idle }),
});

function Demo({
  trigger,
  query,
}: {
  trigger: PickerTrigger;
  query: string;
}): React.JSX.Element {
  return (
    <div className="mx-auto mt-[460px] max-w-[720px]">
      <div className="relative">
        <Popup
          trigger={trigger}
          query={query}
          currentProjectName="command-center"
          scopeRef={{ scope: "session", sessionName: "ux-lab" }}
          currentConversationId="storybook-current"
          onSelect={() => {}}
          onComplete={() => {}}
          isCaretAtQueryEnd={() => true}
        />
        <div className="min-h-[80px] rounded-md border border-border-default bg-bg-surface px-[14px] py-[12px] font-mono text-[0.85rem] text-text-primary">
          {trigger}
          {query}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Session/PromptEditor/ReferencePickerPopup",
  component: Demo,
  args: { trigger: "#" as PickerTrigger, query: "" },
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** `#` opens every scope, each section capped with a jump row. */
export const AllScopes = {} satisfies Story;

/** `@` preselects files; Tab still reaches every other scope. */
export const FileScope = {
  args: { trigger: "@" as PickerTrigger, query: "picker" },
} satisfies Story;

/** `!` preselects tickets, active-only, with the done count on a header chip. */
export const TicketScope = {
  args: { trigger: "!" as PickerTrigger },
} satisfies Story;

/** A multi-word query — the reason the picker survives a space. */
export const MultiWordQuery = {
  args: { query: "auth token refresh" },
} satisfies Story;

/** `<slug>/` turns the tabs into the spec's element kinds. */
export const SpecDrillIn = {
  args: { query: "prompt-autocomplete/" },
} satisfies Story;
