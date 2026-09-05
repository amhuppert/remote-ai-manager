import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn, waitFor, within, userEvent } from "storybook/test";
import { z } from "zod";
import { createWorkflowDefinitionRecord } from "@/lib/workflow-graph/test-fixtures";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import type { GraphWorkflowExecutionContextDefinition } from "@/lib/workflow-graph/definition-schemas";
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

export const Mobile = {
  args: { isMobile: true },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        className="app h-dvh"
        data-page="workflow-builder"
        data-mobile-panel="graph"
      >
        <Story />
      </div>
    ),
  ],
} satisfies Story;

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

/**
 * Every shape the generated band layout must make readable at a glance:
 * parallel roots stacked inside one lane, a sequential chain within a lane, a
 * fan-out to same-column parallels in different lanes, a fan-in join, a lane
 * whose chain starts mid-flow (its band opens deep, the empty run before its
 * first card is the wait it depicts), and a read-only report on the reserved
 * session lane. The record stores NO positions, so the canvas generates the
 * geometry live — this story shows the auto-layout itself, not a recorded
 * arrangement.
 */
export const RepresentativeLayout = {
  args: (() => {
    const source = createWorkflowDefinitionRecord();
    const base = source.definition.executionContexts[0];
    if (!base) throw new Error("fixture has no execution context");

    // Derived, not hand-written: a schema literal here would add old-way debt
    // to the structured-output-schema-literals seam.
    const reportSchema = {
      ...z.toJSONSchema(
        z.object({ summary: z.string(), risks: z.array(z.string()) }),
      ),
    };
    delete reportSchema.$schema;

    const context = (
      id: string,
      title: string,
      lane: string,
      overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
    ): GraphWorkflowExecutionContextDefinition => ({
      ...base,
      id: `context-${id}`,
      title,
      description: `${title}.`,
      acceptanceCriteria: `${title} is complete.`,
      placement: { lane, mode: "full" },
      ...overrides,
    });

    const contexts = [
      // Two roots in one lane: same depth, so they stack in one column. With
      // no dependency path between them they must partition the lane's write
      // surface, so each owns a disjoint path set.
      context("survey", "Survey code", "research", {
        placement: {
          lane: "research",
          mode: "owned",
          ownedPaths: ["docs/survey/**"],
        },
      }),
      context("spike", "Prototype spike", "research", {
        placement: {
          lane: "research",
          mode: "owned",
          ownedPaths: ["spikes/**"],
        },
      }),
      // A chain inside one lane: sequential columns in one band.
      context("api-design", "Design API", "api"),
      context("api-impl", "Implement API", "api"),
      // Same depth as Implement API, different lane: parallel across bands.
      context("ui-impl", "Implement UI", "ui"),
      // A lane whose only member sits deep: its band opens mid-flow.
      context("e2e", "End-to-end QA", "qa"),
      // The reserved session lane admits only read-only members, and a
      // read-only context delivers exclusively through its output contract.
      context("report", "Delivery report", "session", {
        placement: { lane: "session", mode: "readOnly" },
        outputSchema: reportSchema,
      }),
    ];

    const edge = (from: string, to: string) => ({
      id: `edge-${from}-${to}`,
      sourceContextId: `context-${from}`,
      targetContextId: `context-${to}`,
    });

    const record = createWorkflowDefinitionRecord({
      name: "Representative Layout",
      definition: {
        ...source.definition,
        executionContexts: contexts,
        tasks: contexts.map((member) => ({
          id: `task-${member.id}`,
          contextId: member.id,
          order: 1,
          title: member.title,
          instructions: `Carry out: ${member.title.toLowerCase()}.`,
          source: "user" as const,
        })),
        edges: [
          // Fan-in from the parallel roots.
          edge("survey", "api-design"),
          edge("spike", "api-design"),
          // Fan-out to parallel work in two lanes…
          edge("api-design", "api-impl"),
          edge("api-design", "ui-impl"),
          // …closed by a fan-in join (a diamond, across three lanes).
          edge("api-impl", "e2e"),
          edge("ui-impl", "e2e"),
          edge("e2e", "report"),
        ],
      },
      layout: {
        workflowId: "workflow-representative",
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
  // React Flow fits the viewport when nodes first measure — while every node
  // still sits at the origin, since this record stores no positions. Refit
  // once the generated geometry has actually placed them.
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        const transforms = new Set(
          [...canvasElement.querySelectorAll(".react-flow__node")].map(
            (node) => (node as HTMLElement).style.transform,
          ),
        );
        if (transforms.size < 2) {
          throw new Error("auto-layout has not placed the nodes yet");
        }
      },
      { timeout: 5000 },
    );
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Fit view" }),
    );
  },
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
