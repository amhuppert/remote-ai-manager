import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";
import type { ConversationMentionAttrs } from "@/lib/prompt-editor";

const MAX_LABEL_LENGTH = 40;

function truncate(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return label.slice(0, MAX_LABEL_LENGTH - 1) + "…";
}

interface ChipPreviewProps {
  attrs: ConversationMentionAttrs;
  selected?: boolean;
}

function ChipPreview({
  attrs,
  selected = false,
}: ChipPreviewProps): React.JSX.Element {
  const label = truncate(
    resolveDisplayLabel({
      conversationName:
        attrs.conversationName.length > 0 ? attrs.conversationName : null,
      summary: null,
      firstPromptSnippet: null,
      conversationId: attrs.conversationId,
    }),
  );
  const removeAriaTarget =
    attrs.conversationName.length > 0
      ? attrs.conversationName
      : attrs.conversationId;

  return (
    <span
      className="conversation-mention-chip"
      data-selected={selected ? "true" : "false"}
      data-backend={attrs.backend}
      title={`${attrs.projectName} · ${attrs.sessionName}`}
    >
      <span className="conversation-mention-chip__hash">#</span>
      <span className="conversation-mention-chip__name">{label}</span>
      <button
        type="button"
        className="conversation-mention-chip__remove"
        aria-label={`Remove #${removeAriaTarget}`}
      >
        &times;
      </button>
    </span>
  );
}

const baseAttrs: ConversationMentionAttrs = {
  projectName: "my-app",
  projectPath: "/repos/my-app",
  sessionName: "main",
  worktreePath: "/repos/my-app/.worktrees/main",
  conversationId: "conv-123",
  conversationName: "Refactor parser",
  backend: "claude",
  backendRef: "claude-sess-abc",
  transcriptPath: "/t/conv-123.jsonl",
  debugLogPath: "",
  status: "running",
  lastActivityAt: "2024-06-01T12:00:00Z",
};

const meta = {
  title: "Components/ConversationMentionChip",
  component: ChipPreview,
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-md)",
          padding: "var(--space-md) var(--space-lg)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ChipPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: { attrs: baseAttrs, selected: false },
} satisfies Story;

export const Selected = {
  args: { attrs: baseAttrs, selected: true },
} satisfies Story;

export const Truncated = {
  args: {
    attrs: {
      ...baseAttrs,
      conversationName:
        "Investigate intermittent flaky test in the orchestrator integration suite for the backend",
    },
  },
} satisfies Story;
