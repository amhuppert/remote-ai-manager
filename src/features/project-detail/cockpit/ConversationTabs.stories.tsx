import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import ConversationTabs, { type ConversationTabItem } from "./ConversationTabs";
import "./styles/cockpit.css";

const baseTabs: ConversationTabItem[] = [
  {
    id: "a",
    name: "Auth refactor",
    unread: false,
    agent: "claude",
    status: "running",
  },
  {
    id: "b",
    name: "Parser bug",
    unread: true,
    agent: "claude",
    status: "awaiting",
  },
  {
    id: "c",
    name: "Codex spike",
    unread: false,
    agent: "codex",
    status: "new",
  },
];

const meta: Meta<typeof ConversationTabs> = {
  title: "Project Cockpit/ConversationTabs",
  component: ConversationTabs,
};
export default meta;

type Story = StoryObj<typeof ConversationTabs>;

export const Default: Story = {
  args: {
    tabs: baseTabs,
    activeTabId: "a",
    onSelect: fn(),
    onClose: fn(),
    onNewChat: fn(),
  },
};

/** Tab `b` is non-active and carries an amber unread dot. */
export const WithUnread: Story = {
  args: {
    tabs: baseTabs,
    activeTabId: "a",
    onSelect: fn(),
    onClose: fn(),
    onNewChat: fn(),
  },
};

/**
 * Interactive: select tabs, close one (the active tab falls back to another),
 * and add a new chat.
 */
export const Interactive: Story = {
  render: function InteractiveTabs() {
    const [tabs, setTabs] = useState(baseTabs);
    const [active, setActive] = useState<string | null>("a");
    let counter = tabs.length;
    return (
      <ConversationTabs
        tabs={tabs}
        activeTabId={active}
        onSelect={setActive}
        onClose={(id) => {
          setTabs((prev) => {
            const next = prev.filter((t) => t.id !== id);
            if (id === active) setActive(next[0]?.id ?? null);
            return next;
          });
        }}
        onNewChat={() => {
          counter += 1;
          const id = `new-${counter}`;
          setTabs((prev) => [
            ...prev,
            {
              id,
              name: `New chat ${counter}`,
              unread: false,
              agent: "claude",
              status: "new",
            },
          ]);
          setActive(id);
        }}
      />
    );
  },
};
