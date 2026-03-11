import { useState, useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ContextFillIndicator } from "./ContextFillIndicator";

const meta = {
  title: "Components/ContextFillIndicator",
  component: ContextFillIndicator,
  args: {
    percentage: 42,
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "2rem", background: "var(--bg-void, #06090f)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ContextFillIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

// --- Static stories ---

export const Low: Story = {
  args: { percentage: 25 },
};

export const Medium: Story = {
  args: { percentage: 50 },
};

export const Warning: Story = {
  args: { percentage: 68 },
};

export const Danger: Story = {
  args: { percentage: 88 },
};

export const Full: Story = {
  args: { percentage: 100 },
};

export const Empty: Story = {
  args: { percentage: 0 },
};

// --- All thresholds side by side ---

export const AllThresholds: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div>
        <div
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.58rem",
            color: "var(--text-tertiary, #4d5a72)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "0.5rem",
          }}
        >
          Normal (0-59%)
        </div>
        <ContextFillIndicator percentage={42} />
      </div>
      <div>
        <div
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.58rem",
            color: "var(--text-tertiary, #4d5a72)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "0.5rem",
          }}
        >
          Warning (60-79%)
        </div>
        <ContextFillIndicator percentage={72} />
      </div>
      <div>
        <div
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.58rem",
            color: "var(--text-tertiary, #4d5a72)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "0.5rem",
          }}
        >
          Danger (80-100%)
        </div>
        <ContextFillIndicator percentage={91} />
      </div>
    </div>
  ),
};

// --- In mock info strip context ---

export const InInfoStrip: Story = {
  render: () => (
    <div
      style={{
        background: "var(--bg-surface, #111825)",
        borderRadius: "var(--radius-sm, 4px)",
        border: "1px solid var(--border-subtle, #1a2338)",
        padding: "5px 16px",
        display: "flex",
        alignItems: "center",
        gap: "24px",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "0.68rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
        <span
          style={{
            color: "var(--text-tertiary, #4d5a72)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontSize: "0.58rem",
          }}
        >
          Branch
        </span>
        <span style={{ color: "var(--text-secondary, #7b899f)" }}>
          csm/context-window-indicator
        </span>
      </div>
      <div
        style={{
          width: 1,
          height: 12,
          background: "var(--border-subtle, #1a2338)",
          flexShrink: 0,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
        <span
          style={{
            color: "var(--text-tertiary, #4d5a72)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontSize: "0.58rem",
          }}
        >
          Prompts
        </span>
        <span style={{ color: "var(--text-secondary, #7b899f)" }}>5</span>
      </div>
      <div
        style={{
          width: 1,
          height: 12,
          background: "var(--border-subtle, #1a2338)",
          flexShrink: 0,
        }}
      />
      <ContextFillIndicator percentage={42} />
      <div
        style={{
          width: 1,
          height: 12,
          background: "var(--border-subtle, #1a2338)",
          flexShrink: 0,
        }}
      />
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          background: "none",
          border: "1px solid var(--border-subtle, #1a2338)",
          borderRadius: "var(--radius-sm, 4px)",
          color: "var(--text-tertiary, #4d5a72)",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "0.58rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          padding: "1px 6px",
        }}
      >
        TDD
      </div>
    </div>
  ),
};

// --- Animated fill story ---

function AnimatedFill() {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setPct((prev) => (prev >= 100 ? 0 : prev + 1));
    }, 80);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <ContextFillIndicator percentage={pct} />
      <div
        style={{
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "0.58rem",
          color: "var(--text-tertiary, #4d5a72)",
        }}
      >
        Simulating fill: {pct}%
      </div>
    </div>
  );
}

export const Animated: Story = {
  render: () => <AnimatedFill />,
};
