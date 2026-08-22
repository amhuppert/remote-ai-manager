import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import WorkflowToolbar from "./WorkflowToolbar";

const meta = {
  title: "Workflows/WorkflowToolbar",
  component: WorkflowToolbar,
  args: {
    workflowName: "Poem Writing & Review",
    revision: 4,
    onRename: fn(),
    onDelete: fn(),
    onAddContext: fn(),
    onNewLane: fn(),
    onSave: fn(),
    onReset: fn(),
    onRelayout: fn(),
    onOpenWorkflowSettings: fn(),
    dirty: false,
    saving: false,
    hasValidationErrors: false,
  },
} satisfies Meta<typeof WorkflowToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved = {} satisfies Story;

export const UnsavedChanges = {
  args: {
    dirty: true,
  },
} satisfies Story;

export const Saving = {
  args: {
    dirty: true,
    saving: true,
  },
} satisfies Story;

export const ValidationErrors = {
  args: {
    dirty: true,
    hasValidationErrors: true,
  },
} satisfies Story;

/**
 * Save is refused for a reason no validator raised: unacceptable schema text.
 * It still puts a row in the red strip, so the status reads *Validation errors*
 * — only the button's title distinguishes the two refusals.
 */
export const SaveBlockedBySchema = {
  args: {
    dirty: true,
    hasValidationErrors: true,
    saveBlocked: true,
  },
} satisfies Story;

export const Mobile = {
  args: {
    dirty: true,
    isMobile: true,
  },
} satisfies Story;

export const LongName = {
  args: {
    workflowName: "Very Long Workflow Name That Might Overflow the Header Bar",
    revision: 12,
    dirty: true,
  },
} satisfies Story;
