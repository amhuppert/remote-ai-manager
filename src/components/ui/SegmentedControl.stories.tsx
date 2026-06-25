import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SegmentedControl, SegmentedControlItem } from "./SegmentedControl";

const meta = {
  title: "UI/SegmentedControl",
  component: SegmentedControl,
  parameters: {
    // A value picker built on the WAI-ARIA radio-group pattern (NOT Tabs):
    // role=radiogroup/radio, horizontal roving, exactly-one-selected. a11y
    // violations fail the Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two-way mode picker (the ConversationSidebarFilters "Group by" shape). */
export const Default: Story = {
  render: () => {
    const [value, setValue] = useState("project");
    return (
      <SegmentedControl
        aria-label="Group by"
        value={value}
        onValueChange={setValue}
      >
        <SegmentedControlItem value="project">Project</SegmentedControlItem>
        <SegmentedControlItem value="session">Session</SegmentedControlItem>
      </SegmentedControl>
    );
  },
};

/** Three+ segments (a backend / threshold picker). */
export const ThreeSegments: Story = {
  render: () => {
    const [value, setValue] = useState("auto");
    return (
      <SegmentedControl
        aria-label="Auto-resolve"
        value={value}
        onValueChange={setValue}
      >
        <SegmentedControlItem value="off">Off</SegmentedControlItem>
        <SegmentedControlItem value="auto">Auto</SegmentedControlItem>
        <SegmentedControlItem value="always">Always</SegmentedControlItem>
      </SegmentedControl>
    );
  },
};

/** A disabled segment alongside selectable ones. */
export const WithDisabledSegment: Story = {
  render: () => {
    const [value, setValue] = useState("claude");
    return (
      <SegmentedControl
        aria-label="Backend"
        value={value}
        onValueChange={setValue}
      >
        <SegmentedControlItem value="claude">Claude</SegmentedControlItem>
        <SegmentedControlItem value="codex">Codex</SegmentedControlItem>
        <SegmentedControlItem value="gemini" disabled>
          Gemini
        </SegmentedControlItem>
      </SegmentedControl>
    );
  },
};

/** Full-width segments that split the available row (mobile toolbar usage). */
export const FullWidth: Story = {
  render: () => {
    const [value, setValue] = useState("all");
    return (
      <div className="w-[320px]">
        <SegmentedControl
          aria-label="Filter"
          value={value}
          onValueChange={setValue}
          layoutClassName="flex w-full"
        >
          <SegmentedControlItem value="all" layoutClassName="flex-1">
            All
          </SegmentedControlItem>
          <SegmentedControlItem value="active" layoutClassName="flex-1">
            Active
          </SegmentedControlItem>
          <SegmentedControlItem value="archived" layoutClassName="flex-1">
            Archived
          </SegmentedControlItem>
        </SegmentedControl>
      </div>
    );
  },
};
