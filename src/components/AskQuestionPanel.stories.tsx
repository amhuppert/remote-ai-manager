import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { ReactNode } from "react";
import AskQuestionPanel from "./AskQuestionPanel";
import type { AskQuestionItem } from "@/lib/conversations/schemas";

const SAMPLE_QUESTIONS: AskQuestionItem[] = [
  {
    id: "storage",
    header: "Architecture",
    required: true,
    multiSelect: false,
    allowNote: true,
    question: "Which backing store should the new conversation cache use?",
    context:
      "The cache holds decoded `conversationState` for hot sessions so we avoid re-reading transcripts on every poll. Expected working set is **2–5k sessions**, read-heavy.\n- We already ship `better-sqlite3` for the session index.\n- Redis would add a new runtime dependency to the self-host story.",
    options: [
      {
        label: "SQLite (WAL mode)",
        description:
          "Embedded, zero new infra. Reuses the session-index connection.",
        recommended: true,
        tradeoff: {
          pro: "No new dependency; survives restart on disk.",
          con: "Single-writer; cross-process writes need care.",
        },
      },
      {
        label: "Redis",
        description: "Separate process, TTL eviction for free.",
        recommended: false,
        tradeoff: {
          pro: "Best multi-process story + native TTL.",
          con: "New dependency the self-host install must run.",
        },
      },
      {
        label: "In-memory LRU only",
        description: "Plain Map with an LRU cap. Fastest, cold on restart.",
        recommended: false,
        tradeoff: { con: "Cold-start stampede after every daemon restart." },
      },
    ],
  },
  {
    id: "migration",
    header: "Rollout",
    required: true,
    multiSelect: false,
    allowNote: true,
    question: "How should we migrate existing sessions onto the new cache?",
    context:
      "There are ~38k persisted sessions in the field. Dual-write lets us roll forward safely and roll back without data loss.",
    options: [
      {
        label: "Dual-write, lazy backfill",
        description: "Write both paths; backfill on first read.",
        recommended: true,
        tradeoff: { pro: "Zero downtime, trivially reversible." },
      },
      {
        label: "Big-bang on next startup",
        description: "Migrate everything once on the first boot.",
        recommended: false,
        tradeoff: {
          con: "First boot after update is slow; hard to roll back.",
        },
      },
    ],
  },
  {
    id: "legacy",
    header: "Compatibility",
    required: false,
    multiSelect: true,
    allowNote: true,
    question: "Which legacy read paths should we keep during the transition?",
    context:
      "Selecting more paths is safer but slows the cleanup and keeps dead code around.",
    options: [
      {
        label: "Direct transcript reader",
        description: "Used by the export + debug-bundle tooling.",
        recommended: true,
      },
      {
        label: "`/v1/conversation` REST endpoint",
        description: "Hit by the VS Code extension < 2.4.",
        recommended: true,
      },
      {
        label: "Legacy websocket frame format",
        description: "No known consumers; likely safe to drop.",
        recommended: false,
      },
    ],
  },
  {
    id: "naming",
    header: "Polish",
    required: false,
    multiSelect: false,
    allowNote: true,
    question: "What should we call the new module?",
    context:
      "Lowest-stakes question — answer with a note, or skip for the suggestion.",
    options: [
      { label: "ConversationCache", recommended: true },
      { label: "SessionStateStore", recommended: false },
      { label: "HotConvoIndex", recommended: false },
    ],
  },
];

function Stage({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: compact ? 400 : 900,
        height: compact ? 640 : 600,
        background: "var(--bg-void)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "var(--space-lg)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.78rem",
          color: "var(--text-tertiary)",
        }}
      >
        (conversation transcript renders here — the panel overlays it)
      </div>
      {children}
    </div>
  );
}

const meta = {
  title: "Components/AskQuestionPanel",
  component: AskQuestionPanel,
  args: {
    questionId: "batch-1",
    currentIndex: 0,
    onNavigate: fn(),
    onSubmit: fn(),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof AskQuestionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RailAndDetail: Story = {
  args: { questions: SAMPLE_QUESTIONS },
  decorators: [
    (Story) => (
      <Stage>
        <Story />
      </Stage>
    ),
  ],
};

export const SingleQuestion: Story = {
  args: { questions: [SAMPLE_QUESTIONS[0] as AskQuestionItem] },
  decorators: [
    (Story) => (
      <Stage>
        <Story />
      </Stage>
    ),
  ],
};

export const CompactPager: Story = {
  args: { questions: SAMPLE_QUESTIONS, compact: true },
  decorators: [
    (Story) => (
      <Stage compact>
        <Story />
      </Stage>
    ),
  ],
};

export const CodexAccent: Story = {
  args: { questions: SAMPLE_QUESTIONS, agent: "codex" },
  decorators: [
    (Story) => (
      <Stage>
        <Story />
      </Stage>
    ),
  ],
};

export const AllOptional: Story = {
  args: {
    questions: SAMPLE_QUESTIONS.map((q) => ({ ...q, required: false })),
  },
  decorators: [
    (Story) => (
      <Stage>
        <Story />
      </Stage>
    ),
  ],
};
