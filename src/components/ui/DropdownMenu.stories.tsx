import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  ArchiveIcon,
  BranchIcon,
  ChevronDownIcon,
  CopyIcon,
  KebabIcon,
  TrashIcon,
} from "@/components/icons";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./DropdownMenu";

const meta = {
  title: "UI/DropdownMenu",
  component: DropdownMenu,
  parameters: {
    // Radix drives the WAI-ARIA Menu Button pattern (roving focus, type-ahead,
    // arrow/Home/End/Escape, correct role/aria wiring); a11y violations fail the
    // Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The canonical row-actions menu: an icon-only kebab trigger (composing the
 * `IconButton` primitive via `asChild`) opening an action list with leading
 * icons, a keyboard-shortcut hint, a separator, and a destructive item.
 */
export const Actions: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label="More actions">
          <KebabIcon size={16} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={fn()}>
          <CopyIcon size={15} />
          Duplicate
          <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={fn()}>
          <BranchIcon size={15} />
          New branch
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={fn()}>
          <ArchiveIcon size={15} />
          Archive
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={fn()}>
          <TrashIcon size={15} />
          Delete
          <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/** A labeled trigger composing the `Button` primitive instead of an icon button. */
export const LabeledTrigger: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          Actions
          <ChevronDownIcon size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={fn()}>Open</DropdownMenuItem>
        <DropdownMenuItem onSelect={fn()}>Rename</DropdownMenuItem>
        <DropdownMenuItem disabled>Merge (unavailable)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

const MODELS = [
  { id: "fable", label: "Fable", desc: "Most capable" },
  { id: "opus", label: "Opus", desc: "Highly capable" },
  { id: "sonnet", label: "Sonnet", desc: "Balanced" },
  { id: "haiku", label: "Haiku", desc: "Fastest" },
];

/**
 * Single-value selection via `RadioGroup` — the checked row takes the cyan-glow
 * treatment (the affordance the bespoke ModelSelector/ReasoningLevelSelector
 * dropdowns hand-roll today).
 */
export const Selection: Story = {
  render: () => {
    const [model, setModel] = useState("opus");
    const current = MODELS.find((m) => m.id === model);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            {current?.label}
            <ChevronDownIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={model} onValueChange={setModel}>
            {MODELS.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                {m.label}
                <span className="ml-auto pl-[16px] text-[0.7rem] text-text-tertiary">
                  {m.desc}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
};

/** Multi-toggle via `CheckboxItem`s (e.g. column visibility). */
export const Checkboxes: Story = {
  render: () => {
    const [cols, setCols] = useState({
      status: true,
      branch: true,
      agent: false,
    });
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            Columns
            <ChevronDownIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={cols.status}
            onCheckedChange={(v) =>
              setCols((c) => ({ ...c, status: v === true }))
            }
          >
            Status
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={cols.branch}
            onCheckedChange={(v) =>
              setCols((c) => ({ ...c, branch: v === true }))
            }
          >
            Branch
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={cols.agent}
            onCheckedChange={(v) =>
              setCols((c) => ({ ...c, agent: v === true }))
            }
          >
            Agent
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
};

/** A nested submenu — the menubar pattern's keyboard model, scoped to one menu. */
export const Submenu: Story = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          Actions
          <ChevronDownIcon size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={fn()}>Open</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to project</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={fn()}>command-center</DropdownMenuItem>
            <DropdownMenuItem onSelect={fn()}>spec-driven-dev</DropdownMenuItem>
            <DropdownMenuItem onSelect={fn()}>ai-resources</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={fn()}>
          <TrashIcon size={15} />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};

/** Opened on mount so the menu surface is reviewable without interaction. */
export const StaticOpen: Story = {
  render: () => (
    <div className="flex h-[260px] items-start justify-center pt-[40px]">
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            Actions
            <ChevronDownIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          <DropdownMenuItem onSelect={fn()}>
            <CopyIcon size={15} />
            Duplicate
            <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={fn()}>
            <ArchiveIcon size={15} />
            Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={fn()}>
            <TrashIcon size={15} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};
