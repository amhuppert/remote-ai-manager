import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  FileAutocompleteList,
  type FileAutocompleteListItem,
} from "./FileAutocompleteList";

const items: FileAutocompleteListItem[] = [
  { id: "1", path: "src/components/FileAutocompleteList.tsx" },
  {
    id: "2",
    path: "src/lib/files/file-autocomplete-filter.ts",
    matchIndices: [9, 10, 11, 12],
  },
  { id: "3", path: "src/app/globals.css" },
  { id: "4", path: "src/features/session/prompt/PromptEditor.tsx" },
  { id: "5", path: "README.md" },
];

const meta = {
  title: "Components/FileAutocompleteList",
  component: FileAutocompleteList,
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
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FileAutocompleteList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {
    items,
    selectedIndex: 1,
    onHover: () => {},
    onSelect: () => {},
    totalCount: items.length,
  },
} satisfies Story;

export const ManyResults = {
  args: {
    items,
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    totalCount: 50,
    truncated: true,
  },
} satisfies Story;

export const Empty = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
  },
} satisfies Story;

export const Loading = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    loading: true,
  },
} satisfies Story;

export const ErrorState = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    error: "Failed to scan project files",
  },
} satisfies Story;
