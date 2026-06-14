import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import WorkflowBuilderEditor from "./WorkflowBuilderEditor";

const defaultRecord = createWorkflowDefinitionRecord();

const meta = {
  title: "Workflows/WorkflowBuilderEditor",
  component: WorkflowBuilderEditor,
  args: {
    record: defaultRecord,
    workflowName: defaultRecord.name,
    revision: defaultRecord.revision,
    onRename: fn(),
    onDelete: fn(),
  },
} satisfies Meta<typeof WorkflowBuilderEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const EmptyWorkflow = {
  args: (() => {
    const record = createWorkflowDefinitionRecord({
      name: "Empty Workflow",
      definition: {
        schemaVersion: 1,
        workflowConfig: {},
        charter: makeTestCharter(),
        executionContexts: [],
        tasks: [],
        edges: [],
      },
      layout: {
        workflowId: "workflow-empty",
        contextPositions: {},
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    });
    return {
      record,
      workflowName: record.name,
      revision: record.revision,
    };
  })(),
} satisfies Story;
