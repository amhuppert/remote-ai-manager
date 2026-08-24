import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { Button, type ButtonVariant, type ButtonSize } from "./Button";

const meta = {
  title: "UI/Button",
  component: Button,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
  args: { onClick: fn(), children: "Action" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

const variants: ButtonVariant[] = [
  "default",
  "primary",
  "danger",
  "success",
  "ghost",
];
const sizes: ButtonSize[] = ["md", "sm", "touch"];

/** Every variant × size — the parity matrix later waves verify against. */
export const Matrix: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 16 }}>
      {sizes.map((size) => (
        <div
          key={size}
          style={{ display: "flex", gap: 12, alignItems: "center" }}
        >
          <span
            style={{
              width: 40,
              color: "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
            }}
          >
            {size}
          </span>
          {variants.map((variant) => (
            <Button key={variant} variant={variant} size={size}>
              {variant}
            </Button>
          ))}
        </div>
      ))}
    </div>
  ),
};

export const Disabled: Story = {
  args: { variant: "primary", disabled: true, children: "Disabled" },
};

/** Rung-3 pending state: inherit-tone spinner + label, disabled, aria-busy. */
export const Loading: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      {variants.map((variant) => (
        <Button key={variant} variant={variant} loading>
          Saving…
        </Button>
      ))}
    </div>
  ),
};

/** layoutClassName places the button from its container (external geometry only). */
export const LayoutPlacement: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: 320,
        padding: 12,
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
      }}
    >
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
        }}
      >
        Title
      </span>
      <Button variant="primary" layoutClassName="ml-auto">
        Save
      </Button>
    </div>
  ),
};
