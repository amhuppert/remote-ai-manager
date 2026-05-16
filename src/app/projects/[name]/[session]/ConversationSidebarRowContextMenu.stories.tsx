import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ConversationSidebarRowContextMenu, {
  type ContextMenuItem,
} from "./ConversationSidebarRowContextMenu";

const Anchor = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      width: 480,
      height: 360,
      position: "relative",
      padding: 24,
      background: "var(--bg-void)",
      color: "var(--text-secondary)",
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius-md)",
    }}
  >
    <div style={{ marginBottom: 12 }}>
      Imagined sidebar row anchor — the menu opens from the top-left of this
      frame (x=24, y=24).
    </div>
    {children}
  </div>
);

const meta = {
  title: "Session/ConversationSidebarRowContextMenu",
  component: ConversationSidebarRowContextMenu,
  decorators: [
    (Story) => (
      <Anchor>
        <Story />
      </Anchor>
    ),
  ],
  args: {
    x: 24,
    y: 24,
    onClose: fn(),
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ConversationSidebarRowContextMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

const baseItems: ContextMenuItem[] = [
  { kind: "item", label: "Open conversation", onSelect: fn(), hotkey: "Enter" },
  { kind: "divider" },
  {
    kind: "item",
    label: "Filter sidebar to session: feature/sidebar-row",
    onSelect: fn(),
  },
  { kind: "item", label: "Open project page", onSelect: fn() },
  { kind: "item", label: "Copy branch name", onSelect: fn() },
  { kind: "divider" },
  { kind: "item", label: "Rename…", onSelect: fn() },
  { kind: "item", label: "Archive", onSelect: fn() },
];

export const Default = {
  args: {
    items: baseItems,
  },
} satisfies Story;

export const Unarchive = {
  args: {
    items: baseItems.map((item) =>
      item.kind === "item" && item.label === "Archive"
        ? { ...item, label: "Unarchive" }
        : item,
    ),
  },
} satisfies Story;

export const CopyBranchDisabled = {
  args: {
    items: baseItems.map((item) =>
      item.kind === "item" && item.label === "Copy branch name"
        ? { ...item, disabled: true }
        : item,
    ),
  },
} satisfies Story;

export const FilterAlreadyApplied = {
  args: {
    items: baseItems.map((item) =>
      item.kind === "item" && item.label.startsWith("Filter sidebar to session")
        ? {
            ...item,
            label: "Filtered to feature/sidebar-row",
            disabled: true,
          }
        : item,
    ),
  },
} satisfies Story;

export const WithDangerItem = {
  args: {
    items: [
      ...baseItems,
      { kind: "divider" },
      {
        kind: "item",
        label: "Delete conversation…",
        onSelect: fn(),
        danger: true,
      },
    ] satisfies ContextMenuItem[],
  },
} satisfies Story;
