import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { MessageMentionAttrs } from "@/lib/prompt-editor";

const MAX_LABEL_LENGTH = 40;

function truncate(label: string): string {
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return label.slice(0, MAX_LABEL_LENGTH - 1) + "…";
}

interface ChipPreviewProps {
  attrs: MessageMentionAttrs;
  selected?: boolean;
}

// Mirrors the real MessageMentionChip.tsx utility recipe (it is a Tiptap
// NodeView, not directly renderable in a story) so this preview stays faithful.
function ChipPreview({
  attrs,
  selected = false,
}: ChipPreviewProps): React.JSX.Element {
  const conversationLabel =
    attrs.conversationName.length > 0
      ? attrs.conversationName
      : attrs.conversationId;
  const label = truncate(`${conversationLabel} · msg ${attrs.messageIndex}`);
  const tooltip = [attrs.projectName, attrs.sessionName]
    .filter((part) => part.length > 0)
    .join(" · ");

  return (
    <span
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised py-[2px] pr-[4px] pl-[6px] align-baseline font-mono text-[0.78rem] leading-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] data-[selected=true]:border-cyan-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] max-768:min-h-[28px] max-768:py-[4px] max-768:pr-[6px] max-768:pl-[8px]"
      data-selected={selected ? "true" : "false"}
      title={tooltip}
    >
      <span className="font-semibold text-cyan">#</span>
      <span className="text-text-primary">{label}</span>
      <button
        type="button"
        className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
        aria-label={`Remove reference to message ${attrs.messageIndex}`}
      >
        &times;
      </button>
    </span>
  );
}

const baseAttrs: MessageMentionAttrs = {
  projectName: "my-app",
  sessionName: "main",
  conversationId: "conv-123",
  conversationName: "Refactor parser",
  messageIndex: "5",
  role: "assistant",
  timestamp: "2026-07-06T12:00:00Z",
  model: "opus",
  compacted: "true",
  compactArtifactId: "art-1",
  compactCreatedAt: "2026-07-05T10:30:00Z",
};

const meta = {
  title: "Components/MessageMentionChip",
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

export const UnnamedConversation = {
  args: {
    attrs: { ...baseAttrs, conversationName: "", compacted: "false" },
  },
} satisfies Story;

export const Truncated = {
  args: {
    attrs: {
      ...baseAttrs,
      conversationName:
        "Investigate intermittent flaky test in the orchestrator integration suite",
    },
  },
} satisfies Story;
