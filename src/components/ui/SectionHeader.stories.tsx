import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  SectionHeader,
  SectionChevron,
  SectionLabel,
  SectionCount,
  SectionActions,
} from "./SectionHeader";
import { Button } from "./Button";

const meta = {
  title: "UI/SectionHeader",
  component: SectionHeader,
  parameters: {
    a11y: { test: "error" },
    layout: "padded",
  },
} satisfies Meta<typeof SectionHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

function Chevron() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Full header: collapse chevron (expanded + collapsed), label, count, trailing actions. */
export const Composed: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 20, width: 360 }}>
      <SectionHeader>
        <SectionChevron>
          <Chevron />
        </SectionChevron>
        <SectionLabel>Sessions</SectionLabel>
        <SectionCount>(3)</SectionCount>
        <SectionActions>
          <Button variant="ghost" size="sm">
            New
          </Button>
        </SectionActions>
      </SectionHeader>

      <SectionHeader>
        <SectionChevron collapsed>
          <Chevron />
        </SectionChevron>
        <SectionLabel>Archived</SectionLabel>
        <SectionCount>(0)</SectionCount>
      </SectionHeader>
    </div>
  ),
};

/** layoutClassName offsets the whole header (external geometry only). */
export const LayoutPlacement: Story = {
  render: () => (
    <SectionHeader layoutClassName="ml-4">
      <SectionLabel>Indented</SectionLabel>
      <SectionCount>(1)</SectionCount>
    </SectionHeader>
  ),
};
