import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useLayoutEffect, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { z } from "zod";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { stampedTranscriptMessageSchema } from "@/lib/conversations/schemas";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import PanesGrid from "./PanesGrid";

type StampedTranscriptMessage = z.infer<typeof stampedTranscriptMessageSchema>;

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const now = new Date();
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();

const PROJECT = "command-center";
const SESSION = "panes-mode-fixes";

function makeConversation(
  id: string,
  overrides: Partial<SessionActiveConversation> = {},
): SessionActiveConversation {
  return {
    scope: "session",
    id,
    name: overrides.name ?? `Conversation ${id}`,
    status: overrides.status ?? "running",
    lastActivityAt: overrides.lastActivityAt ?? minutesAgo(3),
    projectName: PROJECT,
    projectPath: `/home/alex/github/${PROJECT}`,
    sessionName: SESSION,
    agentBackend: overrides.agentBackend ?? "claude",
    summary: null,
    pendingQuestion: overrides.pendingQuestion ?? null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    branchName: "csm/panes-mode-fixes",
    worktreePath: `/home/alex/github/${PROJECT}/.worktrees/${SESSION}`,
    lastActivitySummary:
      overrides.lastActivitySummary ?? "Edited three files in src/features.",
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
    ...overrides,
  };
}

function userMsg(seq: number, text: string): StampedTranscriptMessage {
  return {
    seq,
    role: "user",
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

function assistantMsg(seq: number, text: string): StampedTranscriptMessage {
  return {
    seq,
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

function toolMsg(
  seq: number,
  name: string,
  input: Record<string, unknown>,
): StampedTranscriptMessage {
  return {
    seq,
    role: "assistant",
    content: [{ type: "tool_use", name, input }],
    timestamp: null,
  };
}

/** A reasonably long transcript so the pane scrolls and shows full history. */
function sampleTranscript(topic: string): StampedTranscriptMessage[] {
  return [
    userMsg(1, `Let's work on ${topic}. Start by reading the relevant files.`),
    assistantMsg(
      2,
      `On it. I'll begin by mapping the code for **${topic}**, then propose a plan.`,
    ),
    toolMsg(3, "Read", {
      file_path: "src/features/session/panes/PanesGrid.tsx",
    }),
    assistantMsg(
      4,
      "Here's what I found:\n\n1. The toolbar was a grid child.\n2. The panes used a compact tail.\n\nI'll fix both.",
    ),
    userMsg(5, "Sounds right — go ahead."),
    toolMsg(6, "Edit", {
      file_path: "src/features/_root/styles/conversation-panes.css",
    }),
    assistantMsg(
      7,
      '```tsx\n<div className="panes">\n  <PanesToolbar />\n  <div className="panes-grid">{panes}</div>\n</div>\n```\n\nThe toolbar is now a flex sibling, not a grid cell.',
    ),
    assistantMsg(
      8,
      "All tests pass. The panes now render the full transcript with the same `MessageRow` component as the primary panel.",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessProps {
  count: number;
  activeIndex?: number;
  composerFocused?: boolean;
  withBanner?: boolean;
}

function PanesHarness({
  count,
  activeIndex = 0,
  composerFocused = false,
  withBanner = false,
}: HarnessProps) {
  const workingSet = useMemo(() => {
    const titles = [
      "Fix panes layout",
      "Render real messages",
      "Eliminate the flash",
      "Tab strip polish",
      "Composer focus fade",
      "Keyboard shortcuts",
    ];
    return Array.from({ length: count }, (_, i) =>
      makeConversation(`conv-${i + 1}`, {
        name: titles[i] ?? `Conversation ${i + 1}`,
        status:
          withBanner && i === 1
            ? "waiting_for_input"
            : i % 3 === 0
              ? "running"
              : "awaiting",
        pendingQuestion:
          withBanner && i === 1
            ? "Should I collapse the diff panel by default in panes mode?"
            : null,
        lastActivityAt: minutesAgo(2 + i),
      }),
    );
  }, [count, withBanner]);

  const queryClient = useMemo(() => {
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    for (const c of workingSet) {
      qc.setQueryData(
        conversationKeys.messages(c.projectName, c.sessionName, c.id),
        sampleTranscript(c.name ?? c.id),
      );
    }
    return qc;
  }, [workingSet]);

  useLayoutEffect(() => {
    useSessionDetailStore.getState().setComposerFocused(composerFocused);
    return () => useSessionDetailStore.getState().setComposerFocused(false);
  }, [composerFocused]);

  return (
    <QueryClientProvider client={queryClient}>
      <PanesGrid
        workingSet={workingSet}
        activeId={workingSet[activeIndex]?.id ?? ""}
        isAtCap={count >= 6}
        addableConversations={[]}
        onActivate={() => {}}
        onOpenConversation={() => {}}
        onOpenFull={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
        onExit={() => {}}
      />
    </QueryClientProvider>
  );
}

const meta = {
  title: "Session/PanesGrid",
  component: PanesHarness,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          height: 820,
          width: "100%",
          display: "flex",
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PanesHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoPanes: Story = { args: { count: 2, activeIndex: 0 } };
export const ThreePanes: Story = { args: { count: 3, activeIndex: 1 } };
export const FourPanes: Story = { args: { count: 4, activeIndex: 2 } };
export const FivePanes: Story = { args: { count: 5, activeIndex: 0 } };
export const SixPanes: Story = { args: { count: 6, activeIndex: 3 } };
export const WithPendingQuestionBanner: Story = {
  args: { count: 4, activeIndex: 0, withBanner: true },
};
export const ComposerFocusedFade: Story = {
  args: { count: 4, activeIndex: 1, composerFocused: true },
};
