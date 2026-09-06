import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  CommandAutocompleteList,
  type CommandAutocompleteListItem,
} from "./CommandAutocompleteList";

const items: CommandAutocompleteListItem[] = [
  {
    id: "1",
    name: "/spec-init",
    description: "Initialize a new specification",
    badge: "command",
    source: "user",
  },
  {
    id: "2",
    name: "/spec-design",
    description: "Generate the technical design",
    badge: "command",
    source: "user",
    matchIndices: [1, 2, 3, 4],
  },
  {
    id: "3",
    name: "cc-design-system",
    description: "Design or review CC UI against the design system",
    badge: "skill",
    source: "project",
  },
  {
    id: "4",
    name: "deep-research",
    description: "Fan-out web research with cited synthesis",
    badge: "skill",
    source: "user",
  },
];

const meta = {
  title: "Components/CommandAutocompleteList",
  component: CommandAutocompleteList,
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
} satisfies Meta<typeof CommandAutocompleteList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {
    items,
    selectedIndex: 1,
    onHover: () => {},
    onSelect: () => {},
    headerLabel: "Commands",
    emptyLabel: "No matching commands",
  },
} satisfies Story;

export const Empty = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    headerLabel: "Commands",
    emptyLabel: "No matching commands",
  },
} satisfies Story;

export const Loading = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    headerLabel: "Skills",
    emptyLabel: "No matching skills",
    loading: true,
  },
} satisfies Story;

export const ErrorState = {
  args: {
    items: [],
    selectedIndex: 0,
    onHover: () => {},
    onSelect: () => {},
    headerLabel: "Commands",
    emptyLabel: "No matching commands",
    error: "Failed to load commands",
  },
} satisfies Story;

export const BackendAvailability = {
  args: {
    ...Default.args,
    items: [
      {
        id: "ticket",
        name: "/ticket",
        description: "Cursor does not support task execution.",
        disabled: true,
        badge: "Unavailable",
      },
      {
        id: "commit",
        name: "/commit",
        description:
          "Commit with a default message. Automatic fixes are unavailable.",
        badge: "Limited assistance",
      },
      {
        id: "spec",
        name: "/spec",
        description: "Author a native Command Center spec.",
        badge: "command",
      },
    ],
  },
} satisfies Story;
