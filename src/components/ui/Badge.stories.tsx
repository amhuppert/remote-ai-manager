import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Badge, type BadgeStatus, type BadgeKind } from "./Badge";

const meta = {
  title: "UI/Badge",
  component: Badge,
  parameters: {
    // `subtle` is opacity-0.5 by design (legacy `.cc-badge--subtle`, for content
    // redundant with context), which axe flags for faded contrast. That opacity
    // is frozen design-token parity, so a11y stays advisory here ("todo", the
    // project default) rather than failing the Storybook test project on legacy
    // debt. The non-subtle variants are contrast-clean.
    a11y: { test: "todo" },
    layout: "centered",
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

const row: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  flexWrap: "wrap",
};
const label: React.CSSProperties = {
  width: 72,
  color: "var(--text-tertiary)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.7rem",
};

const statuses: BadgeStatus[] = [
  "idle",
  "running",
  "active",
  "merged",
  "ready",
  "awaiting",
  "warning",
];
const kinds: BadgeKind[] = ["feature", "bug", "idea"];

/** All tiers × values + backend + subtle — the full hybrid-API surface. */
export const Matrix: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={row}>
        <span style={label}>status</span>
        {statuses.map((s) => (
          <Badge key={s} status={s}>
            {s}
          </Badge>
        ))}
      </div>
      <div style={row}>
        <span style={label}>type</span>
        {kinds.map((k) => (
          <Badge key={k} tier="type" kind={k}>
            {k}
          </Badge>
        ))}
      </div>
      <div style={row}>
        <span style={label}>count</span>
        <Badge tier="count">2</Badge>
        <Badge tier="count" active>
          5
        </Badge>
      </div>
      <div style={row}>
        <span style={label}>backend</span>
        <Badge backend="claude">claude</Badge>
        <Badge backend="codex">codex</Badge>
      </div>
      <div style={row}>
        <span style={label}>subtle</span>
        <Badge status="running" subtle>
          running
        </Badge>
        <Badge tier="type" kind="bug" subtle>
          bug
        </Badge>
      </div>
    </div>
  ),
};

/** layoutClassName applies external geometry (margin) without touching appearance. */
export const LayoutPlacement: Story = {
  render: () => (
    <div style={row}>
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.75rem",
        }}
      >
        Session
      </span>
      <Badge status="running" layoutClassName="ml-auto">
        Running
      </Badge>
    </div>
  ),
};
