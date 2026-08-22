import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import { WorkflowMobileTabBar } from "./WorkflowMobileTabBar";

/**
 * The M1/M2 bottom toolbar at a phone viewport. It is fixed, safe-area padded
 * and 44px-tall: the only way between panels, so it never moves — not while a
 * nested config screen pushes, not while a sheet is open (README §12).
 */
const meta = {
  title: "WorkflowGraph/WorkflowMobileTabBar",
  component: WorkflowMobileTabBar,
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    backgrounds: { default: "dark" },
  },
  args: { onChange: fn() },
} satisfies Meta<typeof WorkflowMobileTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** M1: Graph · Defs · Inspector, opened on Graph. */
export const BuilderPanels: Story = {
  args: {
    label: "Builder panels",
    activePanel: "graph",
    tabs: [
      { value: "graph", label: "Graph", icon: "graph" },
      { value: "defs", label: "Defs", icon: "list" },
      { value: "inspector", label: "Inspector", icon: "panel" },
    ],
  },
};

/** M1, after a context was selected: the Inspector is the current panel. */
export const BuilderInspectorCurrent: Story = {
  args: { ...BuilderPanels.args, activePanel: "inspector" },
};

/** M2: Graph · Inspector · Log, with a transcript open. */
export const ExecutionPanels: Story = {
  args: {
    label: "Execution panels",
    activePanel: "log",
    tabs: [
      { value: "graph", label: "Graph", icon: "graph" },
      { value: "inspector", label: "Inspector", icon: "panel" },
      { value: "log", label: "Log", icon: "log" },
    ],
  },
};
