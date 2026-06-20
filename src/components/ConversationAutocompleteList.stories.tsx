import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  ConversationAutocompleteList,
  type ConversationAutocompleteListItem,
} from "@/components/ConversationAutocompleteList";

function makeItem(
  overrides: Partial<ConversationAutocompleteListItem> & { id: string },
): ConversationAutocompleteListItem {
  return {
    id: overrides.id,
    displayLabel: overrides.displayLabel ?? `Conversation ${overrides.id}`,
    matchIndices: overrides.matchIndices ?? [],
    projectName: overrides.projectName ?? "my-app",
    sessionName: overrides.sessionName ?? "main",
    backend: overrides.backend ?? "claude",
    model: overrides.model ?? null,
    lastActivityRelative: overrides.lastActivityRelative ?? "1h",
    status: overrides.status ?? "new",
    isCurrentProject: overrides.isCurrentProject ?? false,
    archived: overrides.archived ?? false,
  };
}

const defaultItems: ConversationAutocompleteListItem[] = [
  makeItem({
    id: "a",
    displayLabel: "Refactor parser",
    matchIndices: [0, 1, 2, 3],
    isCurrentProject: true,
    status: "running",
    lastActivityRelative: "8m",
  }),
  makeItem({
    id: "b",
    displayLabel: "Investigate flaky test",
    isCurrentProject: true,
    status: "waiting_for_input",
    lastActivityRelative: "2h",
  }),
  makeItem({
    id: "c",
    displayLabel: "Add login flow",
    projectName: "other-proj",
    sessionName: "feature/login",
    status: "new",
    lastActivityRelative: "1d",
  }),
  makeItem({
    id: "d",
    displayLabel: "Codex investigation",
    projectName: "yet-another",
    backend: "codex",
    model: "gpt-5-codex",
    status: "new",
    lastActivityRelative: "3d",
  }),
];

const meta = {
  title: "Components/ConversationAutocompleteList",
  component: ConversationAutocompleteList,
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: 700,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
        }}
      >
        <div style={{ position: "relative", maxWidth: 520 }}>
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ConversationAutocompleteList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {
    items: defaultItems,
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    totalCount: defaultItems.length,
    loading: false,
    error: null,
    includeArchived: false,
    onToggleArchived: () => {},
  },
} satisfies Story;

export const Loading = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    totalCount: 0,
    loading: true,
    error: null,
    includeArchived: false,
    onToggleArchived: () => {},
  },
} satisfies Story;

export const ErrorState = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    totalCount: 0,
    loading: false,
    error: "Failed to load conversations: network error",
    includeArchived: false,
    onToggleArchived: () => {},
  },
} satisfies Story;

export const Empty = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    totalCount: 0,
    loading: false,
    error: null,
    includeArchived: false,
    onToggleArchived: () => {},
  },
} satisfies Story;

export const ArchivedOn = {
  args: {
    items: [
      ...defaultItems,
      makeItem({
        id: "arch-1",
        displayLabel: "Old archived conversation",
        archived: true,
        status: "new",
        lastActivityRelative: "21d",
      }),
    ],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    totalCount: defaultItems.length + 1,
    loading: false,
    error: null,
    includeArchived: true,
    onToggleArchived: () => {},
  },
} satisfies Story;

export const ManyMatches = {
  args: {
    items: Array.from({ length: 30 }, (_, i) =>
      makeItem({
        id: `c-${i}`,
        displayLabel: `match ${i} — long-ish conversation label here`,
        matchIndices: [0, 1, 2, 3, 4],
        isCurrentProject: i < 8,
        lastActivityRelative: `${i}h`,
      }),
    ),
    selectedIndex: 5,
    onHover: () => {},
    onSelect: () => {},
    totalCount: 30,
    loading: false,
    error: null,
    includeArchived: false,
    onToggleArchived: () => {},
  },
} satisfies Story;

export const CurrentProjectOnly = {
  args: {
    items: defaultItems.map((it) => ({ ...it, isCurrentProject: true })),
    selectedIndex: 1,
    onHover: () => {},
    onSelect: () => {},
    totalCount: defaultItems.length,
    loading: false,
    error: null,
    includeArchived: false,
    onToggleArchived: () => {},
  },
} satisfies Story;
