import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { JsonTree } from "./JsonTree";

const meta = {
  title: "UI/JsonTree",
  component: JsonTree,
  parameters: {
    // a11y enforced: every branch toggle is a native button with
    // aria-expanded/aria-controls from Radix, a canonical cyan focus-visible
    // ring, and an sr-only branch description. "error" fails the Storybook test
    // project on any violation.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof JsonTree>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A captured execution-context output — the shape this primitive was built for. */
const OUTPUT = {
  verdict: "flaky",
  confidence: 0.82,
  retriable: true,
  blockers: ["retry storm in ci/e2e.spec.ts", "missing fixture teardown"],
  evidence: {
    runId: "9f2c41",
    failedAt: "2026-07-30T09:14:22Z",
    attempts: 3,
    owner: null,
  },
};

/**
 * The consumer's bordered surface (e.g. `CapturedOutputSection`). The primitive
 * owns only the rows — the box, the provenance strip, and the section header
 * belong to the feature component around it.
 */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-[420px] overflow-hidden rounded-sm border border-solid border-border-default bg-bg-base">
      {children}
    </div>
  );
}

/** Default: fully expanded. Click / Enter / Space on any branch row folds it. */
export const Expanded: Story = {
  args: { value: OUTPUT },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/** `defaultCollapsedDepth={1}` — the top-level keys read at a glance, nested branches start folded. */
export const CollapsedChildren: Story = {
  args: { value: OUTPUT, defaultCollapsedDepth: 1 },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/** `defaultCollapsedDepth={0}` — the root itself is folded to a one-line summary. */
export const CollapsedRoot: Story = {
  args: { value: OUTPUT, defaultCollapsedDepth: 0 },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/** The copy affordance: writes the pretty-printed JSON, then confirms with "Copied". */
export const Copyable: Story = {
  args: { value: OUTPUT, copyable: true },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/** The thin colour mapping across every scalar kind, plus empty containers. */
export const ValueKinds: Story = {
  args: {
    value: {
      string: "a quoted string",
      number: 42,
      negative: -0.5,
      boolean: true,
      falsy: false,
      nothing: null,
      emptyObject: {},
      emptyArray: [],
    },
  },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/**
 * Lossless encoding: quotes, backslashes and control characters are escaped
 * with JSON semantics, and runs of spaces survive instead of collapsing — so
 * `"a b"` and `"a  b"` stay visibly different and every line parses back to its
 * source value.
 */
export const TrickyStrings: Story = {
  args: {
    value: {
      quoted: 'he said "hi"',
      backslash: "C:\\tmp\\out",
      control: "line1\nline2\ttabbed",
      oneSpace: "a b",
      twoSpaces: "a  b",
      padded: "  leading and trailing  ",
      empty: "",
      'we"ird key': "escaped property name",
    },
  },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/** Arrays render items without key labels; nesting is expressed by indentation. */
export const NestedArrays: Story = {
  args: {
    value: {
      matrix: [
        [1, 2],
        [3, 4],
      ],
      runs: [
        { id: "a", passed: true },
        { id: "b", passed: false },
      ],
    },
  },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/** A deep payload — the second consumer shape (halt failure payloads). */
export const DeepPayload: Story = {
  args: {
    value: {
      halt: {
        reason: "join_conflict",
        at: { iteration: 4, context: "implement-api", task: "task-3" },
        conflict: {
          files: ["src/lib/workflows/graph/engine.ts"],
          markers: 2,
          resolution: { attempted: true, strategy: "rerun", succeeded: false },
        },
      },
    },
    defaultCollapsedDepth: 2,
    copyable: true,
  },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/** A bare scalar: no branch, no toggle — the primitive degrades to one row. */
export const ScalarRoot: Story = {
  args: { value: "no schema fields, just a string" },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};

/**
 * Long values wrap inside the row rather than forcing the container to scroll,
 * so a narrow inspector column stays readable.
 */
export const LongValues: Story = {
  args: {
    value: {
      summary:
        "The e2e suite retried four times before the fixture teardown ran, which left the database seeded between runs and made every downstream assertion order-dependent.",
      path: "src/features/workflow-execution/components/inspector/CapturedOutputSection.tsx",
    },
  },
  render: (args) => (
    <div className="w-[280px] overflow-hidden rounded-sm border border-solid border-border-default bg-bg-base">
      <JsonTree {...args} />
    </div>
  ),
};

/** `layoutClassName` is layout-only: the parent caps the width, appearance is untouched. */
export const LayoutPlacement: Story = {
  args: { value: OUTPUT, layoutClassName: "max-w-[300px]" },
  render: (args) => (
    <Frame>
      <JsonTree {...args} />
    </Frame>
  ),
};
