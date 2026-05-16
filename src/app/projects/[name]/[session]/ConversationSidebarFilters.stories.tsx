import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useLayoutEffect } from "react";
import {
  useSessionDetailStore,
  type SidebarGroupBy,
} from "@/stores/session-detail.store";
import ConversationSidebarFilters from "./ConversationSidebarFilters";

interface WrapperProps {
  initialGroupBy: SidebarGroupBy;
}

function FiltersHarness({ initialGroupBy }: WrapperProps) {
  useLayoutEffect(() => {
    useSessionDetailStore.setState({ sidebarGroupBy: initialGroupBy });
  }, [initialGroupBy]);

  return <ConversationSidebarFilters />;
}

const meta = {
  title: "Session/ConversationSidebarFilters",
  component: FiltersHarness,
  decorators: [
    (Story) => (
      <div
        style={{
          width: 320,
          padding: "var(--space-md)",
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    initialGroupBy: "project" as SidebarGroupBy,
  },
} satisfies Meta<typeof FiltersHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GroupBySession: Story = {
  args: { initialGroupBy: "session" },
};

export const GroupByProject: Story = {
  args: { initialGroupBy: "project" },
};
