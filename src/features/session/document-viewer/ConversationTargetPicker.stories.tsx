import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { createConversationTargetPicker } from "./ConversationTargetPicker";
import { targetFromConversation } from "./use-conversation-target";
import type { ConversationListItem } from "@/lib/conversations/schemas";
import type { DocumentFeedbackTarget } from "@/lib/document-comments/schemas";

function conv(
  overrides: Partial<ConversationListItem> & { conversationId: string },
): ConversationListItem {
  return {
    projectName: overrides.projectName ?? "command-center",
    projectPath: overrides.projectPath ?? "/abs/command-center",
    sessionName: overrides.sessionName ?? "main",
    worktreePath: overrides.worktreePath ?? "/abs/command-center",
    conversationId: overrides.conversationId,
    conversationName: overrides.conversationName ?? null,
    summary: overrides.summary ?? null,
    firstPromptSnippet: overrides.firstPromptSnippet ?? null,
    backend: overrides.backend ?? "claude",
    backendRef: overrides.backendRef ?? null,
    transcriptPath: overrides.transcriptPath ?? null,
    debugLogPath: overrides.debugLogPath ?? null,
    status: overrides.status ?? "awaiting",
    lastActivityAt: overrides.lastActivityAt ?? "2026-06-27T10:00:00.000Z",
    archived: overrides.archived ?? false,
  };
}

const ITEMS: ConversationListItem[] = [
  conv({
    conversationId: "c-review",
    conversationName: "Markdown viewer review",
    status: "running",
  }),
  conv({
    conversationId: "c-plan",
    conversationName: "Anchoring design",
    sessionName: "anchoring",
  }),
  conv({
    conversationId: "c-other",
    conversationName: "Sidebar refactor",
    projectName: "design-system",
    projectPath: "/abs/design-system",
    sessionName: "sidebar",
    backend: "codex",
  }),
];

const StoryPicker = createConversationTargetPicker({
  useAllConversations: () => ({
    data: { items: ITEMS, totalCount: ITEMS.length },
    isLoading: false,
    isError: false,
  }),
});

const meta = {
  title: "Session/DocumentViewer/ConversationTargetPicker",
  component: StoryPicker,
  decorators: [
    (Story) => (
      <div
        style={{
          padding: 24,
          background: "var(--bg-base)",
          minHeight: 480,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StoryPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

function Interactive({
  initialTarget,
  defaultOpen,
}: {
  initialTarget: DocumentFeedbackTarget | null;
  defaultOpen?: boolean;
}): React.JSX.Element {
  const [target, setTarget] = useState<DocumentFeedbackTarget | null>(
    initialTarget,
  );
  return (
    <StoryPicker
      target={target}
      onSelect={setTarget}
      docProjectName="command-center"
      defaultOpen={defaultOpen}
    />
  );
}

export const NoSelection: Story = {
  args: { target: null, onSelect: () => {} },
  render: () => <Interactive initialTarget={null} />,
};

export const Preselected: Story = {
  args: { target: null, onSelect: () => {} },
  render: () => (
    <Interactive initialTarget={targetFromConversation(ITEMS[0]!)} />
  ),
};

export const Open: Story = {
  args: { target: null, onSelect: () => {} },
  render: () => <Interactive initialTarget={null} defaultOpen />,
};
