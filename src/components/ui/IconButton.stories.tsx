import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { IconButton } from "./IconButton";

/** Inline glyph that exercises the primitive's `& svg` sizing/colour rules. */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" strokeLinecap="round" />
    </svg>
  );
}

const meta = {
  title: "UI/IconButton",
  component: IconButton,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
  args: { onClick: fn() },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
};
const labelStyle: React.CSSProperties = {
  width: 96,
  color: "var(--text-tertiary)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.7rem",
};

/** Every variant × size × state — the parity matrix later waves verify against. */
export const Matrix: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 18 }}>
      <div style={rowStyle}>
        <span style={labelStyle}>square md</span>
        <IconButton variant="square" aria-label="Settings">
          <GearIcon />
        </IconButton>
        <IconButton variant="square" tone="danger" aria-label="Delete">
          <GearIcon />
        </IconButton>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>square touch</span>
        <IconButton variant="square" size="touch" aria-label="Settings">
          <GearIcon />
        </IconButton>
        <IconButton
          variant="square"
          size="touch"
          tone="danger"
          aria-label="Delete"
        >
          <GearIcon />
        </IconButton>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>pill</span>
        <IconButton variant="pill">
          <GearIcon />
          <span>Settings</span>
        </IconButton>
        <IconButton variant="pill" pressed>
          <GearIcon />
          <span>Active</span>
        </IconButton>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>ghost</span>
        <IconButton variant="ghost" aria-label="Pin project">
          <span>☆</span>
        </IconButton>
        <IconButton variant="ghost" pressed aria-label="Unpin project">
          <span>★</span>
        </IconButton>
      </div>
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    variant: "square",
    disabled: true,
    "aria-label": "Settings",
    children: <GearIcon />,
  },
};

/**
 * Proves the layout-only `layoutClassName` slot: a parent-positioned container
 * replicating `.cc-page-actions .cc-ibtn` (legacy `display:flex; gap; align`)
 * places the pill controls from the outside. `ml-auto` pushes a control to the
 * right edge and `grow`/`self-stretch` reflow it — all external geometry only —
 * while the pill keeps its own appearance (border/colour/radius) untouched.
 *
 * NOTE: the legacy mobile rule `.cc-page-actions .cc-ibtn { height/min-height:
 * 44px; justify-content:center }` is only partly expressible through the slot —
 * `flex:1`→`grow` and `align-self`→`self-*` are allowed, but height and
 * justify-content are NOT in the layoutClassName allowlist. The owning wave must
 * apply those via the parent's own utilities (see docs/tailwind-conventions.md).
 */
export const LayoutPlacement: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: 420,
        padding: 12,
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
      }}
    >
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.78rem",
        }}
      >
        Project
      </span>
      <IconButton variant="pill" layoutClassName="ml-auto">
        <GearIcon />
        <span>Workflows</span>
      </IconButton>
      <IconButton variant="pill" pressed layoutClassName="self-stretch">
        <GearIcon />
        <span>New</span>
      </IconButton>
    </div>
  ),
};
