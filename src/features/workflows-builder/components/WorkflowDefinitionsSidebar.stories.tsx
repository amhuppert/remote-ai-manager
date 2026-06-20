import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import WorkflowDefinitionsSidebar from "./WorkflowDefinitionsSidebar";

const sampleDefinitions = [
  { id: "wf-1", name: "Poem Writing & Review", revision: 4 },
  { id: "wf-2", name: "Setup & Build", revision: 2 },
  { id: "wf-3", name: "API Migration", revision: 1 },
  { id: "wf-4", name: "Refactor Auth Module", revision: 7 },
];

const meta = {
  title: "Workflows/WorkflowDefinitionsSidebar",
  component: WorkflowDefinitionsSidebar,
  args: {
    definitions: sampleDefinitions,
    selectedId: "wf-1",
    onSelect: fn(),
    onCreate: fn(),
    isLoading: false,
  },
  decorators: [
    (Story) => (
      <div style={{ height: 500, display: "flex" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowDefinitionsSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const NoneSelected = {
  args: {
    selectedId: null,
  },
} satisfies Story;

export const Empty = {
  args: {
    definitions: [],
    selectedId: null,
  },
} satisfies Story;

export const Loading = {
  args: {
    definitions: [],
    selectedId: null,
    isLoading: true,
  },
} satisfies Story;

export const WithFooter = {
  args: {
    footer: (
      <a
        className="flex items-center gap-[6px] px-0 py-[6px] text-[0.72rem] font-medium text-text-secondary no-underline transition-colors duration-150 hover:text-text-primary"
        href="#"
      >
        ← Back to Sessions
      </a>
    ),
  },
} satisfies Story;

export const ManyItems = {
  args: {
    definitions: Array.from({ length: 12 }, (_, i) => ({
      id: `wf-${i + 1}`,
      name: `Workflow ${i + 1}`,
      revision: Math.floor(Math.random() * 10) + 1,
    })),
    selectedId: "wf-3",
  },
} satisfies Story;
