import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Spinner, type SpinnerSize } from "./Spinner";

const meta = {
  title: "UI/Spinner",
  component: Spinner,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

const sizes: SpinnerSize[] = ["md", "sm"];

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      {sizes.map((size) => (
        <Spinner key={size} size={size} />
      ))}
    </div>
  ),
};

/** inherit tone follows the surrounding text color. */
export const InheritTone: Story = {
  render: () => (
    <span
      style={{
        display: "inline-flex",
        gap: 8,
        alignItems: "center",
        color: "var(--green)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.78rem",
      }}
    >
      <Spinner size="sm" tone="inherit" /> Working…
    </span>
  ),
};
