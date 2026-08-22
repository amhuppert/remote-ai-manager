import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CanvasContextMenu from "./CanvasContextMenu";

const meta = {
  title: "Workflows/CanvasContextMenu",
  component: CanvasContextMenu,
  args: {
    onClose: fn(),
    onDeleteContext: fn(),
    onDeleteDependency: fn(),
    onMoveContext: fn(),
  },
} satisfies Meta<typeof CanvasContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Right-clicking a context node. */
export const NodeTarget = {
  args: {
    target: {
      kind: "node",
      id: "ctx_implement",
      title: "Implement checkout",
      x: 180,
      y: 140,
    },
  },
} satisfies Story;

/** Right-clicking a dependency edge. */
export const EdgeTarget = {
  args: {
    target: { kind: "edge", id: "ctx_plan->ctx_implement", x: 180, y: 140 },
  },
} satisfies Story;

/** Nothing was right-clicked, so nothing opens. */
export const Closed = {
  args: { target: null },
} satisfies Story;
