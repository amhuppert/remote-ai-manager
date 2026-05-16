import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { useLayoutEffect } from "react";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { SidebarListFilter } from "./ConversationSidebar.helpers";
import ConversationSidebarHeader from "./ConversationSidebarHeader";

interface WrapperProps {
  counts: Record<SidebarListFilter, number>;
  initialFilter: string;
  initialListFilter: SidebarListFilter;
}

function HeaderHarness({
  counts,
  initialFilter,
  initialListFilter,
}: WrapperProps) {
  const [activeFilter, setActiveFilter] =
    useState<SidebarListFilter>(initialListFilter);

  useLayoutEffect(() => {
    useSessionDetailStore.setState({
      sidebarFilter: initialFilter,
    });
  }, [initialFilter]);

  return (
    <ConversationSidebarHeader
      counts={counts}
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
    />
  );
}

const meta = {
  title: "Session/ConversationSidebarHeader",
  component: HeaderHarness,
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
    counts: { all: 6, needs: 0, running: 4, session: 1 },
    initialFilter: "",
    initialListFilter: "all" as SidebarListFilter,
  },
} satisfies Meta<typeof HeaderHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Populated: Story = {
  args: {
    initialFilter: "validate",
  },
};

export const NeedsFilterActive: Story = {
  args: {
    initialListFilter: "needs",
    counts: { all: 6, needs: 3, running: 2, session: 1 },
  },
};
