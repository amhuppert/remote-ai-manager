import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { specElementReaderDetailFixture } from "./SpecElementReader.fixtures";
import { SpecElementReader } from "./SpecElementReader";

const meta = {
  title: "Specs/Studio/Element Reader",
  component: SpecElementReader,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-bg-void p-2xl text-text-primary max-768:p-lg">
        <Story />
      </main>
    ),
  ],
  args: {
    detail: specElementReaderDetailFixture(),
    kind: "requirements",
  },
} satisfies Meta<typeof SpecElementReader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Requirements: Story = {};

export const Decisions: Story = {
  args: { kind: "decisions" },
};

export const Tasks: Story = {
  args: { kind: "tasks" },
};

export const ApprovedFallback: Story = {
  args: {
    detail: (() => {
      const detail = specElementReaderDetailFixture();
      detail.currentRevision = null;
      return detail;
    })(),
    kind: "tasks",
  },
};

export const NoRevision: Story = {
  args: {
    detail: (() => {
      const detail = specElementReaderDetailFixture();
      detail.currentRevision = null;
      detail.currentApprovedRevision = null;
      return detail;
    })(),
    kind: "requirements",
  },
};

export const MobileRequirements: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
