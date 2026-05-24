import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import WorkflowCanvasShell from "./WorkflowCanvasShell";
import OptimisticLayout from "../layouts/OptimisticLayout";
import ConversationLayout from "../layouts/ConversationLayout";
import RetryLayout from "../layouts/RetryLayout";

const meta = {
  title: "Workflows/WorkflowCanvasShell",
  component: WorkflowCanvasShell,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    title: "Optimistic",
    character: "linear",
    index: 4,
    total: 5,
    prev: { name: "Smart Commit", href: "#" },
    next: { name: "Retry", href: "#" },
    onPrev: fn(),
    onNext: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          height: "100vh",
          width: "100%",
          padding: "16px",
          background: "var(--bg-void)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 360px",
            gap: "12px",
          }}
        >
          <Story />
          <aside
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-lg)",
              padding: "16px",
              fontFamily: "var(--font-mono)",
              fontSize: "0.78rem",
              color: "var(--text-secondary)",
              overflow: "auto",
            }}
          >
            <div
              style={{
                fontSize: "var(--font-size-floor)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--text-tertiary)",
                marginBottom: "8px",
              }}
            >
              About this workflow
            </div>
            <p
              style={{
                margin: 0,
                color: "var(--text-secondary)",
                fontFamily: "var(--font-body)",
              }}
            >
              Detail rail goes here — actors, guards, actions, and
              selected-state info. Renders alongside the canvas shell at desktop
              widths.
            </p>
          </aside>
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowCanvasShell>;

export default meta;
type Story = StoryObj<typeof meta>;

function OptimisticDemo(): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <OptimisticLayout
      selectedStateId={selected}
      onSelectState={(id) =>
        setSelected((current) => (current === id ? null : id))
      }
    />
  );
}

function ConversationDemo(): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <ConversationLayout
      selectedStateId={selected}
      onSelectState={(id) =>
        setSelected((current) => (current === id ? null : id))
      }
    />
  );
}

function RetryDemo(): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <RetryLayout
      selectedStateId={selected}
      onSelectState={(id) =>
        setSelected((current) => (current === id ? null : id))
      }
    />
  );
}

export const SmallCanvas = {
  args: {
    title: "Optimistic",
    character: "linear",
    index: 4,
    total: 5,
    prev: { name: "Smart Commit", href: "#" },
    next: { name: "Retry", href: "#" },
    children: <OptimisticDemo />,
  },
} satisfies Story;

export const LargeCanvas = {
  args: {
    title: "Conversation",
    character: "hierarchical",
    index: 1,
    total: 5,
    prev: undefined,
    next: { name: "Smart Merge", href: "#" },
    children: <ConversationDemo />,
  },
} satisfies Story;

export const FirstWorkflow = {
  args: {
    title: "Conversation",
    character: "hierarchical",
    index: 1,
    total: 5,
    prev: undefined,
    next: { name: "Smart Merge", href: "#" },
    children: <ConversationDemo />,
  },
} satisfies Story;

export const LastWorkflow = {
  args: {
    title: "Retry",
    character: "loop",
    index: 5,
    total: 5,
    prev: { name: "Optimistic", href: "#" },
    next: undefined,
    children: <RetryDemo />,
  },
} satisfies Story;
