import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useLayoutEffect } from "react";
import type { SidebarGroupBy } from "./ConversationSidebar.helpers";
import { GROUP_BY_STORAGE_KEY } from "./use-sidebar-persistent-filters";
import ConversationSidebarFilters from "./ConversationSidebarFilters";

interface WrapperProps {
  initialGroupBy: SidebarGroupBy;
}

function FiltersHarness({ initialGroupBy }: WrapperProps) {
  useLayoutEffect(() => {
    window.sessionStorage.setItem(
      GROUP_BY_STORAGE_KEY,
      JSON.stringify(initialGroupBy),
    );
    return () => {
      window.sessionStorage.removeItem(GROUP_BY_STORAGE_KEY);
    };
  }, [initialGroupBy]);

  return <ConversationSidebarFilters key={initialGroupBy} />;
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
