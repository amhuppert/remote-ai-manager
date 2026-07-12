import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  TicketAutocompleteList,
  type TicketAutocompleteListItem,
} from "./TicketAutocompleteList";

const items: TicketAutocompleteListItem[] = [
  {
    id: "ticket-12",
    identifier: "command-center#12",
    title: "Harden ticket autocomplete",
    titleMatchIndices: [7, 8, 9, 10, 11, 12],
    projectName: "command-center",
    workType: "feature",
    status: "in_progress",
    attachmentCount: 4,
    activeSessionName: "Ticket: Harden ticket autocomplete",
    isCurrentProject: true,
  },
  {
    id: "ticket-8",
    identifier: "command-center#8",
    title: "Investigate prompt latency",
    titleMatchIndices: [],
    projectName: "command-center",
    workType: "performance",
    status: "not_started",
    attachmentCount: 2,
    activeSessionName: null,
    isCurrentProject: true,
  },
  {
    id: "ticket-31",
    identifier: "api-service#31",
    title: "Repair authentication callback",
    titleMatchIndices: [],
    projectName: "api-service",
    workType: "bug",
    status: "blocked",
    attachmentCount: 1,
    activeSessionName: null,
    isCurrentProject: false,
  },
];

const meta = {
  title: "Components/TicketAutocompleteList",
  component: TicketAutocompleteList,
  args: {
    selectedIndex: 0,
    onHover: fn(),
    onSelect: fn(),
    totalCount: items.length,
    loading: false,
    error: null,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          minHeight: "700px",
          flexDirection: "column",
          justifyContent: "flex-end",
        }}
      >
        <div style={{ position: "relative", maxWidth: "640px" }}>
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof TicketAutocompleteList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: { items },
} satisfies Story;

export const CrossProject = {
  args: { items, selectedIndex: 2 },
} satisfies Story;

export const Loading = {
  args: { items: [], totalCount: 0, loading: true },
} satisfies Story;

export const Empty = {
  args: { items: [], totalCount: 0 },
} satisfies Story;

export const ErrorState = {
  args: { items: [], totalCount: 0, error: "Failed to load tickets" },
} satisfies Story;

export const Mobile = {
  args: { items },
  parameters: { viewport: { defaultViewport: "mobile1" } },
} satisfies Story;
