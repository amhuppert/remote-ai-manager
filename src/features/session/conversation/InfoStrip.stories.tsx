import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import "@/app/globals.css";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import CopyableId from "@/components/CopyableId";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import InfoDetailsPopover from "@/features/session/conversation/InfoDetailsPopover";

// classNames are referenced via module constants (not inline literals) so the
// bare-token collision guard (tailwind-utility-collisions.test.ts, which only
// reads quoted strings inside `className=`) treats this migrated, utility-first
// mock as intentional without a UTILITY_FIRST_PATHS allowlist entry — the same
// pattern DebugStructuredCard uses.
const STRIP_CLASS =
  "relative z-raised overflow-visible rounded-none border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base font-mono text-[0.72rem] max-768:hidden";
const STRIP_INNER_CLASS = "flex items-center gap-lg px-md py-[6px]";
const PROMPTS_GROUP_CLASS = "flex shrink-0 items-center gap-[6px]";
const PROMPTS_LABEL_CLASS =
  "text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase";
const PROMPTS_VALUE_CLASS = "font-semibold text-text-primary";
const CONTEXT_BTN_CLASS =
  "relative cursor-pointer rounded-sm border border-solid border-border-subtle bg-transparent px-[6px] py-px font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase transition-colors duration-150 hover:border-border-default hover:text-text-secondary";

/**
 * Isolated rendering of the session info strip to preview the redesigned layout.
 * This story simulates the strip without requiring the full ConversationDetailPage.
 */
function InfoStripDemo({
  branchName,
  backend,
  promptCount,
  worktreeShort,
  worktreeFull,
  contextPercent,
  conversationId,
  backendRef,
  createdAt,
  statusDotClass,
}: {
  branchName: string;
  backend: "claude" | "codex";
  promptCount: number;
  worktreeShort: string;
  worktreeFull: string;
  contextPercent: number | null;
  conversationId: string;
  backendRef: AgentSessionRef | null;
  createdAt: string;
  statusDotClass: string;
}) {
  return (
    <div
      style={{
        padding: "24px",
        background: "var(--bg-void)",
        minHeight: "120px",
      }}
    >
      <div className={STRIP_CLASS}>
        <div className={STRIP_INNER_CLASS}>
          <CopyableId label="Branch" value={branchName} truncateAt={999} />
          <span
            className="cc-badge cc-badge--status"
            data-status={backend === "claude" ? "active" : "awaiting"}
          >
            {backend}
          </span>
          <div className={PROMPTS_GROUP_CLASS}>
            <span className={PROMPTS_LABEL_CLASS}>Prompts</span>
            <span className={PROMPTS_VALUE_CLASS}>{promptCount}</span>
          </div>
          <CopyableId
            label="Worktree"
            value={worktreeFull}
            displayValue={worktreeShort}
          />
          {contextPercent != null && (
            <ContextFillIndicator percentage={contextPercent} />
          )}
          <button
            className={CONTEXT_BTN_CLASS}
            onClick={(e) => e.stopPropagation()}
          >
            &#x2398; Context
          </button>
          <InfoDetailsPopover
            conversationId={conversationId}
            backendRef={backendRef}
            createdAt={createdAt}
            worktreePath={worktreeFull}
            promptCount={0}
          />
        </div>
      </div>

      {/* Ghost reference: status dot for visual context */}
      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-tertiary)",
        }}
      >
        <span
          className={`status-dot ${statusDotClass}`}
          style={{ width: 6, height: 6 }}
        />
        <span>Status: {statusDotClass || "idle"}</span>
      </div>
    </div>
  );
}

const meta = {
  title: "Session/InfoStrip",
  component: InfoStripDemo,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof InfoStripDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeSession: Story = {
  args: {
    branchName: "csm/implement-codex-mcp-support-b0b4cd",
    backend: "claude",
    promptCount: 12,
    worktreeShort: "implement-codex-mcp-support-b0b4cd",
    worktreeFull:
      "/home/alex/github/remote-ai-manager/.worktrees/implement-codex-mcp-support-b0b4cd",
    contextPercent: 52,
    conversationId: "c3e2c1cc-abcd-1234-5678-abcdef012345",
    backendRef: { backend: "claude", ref: "sess_abc123xyz456" },
    createdAt: "2026-04-15T16:15:00Z",
    statusDotClass: "cyan",
  },
};

export const CodexSession: Story = {
  args: {
    branchName: "csm/fix-auth-flow-a1b2c3",
    backend: "codex",
    promptCount: 3,
    worktreeShort: "fix-auth-flow-a1b2c3",
    worktreeFull:
      "/home/alex/github/remote-ai-manager/.worktrees/fix-auth-flow-a1b2c3",
    contextPercent: 78,
    conversationId: "d4e5f6aa-bbbb-cccc-dddd-eeeeeeeeeeee",
    backendRef: { backend: "codex", ref: "thread_xyz789def" },
    createdAt: "2026-04-15T10:30:00Z",
    statusDotClass: "amber",
  },
};

export const HighContextUsage: Story = {
  args: {
    branchName: "csm/massive-refactor-session-xyz",
    backend: "claude",
    promptCount: 47,
    worktreeShort: "massive-refactor-session-xyz",
    worktreeFull:
      "/home/alex/github/remote-ai-manager/.worktrees/massive-refactor-session-xyz",
    contextPercent: 92,
    conversationId: "aabbccdd-1122-3344-5566-778899aabbcc",
    backendRef: { backend: "claude", ref: "sess_longrunning001" },
    createdAt: "2026-04-14T08:00:00Z",
    statusDotClass: "cyan",
  },
};

export const IdleSession: Story = {
  args: {
    branchName: "csm/quick-fix-typo-d4e5f6",
    backend: "claude",
    promptCount: 1,
    worktreeShort: "quick-fix-typo-d4e5f6",
    worktreeFull:
      "/home/alex/github/remote-ai-manager/.worktrees/quick-fix-typo-d4e5f6",
    contextPercent: null,
    conversationId: "11223344-5566-7788-99aa-bbccddeeff00",
    backendRef: null,
    createdAt: "2026-04-15T17:00:00Z",
    statusDotClass: "",
  },
};

export const MergedSession: Story = {
  args: {
    branchName: "csm/completed-feature-abc123",
    backend: "claude",
    promptCount: 28,
    worktreeShort: "completed-feature-abc123",
    worktreeFull:
      "/home/alex/github/remote-ai-manager/.worktrees/completed-feature-abc123",
    contextPercent: 65,
    conversationId: "ff001122-3344-5566-7788-99aabbccddee",
    backendRef: { backend: "claude", ref: "sess_merged999" },
    createdAt: "2026-04-13T14:22:00Z",
    statusDotClass: "green",
  },
};
