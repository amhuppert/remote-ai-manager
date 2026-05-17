import type { Meta, StoryObj } from "@storybook/nextjs-vite";

const TypographyHelpers = () => (
  <div
    style={{
      padding: "var(--space-xl)",
      display: "flex",
      flexDirection: "column",
      gap: "var(--space-xl)",
      maxWidth: "720px",
    }}
  >
    <section>
      <p className="cc-meta-label" style={{ marginBottom: "var(--space-sm)" }}>
        Display recipes
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-md)",
        }}
      >
        <h1 className="cc-page-title">Page title</h1>
        <p className="cc-page-subtitle">
          Page subtitle — mono, secondary text.
        </p>
        <p className="cc-logo">CC</p>
        <p className="cc-modal-title">Modal title</p>
        <p className="cc-empty-title">Empty-state title</p>
      </div>
    </section>

    <section>
      <p className="cc-meta-label" style={{ marginBottom: "var(--space-sm)" }}>
        Body and prose
      </p>
      <p className="cc-prose">
        Conversation message body rendered in the body font. Used only for
        message content; everything else stays in mono. Long-form prose reads
        with 1.65 line-height for comfortable reading.
      </p>
    </section>

    <section>
      <p className="cc-meta-label" style={{ marginBottom: "var(--space-sm)" }}>
        Labels and chrome
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-sm)",
        }}
      >
        <span className="cc-section-label">section label</span>
        <span className="cc-meta-label">meta label</span>
        <button
          type="button"
          className="cc-button-text"
          style={{
            background: "transparent",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
            padding: "6px 12px",
            borderRadius: "var(--radius-md)",
          }}
        >
          Button text
        </button>
      </div>
    </section>

    <section>
      <p className="cc-meta-label" style={{ marginBottom: "var(--space-sm)" }}>
        Code
      </p>
      <p>
        Inline: <code className="cc-inline-code">var(--space-xl)</code> renders
        24px on the canonical scale.
      </p>
      <pre
        className="cc-code-block"
        style={{ marginTop: "var(--space-sm)" }}
      >{`.cc-card {
  padding: var(--space-xl);
  background: var(--bg-surface);
}`}</pre>
      <pre className="cc-diff" style={{ marginTop: "var(--space-sm)" }}>
        {`+ added line
- removed line
  context line`}
      </pre>
    </section>

    <section>
      <p className="cc-meta-label" style={{ marginBottom: "var(--space-sm)" }}>
        Color utilities
      </p>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-xs)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.85rem",
        }}
      >
        <span className="text-primary">text-primary</span>
        <span className="text-secondary">text-secondary</span>
        <span className="text-tertiary">text-tertiary</span>
        <span className="text-cyan">text-cyan</span>
        <span className="text-amber">text-amber</span>
        <span className="text-green">text-green</span>
        <span className="text-red">text-red</span>
        <span className="text-violet">text-violet</span>
      </div>
    </section>
  </div>
);

const meta = {
  title: "Design System/Typography Helpers",
  component: TypographyHelpers,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof TypographyHelpers>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllHelpers: Story = {};
