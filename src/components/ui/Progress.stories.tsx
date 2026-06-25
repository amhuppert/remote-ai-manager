import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Progress } from "./Progress";

const meta = {
  title: "UI/Progress",
  component: Progress,
  parameters: {
    // Radix exposes the `progressbar` role + aria-value* wiring; a11y violations
    // fail the Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
        color: "var(--text-secondary)",
      }}
    >
      <span style={{ width: 88 }}>{label}</span>
      <div style={{ width: 200 }}>{children}</div>
    </div>
  );
}

/** Determinate bar at a few values; the accent (cyan) tone by default. */
export const Default: Story = {
  args: { value: 64 },
  render: (args) => (
    <Progress {...args} layoutClassName="w-[200px]" aria-label="Download" />
  ),
};

/** Each tone — the same color-by-threshold language as the context-fill meter. */
export const Tones: Story = {
  args: { value: 64 },
  render: () => (
    <div style={{ display: "grid", gap: 14 }}>
      <Row label="accent">
        <Progress
          value={45}
          tone="accent"
          layoutClassName="w-full"
          aria-label="Accent progress"
        />
      </Row>
      <Row label="warning">
        <Progress
          value={68}
          tone="warning"
          layoutClassName="w-full"
          aria-label="Warning progress"
        />
      </Row>
      <Row label="danger">
        <Progress
          value={92}
          tone="danger"
          layoutClassName="w-full"
          aria-label="Danger progress"
        />
      </Row>
    </div>
  ),
};

/** Boundary values clamp to the track. */
export const Thresholds: Story = {
  args: { value: 0 },
  render: () => (
    <div style={{ display: "grid", gap: 14 }}>
      {[0, 25, 50, 75, 100].map((v) => (
        <Row key={v} label={`${v}%`}>
          <Progress
            value={v}
            layoutClassName="w-full"
            aria-label={`Progress ${v}%`}
          />
        </Row>
      ))}
    </div>
  ),
};

/** A non-percentage scale via `max` (e.g. 3 of 5 tasks complete). */
export const CustomMax: Story = {
  args: { value: 3, max: 5 },
  render: (args) => (
    <Progress
      {...args}
      layoutClassName="w-[200px]"
      aria-label="Tasks complete"
    />
  ),
};

/** Indeterminate — `value={null}` carries no `aria-valuenow` and pulses. */
export const Indeterminate: Story = {
  args: { value: null },
  render: (args) => (
    <Progress {...args} layoutClassName="w-[200px]" aria-label="Loading" />
  ),
};
