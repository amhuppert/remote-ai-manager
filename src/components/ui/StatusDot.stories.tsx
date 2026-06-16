import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { StatusDot, type StatusDotTone } from "./StatusDot";

const meta = {
  title: "UI/StatusDot",
  component: StatusDot,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

const tones: StatusDotTone[] = ["green", "cyan", "amber", "warning"];

/** Every tone (all pulse; cyan/amber/warning override only the color + glow). */
export const Tones: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 12 }}>
      {tones.map((tone) => (
        <div
          key={tone}
          style={{ display: "flex", gap: 10, alignItems: "center" }}
        >
          <StatusDot tone={tone} />
          <span
            style={{
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
            }}
          >
            {tone}
          </span>
        </div>
      ))}
    </div>
  ),
};

/** layoutClassName nudges the dot's placement (external geometry only). */
export const LayoutPlacement: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: "0.75rem",
        color: "var(--text-secondary)",
      }}
    >
      <StatusDot tone="cyan" layoutClassName="mr-2" />
      Active session
    </div>
  ),
};
