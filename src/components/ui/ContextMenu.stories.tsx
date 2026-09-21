import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { ArchiveIcon, CopyIcon, TrashIcon } from "@/components/icons";
import { MenuItemIcon, MenuItemText } from "./MenuItemContent";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "./ContextMenu";

const meta = {
  title: "UI/ContextMenu",
  component: ContextMenu,
  parameters: {
    // Radix drives the WAI-ARIA menu pattern, opened via the contextmenu event
    // (roving focus, type-ahead, arrow/Home/End/Escape, role/aria wiring); a11y
    // violations fail the Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof ContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

const triggerArea =
  "flex h-[160px] w-[300px] items-center justify-center rounded-md border border-dashed border-border-default font-mono text-[0.78rem] text-text-tertiary select-none";

/** Right-click the dashed area to open the menu (icons, shortcut, danger item). */
export const Default: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={triggerArea}>Right-click anywhere here</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={fn()}>
          <CopyIcon size={15} />
          Duplicate
          <ContextMenuShortcut>⌘D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={fn()}>
          <ArchiveIcon size={15} />
          Archive
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={fn()}>
          <TrashIcon size={15} />
          Delete
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
};

/** A nested submenu opened from a context menu. */
export const Submenu: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={triggerArea}>Right-click here</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={fn()}>Open</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to project</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={fn()}>command-center</ContextMenuItem>
            <ContextMenuItem onSelect={fn()}>spec-driven-dev</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={fn()}>
          <TrashIcon size={15} />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
};

/** Grouped label + checkbox items (e.g. row display toggles). */
export const WithCheckboxes: Story = {
  render: () => {
    const [pinned, setPinned] = useState(true);
    const [muted, setMuted] = useState(false);
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={triggerArea}>Right-click here</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>Row</ContextMenuLabel>
          <ContextMenuCheckboxItem
            checked={pinned}
            onCheckedChange={(v) => setPinned(v === true)}
          >
            Pinned
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={muted}
            onCheckedChange={(v) => setMuted(v === true)}
          >
            Muted
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  },
};

/** The same shared icon gutter and descriptive row used in dropdown menus. */
export const Descriptions: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={triggerArea}>Right-click for session actions</div>
      </ContextMenuTrigger>
      <ContextMenuContent layoutClassName="w-[300px] max-w-[calc(100vw-16px)]">
        <ContextMenuLabel>Session</ContextMenuLabel>
        <ContextMenuItem onSelect={fn()}>
          <MenuItemIcon>
            <CopyIcon />
          </MenuItemIcon>
          <MenuItemText description="Copy the # mention for this session">
            Copy reference
          </MenuItemText>
        </ContextMenuItem>
        <ContextMenuItem disabled>
          <MenuItemIcon>
            <ArchiveIcon />
          </MenuItemIcon>
          <MenuItemText description="Stop the running agent before archiving">
            Archive session
          </MenuItemText>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={fn()}>
          <MenuItemIcon>
            <TrashIcon />
          </MenuItemIcon>
          <MenuItemText description="Delete worktree and session state">
            Delete session…
          </MenuItemText>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
};
