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

/**
 * B3: a draft the validator refuses. The strip under the toolbar lists every
 * error and each row opens the screen that can clear it; Save stays refused
 * while any row stands.
 */
export const ValidationErrors = {
  args: (() => {
    const source = createWorkflowDefinitionRecord();
    const contexts = source.definition.executionContexts;
    const leaf = contexts.at(-1);
    if (!leaf) throw new Error("fixture has no execution context");
    const record = createWorkflowDefinitionRecord({
      name: "Refused Draft",
      definition: {
        ...source.definition,
        executionContexts: [
          ...contexts.slice(0, -1),
          // Read-only delivers only through structured outputs, so an undeclared
          // output contract is refused.
          {
            ...leaf,
            placement: { lane: leaf.placement.lane, mode: "readOnly" },
          },
        ],
      },
    });
    return {
      record,
      workflowName: record.name,
      revision: record.revision,
    };
  })(),
} satisfies Story;

export const EmptyWorkflow = {
  args: (() => {
    const record = createWorkflowDefinitionRecord({
      name: "Empty Workflow",
      definition: {
        schemaVersion: 1,
        workflowConfig: {},
        charter: makeTestCharter(),
        parameters: [],
        prerequisites: [],
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
