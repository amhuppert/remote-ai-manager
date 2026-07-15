import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { resolveDisplayLabel } from "@/lib/conversations/display-label";
import type { ConversationMentionAttrs } from "@/lib/prompt-editor";
import { truncate } from "@/lib/shared/truncate";

const MAX_LABEL_LENGTH = 40;

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
    MAX_LABEL_LENGTH,
    { countEllipsisInBudget: true },
  );
  const removeAriaTarget =
    attrs.conversationName.length > 0
      ? attrs.conversationName
      : attrs.conversationId;

  // Mirrors the real ConversationMentionChip.tsx utility recipe (it is a Tiptap
  // NodeView, not directly renderable in a story) so this preview stays faithful
  // after the conversation-surfaces migration.
  return (
    <span
      className="inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised py-[2px] pr-[4px] pl-[6px] align-baseline font-mono text-[0.78rem] leading-none [transition:border-color_0.15s_ease,box-shadow_0.15s_ease] data-[backend=codex]:border-violet-dim data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)] data-[backend=claude]:data-[selected=true]:border-cyan-dim max-768:min-h-[28px] max-768:py-[4px] max-768:pr-[6px] max-768:pl-[8px]"
      data-selected={selected ? "true" : "false"}
      data-backend={attrs.backend}
      title={`${attrs.projectName} · ${attrs.sessionName}`}
    >
      <span className="font-semibold text-cyan">#</span>
      <span className="text-text-primary">{label}</span>
      <button
        type="button"
        className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text max-768:min-h-[24px] max-768:min-w-[24px]"
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
  compactArtifactId: "",
  compactStatus: "none",
  compactCoveredSeq: "",
  compactCreatedAt: "",
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
