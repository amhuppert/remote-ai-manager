import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { createRef } from "react";
import CommandConsole from "./CommandConsole";
import type { Suggestion } from "./command-suggestions";
import type { FilterToken } from "./filter-tokens";

const inputRef = createRef<HTMLInputElement | null>();

const baseTokens: FilterToken[] = [
  { cat: "status", key: "is", value: "running" },
  { cat: "target", key: "target", value: "main" },
];

const filterSuggestions: Suggestion[] = [
  {
    kind: "filter",
    cat: "archived",
    key: "include",
    value: "include",
    label: "Include archived",
    grp: "Filter",
  },
  {
    kind: "filter",
    cat: "archived",
    key: "only",
    value: "only",
    exclusive: true,
    label: "Show only archived (12)",
    grp: "Filter",
  },
  {
    kind: "filter",
    cat: "status",
    key: "is",
    value: "running",
    label: "is:running · 3",
    grp: "Filter",
  },
];

const slashSuggestions: Suggestion[] = [
  {
    kind: "action",
    id: "new",
    label: "/new — Create new session",
    grp: "Actions",
  },
  {
    kind: "action",
    id: "install-preset",
    label: "/install-preset — Install a preset…",
    grp: "Actions",
  },
  {
    kind: "action",
    id: "capabilities",
    label: "/capabilities — Configure capabilities",
    grp: "Actions",
  },
];

const meta = {
  title: "Projects/CommandConsole",
  component: CommandConsole,
  args: {
    tokens: [],
    draft: "",
    suggestions: [],
    focused: false,
    onDraftChange: fn(),
    onApply: fn(),
    onRemoveToken: fn(),
    onFocus: fn(),
    onBlur: fn(),
    inputRef,
  },
} satisfies Meta<typeof CommandConsole>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyBlurred = {} satisfies Story;

export const WithChips = {
  args: { tokens: baseTokens },
} satisfies Story;

export const FocusedWithFilterSuggestions = {
  args: { focused: true, suggestions: filterSuggestions },
} satisfies Story;

export const SlashMode = {
  args: { focused: true, draft: "/", suggestions: slashSuggestions },
} satisfies Story;
